/**
 * 同じ URL を 2 つの構成で撮って、所要時間と結果を JSONL に落とす。
 *
 *   boa … /ashot   V8 + Boa。ページの JS は Dynamic Worker の handler で Boa が実行し、
 *                  解釈の途中で足りない資源を取りに行く
 *   v8  … /v8shot  V8 だけ。資源を先に全部揃えてから Dynamic Worker に渡し、
 *                  モジュールの評価中に V8 がページの JS を実行する
 *
 * 2 つは同時刻に並列で叩く (上流のページが時刻で変わるため)。
 *
 *   WORKER_URL=https://... OUT=/path/configs.jsonl node scripts/measure-configs.mjs
 */
import { readFileSync, appendFileSync } from 'node:fs';

const WORKER = (process.env.WORKER_URL ?? '').replace(/\/$/, '');
if (!WORKER) throw new Error('WORKER_URL が無い');
const OUT = process.env.OUT ?? 'configs.jsonl';
const ROUNDS = Number(process.env.ROUNDS ?? 3);
const W = 1000, H = 780;

const URLS = process.env.URLS
  ? readFileSync(process.env.URLS, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean)
  : [
    'https://example.com/',
    'https://news.ycombinator.com/',
    'https://www.aozora.gr.jp/',
    'https://www.gnu.org/',
    'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/map',
    'https://developer.mozilla.org/ja/docs/Web/CSS',
    'https://docs.python.org/3/',
    'https://developers.cloudflare.com/workers/',
    'https://react.dev/',
    'https://vuejs.org/',
    'https://astro.build/',
    'https://tailwindcss.com/',
    'https://todomvc.com/examples/react/dist/',
    'https://ja.wikipedia.org/wiki/メインページ',
    'https://zenn.dev/',
    'https://qiita.com/',
  ];

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** /ashot と /v8shot は同じレート制限 (10 秒 4 回 / 60 秒 12 回) なので 429 は待って引き直す */
async function shoot(path, url) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const q = new URLSearchParams({ w: String(W), h: String(H), url, fresh: '1' });
    const t0 = Date.now();
    try {
      const res = await fetch(`${WORKER}${path}?${q}`, { signal: AbortSignal.timeout(240000) });
      const buf = Buffer.from(await res.arrayBuffer());
      const ms = Date.now() - t0;
      if (res.status === 429) { await wait(1000 * Number(res.headers.get('retry-after') ?? 10)); continue; }
      let timing = null;
      try { timing = JSON.parse(res.headers.get('x-timing') ?? 'null'); } catch { /* 無くてもよい */ }
      if (!res.ok) return { ok: false, ms, status: res.status, error: buf.toString('utf8').slice(0, 200) };
      return {
        ok: true, ms, bytes: buf.length,
        // 構成 A は settle の周回、構成 B は捨てるための描画の回数
        passes: timing?.passes ?? null,
        discoverPasses: timing?.discoverPasses ?? null,
        resources: timing?.resources ?? timing?.discovered ?? null,
        jsErrors: timing?.jsErrors ?? null,
      };
    } catch (e) {
      return { ok: false, ms: Date.now() - t0, error: String(e?.message ?? e).slice(0, 200) };
    }
  }
  return { ok: false, error: '429 が続いた' };
}

for (let round = 1; round <= ROUNDS; round++) {
  for (const url of URLS) {
    const [boa, v8] = await Promise.all([shoot('/ashot', url), shoot('/v8shot', url)]);
    appendFileSync(OUT, JSON.stringify({ round, url, at: new Date().toISOString(), boa, v8 }) + '\n');
    const f = (r) => (r.ok ? `${String(r.ms).padStart(6)} ms` : `  失敗 (${r.status ?? '-'})`);
    console.log(`r${round} ${new URL(url).hostname.padEnd(26)} V8+Boa:${f(boa)}  V8:${f(v8)}`
      + (v8.ok ? `  捨てる描画 ${v8.discoverPasses}` : ''));
    await wait(4000);
  }
}
console.log('done');
