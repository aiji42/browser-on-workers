// URL を渡すとスクリーンショットが返る Worker。
//
// Kitesurf が公開している構成をなぞる。中でやることは 4 つ:
//
//   1. 外から HTML を取ってくる            … Kitesurf の SandboxOutbound にあたる
//   2. HTML と CSS を解釈してレイアウトする … Blitz + Stylo (Rust/Wasm 側)
//   3. ピクセルに落とす                     … blitz-paint (Rust/Wasm 側)
//   4. PNG にして返す                       … png.js (Workers に画像 API が無いので自前)
//
// Chromium は使わない。ブラウザの処理は全部この isolate の中で終わる。

import { encodePNG } from './png.js';
import { fetchHtml, inlineStylesheets } from './outbound.js';

// Rust 側。wasm-bindgen の glue と、その中身の Wasm。
// wrangler.jsonc の rules で .wasm は CompiledWasm として読み込まれる
import wasmModule from '../crate/pkg/kitesurf_clone_bg.wasm';
import initWasm, { render_png_rgba, last_panic } from '../crate/pkg/kitesurf_clone.js';

// Workers にはシステムフォントが無いので、字を出すには持ち込むしかない。
// scripts/build-fonts.mjs が Latin だけに絞った TTF を作る
import fontTtf from '../fonts/sans-regular.ttf';

let ready = null;
const ensureWasm = () => (ready ??= initWasm(wasmModule));

// Rust 側の panic は `RuntimeError: unreachable` として届く (wasm は unwind できない)。
// abort の前に panic hook がメッセージを控えているので、それを取り出して差し替える。
// hook は console.error にも同じものを流しているので、Workers のログにも残る
const describeError = (e) => {
  // どの経路で来たのか分からないことがあるので、判断材料をそのまま返す
  let panic;
  try { panic = last_panic(); } catch (err) { panic = `last_panic() が失敗: ${err?.message}`; }
  return {
    message: String(e?.message ?? e),
    kind: e?.constructor?.name ?? typeof e,
    isRuntimeError: e instanceof WebAssembly.RuntimeError,
    panic: panic || null,
  };
};

const DEFAULT_WIDTH = 1280;
const DEFAULT_HEIGHT = 800;

const usage = `browser-on-workers

  GET /shot?url=<URL>[&w=1280][&h=800]   ページを PNG で返す
  GET /shot?html=<HTML>                  渡した HTML を直接描く
  GET /health                            Wasm が読めているかだけ確認する

Chromium は使っていません。HTML のパース (html5ever)、CSS (Stylo)、
レイアウト (Taffy)、描画 (blitz-paint) をすべて Worker の isolate の中で
Wasm として動かしています。
`;

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === '/' ) {
      return new Response(usage, { headers: { 'content-type': 'text/plain; charset=utf-8' } });
    }

    if (url.pathname === '/health') {
      try {
        await ensureWasm();
        return Response.json({ ok: true, wasm: 'loaded', fontBytes: fontTtf.byteLength });
      } catch (e) {
        return Response.json({ ok: false, error: String(e?.message ?? e) }, { status: 500 });
      }
    }

    if (url.pathname !== '/shot') return new Response('not found', { status: 404 });

    const target = url.searchParams.get('url');
    const inlineHtml = url.searchParams.get('html');
    if (!target && !inlineHtml) {
      return new Response('url または html が必要です', { status: 400 });
    }

    const width = Math.min(2000, Math.max(64, Number(url.searchParams.get('w')) || DEFAULT_WIDTH));
    const height = Math.min(4000, Math.max(64, Number(url.searchParams.get('h')) || DEFAULT_HEIGHT));

    const timing = {};
    try {
      await ensureWasm();

      let t = Date.now();
      let html = inlineHtml ?? '';
      let baseUrl = target ?? '';
      if (target) {
        const got = await fetchHtml(target);
        html = got.html;
        baseUrl = got.finalUrl;
      }
      timing.fetchMs = Date.now() - t;

      // Blitz はサブリソースを取りに行かない。外部 CSS は Worker が取ってきて
      // <style> として差し込む。これが無いと実ページは素の文書として描かれる
      t = Date.now();
      const sheets = await inlineStylesheets(html, baseUrl || 'https://inline.invalid/');
      html = sheets.html;
      timing.cssMs = Date.now() - t;
      timing.css = { fetched: sheets.fetched, skipped: sheets.skipped, bytes: sheets.cssBytes };

      t = Date.now();
      // base URL を渡す。blitz-dom は <link href="/x.css"> のような相対参照を
      // これに対して解決する。無いと (base になれない data: URL が既定なので) panic する
      const rgba = render_png_rgba(html, baseUrl, new Uint8Array(fontTtf), width, height);
      timing.renderMs = Date.now() - t;

      t = Date.now();
      const png = await encodePNG(rgba, width, height);
      timing.encodeMs = Date.now() - t;

      return new Response(png, {
        headers: {
          'content-type': 'image/png',
          'cache-control': 'no-store',
          // 各段にかかった時間を返す。どこが重いのかを外から見えるようにしておく
          'x-timing': JSON.stringify(timing),
          'x-html-bytes': String(html.length),
        },
      });
    } catch (e) {
      // Rust の panic なら error に "panicked at <file>:<line>:<col>:\n<message>" が入る
      const error = describeError(e);
      console.error('render failed:', error, e?.stack ?? '');
      return Response.json({ ok: false, error, timing }, { status: 500 });
    }
  },
};
