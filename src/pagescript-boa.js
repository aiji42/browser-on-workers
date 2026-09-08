// 構成 A: 公式の Kitesurf に近い形。
//
// # 何が違うのか
//
// `src/pagescript.js` (構成 B) は、ページの JS を **V8** で、**モジュールの
// 評価中に** 走らせる。そこは eval が通る代わりに fetch が通らないので、
// 資源は全部先に取ってから渡すしかない。何が必要かは解釈するまで分からないので、
// 「捨てるための描画」を先にやることになる。
//
// こちらは動的 Worker の **handler** で走らせる。handler では
//
//   - fetch が使える -> **解釈の途中で資源を取りに行ける**
//   - eval が使えない -> ページの JS は Boa で解釈する
//
// Boa は Wasm の中のインタプリタなので、V8 のコード生成を通らない。
// だから handler でも動く。**Kitesurf が Boa を積んでいる理由がここ。**
//
// # なぜ 1 つの document で足りるのか
//
// Rust 側の `sess_*` は、資源の応答を後回しにできる `NetProvider` を使う。
// blitz-dom が要求した URL は「保留」に積まれ、JS が fetch してから
// `sess_provide` で答える。document は開いたまま。だから
// **構成 B のような描き直しが要らない。**
//
//   sess_open -> [sess_pending -> fetch -> sess_provide -> sess_settle] * n
//             -> sess_run_scripts -> (同じループ) -> sess_run_timers -> sess_paint
//
// # ネットワーク
//
// 子 Worker には直接ネットワークを持たせず、`globalOutbound` で本体の Worker に
// 通す (Kitesurf の SandboxOutbound と同じ形)。子から見ると普通の `fetch` だが、
// 実際には親の `/` に届いて、そこで方針を当ててから外に出る。

const COMPAT = '2026-09-01';

// 保留を解く回数の上限。@import が段になっていると 2 周では終わらない
const MAX_PASSES = 6;

// 1 周で並列に取る本数の上限。ページ 1 枚で数百本要求してくるものがある
const MAX_PER_PASS = 48;

/** 動的 Worker の中身 (handler で走る部分) を組む */
function entryModule({ baseUrl, width, height, fonts, generics, timerLimit, probe, runJs }) {
  return `
import * as glue from './glue.js';
import wasm from './engine.wasm';
import html from './page.html';
${fonts.map((_, i) => `import font${i} from './font${i}.ttf';`).join('\n')}

// ここはモジュールの評価中。I/O は使えないが、instantiate とフォントの登録は
// 純粋な計算なので通る。top-level await は使わない (initSync がある)
glue.initSync({ module: wasm });
${fonts.map((f, i) => `glue.add_font(new Uint8Array(font${i}), ${JSON.stringify(f.family)});`).join('\n')}
${generics.map(([g, fams]) => `glue.set_generic_lead(${JSON.stringify(g)}, ${JSON.stringify(fams)});`).join('\n')}

const BASE = ${JSON.stringify(baseUrl)};
const PROBE = ${JSON.stringify(probe ?? null)};
const RUN_JS = ${runJs === false ? 'false' : 'true'};
const W = ${width};
const H = ${height};

/** 保留になっている URL を取ってきて、fetch して答える。答えた本数を返す */
async function drain(doc, report) {
  const pending = glue.sess_pending(doc).slice(0, ${MAX_PER_PASS});
  if (!pending.length) return 0;
  await Promise.all(pending.map(async (url) => {
    try {
      // ここは handler。fetch が通る。実際には globalOutbound で親に届く
      const res = await fetch(url, { redirect: 'follow' });
      if (!res.ok) { glue.sess_fail(doc, url); report.failed++; return; }
      const bytes = new Uint8Array(await res.arrayBuffer());
      glue.sess_provide(doc, url, bytes);
      report.fetched++;
      report.bytes += bytes.length;
    } catch (e) {
      // 答えないと pending_critical_resources が残ったままになり、
      // document が永久に描かれない。失敗も「空で答える」で伝える
      glue.sess_fail(doc, url);
      report.failed++;
      if (report.errors.length < 6) report.errors.push(String(e && e.message).slice(0, 120));
    }
  }));
  return pending.length;
}

/** 保留が無くなるまで回す */
async function settleLoop(doc, report, label) {
  for (let pass = 0; pass < ${MAX_PASSES}; pass++) {
    const n = await drain(doc, report);
    if (!n) break;
    glue.sess_settle(doc);
    report.passes.push(label + ':' + n);
  }
}

export default {
  async fetch(request) {
    const path = new URL(request.url).pathname;
    const report = {
      engine: 'Boa (dynamic Worker, handler)',
      passes: [], fetched: 0, failed: 0, bytes: 0, errors: [],
      scripts: null, timers: null, jsErrors: [],
    };
    const doc = glue.sess_open(html, BASE, W, H, RUN_JS);
    if (!doc) throw new Error('sess_open が 0 を返した: ' + (glue.last_panic() ?? '?'));

    // 1. HTML から要求された資源 (CSS、画像) を解く
    await settleLoop(doc, report, 'html');

    // 2. 外部スクリプトの中身が揃ったので、ここで初めて JS を走らせる
    report.scripts = RUN_JS ? glue.sess_run_scripts(doc) : false;
    glue.sess_settle(doc);

    // 3. JS が足したノードが要求する資源を解く
    await settleLoop(doc, report, 'js');

    // 4. タイマーを流す。React はここで進む
    report.timers = RUN_JS ? glue.sess_run_timers(doc, ${timerLimit}) : 0;
    await settleLoop(doc, report, 'timer');
    glue.sess_settle(doc);

    report.jsErrors = glue.sess_js_errors(doc).slice(0, 8);
    report.pending = glue.sess_pending(doc).length;

    // 白紙になったときの手がかりを **絵に焼く**。
    //
    // sess_eval は真偽しか返さないので、値を JS 側に持ち帰る道が無い。
    // document の中に書き込ませて、そのまま描けば外から読める
    if (PROBE) {
      const ok = glue.sess_eval(doc, PROBE);
      report.probe = ok;
      glue.sess_settle(doc);
    }

    if (path === '/report') { glue.sess_close(doc); return Response.json(report); }
    const rgba = glue.sess_paint(doc);
    glue.sess_close(doc);
    return new Response(rgba, {
      headers: { 'content-type': 'application/octet-stream', 'x-report': JSON.stringify(report) },
    });
  },
};
`;
}

/**
 * 構成 A で 1 枚描く。
 *
 * @param env      LOADER と OUTBOUND binding を持つ env
 * @param request  ASSETS を引くための request
 * @param page     { html, baseUrl, width, height, fonts, generics, id, timerLimit }
 */
export async function renderInBoaWorker(env, request, page) {
  const {
    html, baseUrl, width, height, fonts = [], generics = [], timerLimit = 64,
  } = page;

  const modules = {
    'glue.js': await (await env.ASSETS.fetch(new URL('/glue.js', request.url))).text(),
    'engine.wasm': { wasm: (await import('../crate/pkg/kitesurf_clone_bg.wasm')).default },
    'page.html': { text: html },
    'entry.js': entryModule({
      baseUrl, width, height, fonts, generics, timerLimit,
      probe: page.probe, runJs: page.runJs,
    }),
  };
  fonts.forEach((f, i) => { modules[`font${i}.ttf`] = { data: f.bytes.buffer ?? f.bytes }; });

  const stub = env.LOADER.get(`${page.id ?? `boa:${Math.random()}`}${page.runJs === false ? ':nojs' : ''}`, async () => ({
    compatibilityDate: COMPAT,
    mainModule: 'entry.js',
    modules,
    // 子のネットワークは全部ここへ届く。方針は親の 1 箇所に置く
    globalOutbound: env.OUTBOUND,
  }));

  const ep = stub.getEntrypoint();
  const res = await ep.fetch('https://page.invalid/');
  if (!res.ok) throw new Error(`PageScript が失敗した (${res.status})`);
  const report = JSON.parse(res.headers.get('x-report') ?? 'null');
  return { rgba: new Uint8Array(await res.arrayBuffer()), report };
}
