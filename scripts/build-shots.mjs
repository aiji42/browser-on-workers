/**
 * 同じページを 3 つのブラウザで撮って public/shots/ に置く。
 *
 *   Chromium  … Cloudflare Browser Run の既定 (本物のブラウザ)
 *   Kitesurf  … Browser Run の ?browser=kitesurf (Cloudflare 版)
 *   mine      … このリポジトリの Worker
 *
 * なぜ静的に置くのか: ja.wikipedia のトップページは日ごとに変わるので、
 * 3 枚を別々の時刻に撮ると「エンジンの違い」と「ページの違い」が混ざる。
 * **3 枚を同じ時刻に撮って固める。** ついでに Browser Run の課金も 1 回で済む。
 *
 * トークンとアカウント ID はリポジトリに置かない。環境変数か、
 * リポジトリの外のファイルから実行時に読む。
 *
 *   CF_BR_TOKEN=... CF_ACCOUNT_ID=... WORKER_URL=https://... node scripts/build-shots.mjs
 *   BR_TOKEN_FILE=/path/.cf-token BR_ACCOUNT_FILE=/path/.cf-account WORKER_URL=... node scripts/build-shots.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { DEMO_SHOTS } from '../src/demo.js';

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
if (!WORKER) throw new Error('WORKER_URL が無い。デプロイ済みの Worker の URL を渡す');

// Browser Run は応答をキャッシュする。query を足すと上流のキャッシュにも別々に載って
// しまうので、fragment で外す (サーバには送られないが、キャッシュキーには効く)
const bust = () => `#cb=${Date.now()}`;

// URL は percent-encode して渡す。生の日本語を含む URL を渡すと Chromium は
// 422 (`The target closed.`) で落ちる。Kitesurf は生のままでも 200 を返す
const encoded = (u) => new URL(u).href;

/** Browser Run の Quick Action を 1 回叩く */
async function browserRun(browser, url, width, height) {
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/browser-run/screenshot`
    + (browser === 'kitesurf' ? '?browser=kitesurf' : '');
  const t0 = Date.now();
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: encoded(url) + bust(),
      viewport: { width, height },
      screenshotOptions: { fullPage: false },
    }),
    signal: AbortSignal.timeout(180000),
  });
  const buf = Buffer.from(await res.arrayBuffer());
  if (!res.ok || buf.length < 1000) {
    throw new Error(`${browser} が失敗した (${res.status}): ${buf.toString('utf8').slice(0, 300)}`);
  }
  const billed = res.headers.get('x-browser-ms-used');
  return { buf, ms: Date.now() - t0, billedMs: billed == null ? null : Math.round(Number(billed)) };
}

/** 自作の Worker で 1 枚撮る */
async function mine(url, width, height) {
  const q = new URLSearchParams({ demo: '1', w: String(width), h: String(height), url });
  const t0 = Date.now();
  const res = await fetch(`${WORKER}/shot?${q}`, { signal: AbortSignal.timeout(180000) });
  const buf = Buffer.from(await res.arrayBuffer());
  if (!res.ok) throw new Error(`mine が失敗した (${res.status}): ${buf.toString('utf8').slice(0, 300)}`);
  let timing = null;
  try { timing = JSON.parse(res.headers.get('x-timing') ?? 'null'); } catch { /* 無くてもよい */ }
  return { buf, ms: Date.now() - t0, timing };
}

const slugOf = (url) => new URL(url).hostname.replace(/^www\./, '').replace(/\./g, '-');

mkdirSync(new URL('../public/shots/', import.meta.url), { recursive: true });
const out = { capturedAt: new Date().toISOString(), shots: [] };

for (const [url, w, h, title, note] of DEMO_SHOTS) {
  const slug = slugOf(url);
  console.log(`\n${slug}  ${url}  ${w}x${h}`);
  const engines = {};
  // 3 つを並列で撮る。同じ時刻のページを見せたいので順番に撮らない
  const [chromium, kitesurf, ours] = await Promise.all([
    browserRun('chromium', url, w, h),
    browserRun('kitesurf', url, w, h),
    mine(url, w, h),
  ]);
  for (const [name, r] of [['chromium', chromium], ['kitesurf', kitesurf], ['mine', ours]]) {
    const file = `/shots/${slug}.${name}.png`;
    writeFileSync(new URL(`../public${file}`, import.meta.url), r.buf);
    engines[name] = { file, kb: Math.round(r.buf.length / 1024), ms: r.ms, billedMs: r.billedMs ?? null, timing: r.timing ?? null };
    console.log(`  ${name.padEnd(9)} ${(r.buf.length / 1024).toFixed(0).padStart(5)} KB  ${r.ms} ms`
      + (r.billedMs != null ? `  課金 ${r.billedMs} ms` : '')
      + (r.timing ? `  ${r.timing.passes} パス / CSS ${r.timing.css.fetched} / 画像 ${r.timing.img.fetched}` : ''));
  }
  out.shots.push({ slug, url, w, h, title, note, engines });
}

// JSON ではなく JS のモジュールとして書く。Node は JSON の import に
// `with { type: 'json' }` を要求するので、ビルド用のスクリプトから読めなくなる
writeFileSync(
  new URL('../src/shots.js', import.meta.url),
  '// scripts/build-shots.mjs が生成する。手で編集しない\n'
  + `export default ${JSON.stringify(out, null, 2)};\n`,
);
console.log(`\n${out.shots.length} ページ × 3 枚を public/shots/ に置いた (撮影 ${out.capturedAt})`);
