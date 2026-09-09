/**
 * 同じ URL を 3 つのエンジンで撮って、所要時間と結果を JSONL に落とす。
 *
 *   Chromium  … Browser Run の既定
 *   Kitesurf  … Browser Run の ?browser=kitesurf
 *   mine      … このリポジトリの Worker の /ashot (構成 A、掛け合わせ)
 *
 * build-shots.mjs と違って PNG は保存しない。数だけ取る。
 * 3 つは同時刻に並列で撮る (ページの側が時刻で変わるため)。
 *
 *   BR_TOKEN_FILE=... BR_ACCOUNT_FILE=... WORKER_URL=https://... \
 *     OUT=/path/measure.jsonl node scripts/measure-engines.mjs
 *
 * ROUNDS で繰り返し回数、URLS でファイルから URL を読む。
 */
import { readFileSync, appendFileSync } from 'node:fs';

const secret = (envName, fileEnvName, label) => {
  if (process.env[envName]) return process.env[envName].trim();
  const f = process.env[fileEnvName];
  if (f) {
    const v = readFileSync(f, 'utf8').trim();
    if (v) return v;
  }
  throw new Error(`${label} が無い。${envName} か ${fileEnvName} を渡す (リポジトリの外に置く)`);
};

const TOKEN = secret('CF_BR_TOKEN', 'BR_TOKEN_FILE', 'Browser Run のトークン');
const ACCOUNT = secret('CF_ACCOUNT_ID', 'BR_ACCOUNT_FILE', 'Cloudflare のアカウント ID');
const WORKER = (process.env.WORKER_URL ?? '').replace(/\/$/, '');
if (!WORKER) throw new Error('WORKER_URL が無い');
const OUT = process.env.OUT ?? 'measure.jsonl';
const ROUNDS = Number(process.env.ROUNDS ?? 3);
const W = 1000, H = 780;

/** 素の HTML から SPA まで、日本語と英語、CSS の重さで散らす */
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
// Browser Run は応答をキャッシュする。fragment ならサーバには送られずキャッシュキーだけ外せる
const bust = () => `#cb=${Date.now()}`;

async function browserRun(browser, url) {
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/browser-run/screenshot`
    + (browser === 'kitesurf' ? '?browser=kitesurf' : '');
  const t0 = Date.now();
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: new URL(url).href + bust(),
        viewport: { width: W, height: H },
        screenshotOptions: { fullPage: false },
      }),
      signal: AbortSignal.timeout(180000),
    });
    const buf = Buffer.from(await res.arrayBuffer());
    const ms = Date.now() - t0;
    if (!res.ok || buf.length < 1000) {
      return { ok: false, ms, status: res.status, error: buf.toString('utf8').slice(0, 200) };
    }
    const billed = res.headers.get('x-browser-ms-used');
    return { ok: true, ms, bytes: buf.length, billedMs: billed == null ? null : Math.round(Number(billed)) };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, error: String(e?.message ?? e).slice(0, 200) };
  }
}

/** 自作の Worker。/ashot は 10 秒 4 回 / 60 秒 12 回の制限があるので 429 は待って引き直す */
async function mine(url) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const q = new URLSearchParams({ w: String(W), h: String(H), url, fresh: '1' });
    const t0 = Date.now();
    try {
      const res = await fetch(`${WORKER}/ashot?${q}`, { signal: AbortSignal.timeout(180000) });
      const buf = Buffer.from(await res.arrayBuffer());
      const ms = Date.now() - t0;
      if (res.status === 429) {
        await wait(1000 * Number(res.headers.get('retry-after') ?? 10));
        continue;
      }
      if (!res.ok) return { ok: false, ms, status: res.status, error: buf.toString('utf8').slice(0, 200) };
      let timing = null;
      try { timing = JSON.parse(res.headers.get('x-timing') ?? 'null'); } catch { /* 無くてもよい */ }
      let report = null;
      try { report = JSON.parse(res.headers.get('x-page-script') ?? 'null'); } catch { /* 同上 */ }
      return {
        ok: true, ms, bytes: buf.length,
        passes: report?.passes?.length ?? null,
        resources: timing?.resources ?? null,
        jsErrors: timing?.jsErrors ?? null,
        usedNoJs: timing?.usedNoJs ?? false,
      };
    } catch (e) {
      return { ok: false, ms: Date.now() - t0, error: String(e?.message ?? e).slice(0, 200) };
    }
  }
  return { ok: false, error: '429 が続いた' };
}

for (let round = 1; round <= ROUNDS; round++) {
  for (const url of URLS) {
    const [chromium, kitesurf, ours] = await Promise.all([
      browserRun('chromium', url), browserRun('kitesurf', url), mine(url),
    ]);
    const row = { round, url, at: new Date().toISOString(), chromium, kitesurf, mine: ours };
    appendFileSync(OUT, JSON.stringify(row) + '\n');
    const fmt = (r) => (r.ok ? `${String(r.ms).padStart(6)} ms` : `  失敗 (${r.status ?? '-'})`);
    console.log(`r${round} ${new URL(url).hostname.padEnd(26)} C:${fmt(chromium)}  K:${fmt(kitesurf)}  M:${fmt(ours)}`
      + (ours.ok ? `  ${ours.passes} 往復 / ${ours.resources} 本` : ''));
    // /ashot の 60 秒 12 回に当てないよう間を空ける
    await wait(3000);
  }
}
console.log('done');
