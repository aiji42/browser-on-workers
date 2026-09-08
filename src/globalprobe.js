// グローバルスコープ (モジュールの評価中) で engine を立ち上げられるかを確かめる。
//
// ここが通るなら、ページのスクリプトも同じグローバルスコープで走らせられる。
// そうすると **eval が使える** (handler の中では使えない)。
// 通らないなら handler で走らせるしかなく、eval は Boa に回すことになる。
//
// グローバルスコープで禁止されているのは「非同期 I/O・タイマー・乱数」で、
// WebAssembly.instantiate はそのどれでもないはず、という読み

const COMPAT = '2026-09-01';

export async function probeGlobalInit(env, request, id) {
  const res = await env.ASSETS.fetch(new URL('/glue.js', request.url));
  if (!res.ok) throw new Error(`glue.js が読めない (${res.status})`);
  const glue = await res.text();

  const mod = (await import('../crate/pkg/kitesurf_clone_bg.wasm')).default;

  const entry = `
import initWasm, { render_png_rgba_no_js, font_families } from './glue.js';
import wasm from './engine.wasm';

// ここはモジュールの評価中。I/O とタイマーは使えないが、
// instantiate と eval は使えるのか?
const report = {};

try {
  await initWasm(wasm);
  report.init = 'ok';
} catch (e) {
  report.init = e.name + ': ' + String(e.message).slice(0, 140);
}

try {
  report.families = font_families().length;
} catch (e) {
  report.families = e.name + ': ' + String(e.message).slice(0, 100);
}

// フォントを 1 本も登録していないので文字は出ないが、描けるかだけ見る
try {
  const rgba = render_png_rgba_no_js('<p style="background:#0f0">x</p>', 'https://x.invalid/', 40, 20);
  report.render = 'ok: ' + rgba.length + ' bytes';
} catch (e) {
  report.render = e.name + ': ' + String(e.message).slice(0, 140);
}

// 描いたあとでも eval はまだ使えるか
try {
  report.evalAfterRender = 'ok: ' + eval('6*7');
} catch (e) {
  report.evalAfterRender = e.name;
}

export default {
  async fetch() {
    return Response.json(report);
  },
};
`;

  const stub = env.LOADER.get(id, async () => ({
    compatibilityDate: COMPAT,
    mainModule: 'entry.js',
    modules: {
      'entry.js': entry,
      'glue.js': glue,
      'engine.wasm': { wasm: mod },
    },
    globalOutbound: null,
  }));
  const out = await stub.getEntrypoint().fetch('https://page.invalid/');
  return out.json();
}

/**
 * `globalOutbound` を渡したら、グローバルスコープでも fetch できるのかを確かめる。
 *
 * これが通るなら「資源を先に取ってから渡す」必要が無くなり、
 * Kitesurf と同じ「解釈の途中で取りに行く」形をグローバルスコープで組める。
 * つまり eval も使えて 1 パスで描ける。通らないなら、
 * **資源の取得と eval はどちらかしか選べない**ことになる。
 */
export async function probeGlobalFetch(env, id) {
  const entry = `
const report = {};
// 1. グローバルスコープで fetch を await する
try {
  const r = await fetch('https://example.com/');
  report.globalFetch = 'ok: ' + r.status;
} catch (e) {
  report.globalFetch = e.name + ': ' + String(e.message).slice(0, 160);
}
// 2. そのあとで eval は使えるか
try { report.evalAfter = 'ok: ' + eval('1+1'); } catch (e) { report.evalAfter = e.name; }

export default {
  async fetch() {
    // 3. handler の中なら fetch は通るはず
    let inHandler;
    try {
      const r = await fetch('https://example.com/');
      inHandler = 'ok: ' + r.status;
    } catch (e) {
      inHandler = e.name + ': ' + String(e.message).slice(0, 120);
    }
    return Response.json({ ...report, handlerFetch: inHandler });
  },
};
`;
  // globalOutbound を渡さない (null) 場合と、既定 (undefined = 親の経路) の 2 通り
  const make = (outbound) => ({
    compatibilityDate: COMPAT,
    mainModule: 'entry.js',
    modules: { 'entry.js': entry },
    ...(outbound === 'none' ? { globalOutbound: null } : {}),
  });

  const out = {};
  for (const kind of ['default', 'none']) {
    const stub = env.LOADER.get(`${id}:${kind}`, async () => make(kind === 'none' ? 'none' : undefined));
    try {
      const res = await stub.getEntrypoint().fetch('https://page.invalid/');
      out[kind] = await res.json();
    } catch (e) {
      out[kind] = { error: String(e?.message ?? e) };
    }
  }
  return out;
}
