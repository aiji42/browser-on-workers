// ページの JavaScript を V8 で動かす試み。
//
// Workers は `eval` と `new Function` を禁じているので、文字列からコードは作れない。
// ただし **動的 Worker のモジュールとして渡せば V8 が普通にコンパイルする。**
// Kitesurf の PageScript はこの形 (「Dynamic Workers を使ってページごとの
// isolate を立ち上げ、clean な globalThis と DOM document object を用意する」)。
//
// ここではまず「本当に V8 で動くのか」だけを確かめる。DOM はまだ渡していない。

const COMPAT = '2026-09-01';

/**
 * ページのスクリプトを動的 Worker の中で走らせて、結果を JSON で受け取る。
 *
 * @param env      LOADER binding を持つ env
 * @param id       Worker のキー。同じ id なら同じ Worker が使い回される
 * @param source   ページの `<script>` の中身
 */
export async function runInV8(env, id, source) {
  // 走らせる本体。ページのコードを別モジュールに置いて import する。
  // こうするとページのコードは module の top-level として V8 に渡る
  const entry = `
import { result } from './page.js';

export default {
  async fetch() {
    return Response.json(result);
  },
};
`;

  // ページのコードは、値を返せるように result という名前で出す。
  // engine を名乗るための小さな道具も先に置いておく
  const page = `
const __probe = {};
export const result = (() => {
  const t0 = Date.now();
  let value, error = null;
  try {
    value = (() => { ${source} })();
  } catch (e) {
    error = { name: e && e.name, message: String(e && e.message) };
  }
  return {
    value, error,
    ms: Date.now() - t0,
    // このコードを実行したエンジンを見分けるための材料
    engine: {
      hasCaptureStackTrace: typeof Error.captureStackTrace,
      hasStack: typeof new Error('x').stack,
      typedArray: typeof globalThis.TypedArray,
      globals: Object.getOwnPropertyNames(globalThis).length,
      nullError: (() => { try { null.x; } catch (e) { return e.message; } })(),
      callError: (() => { try { (1)(); } catch (e) { return e.message; } })(),
      evalError: (() => { try { return String(eval('1+1')); } catch (e) { return e.name + ': ' + e.message; } })(),
    },
  };
})();
`;

  const stub = env.LOADER.get(id, async () => ({
    compatibilityDate: COMPAT,
    mainModule: 'entry.js',
    modules: { 'entry.js': entry, 'page.js': page },
    // 外に出る口は渡さない。ページのコードにネットワークを持たせない
    globalOutbound: null,
  }));

  const res = await stub.getEntrypoint().fetch('https://page.invalid/');
  return res.json();
}

/**
 * engine (Wasm) を動的 Worker に持ち込めるかを確かめる。
 *
 * 渡し方を 2 通り試す:
 *   compiled … 本体の Worker が持っている WebAssembly.Module をそのまま渡す
 *   bytes    … Static Assets から 15 MB を読んで ArrayBuffer で渡す
 *
 * compiled が通るなら、ページごとに Wasm を再コンパイルしなくて済む
 */
export async function probeWasmInV8(env, request, how, id) {
  const entry = `
import wasm from './engine.wasm';

export default {
  async fetch() {
    return Response.json({
      typeofModule: typeof wasm,
      isModule: wasm instanceof WebAssembly.Module,
      exportCount: wasm instanceof WebAssembly.Module
        ? WebAssembly.Module.exports(wasm).length
        : null,
      canEval: (() => { try { return String(eval('1+1')); } catch (e) { return e.name; } })(),
    });
  },
};
`;

  let wasmValue;
  if (how === 'compiled') {
    // 本体の Worker が CompiledWasm として持っているもの。
    // これがそのまま渡せるなら再コンパイルが要らない
    const mod = (await import('../crate/pkg/kitesurf_clone_bg.wasm')).default;
    wasmValue = mod;
  } else {
    const res = await env.ASSETS.fetch(new URL('/engine.wasm', request.url));
    if (!res.ok) throw new Error(`engine.wasm が読めない (${res.status})`);
    wasmValue = await res.arrayBuffer();
  }

  const stub = env.LOADER.get(id, async () => ({
    compatibilityDate: COMPAT,
    mainModule: 'entry.js',
    modules: { 'entry.js': entry, 'engine.wasm': { wasm: wasmValue } },
    globalOutbound: null,
  }));
  const res = await stub.getEntrypoint().fetch('https://page.invalid/');
  return res.json();
}

/**
 * `eval` が通る場所を特定する。
 *
 * Workers の「Code generation from strings disallowed for this context」は
 * context 依存で、モジュールの評価中 (起動時) とリクエストの処理中で
 * 挙動が違うのではないか、という仮説を確かめる。
 *
 * ページのスクリプトを module の top-level として走らせられるなら、
 * その中の `eval` は通ることになる
 */
export async function probeEvalContext(env, id) {
  const entry = `
// (1) モジュールの評価中に呼ぶ
export const atModuleTop = (() => {
  try { return 'ok: ' + eval('1+1'); } catch (e) { return e.name + ': ' + e.message; }
})();

export const newFunctionAtTop = (() => {
  try { return 'ok: ' + new Function('return 3+4')(); } catch (e) { return e.name + ': ' + e.message; }
})();

export default {
  async fetch() {
    // (2) リクエストの処理中に呼ぶ
    let inHandler, newFunctionInHandler, inTimer;
    try { inHandler = 'ok: ' + eval('1+1'); } catch (e) { inHandler = e.name + ': ' + e.message; }
    try { newFunctionInHandler = 'ok: ' + new Function('return 3+4')(); } catch (e) { newFunctionInHandler = e.name + ': ' + e.message; }
    // (3) タイマーの中で呼ぶ (ページの setTimeout に相当)
    inTimer = await new Promise((resolve) => {
      setTimeout(() => {
        try { resolve('ok: ' + eval('1+1')); } catch (e) { resolve(e.name + ': ' + e.message); }
      }, 1);
    });
    return Response.json({ atModuleTop, newFunctionAtTop, inHandler, newFunctionInHandler, inTimer });
  },
};
`;
  const stub = env.LOADER.get(id, async () => ({
    compatibilityDate: COMPAT,
    mainModule: 'entry.js',
    modules: { 'entry.js': entry },
    globalOutbound: null,
  }));
  const res = await stub.getEntrypoint().fetch('https://page.invalid/');
  return res.json();
}

/**
 * モジュールの評価中に `await` を挟んでも `eval` が通るかを確かめる。
 *
 * これが通るなら、スクリーンショットのような一発勝負の用途では
 * **Boa が要らない**。資源の取得 (fetch) を top-level await で挟みながら
 * ページのスクリプトを走らせて、最後に描いて返せばよい。
 */
export async function probeTopLevelAwait(env, id) {
  const entry = `
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tryEval = (label) => {
  try { return label + ': ok ' + eval('1+1'); } catch (e) { return label + ': ' + e.name; }
};

// 1. 同期の top-level
const sync = tryEval('sync');

// 2. マイクロタスクのあと (Promise.resolve().then)
let afterMicrotask;
await Promise.resolve().then(() => { afterMicrotask = tryEval('microtask'); });

// 3. setTimeout を top-level await で待ったあと
await sleep(1);
const afterTimer = tryEval('after-sleep');

// 4. その setTimeout の**中**
let insideTimer;
await new Promise((resolve) => setTimeout(() => { insideTimer = tryEval('inside-timer'); resolve(); }, 1));

// 5. fetch を挟んだあと (globalOutbound を渡していないので失敗するが、待つことはできる)
let afterFetch;
try { await fetch('https://example.com/'); } catch (e) { /* 失敗してよい */ }
afterFetch = tryEval('after-fetch');

export default {
  async fetch() {
    return Response.json({ sync, afterMicrotask, afterTimer, insideTimer, afterFetch,
      inHandler: tryEval('in-handler') });
  },
};
`;
  const stub = env.LOADER.get(id, async () => ({
    compatibilityDate: COMPAT,
    mainModule: 'entry.js',
    modules: { 'entry.js': entry },
    globalOutbound: null,
  }));
  const res = await stub.getEntrypoint().fetch('https://page.invalid/');
  return res.json();
}

/**
 * 「eval が使える場所」と「fetch / タイマーが使える場所」が排他かを確かめる。
 *
 * ここが排他なら、ブラウザは詰む。ページのスクリプトは資源の取得とタイマーを
 * 必要とするので handler で走らせるしかなく、handler では eval が使えない。
 * だから別の JS エンジンを持ち込むことになる
 */
export async function probeExclusivity(env, id) {
  const entry = `
const t = (label, fn) => { try { return [label, 'ok: ' + fn()]; } catch (e) { return [label, e.name + ': ' + String(e.message).slice(0, 90)]; } };

// グローバルスコープ (モジュールの評価中) で 1 つずつ試す
const inGlobal = Object.fromEntries([
  t('eval', () => eval('1+1')),
  t('new Function', () => new Function('return 1+1')()),
  t('setTimeout', () => { setTimeout(() => {}, 1); return 'armed'; }),
  t('fetch', () => { fetch('https://example.com/'); return 'called'; }),
  t('Math.random', () => Math.random()),
  t('crypto.getRandomValues', () => crypto.getRandomValues(new Uint8Array(4))[0]),
  t('Date.now', () => Date.now()),
]);

export default {
  async fetch() {
    // handler の中で同じことを 1 つずつ試す
    const inHandler = Object.fromEntries([
      t('eval', () => eval('1+1')),
      t('new Function', () => new Function('return 1+1')()),
      t('setTimeout', () => { setTimeout(() => {}, 1); return 'armed'; }),
      t('fetch', () => { fetch('https://example.com/').catch(() => {}); return 'called'; }),
      t('Math.random', () => Math.random()),
      t('crypto.getRandomValues', () => crypto.getRandomValues(new Uint8Array(4))[0]),
      t('Date.now', () => Date.now()),
    ]);
    return Response.json({ inGlobal, inHandler });
  },
};
`;
  const stub = env.LOADER.get(id, async () => ({
    compatibilityDate: COMPAT,
    mainModule: 'entry.js',
    modules: { 'entry.js': entry },
    globalOutbound: null,
  }));
  const res = await stub.getEntrypoint().fetch('https://page.invalid/');
  return res.json();
}
