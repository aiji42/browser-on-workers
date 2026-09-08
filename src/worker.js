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
import { demoHtml, cardHtml, jsDemoHtml, DEMO_SHOTS } from './demo.js';
import { fetchHtml, fetchStylesheets, fetchImages, fetchResources, decodeEntities } from './outbound.js';
import { injectPolyfill } from './polyfill.js';
import { runInV8, probeWasmInV8, probeEvalContext, probeTopLevelAwait, probeExclusivity } from './v8page.js';
import { probeGlobalInit, probeGlobalFetch } from './globalprobe.js';
import { renderInV8 } from './pagescript.js';

export { RateLimiter } from './ratelimit.js';

// Rust 側。wasm-bindgen の glue と、その中身の Wasm。
// wrangler.jsonc の rules で .wasm は CompiledWasm として読み込まれる
import wasmModule from '../crate/pkg/kitesurf_clone_bg.wasm';
import initWasm, {
  add_font, set_generic_lead, add_resource, clear_resources, missed_resources,
  render_png_rgba, render_png_rgba_no_js, last_js_errors, last_panic,
} from '../crate/pkg/kitesurf_clone.js';

// Workers にはシステムフォントが 1 つも無いので、字を出すには持ち込むしかない。
// woff2 は Brotli で圧縮されていて Workers 側でほどけないので TrueType のまま置く
// (scripts/build-fonts.mjs が public/fonts/ に生成する)。
//
// バンドルに埋め込まず Static Assets に置いて、実行時に ASSETS binding で読む。
// Kitesurf も PageRenderer が Static Assets からフォントを取っている。
// スクリプトサイズに含まれないので、フォントを増やしても上限に効かない

// 登録順が優先順位になるので、Latin を先、日本語を後にする
// (どちらも持っている英数字は Latin 側で出る)
const FONTS = [
  ['/fonts/sans-regular.ttf', 'sans'],
  ['/fonts/sans-bold.ttf', 'sans'],   // 同じ family に入れると weight が解決される
  ['/fonts/mono-regular.ttf', 'mono'],
  ['/fonts/jp-regular.ttf', 'jp'],    // 文字集合が違うので別 family。同じにすると片方が消える
];

// 既定では generic family の全部に、登録順 (sans -> mono -> jp) で入る。
// それだと `monospace` を指したページも sans で描かれるので、等幅の generic だけ
// mono を先頭にする。mono は Latin しか持たないので、後ろに jp を残す
const GENERIC_LEAD = [
  ['monospace', ['mono', 'jp']],
  ['ui-monospace', ['mono', 'jp']],
];

// フォントの登録は isolate ごとに 1 度だけ。2 度呼ぶと同じ face が二重に入る。
// cold start のときだけ Static Assets からの読み込みが乗る (2 MB で数十ミリ秒)
let ready = null;
let boot = null;
const ensureWasm = (env, request) => (ready ??= (async () => {
  const fonts = [];
  let t = Date.now();
  await initWasm(wasmModule);
  const initMs = Date.now() - t;
  for (const [path, family] of FONTS) {
    t = Date.now();
    const res = await env.ASSETS.fetch(new URL(path, request.url));
    if (!res.ok) throw new Error(`font not found: ${path} (${res.status})`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const fetchMs = Date.now() - t;
    t = Date.now();
    const faces = add_font(bytes, family);
    fonts.push({ path, family, kb: Math.round(bytes.length / 1024), faces, fetchMs, addMs: Date.now() - t });
  }
  // フォントを全部登録し終わってから並べ替える (呼ぶたびに FontContext を組み直すので)
  const lead = GENERIC_LEAD.map(([g, fams]) => [g, set_generic_lead(g, fams)]);
  boot = { initMs, fonts, lead };
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

// この Worker の**モジュールスコープ**で eval を試す。
//
// 動的 Worker のグローバルスコープでは通った。それが動的 Worker だけの性質なのか、
// Workers 全般で「起動時だけは通る」のかで、話がまったく変わる。
// ここはモジュールの評価中なので、後者ならこれも通るはず
const EVAL_AT_MODULE_SCOPE = (() => {
  try {
    return `ok: ${eval('1+1')}`;
  } catch (e) {
    return `${e.name}: ${e.message}`;
  }
})();
const NEW_FUNCTION_AT_MODULE_SCOPE = (() => {
  try {
    return `ok: ${new Function('return 1+1')()}`;
  } catch (e) {
    return `${e.name}: ${e.message}`;
  }
})();

// 取りこぼしを回収して描き直す回数の上限。@import が段になっていると 2 周では終わらない
const MAX_PASSES = 3;

// 描くのは 1 リクエストで 0.1〜2 秒の CPU を使う仕事なので、公開したままにするなら
// 数を絞る。送信元 IP ごとに Durable Object を 1 つ持って、そこで数える
// (組み込みの Rate Limiting binding は効かなかった。src/ratelimit.js を参照)。
// 10 秒で 4 回、60 秒で 12 回まで。
//
// バケットは 2 つ。
//
// - shot: 訪問者が URL を指定して撮る経路。1 枚 0.1〜2 秒の CPU を使い、
//   外向きの fetch もするので厳しくする
// - demo: このサイトが自分で貼っている決まった絵。中身が固定で、
//   edge にキャッシュされるので緩くていい (トップページ 1 回の表示で 4 枚使う)
const BUCKETS = {
  shot: [[10, 4], [60, 12]],
  demo: [[10, 12], [60, 40]],
};

// 返すのは「断るなら retry-after の秒数、通すなら null」
async function overLimit(env, request, bucket) {
  if (!env.RATE) return null;   // binding が無いときは通す
  const key = request.headers.get('cf-connecting-ip') ?? 'unknown';
  const stub = env.RATE.get(env.RATE.idFromName(`${bucket}:${key}`));
  const q = BUCKETS[bucket].map(([sec, limit]) => `w=${sec},${limit}`).join('&');
  const verdict = await stub.fetch(`https://rate.invalid/?${q}`).then((r) => r.json());
  return verdict.ok ? null : verdict.retryAfter;
}

// 渡せる HTML の大きさ。これ以上は描く前に断る
const MAX_INLINE_HTML = 512 * 1024;

// 1 リクエストで wasm のメモリに載せる画素の合計。<img> と取りこぼしの回収で通算する。
// 経路ごとに分けて数えると、合わせたときに isolate のメモリを超える
const DECODED_BUDGET = 48 * 1024 * 1024;

// 絵が 1 色だけかを見る。3.2 MB を全部なめる必要は無いので、間を飛ばして数える。
// 1 色だけなら、描けなかったのと同じ
function isBlank(rgba) {
  const first = rgba.subarray(0, 4).join(',');
  for (let i = 0; i < rgba.length; i += 4 * 997) {
    if (rgba.subarray(i, i + 4).join(',') !== first) return false;
  }
  return true;
}

const DEFAULT_WIDTH = 1280;
const DEFAULT_HEIGHT = 800;

const usage = `browser-on-workers

  GET /shot?url=<URL>[&w=1280][&h=800]   ページを PNG で返す
  GET /shot?html=<HTML>                  渡した HTML を直接描く
  GET /shot?url=<URL>&js=0               ページの <script> を実行せずに描く
  GET /health                            Wasm が読めているかだけ確認する

返す x-timing ヘッダの renderMs は、描画にかかった CPU 時間ではありません。
Workers の Date.now() は I/O の無い区間で進まないので、描画のような純粋な計算は
0 ms と出ます。実際の CPU 時間は wrangler tail の cpuTime で見てください。

Chromium は使っていません。HTML のパース (html5ever)、CSS (Stylo)、
レイアウト (Taffy)、描画 (blitz-paint) をすべて Worker の isolate の中で
Wasm として動かしています。
`;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    const html5 = (body) => new Response(body, {
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
    });

    const tooMany = (retryAfter) => new Response(
      'リクエストが多すぎます。少し待ってからもう一度どうぞ。\n' +
      '(1 枚描くのに 0.1〜2 秒の CPU を使うので、10 秒で 4 枚・60 秒で 12 枚までに\n' +
      'しています)\n',
      {
        status: 429,
        headers: {
          'content-type': 'text/plain; charset=utf-8',
          'retry-after': String(retryAfter),
        },
      },
    );

    // デモ。このブラウザで自分自身を描けるように、JS を 1 行も使っていない
    if (url.pathname === '/') return html5(demoHtml(url.origin));
    // X などに貼る見せ札。外部資源を持たないので単体で描ける
    if (url.pathname === '/card') return html5(cardHtml());
    // JavaScript が動いていることを見せるページ。Chrome で開いた絵と /js.png が一致する
    if (url.pathname === '/js') return html5(jsDemoHtml());

    // 自分の HTML を、fetch を挟まずにそのまま描く。
    // Worker は自分自身の workers.dev の URL を fetch できない (404 になる) ので、
    // 自己紹介の絵を出すにはこの経路が必要
    // 自分の HTML を描く経路。毎リクエストで HTML を組まないよう、関数のまま持つ
    const SELF = {
      '/card.png': [cardHtml, 1200, 630],
      '/js.png': [jsDemoHtml, 760, 560],
      '/self.png': [() => demoHtml(url.origin), 1000, 900],
    };
    if (SELF[url.pathname]) {
      const [make, w, h] = SELF[url.pathname];
      const limited = await overLimit(env, request, 'demo');
      if (limited) return tooMany(limited);
      const body = make();
      try {
        await ensureWasm(env, request);
        clear_resources();
        // 自画像の中に自分で描いた絵が入っている。Worker は自分の URL を fetch できないので、
        // 先にその 2 枚を描いて資源の表に入れてから、外側を描く
        if (url.pathname === '/self.png') {
          for (const inner of ['/card.png', '/js.png']) {
            const [innerMake, iw, ih] = SELF[inner];
            const png = await encodePNG(render_png_rgba(innerMake(), `${url.origin}/`, iw, ih), iw, ih);
            add_resource(`${url.origin}${inner}`, new Uint8Array(png));
          }
        }
        const rgba = render_png_rgba(body, `${url.origin}/`, w, h);
        return new Response(await encodePNG(rgba, w, h), {
          headers: { 'content-type': 'image/png', 'cache-control': 'public, max-age=300' },
        });
      } catch (e) {
        return Response.json({ ok: false, error: describeError(e) }, { status: 500 });
      }
    }
    // 同じループを Worker の V8 で回す。ページの中の Boa と比べるため。
    // Workers は eval を禁じているので、ループは文字列から作れない。ここに直接書く
    if (url.pathname === '/bench') {
      const n = Math.min(50_000_000, Math.max(1, Number(url.searchParams.get('n')) || 200_000));
      const limited = await overLimit(env, request, 'demo');
      if (limited) return tooMany(limited);
      const t = Date.now();
      let x = 0;
      for (let i = 0; i < n; i++) x += i % 7;
      // cpuTime は wrangler tail で見る。Date.now() は I/O の無い区間で進まないので、
      // ここの ms はほぼ 0 になる
      return Response.json({ engine: 'V8 (Worker)', n, x, ms: Date.now() - t });
    }

    // ページの JS を V8 で実行して描く経路。/shot と同じ引数を取る
    if (url.pathname === '/v8shot') {
      const target = url.searchParams.get('url');
      const inlineHtml = url.searchParams.get('html');
      if (!target && !inlineHtml) return new Response('url または html が必要です', { status: 400 });
      const w = Math.min(2000, Math.max(64, Number(url.searchParams.get('w')) || DEFAULT_WIDTH));
      const h = Math.min(4000, Math.max(64, Number(url.searchParams.get('h')) || DEFAULT_HEIGHT));
      const limited = await overLimit(env, request, 'shot');
      if (limited) return tooMany(limited);

      const timing = {};
      try {
        let t = Date.now();
        let html = inlineHtml ?? '';
        let baseUrl = target ?? 'https://inline.invalid/';
        if (target) {
          const got = await fetchHtml(target);
          html = got.html;
          baseUrl = got.finalUrl;
        }
        timing.fetchMs = Date.now() - t;

        // 資源は本体の Worker が取ってから渡す。PageScript には
        // ネットワークを持たせない (Kitesurf が SandboxOutbound に閉じているのと同じ形)
        t = Date.now();
        const deny = (u) => u.startsWith(`${url.origin}/`);
        const [sheets, imgs] = await Promise.all([
          fetchStylesheets(html, baseUrl, deny),
          fetchImages(html, baseUrl, deny),
        ]);
        // ページの外部スクリプトも先に取る
        const scriptUrls = [...html.matchAll(/<script\b[^>]*\bsrc\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>/gi)]
          .map((m) => m.slice(2).find(Boolean))
          .map((u) => { try { return new URL(decodeEntities(u), baseUrl).href; } catch { return null; } })
          .filter(Boolean);
        const gotScripts = scriptUrls.length ? await fetchResources(scriptUrls, baseUrl, deny) : { got: [] };
        timing.subresourceMs = Date.now() - t;
        timing.css = sheets.sheets.length;
        timing.img = imgs.images.length;
        timing.scriptFiles = gotScripts.got.length;

        const resources = [
          ...sheets.sheets.map((s2) => ({ url: s2.url, bytes: s2.bytes })),
          ...imgs.images.map((i2) => ({ url: i2.url, bytes: i2.bytes })),
          ...gotScripts.got.map((r) => ({ url: r.url, bytes: r.bytes })),
        ];

        // ここが V8 経路のいちばん高い買い物。
        //
        // PageScript はモジュールの評価中に走る。そこは eval が通る代わりに
        // fetch が通らないので、**足りない資源を後から取りに行けない**。
        // HTML を見るだけでは、CSS の中の url() や @import、@font-face が
        // 分からない。だから本体の Worker で一度描いて missed_resources() を
        // 吐かせ、それを取ってから渡す。
        //
        // つまり V8 経路は「捨てるための描画」を先に 1〜3 回やる。
        // Kitesurf が解釈の途中で取りに行けるのは、ページの JS を handler で
        // 走らせているから。その代償が Boa
        let decodedLeft = Math.max(0, DECODED_BUDGET - (imgs.decodedBytes ?? 0));
        timing.discoverMs = 0;
        timing.discoverPasses = 0;
        timing.discoverFetchMs = 0;
        timing.discovered = 0;
        if (url.searchParams.get('discover') !== '0') {
          // 探索の描画は本体の Worker 側の engine を使う
          await ensureWasm(env, request);
          clear_resources();
          for (const r of resources) add_resource(r.url, r.bytes);
          t = Date.now();
          render_png_rgba_no_js(html, baseUrl, w, h);
          timing.discoverMs += Date.now() - t;
          timing.discoverPasses = 1;
          for (let pass = 0; pass < MAX_PASSES; pass++) {
            const missed = missed_resources();
            if (!missed.length) break;
            t = Date.now();
            const more = await fetchResources(missed, baseUrl, deny, decodedLeft);
            timing.discoverFetchMs += Date.now() - t;
            decodedLeft = Math.max(0, decodedLeft - (more.decodedBytes ?? 0));
            if (!more.got.length) break;
            for (const r of more.got) {
              add_resource(r.url, r.bytes);
              resources.push({ url: r.url, bytes: r.bytes });
              timing.discovered++;
            }
            t = Date.now();
            render_png_rgba_no_js(html, baseUrl, w, h);
            timing.discoverMs += Date.now() - t;
            timing.discoverPasses++;
          }
        }

        // フォントも I/O では渡せないのでバイト列にして持たせる
        t = Date.now();
        const fonts = [];
        for (const [path, family] of FONTS) {
          const fr = await env.ASSETS.fetch(new URL(path, request.url));
          if (fr.ok) fonts.push({ family, bytes: new Uint8Array(await fr.arrayBuffer()) });
        }
        timing.fontMs = Date.now() - t;

        t = Date.now();
        const { rgba, report } = await renderInV8(env, request, {
          html, baseUrl, width: w, height: h, resources, fonts,
          // 同じページなら同じ動的 Worker が使い回される (結果はモジュールの
          // 評価中に出ているので、2 回目はほぼ 0 秒で返る)。計測のときは
          // 毎回作らせないと cold の値が取れない
          id: url.searchParams.get('fresh')
            ? `page:fresh:${Math.random()}` : undefined,
        });
        timing.pageScriptMs = Date.now() - t;

        t = Date.now();
        const png = await encodePNG(rgba, w, h);
        timing.encodeMs = Date.now() - t;

        return new Response(png, {
          headers: {
            'content-type': 'image/png',
            'cache-control': 'no-store',
            'x-timing': JSON.stringify(timing),
            // 非 ASCII を入れると Workers が警告を出すので落とす。
            // ページの中身 (bodyHtml) は ?debug=1 のときだけ
            'x-page-script': JSON.stringify(
              url.searchParams.get('debug') ? report : { ...report, bodyHtml: undefined },
            ).replace(/[^\x20-\x7e]/g, '?'),
          },
        });
      } catch (e) {
        return Response.json({ ok: false, error: describeError(e), timing }, { status: 500 });
      }
    }

    // グローバルスコープで fetch できるか (できるなら 1 パスで描ける)
    if (url.pathname === '/v8fetch') {
      const limited = await overLimit(env, request, 'demo');
      if (limited) return tooMany(limited);
      try {
        return Response.json({ ok: true, ...(await probeGlobalFetch(env, `gf:${Math.random()}`)) });
      } catch (e) {
        return Response.json({ ok: false, error: String(e?.message ?? e) }, { status: 500 });
      }
    }

    // グローバルスコープで engine を立ち上げられるか。
    // 通れば、ページのスクリプトも eval が使える場所で走らせられる
    if (url.pathname === '/v8global') {
      const limited = await overLimit(env, request, 'demo');
      if (limited) return tooMany(limited);
      const t = Date.now();
      try {
        const out = await probeGlobalInit(env, request, url.searchParams.get('id') ?? `gi:${Math.random()}`);
        return Response.json({ ok: true, ms: Date.now() - t, ...out });
      } catch (e) {
        return Response.json({ ok: false, ms: Date.now() - t, error: String(e?.message ?? e) }, { status: 500 });
      }
    }

    // 「eval が使える場所」と「I/O が使える場所」が排他かを確かめる
    if (url.pathname === '/v8exclusive') {
      const limited = await overLimit(env, request, 'demo');
      if (limited) return tooMany(limited);
      try {
        return Response.json({ ok: true, ...(await probeExclusivity(env, `excl:${Math.random()}`)) });
      } catch (e) {
        return Response.json({ ok: false, error: String(e?.message ?? e) }, { status: 500 });
      }
    }

    // top-level await を挟んでも eval が通るか。通るなら一発勝負の用途では Boa が要らない
    if (url.pathname === '/v8await') {
      const limited = await overLimit(env, request, 'demo');
      if (limited) return tooMany(limited);
      try {
        return Response.json({ ok: true, ...(await probeTopLevelAwait(env, `tla:${Math.random()}`)) });
      } catch (e) {
        return Response.json({ ok: false, error: String(e?.message ?? e) }, { status: 500 });
      }
    }

    // eval が通る場所を特定する
    if (url.pathname === '/v8eval') {
      const limited = await overLimit(env, request, 'demo');
      if (limited) return tooMany(limited);
      try {
        return Response.json({ ok: true, ...(await probeEvalContext(env, url.searchParams.get('id') ?? `evalctx:${Math.random()}`)) });
      } catch (e) {
        return Response.json({ ok: false, error: String(e?.message ?? e) }, { status: 500 });
      }
    }

    // 15 MB の engine を動的 Worker に持ち込めるかを試す。
    // ?how=compiled で WebAssembly.Module をそのまま、?how=bytes で ArrayBuffer を渡す
    if (url.pathname === '/v8wasm') {
      const limited = await overLimit(env, request, 'demo');
      if (limited) return tooMany(limited);
      const how = url.searchParams.get('how') === 'bytes' ? 'bytes' : 'compiled';
      const id = url.searchParams.get('id') ?? `engine:${how}`;
      const t = Date.now();
      try {
        const out = await probeWasmInV8(env, request, how, id);
        return Response.json({ ok: true, how, ms: Date.now() - t, ...out });
      } catch (e) {
        return Response.json({ ok: false, how, ms: Date.now() - t, error: String(e?.message ?? e) }, { status: 500 });
      }
    }

    // 本体の Worker で eval を呼ぶと何が起きるかを、その場で示す。
    // 動的 Worker との対比のため (あちらでは通る)
    if (url.pathname === '/eval-here') {
      const out = {};
      try {
        out.eval = String(eval('1+1'));
      } catch (e) {
        out.eval = `${e.name}: ${e.message}`;
      }
      try {
        out.newFunction = String(new Function('return 1+1')());
      } catch (e) {
        out.newFunction = `${e.name}: ${e.message}`;
      }
      return Response.json({
        where: '本体の Worker',
        handler: out,
        moduleScope: { eval: EVAL_AT_MODULE_SCOPE, newFunction: NEW_FUNCTION_AT_MODULE_SCOPE },
      });
    }

    // 動的 Worker の中で、ページのコードを V8 に渡してみる。
    // ?code= に JavaScript を書くと、その結果と「どのエンジンが答えたか」が返る
    if (url.pathname === '/v8') {
      const limited = await overLimit(env, request, 'demo');
      if (limited) return tooMany(limited);
      const code = url.searchParams.get('code')
        ?? 'var x = 0; for (var i = 0; i < 200000; i++) x += i % 7; return x;';
      // id を変えると別の Worker になる。同じコードなら使い回したいので中身で決める
      const id = url.searchParams.get('id') ?? `v8:${code.length}:${code.slice(0, 40)}`;
      try {
        const out = await runInV8(env, id, code);
        return Response.json({ ok: true, ...out });
      } catch (e) {
        return Response.json({ ok: false, error: String(e?.message ?? e), stack: e?.stack }, { status: 500 });
      }
    }

    if (url.pathname === '/usage') {
      return new Response(usage, { headers: { 'content-type': 'text/plain; charset=utf-8' } });
    }

    if (url.pathname === '/health') {
      try {
        await ensureWasm(env, request);
        return Response.json({ ok: true, wasm: 'loaded', boot, rateLimiter: !!env.RATE });
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
    if (inlineHtml && inlineHtml.length > MAX_INLINE_HTML) {
      return new Response(`html は ${MAX_INLINE_HTML} バイトまでです`, { status: 413 });
    }

    const width = Math.min(2000, Math.max(64, Number(url.searchParams.get('w')) || DEFAULT_WIDTH));
    const height = Math.min(4000, Math.max(64, Number(url.searchParams.get('h')) || DEFAULT_HEIGHT));

    // トップページが貼っている決まった絵は demo のバケットで数える。
    // `demo=1` だけで緩くすると、その口から好きな URL を撮られるので、
    // 一覧に載っている URL と大きさに一致するときだけ認める
    const isDemoShot = url.searchParams.get('demo') === '1'
      && DEMO_SHOTS.some(([u, w, h]) => u === target && w === width && h === height);
    const bucket = isDemoShot ? 'demo' : 'shot';
    const limited = await overLimit(env, request, bucket);
    if (limited) return tooMany(limited);

    // ページの <script> を実行するか。既定は実行する。
    // 実ページの崩れが JS のせいなのかを切り分けたいときに js=0 を付ける
    const runJs = url.searchParams.get('js') !== '0';
    const render = runJs ? render_png_rgba : render_png_rgba_no_js;

    const timing = {};
    timing.js = runJs;
    try {
      await ensureWasm(env, request);

      let t = Date.now();
      let html = inlineHtml ?? '';
      let baseUrl = target ?? '';
      if (target) {
        const got = await fetchHtml(target);
        html = got.html;
        baseUrl = got.finalUrl;
      }
      timing.fetchMs = Date.now() - t;

      // engine に無いホスト側の Web API (matchMedia / URLSearchParams / localStorage /
      // 3 つの Observer / performance.now / fetch) を、ページのスクリプトより先に埋める。
      // 本来は Rust 側に実装するものだが、何が足りないかを測るには JS が早い。
      // ?polyfill=0 で外して、有る無しを比べられるようにしてある
      const withPolyfill = runJs && url.searchParams.get('polyfill') !== '0';
      if (withPolyfill) html = injectPolyfill(html);
      timing.polyfill = withPolyfill;

      // 切り分け用。?scripts=inline で外部のスクリプトだけ落とす。
      // 「壊れるのはインラインのせいか、読み込んだバンドルのせいか」を分ける
      if (runJs && url.searchParams.get('scripts') === 'inline') {
        const before = html.length;
        html = html
          .replace(/<script\b[^>]*\bsrc\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)[^>]*>[\s\S]*?<\/script>/gi, '')
          .replace(/<script\b[^>]*\bsrc\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)[^>]*\/?>/gi, '');
        timing.strippedBytes = before - html.length;
      }

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
      timing.img = {
        fetched: imgs.images.length, skipped: imgs.skipped,
        // 展開後が大きすぎて断った枚数。ここを通すと wasm のメモリ確保が失敗する
        tooBig: imgs.tooBig, bytes: imgs.bytes, decodedBytes: imgs.decodedBytes,
      };

      // base URL を渡す。blitz-dom は <link href="/x.css"> のような相対参照を
      // これに対して解決する。無いと (base になれない data: URL が既定なので) panic する
      //
      // 1 回描くと、エンジンが要求したのに表に無かった URL が missed_resources() に出る。
      // CSS の中の url() や @font-face は、その CSS が表に入って初めて読めるので、
      // @import が段になっていると 1 周では終わらない。空になるまで回す
      //
      // 時間の内訳について: Workers の `Date.now()` は I/O の無い区間で進まないので、
      // 描画のような純粋な計算は 0 ms と出る。だから renderMs は「描画にかかった時間」
      // ではなく「描画の前後で時計が進んだ量」でしかない。取りこぼしの回収 (fetch) を
      // 同じ区間に入れると、その fetch の時間が描画時間に見えてしまうので分けて数える
      timing.renderMs = 0;
      timing.recoverFetchMs = 0;
      t = Date.now();
      let decodedLeft = Math.max(0, DECODED_BUDGET - (imgs.decodedBytes ?? 0));

      let rgba = render(html, baseUrl, width, height);
      timing.renderMs += Date.now() - t;
      timing.passes = 1;
      timing.recovered = [];
      for (let pass = 0; pass < MAX_PASSES; pass++) {
        const missed = missed_resources();
        if (!missed.length) break;
        t = Date.now();
        const more = await fetchResources(missed, base, deny, decodedLeft);
        timing.recoverFetchMs += Date.now() - t;
        decodedLeft = Math.max(0, decodedLeft - (more.decodedBytes ?? 0));
        if (!more.got.length) break;
        for (const r of more.got) add_resource(r.url, r.bytes);
        t = Date.now();
        rgba = render(html, baseUrl, width, height);
        timing.renderMs += Date.now() - t;
        timing.passes++;
        timing.recovered.push({
          asked: missed.length, got: more.got.length, bytes: more.bytes, tooBig: more.tooBig,
        });
      }

      // ページの JS が DOM を壊して真っ白になることがある。
      // react.dev はハイドレーションの途中で例外が出ると本文が消える。
      // 白いだけの絵を返すより、JS を切って描き直したほうが役に立つ
      if (runJs && isBlank(rgba)) {
        t = Date.now();
        const retry = render_png_rgba_no_js(html, baseUrl, width, height);
        timing.renderMs += Date.now() - t;
        timing.blankWithJs = true;
        timing.usedNoJs = !isBlank(retry);
        if (timing.usedNoJs) rgba = retry;
      }
      // JS が途中で死んでいても絵は出る。何が起きたのかはヘッダで返す
      // (ヘッダの長さに限りがあるので、頭を少しだけ)
      if (runJs) {
        const errors = last_js_errors();
        timing.jsErrors = errors.length;
        // 中身は日本語を含みうるのでヘッダには入れず、ログに流す
        if (errors.length) console.warn('js errors:', errors.slice(0, 5));
      }

      t = Date.now();
      const png = await encodePNG(rgba, width, height);
      timing.encodeMs = Date.now() - t;

      return new Response(png, {
        headers: {
          'content-type': 'image/png',
          // 決まった絵は edge に置く。訪問者が指定した絵は毎回描く
          'cache-control': bucket === 'demo' ? 'public, max-age=3600' : 'no-store',
          // 各段にかかった時間を返す。どこが重いのかを外から見えるようにしておく
          // 非 ASCII を入れると Workers が警告を出すので、値は数字と真偽値だけにする
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
