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

import DOM_SHIM from './pagescript/dom.shim.js';
import { POLYFILL } from './polyfill.js';

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
    // defer と module は「解釈が終わってから」なので、後ろに回す。
    // async は仕様上いつ走ってもよいので、文書順のまま扱う
    const defer = type === 'module' || /\bdefer\b/i.test(attrs);
    if (code != null && code.trim()) {
      scripts.push({ code, src: src ?? null, module: type === 'module', defer, order: scripts.length });
    }
    // engine 側で二重に実行させないよう type を潰す。**要素は消さない。**
    //
    // 消すと `document.getElementsByTagName('script')[0]` が undefined になる。
    // Google Analytics の定番のスニペットはそれを踏んで、最初の script の
    // 隣に自分を挿そうとして落ちる。ブラウザでは実行後も要素は DOM に残る
    stripped += html.slice(last, m.index);
    stripped += `<script type="application/x-already-run"${attrs.replace(/\btype\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/i, '')}>`;
    stripped += m[2] ?? '';
    stripped += '</script>';
    last = m.index + m[0].length;
  }
  stripped += html.slice(last);
  // defer は後ろへ。それぞれの中では文書順を保つ
  scripts.sort((a, b) => (a.defer - b.defer) || (a.order - b.order));
  return { scripts, stripped };
}

/** グローバルスコープで足りないものを埋める shim。ページのスクリプトより先に走る */
const shim = (baseUrl) => `
// location。無いと React Router 系の入口が最初の行で落ちる。
// Workers の URL をそのまま渡す。書き換えは受け取るだけで何もしない
{
  const u = new URL(${JSON.stringify(baseUrl)});
  const loc = {
    href: u.href, protocol: u.protocol, host: u.host, hostname: u.hostname,
    port: u.port, pathname: u.pathname, search: u.search, hash: u.hash,
    origin: u.origin,
    assign() {}, replace() {}, reload() {},
    toString() { return u.href; },
  };
  globalThis.location = loc;
  // history。pushState は状態だけ持つ。絵は 1 枚なので遷移しない
  globalThis.history = {
    length: 1, scrollRestoration: 'auto', state: null,
    pushState(st) { this.state = st; }, replaceState(st) { this.state = st; },
    back() {}, forward() {}, go() {},
  };
}

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
// workerd は setImmediate を持っている。React のスケジューラは MessageChannel
// より先にこれを見るので、これも塞いでキューに寄せないと仕事が消える
globalThis.setImmediate = (fn, ...args) => globalThis.setTimeout(() => fn(...args), 0);
globalThis.clearImmediate = () => {};

/** 積んだタイマーを予定時刻の順に流す。上限つき */
globalThis.__drainTimers = (limit) => {
  let ran = 0;
  const errors = [];
  while (__timers.length && ran < limit) {
    __timers.sort((a, b) => (a.at - b.at) || (a.seq - b.seq));
    const t = __timers.shift();
    ran++;
    try {
      t.fn();
    } catch (e) {
      const at = String((e && e.stack) || '').split('\\n').slice(1, 3).map((l) => l.trim()).join(' | ');
      errors.push(String(e && e.message) + (at ? ' @ ' + at : ''));
    }
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

// window のイベント。1 枚の絵なので、load と DOMContentLoaded だけ後で流す
globalThis.__windowListeners = new Map();
globalThis.addEventListener = (type, fn) => {
  if (typeof fn !== 'function') return;
  const list = globalThis.__windowListeners.get(type) ?? [];
  list.push(fn);
  globalThis.__windowListeners.set(type, list);
};
globalThis.removeEventListener = () => {};
globalThis.dispatchEvent = (ev) => {
  for (const fn of globalThis.__windowListeners.get(ev && ev.type) ?? []) {
    try { fn.call(globalThis, ev); } catch (e) { globalThis.__pageErrors.push(String(e && e.message)); }
  }
  return true;
};
globalThis.window = globalThis;
globalThis.self = globalThis;

// MessageChannel を自前のキューに寄せる。
//
// React 18 のスケジューラは、作業をマクロタスクに逃がすのに MessageChannel を
// 使う (無ければ setTimeout)。モジュールの評価中はイベントループが回らないので、
// 本物の MessageChannel に渡した仕事は **永遠に走らない**。
// キューに積み替えれば finish.js で流せる
globalThis.MessageChannel = function MessageChannel() {
  const mk = () => ({ onmessage: null, start() {}, close() {},
    addEventListener(t, fn) { if (t === 'message') this.onmessage = fn; },
    removeEventListener() {} });
  const port1 = mk();
  const port2 = mk();
  const send = (to, data) => globalThis.setTimeout(() => {
    if (typeof to.onmessage === 'function') to.onmessage({ data, target: to });
  }, 0);
  port1.postMessage = (data) => send(port2, data);
  port2.postMessage = (data) => send(port1, data);
  return { port1, port2 };
};
globalThis.queueMicrotask = globalThis.queueMicrotask
  || ((fn) => Promise.resolve().then(fn));
`;

// 静的な import / export ... from の指定子を拾う。
//
// 束ねられたコードは `import{a}from"./x.js"` のように空白が無いので、
// `from` の前に空白を要求すると取りこぼす。取りこぼしは危険で、
// **書き換え漏れが 1 本あるだけで動的 Worker がまるごと起動しない。**
// だから緩く拾って、あとで漏れが無いか検証する。
//
// `import("x")` は括弧なのでどちらにも当たらない (実行時の失敗で済むので対象外)
const SPEC_RES = [
  /\bfrom\s*("([^"\n]*)"|'([^'\n]*)')/g,
  /\bimport\s*("([^"\n]*)"|'([^'\n]*)')/g,
];

/**
 * `<script type="module">` を本物の ES モジュールとして渡すための下準備。
 *
 * 動的 Worker のモジュールは V8 がそのままコンパイルするので、module スクリプトは
 * eval に流すのではなく **モジュールとして置いたほうが本物に近い** (間接 eval に
 * 流すと `export` の行で SyntaxError になる)。
 *
 * ただし指定子が 1 本でも解決できないと **Worker 自体が起動しない**。
 * 絵が 1 枚も出なくなるくらいなら、そのスクリプトだけ諦めたほうがいい。
 * だから先に import の網を全部たどって、揃っているときだけ昇格させる。
 *
 * @returns { ok, files }  ok が false なら昇格させない
 */
function moduleGraph(entryUrl, entryCode, resolveBytes) {
  const files = new Map();       // モジュール名 -> 中身
  const nameOf = (u) => `m${hash(u)}.js`;
  const seen = new Set();
  let ok = true;

  const walk = (url, code) => {
    const name = nameOf(url);
    if (seen.has(name)) return name;
    seen.add(name);
    // 指定子を、こちらが置くモジュール名に書き換える
    let rewritten = code;
    for (const re of SPEC_RES) {
      rewritten = rewritten.replace(re, (m, q, dq, sq) => {
        const spec = dq ?? sq;
        if (spec.startsWith('./m') && spec.endsWith('.js') && files.has(spec.slice(2))) return m;
        let abs;
        try { abs = new URL(spec, url).href; } catch { ok = false; return m; }
        const text = resolveBytes(abs);
        if (text == null) { ok = false; return m; }
        return m.replace(q, JSON.stringify(`./${walk(abs, text)}`));
      });
    }
    // 書き換え漏れの検証。こちらが置いた名前以外が残っていたら昇格させない
    for (const re of SPEC_RES) {
      for (const m of rewritten.matchAll(re)) {
        const spec = m[2] ?? m[3];
        if (!(spec.startsWith('./m') && spec.endsWith('.js'))) ok = false;
      }
    }
    files.set(name, rewritten);
    return name;
  };

  const entry = walk(entryUrl, entryCode);
  return { ok, entry, files };
}

/**
 * 動的 Worker の中でページを描く。
 *
 * @param env       LOADER binding を持つ env
 * @param request   ASSETS を引くための request (URL が必要)
 * @param page      { html, baseUrl, width, height, resources, fonts, timerLimit }
 *                  resources は [{ url, bytes }]、fonts は [{ family, bytes }]
 */
export async function renderInV8(env, request, page) {
  const {
    html, baseUrl, width, height, resources = [], fonts = [], timerLimit = 64,
    // module スクリプトの昇格を切る。1 本でも評価中に投げると Worker が
    // まるごと起動しないので、失敗したら切って描き直す
    noModules = false,
  } = page;

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
    'shim.js': shim(baseUrl),
    'webapi.js': `${POLYFILL}\n`,
    'dom.js': DOM_SHIM,
    'page.html': { text: stripped },
  };
  fonts.forEach((f, i) => { modules[`font${i}.ttf`] = { data: f.bytes.buffer ?? f.bytes }; });
  resources.forEach((r, i) => { modules[`res${i}.bin`] = { data: r.bytes.buffer ?? r.bytes }; });

  // ページのスクリプトは **モジュールにしない**。
  //
  // ブラウザの classic script はグローバルスコープで走るので、`var x` や
  // `function f()` が window に乗り、あとのスクリプトから見える。モジュールに
  // すると各自が別スコープになって、これが壊れる。
  //
  // グローバルスコープでは `eval` が使えるので、**間接 eval で走らせれば
  // 本物と同じスコープになる。** 文字列は JSON で安全に運ぶ
  // module スクリプトは本物のモジュールとして置く。網が揃わないものは eval に落とす
  const promoted = [];
  const fellBack = [];
  for (const sc of scripts) {
    if (!sc.module || noModules) continue;
    const at = sc.src ? (new URL(sc.src, baseUrl)).href : `${baseUrl}#inline${promoted.length}`;
    const g = moduleGraph(at, sc.code, resourceText);
    if (!g.ok) { fellBack.push(sc); continue; }
    for (const [name, code] of g.files) modules[name] = code;
    promoted.push({ sc, entry: g.entry, files: g.files.size });
  }
  const promotedSet = new Set(promoted.map((p2) => p2.sc));
  const classic = scripts.filter((s2) => !promotedSet.has(s2));

  modules['sources.js'] = `export default ${JSON.stringify(classic.map((s2) => s2.code))};`;

  // 静的 import は「取り込む側の本体」より先に評価される。
  // だから setup を別のモジュールに置いて、いちばん先に import する。
  // 順番は setup -> ページのスクリプト -> finish になる
  const glueImports = "import * as glue from './glue.js';";
  const fontImports = fonts.map((_, i) => `import font${i} from './font${i}.ttf';`).join('\n');
  const resImports = resources.map((_, i) => `import res${i} from './res${i}.bin';`).join('\n');

  modules['setup.js'] = `
${glueImports}
import wasm from './engine.wasm';
import html from './page.html';
import SOURCES from './sources.js';
import './shim.js';
import './webapi.js';
import './dom.js';
${fontImports}
${resImports}

// ここはモジュールの評価中。I/O とタイマーは使えないが、
// instantiate と eval は使える。
//
// **top-level await を使わない。** 使うとこのモジュールが async 扱いになり、
// これを import している側の兄弟モジュールが「setup が終わる前に」評価されうる。
// wasm-bindgen は initSync を出しているので、15 MB でも同期で instantiate できる
glue.initSync({ module: wasm });

${fonts.map((f, i) => `glue.add_font(new Uint8Array(font${i}), ${JSON.stringify(f.family)});`).join('\n')}
glue.clear_resources();
${resources.map((r, i) => `glue.add_resource(${JSON.stringify(r.url)}, new Uint8Array(res${i}));`).join('\n')}

const report = { engine: 'V8', scripts: ${scripts.length}, classic: ${classic.length},
  modules: ${promoted.length}, moduleFiles: ${promoted.reduce((n, p2) => n + p2.files, 0)},
  moduleFellBack: ${fellBack.length},
  errors: [], stacks: [], timers: null, dom: null };
try { report.evalWorks = eval('1+1') === 2; } catch (e) { report.evalWorks = e.name; }

// DOM を開いて JS の顔を付ける。dom_* が無い engine ではここで落ちるので、
// 落ちても描けるように記録だけして進む
let docHandle = 0;
try {
  docHandle = glue.dom_open(html, ${JSON.stringify(baseUrl)}, ${width}, ${height});
  if (!docHandle) throw new Error('dom_open が 0 を返した');
  globalThis.installDom(glue, docHandle);
  report.dom = 'ok';
} catch (e) {
  report.dom = String(e && e.message).slice(0, 160);
}

export const engine = { glue, html, docHandle, report,
  baseUrl: ${JSON.stringify(baseUrl)}, width: ${width}, height: ${height} };

// ページのスクリプトを文書順に走らせる。
// 間接 eval なのでグローバルスコープで評価され、var と function が window に乗る。
// 1 本が投げても次を止めない (ブラウザと同じ)
report.ran = 0;
for (const src of SOURCES) {
  try {
    (0, eval)(src);
    report.ran++;
  } catch (e) {
    // V8 なので本物の stack が付く (Boa に流したコードは Error.stack を持たない)
    const at = String((e && e.stack) || '').split('\\n').slice(1, 4).map((l) => l.trim()).join(' | ');
    report.errors.push(String((e && e.name) + ': ' + (e && e.message)).slice(0, 200));
    if (at) report.stacks.push(at.slice(0, 400));
  }
}
`;

  // `<script type="module">` は defer 相当なので、classic のあとに文書順で走らせる。
  // setup を最初に import しているので、DOM が立ってから評価される
  modules['pagemods.js'] = `
import './setup.js';
${promoted.map((p2) => `import './${p2.entry}';`).join('\n')}
export const count = ${promoted.length};
`;

  modules['finish.js'] = `
// import の順がそのまま評価の順になる (setup も pagemods も同期なので)。
// setup 側が top-level await を持っていた頃は、この順が保証されずに
// finish が先に評価されて落ちていた
import { engine as E } from './setup.js';
import './pagemods.js';

// DOMContentLoaded と load を流す
if (E.report.dom === 'ok') {
  try { globalThis.__domReady(); } catch (e) { E.report.errors.push(String(e && e.message)); }
}

// 積んだタイマーを流す。
//
// 1 回流して終わりにはできない。React は「タイマーで起きて、少し進めて、
// また積む」を繰り返すので、積み直された分も流す必要がある。
// あいだに await を挟んで microtask を吐かせる (await は I/O ではないので
// グローバルスコープでも使える)
{
  const total = { ran: 0, left: 0, errors: [], rounds: 0 };
  for (let round = 0; round < 12; round++) {
    for (let i = 0; i < 4; i++) await Promise.resolve();
    const r = globalThis.__drainTimers(${timerLimit});
    total.ran += r.ran;
    total.left = r.left;
    total.errors.push(...r.errors);
    total.rounds = round + 1;
    if (!r.ran && !r.left) break;
  }
  total.errors = total.errors.slice(0, 8);
  E.report.timers = total;
}
E.report.errors.push(...globalThis.__pageErrors.slice(0, 8));
if (globalThis.__result !== undefined) {
  try { E.report.pageResult = JSON.parse(JSON.stringify(globalThis.__result)); } catch (e) { /* 持ち帰れないものは捨てる */ }
}

// 描く直前の DOM を少しだけ持ち帰る。JS が本当に書き換えたのかを外から見るため
if (E.report.dom === 'ok') {
  try {
    const b = globalThis.document.body;
    E.report.bodyChildren = b ? b.childNodes.length : -1;
    E.report.bodyHtml = b ? String(b.innerHTML).replace(/\\s+/g, ' ').slice(0, 300) : null;
  } catch (e) { E.report.bodyHtml = 'err: ' + String(e && e.message).slice(0, 120); }
}

// 描く。DOM が繋がっていれば JS の変更が入った DOM を描き、
// 繋がっていなければ HTML から描き直す (JS の効果は入らない)
let rgba;
if (E.report.dom === 'ok') {
  E.glue.dom_settle(E.docHandle);
  rgba = E.glue.dom_paint(E.docHandle);
  E.glue.dom_close(E.docHandle);
} else {
  rgba = E.glue.render_png_rgba_no_js(E.html, E.baseUrl, E.width, E.height);
}
export const result = { rgba, report: E.report };
`;

  const entry = `
import { result } from './finish.js';

export default {
  async fetch(request) {
    if (new URL(request.url).pathname === '/report') return Response.json(result.report);
    return new Response(result.rgba, { headers: { 'content-type': 'application/octet-stream' } });
  },
};
`;

  modules['entry.js'] = entry;

  // 同じページなら同じ Worker を使い回す。中身で id を決める
  const id = `${page.id ?? `page:${width}x${height}:${hash(stripped)}:${scripts.map((s) => hash(s.code)).join('.')}`}${noModules ? ':nomod' : ''}`;
  const stub = env.LOADER.get(id, async () => ({
    compatibilityDate: COMPAT,
    mainModule: 'entry.js',
    modules,
    // ページのコードにネットワークを持たせない (資源は先に取って渡してある)
    globalOutbound: null,
  }));

  const ep = stub.getEntrypoint();
  let rgbaRes;
  let reportRes;
  try {
    [rgbaRes, reportRes] = await Promise.all([
      ep.fetch('https://page.invalid/'),
      ep.fetch('https://page.invalid/report'),
    ]);
    if (!rgbaRes.ok) throw new Error(`PageScript が失敗した (${rgbaRes.status})`);
  } catch (e) {
    // モジュールの解決や評価で落ちると、絵が 1 枚も出ない。
    // その 1 本を諦めて eval に落としたほうが、白紙よりましな絵になる
    if (promoted.length && !noModules) {
      const out = await renderInV8(env, request, { ...page, noModules: true });
      out.report.moduleLoadFailed = String(e && e.message).slice(0, 200);
      return out;
    }
    throw e;
  }
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
