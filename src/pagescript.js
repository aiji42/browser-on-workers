// ページの JavaScript を V8 で実行する経路 (PageScript)。
//
// # なぜ動的 Worker なのか
//
// Workers は文字列からコードを作れない (`eval` も `new Function` も
// `EvalError: Code generation from strings disallowed for this context`)。
// だから普通は JS エンジンを Wasm で持ち込むことになる。Kitesurf の Boa がそれ。
//
// ところが **動的 Worker (`worker_loaders` binding) のモジュールとして渡せば、
// V8 が普通にコンパイルする。** ページの `<script>` をモジュールにして渡せば、
// V8 の速度と V8 の意味論で実行できる (Boa は同じループで約 200 倍遅い)。
//
// # なぜグローバルスコープで走らせるのか
//
// 実測すると、`eval` が使える場所と I/O が使える場所が排他だった。
//
//   グローバルスコープ … eval / new Function は通る。setTimeout・fetch・
//                        crypto.getRandomValues は「Disallowed operation」。
//                        Date.now() は 0 を返す
//   handler の中       … setTimeout・fetch は通る。eval は EvalError
//
// ブラウザは資源の取得とタイマーを必要とするので、普通は handler で走らせる
// ことになり、そこでは eval が使えない。**だが一発のスクリーンショットなら、
// 資源は先に取ってから渡せる。** タイマーも「積んで後で流す」で足りる。
// そうするとグローバルスコープで完結し、**eval が使える。**
//
// だからここでは Wasm の初期化からページのスクリプトの実行、描画までを
// すべてモジュールの評価中に済ませる。入力は I/O ではなくモジュールで渡す
// (HTML は text モジュール、フォントと資源は data モジュール)。

const COMPAT = '2026-09-01';

/** ページの `<script>` を切り出す。外部スクリプトは資源の表から中身を引く */
export function extractScripts(html, resourceText) {
  const scripts = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let stripped = '';
  let last = 0;
  for (const m of html.matchAll(re)) {
    const attrs = m[1] ?? '';
    // JSON のデータブロックなどは実行しない
    const type = (/\btype\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs)?.slice(2).find(Boolean) ?? '')
      .trim().toLowerCase();
    const isJs = type === '' || type === 'text/javascript'
      || type === 'application/javascript' || type === 'module';
    if (!isJs) continue;
    const src = /\bsrc\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs)?.slice(2).find(Boolean);
    let code = null;
    if (src) {
      const text = resourceText(src);
      if (text != null) code = text;
    } else {
      code = m[2];
    }
    if (code != null && code.trim()) scripts.push({ code, src: src ?? null, module: type === 'module' });
    // engine 側で二重に実行させないよう、実行したものは HTML から外す
    stripped += html.slice(last, m.index);
    last = m.index + m[0].length;
  }
  stripped += html.slice(last);
  return { scripts, stripped };
}

/** グローバルスコープで足りないものを埋める shim。ページのスクリプトより先に走る */
const SHIM = `
// タイマーはグローバルスコープでは使えない (Disallowed operation) ので、
// 積んで後でまとめて流す。一発の描画なので、待つ意味が無い
const __timers = [];
let __seq = 0;
globalThis.setTimeout = (fn, ms) => {
  if (typeof fn === 'function') __timers.push({ fn, at: Number(ms) || 0, seq: __seq++ });
  return __seq;
};
globalThis.setInterval = globalThis.setTimeout;   // 1 回だけ流す
globalThis.clearTimeout = () => {};
globalThis.clearInterval = () => {};
globalThis.requestAnimationFrame = (fn) => globalThis.setTimeout(fn, 16);
globalThis.cancelAnimationFrame = () => {};
globalThis.requestIdleCallback = (fn) => globalThis.setTimeout(fn, 1);

/** 積んだタイマーを予定時刻の順に流す。上限つき */
globalThis.__drainTimers = (limit) => {
  let ran = 0;
  const errors = [];
  while (__timers.length && ran < limit) {
    __timers.sort((a, b) => (a.at - b.at) || (a.seq - b.seq));
    const t = __timers.shift();
    ran++;
    try { t.fn(); } catch (e) { errors.push(String(e && e.message)); }
  }
  return { ran, left: __timers.length, errors };
};

// 乱数はグローバルスコープでは crypto が使えない。Math.random は使える
if (!globalThis.crypto) globalThis.crypto = {};
if (typeof globalThis.crypto.getRandomValues !== 'function') {
  globalThis.crypto.getRandomValues = (arr) => {
    for (let i = 0; i < arr.length; i++) arr[i] = Math.floor(Math.random() * 256);
    return arr;
  };
}
if (typeof globalThis.crypto.randomUUID !== 'function') {
  globalThis.crypto.randomUUID = () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : ((r & 0x3) | 0x8)).toString(16);
  });
}

// ページからの取得は無い。資源は先に取ってから渡してある
globalThis.fetch = () => Promise.reject(new TypeError('fetch is not available in this renderer'));
globalThis.XMLHttpRequest = function () { throw new TypeError('XMLHttpRequest is not available'); };

// ページのスクリプトが投げた例外を集める
globalThis.__pageErrors = [];
globalThis.addEventListener = globalThis.addEventListener ?? (() => {});
`;

/**
 * 動的 Worker の中でページを描く。
 *
 * @param env       LOADER binding を持つ env
 * @param request   ASSETS を引くための request (URL が必要)
 * @param page      { html, baseUrl, width, height, resources, fonts, timerLimit }
 *                  resources は [{ url, bytes }]、fonts は [{ family, bytes }]
 */
export async function renderInV8(env, request, page) {
  const { html, baseUrl, width, height, resources = [], fonts = [], timerLimit = 64 } = page;

  const decoder = new TextDecoder();
  const byUrl = new Map(resources.map((r) => [r.url, r]));
  const resourceText = (src) => {
    // 相対 URL は base で解いてから引く
    let abs = src;
    try { abs = new URL(src, baseUrl).href; } catch { /* そのまま引く */ }
    const hit = byUrl.get(abs) ?? byUrl.get(src);
    return hit ? decoder.decode(hit.bytes) : null;
  };

  const { scripts, stripped } = extractScripts(html, resourceText);

  // モジュールを組む。入力は I/O では渡せないので全部モジュールにする
  const modules = {
    'glue.js': await assetText(env, request, '/glue.js'),
    'engine.wasm': { wasm: (await import('../crate/pkg/kitesurf_clone_bg.wasm')).default },
    'shim.js': SHIM,
    'page.html': { text: stripped },
  };
  fonts.forEach((f, i) => { modules[`font${i}.ttf`] = { data: f.bytes.buffer ?? f.bytes }; });
  resources.forEach((r, i) => { modules[`res${i}.bin`] = { data: r.bytes.buffer ?? r.bytes }; });
  scripts.forEach((s, i) => { modules[`page${i}.js`] = s.code; });

  // entry。静的 import の順に評価されるので、shim -> 準備 -> ページ -> 仕上げ の順に並べる
  const imports = [
    // dom_* はまだ engine 側に無い。繋がったら差し替える
    "import initWasm, { add_font, add_resource, clear_resources, render_png_rgba_no_js } from './glue.js';",
    "import wasm from './engine.wasm';",
    "import html from './page.html';",
    "import './shim.js';",
    ...fonts.map((_, i) => `import font${i} from './font${i}.ttf';`),
    ...resources.map((_, i) => `import res${i} from './res${i}.bin';`),
  ].join('\n');

  const setup = `
await initWasm(wasm);
${fonts.map((f, i) => `add_font(new Uint8Array(font${i}), ${JSON.stringify(f.family)});`).join('\n')}
clear_resources();
${resources.map((r, i) => `add_resource(${JSON.stringify(r.url)}, new Uint8Array(res${i}));`).join('\n')}
const __report = { engine: 'V8', scripts: ${scripts.length}, errors: [], timers: null };
// eval が使えることをその場で確かめて記録する
try { __report.evalWorks = eval('1+1') === 2; } catch (e) { __report.evalWorks = e.name; }
`;

  // ページのスクリプトは 1 本ずつ import する。1 本が投げても次を止めない、
  // ということは静的 import ではできないので、失敗しても壊れないよう
  // それぞれのモジュールの中で包む
  const pageImports = scripts.map((_, i) => `import './page${i}.js';`).join('\n');

  const finish = `
__report.timers = globalThis.__drainTimers(${timerLimit});
__report.errors = globalThis.__pageErrors.slice(0, 8);
// 切り分け用。ページが globalThis.__result に置いた値を持ち帰る
if (globalThis.__result !== undefined) {
  try { __report.pageResult = JSON.parse(JSON.stringify(globalThis.__result)); } catch (e) { /* 持ち帰れないものは捨てる */ }
}
const __rgba = render_png_rgba_no_js(html, ${JSON.stringify(baseUrl)}, ${width}, ${height});
`;

  const entry = `${imports}\n${setup}\n${pageImports}\n${finish}
export default {
  async fetch(request) {
    if (new URL(request.url).pathname === '/report') return Response.json(__report);
    return new Response(__rgba, { headers: { 'content-type': 'application/octet-stream' } });
  },
};
`;

  modules['entry.js'] = entry;

  // 同じページなら同じ Worker を使い回す。中身で id を決める
  const id = page.id ?? `page:${width}x${height}:${hash(stripped)}:${scripts.map((s) => hash(s.code)).join('.')}`;
  const stub = env.LOADER.get(id, async () => ({
    compatibilityDate: COMPAT,
    mainModule: 'entry.js',
    modules,
    // ページのコードにネットワークを持たせない (資源は先に取って渡してある)
    globalOutbound: null,
  }));

  const ep = stub.getEntrypoint();
  const [rgbaRes, reportRes] = await Promise.all([
    ep.fetch('https://page.invalid/'),
    ep.fetch('https://page.invalid/report'),
  ]);
  if (!rgbaRes.ok) throw new Error(`PageScript が失敗した (${rgbaRes.status})`);
  return {
    rgba: new Uint8Array(await rgbaRes.arrayBuffer()),
    report: await reportRes.json(),
  };
}

async function assetText(env, request, path) {
  const res = await env.ASSETS.fetch(new URL(path, request.url));
  if (!res.ok) throw new Error(`${path} が読めない (${res.status})`);
  return res.text();
}

/** id を作るための軽いハッシュ。衝突しても別のページになるだけ */
function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}
