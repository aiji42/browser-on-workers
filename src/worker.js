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
import { demoHtml, cardHtml } from './demo.js';
import { fetchHtml, fetchStylesheets, fetchImages, fetchResources } from './outbound.js';

// Rust 側。wasm-bindgen の glue と、その中身の Wasm。
// wrangler.jsonc の rules で .wasm は CompiledWasm として読み込まれる
import wasmModule from '../crate/pkg/kitesurf_clone_bg.wasm';
import initWasm, {
  add_font, add_resource, clear_resources, missed_resources, render_png_rgba, last_panic,
} from '../crate/pkg/kitesurf_clone.js';

// Workers にはシステムフォントが 1 つも無いので、字を出すには持ち込むしかない。
// woff2 は Brotli で圧縮されていて Workers 側でほどけないので TrueType のまま置く。
// scripts/build-fonts.mjs が生成する
import sansRegular from '../fonts/sans-regular.ttf';
import sansBold from '../fonts/sans-bold.ttf';
import jpRegular from '../fonts/jp-regular.ttf';

// フォントの登録は isolate ごとに 1 度だけ。2 度呼ぶと同じ face が二重に入る。
// 登録順が優先順位になるので、Latin を先、日本語を後にする
// (どちらも持っている英数字は Latin 側で出る)
const FONTS = [
  [sansRegular, 'sans'],
  [sansBold, 'sans'],      // 同じ family に入れると weight が解決される
  [jpRegular, 'jp'],       // 文字集合が違うので別 family。同じにすると片方が消える
];

let ready = null;
const ensureWasm = () => (ready ??= (async () => {
  await initWasm(wasmModule);
  for (const [ttf, family] of FONTS) add_font(new Uint8Array(ttf), family);
})());

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

// 取りこぼしを回収して描き直す回数の上限。@import が段になっていると 2 周では終わらない
const MAX_PASSES = 3;

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

    const html5 = (body) => new Response(body, {
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
    });

    // デモ。このブラウザで自分自身を描けるように、JS を 1 行も使っていない
    if (url.pathname === '/') return html5(demoHtml(url.origin));
    // X などに貼る見せ札。外部資源を持たないので単体で描ける
    if (url.pathname === '/card') return html5(cardHtml());

    // 自分の HTML を、fetch を挟まずにそのまま描く。
    // Worker は自分自身の workers.dev の URL を fetch できない (404 になる) ので、
    // 自己紹介の絵を出すにはこの経路が必要
    if (url.pathname === '/card.png' || url.pathname === '/self.png') {
      const body = url.pathname === '/card.png' ? cardHtml() : demoHtml(url.origin);
      const w = url.pathname === '/card.png' ? 1200 : 1000;
      const h = url.pathname === '/card.png' ? 630 : 900;
      try {
        await ensureWasm();
        clear_resources();
        const rgba = render_png_rgba(body, `${url.origin}/`, w, h);
        return new Response(await encodePNG(rgba, w, h), {
          headers: { 'content-type': 'image/png', 'cache-control': 'public, max-age=300' },
        });
      } catch (e) {
        return Response.json({ ok: false, error: describeError(e) }, { status: 500 });
      }
    }
    if (url.pathname === '/usage') {
      return new Response(usage, { headers: { 'content-type': 'text/plain; charset=utf-8' } });
    }

    if (url.pathname === '/health') {
      try {
        await ensureWasm();
        return Response.json({
          ok: true,
          wasm: 'loaded',
          fonts: FONTS.map(([ttf, family]) => ({ family, kb: Math.round(ttf.byteLength / 1024) })),
        });
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

      // Blitz はサブリソースを自分で取りに行かないので、Worker が取ってきて
      // 「URL -> バイト列」の表に入れる。Blitz は <link> や <img> から
      // その URL を要求し、表から受け取る。通信は Worker 側の 1 箇所だけ。
      //
      // isolate はリクエストをまたいで生きるので、前のページの分を先に捨てる
      clear_resources();
      const base = baseUrl || 'https://inline.invalid/';

      // 自分の /shot を資源として取りに行くと再帰するので弾く
      const deny = (u) => u.startsWith(`${url.origin}/shot`);

      t = Date.now();
      const [sheets, imgs] = await Promise.all([
        fetchStylesheets(html, base, deny),
        fetchImages(html, base, deny),
      ]);
      for (const sheet of sheets.sheets) add_resource(sheet.url, sheet.bytes);
      for (const img of imgs.images) add_resource(img.url, img.bytes);
      timing.subresourceMs = Date.now() - t;
      timing.css = { fetched: sheets.sheets.length, skipped: sheets.skipped, bytes: sheets.bytes };
      timing.img = { fetched: imgs.images.length, skipped: imgs.skipped, bytes: imgs.bytes };

      // base URL を渡す。blitz-dom は <link href="/x.css"> のような相対参照を
      // これに対して解決する。無いと (base になれない data: URL が既定なので) panic する
      //
      // 1 回描くと、エンジンが要求したのに表に無かった URL が missed_resources() に出る。
      // CSS の中の url() や @font-face は、その CSS が表に入って初めて読めるので、
      // @import が段になっていると 1 周では終わらない。空になるまで回す
      t = Date.now();
      let rgba = render_png_rgba(html, baseUrl, width, height);
      timing.passes = 1;
      timing.recovered = [];
      for (let pass = 0; pass < MAX_PASSES; pass++) {
        const missed = missed_resources();
        if (!missed.length) break;
        const more = await fetchResources(missed, base, deny);
        if (!more.got.length) break;
        for (const r of more.got) add_resource(r.url, r.bytes);
        rgba = render_png_rgba(html, baseUrl, width, height);
        timing.passes++;
        timing.recovered.push({ asked: missed.length, got: more.got.length, bytes: more.bytes });
      }
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
