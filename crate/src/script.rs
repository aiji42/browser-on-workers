//! ページの `<script>` を実行する。
//!
//! Workers の V8 は文字列からコードを作れない (`eval` も `new Function` も
//! `EvalError: Code generation from strings disallowed for this context` になる)。
//! なので JS の実行は wasm の中で完結させる必要がある。Cloudflare の Kitesurf は
//! ここに **Boa** (Rust で書かれた ECMAScript のインタプリタ) を持ち込んでいる。
//! Boa は純粋な Rust なので、wasm の中で JS を「解釈」できる。V8 の
//! コード生成を通らないから、あの禁止に当たらない。
//!
//! DOM の口 (`document.getElementById`、`innerHTML`、イベント、タイマー) は
//! `blitz-vibey-script` が Boa と blitz-dom の間に張っている。crates.io に
//! 出ていないクレートなので `vendor/blitz-vibey-script` にコピーしてある
//! (経緯はそちらの `src/lib.rs` の頭)。
//!
//! # 駆動の順
//!
//! 1. `ScriptDocument::from_html` で DOM を組む (まだ実行しない)
//! 2. `resolve` を回してスタイルとレイアウトを付ける。`offsetWidth` のように
//!    レイアウトを読むスクリプトのために、実行より前に 1 度落ち着かせる
//! 3. `execute_scripts` で `<script>` を文書順に実行し、`DOMContentLoaded` と
//!    `load` を投げる
//! 4. タイマーを**仮想時間で**数回だけ回す (`setTimeout(f, 100)` を待たない)
//! 5. もう 1 度 `resolve`。JS が足したノードにスタイルとレイアウトが付く
//! 6. 描く
//!
//! # 暴走を止める
//!
//! JS は無限ループを書ける。Workers には CPU 時間の上限があるので、
//! 上限を先に置いて JS の例外に変える。上限に当たっても描画は続く
//! (そこまでに JS が組んだ DOM がそのまま絵になる)。上限は 5 つ:
//! ループの回数、呼び出しの深さ、実行に使える実時間、タイマーの回数、
//! 仮想時間の先。
//!
//! Boa には「走っている JS を外から止める」口が無い (interrupt flag も無い)。
//! 止められるのは次の 1 歩に入るところだけ。ループの回数だけは VM が数えて
//! いるのでループの途中でも効くが、実時間の予算は `<script>` と `<script>` の
//! 間、タイマーとタイマーの間でしか見られない。1 本のスクリプトが中で
//! 延々と回るのはループの上限で止める、という二段構えにしている。
//!
//! 止められないものが 1 つ残る。巨大な文字列や配列を作られると Boa の中の
//! 確保が溢れて **panic** する (wasm では abort)。そのときは描画も死ぬので、
//! Worker は 500 を返す。JS を切れば描ける。
//!
//! # 上限に当たったことが分かるか
//!
//! 5 つのうち 4 つは跡が残る。ループと深さは `RuntimeLimitError` として
//! `take_js_errors` に出る (ページの `try/catch` では拾えない。
//! [`LOOP_ITERATION_LIMIT`] を見る)。`<script>` の実時間の予算は
//! 「飛ばした本数」を書き残す。
//!
//! **タイマーの上限 ([`TIMER_ROUNDS`] / [`TIMER_BUDGET`] /
//! [`VIRTUAL_TIME_HORIZON`]) だけは黙って切る。** 例外にならないので
//! `last_js_errors` を見ても分からない。「絵は出ているのに JS のエラーは
//! 0 件」の形になりうるのはここ
//! (`cost_tests::running_out_of_timer_rounds_is_silent`)。
//!
//! もう 1 つ、engine の上限ではないが同じ形になる道がある。**ページの JS が
//! 自分で例外を拾ってしまう場合。** React 18 の `hydrateRoot` は
//! ハイドレーション中の例外を自分で拾ってクライアント描画にやり直し、
//! `onRecoverableError` (既定では `console.error`) で知らせる。console は
//! `log` クレートに流すだけで `take_js_errors` には入らないので、
//! **サーバが吐いた本文が消えても跡が残らない**
//! (`react_tests::an_error_during_hydration_wipes_the_server_html_and_reports_nothing`)

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use blitz_dom::{Document, DocumentConfig};
use blitz_vibey_script::{FetchError, ScriptDocument, ScriptFetcher};
use url::Url;
use wasm_bindgen::prelude::*;

use crate::net::TableNetProvider;

/// 1 つの呼び出しフレームが回せるループの回数。
///
/// Boa の既定は無制限。超えると `RuntimeLimitError` になる。
/// **数え方はフレームごとの通算**で、ループを抜けても 0 に戻らない。つまり
/// 1 つの関数の中のループは全部でこの予算を分け合う。実ページの初期化に
/// 何十万回もループするものは無い一方、`while (true) {}` はここで死ぬ。
///
/// **この例外はページの `try/catch` では拾えない。** Boa では
/// `RuntimeLimitError` は `JsError` の中でも `EngineError` の枝で
/// (boa_engine 0.22 の `error/mod.rs`: "Engine error that cannot be caught
/// from within ECMAScript code")、`is_catchable()` が偽を返す。VM の
/// `handle_error` は catch のハンドラを探さずにフレームを畳んで Rust の
/// 呼び出し元まで返すので、当たった `<script>` は**その行で終わる**
/// (catch の中も、try より後ろの行も走らない)。後ろの `<script>` は走る。
/// 深さの上限 ([`RECURSION_LIMIT`]) もまったく同じ扱い。
/// テストは `tests::the_loop_limit_is_not_catchable_by_the_page_either`
///
/// 50 万回は native の release で 4.6ms、wasm で 150ms ほど。フレームごとの
/// 予算なので、関数の数だけ使い回せる。それを止めるのが [`SCRIPT_BUDGET`]
const LOOP_ITERATION_LIMIT: u64 = 500_000;

/// JS の呼び出しの深さ。Boa の既定は 512。
///
/// **素の JS の呼び出しはホストのスタックを伸ばさない。** Boa 0.22 の
/// `Vm::run` は 1 本の `while` ループで、呼び出しはヒープの `Vec`
/// (`vm.frames`) にフレームを積むだけ。ホストのスタックが伸びるのは
/// **ホスト側から VM に再入するとき** — accessor (getter / setter) や
/// native 関数が JS を呼び戻すとき — で、それを
/// `check_runtime_limits` が `host_call_depth` として深さに足している。
///
/// 1 MB のスタック (wasm-ld の既定。このリポジトリは
/// `-C link-arg=-zstack-size` を渡していない) で測った内訳:
///
/// | 形 | 何段まで | 止まり方 |
/// | --- | --- | --- |
/// | 素の自己再帰 | 1135 | Boa 自身の値スタックの上限 (`stack_size`、既定 10240 スロット) |
/// | getter から自分を読む | 755 | **プロセスの死** (1 段が 1KB 前後) |
///
/// つまり本当に危ないのは深さ全体ではなく accessor の再帰で、そこが
/// 755 段。いまの 160 はその 4.7 分の 1。
///
/// 素の再帰の効き目は `min(この定数, 約 1135)`。上の天井は
/// `with_runtime_limits` が渡していない `stack_size` が決めているので、
/// この定数だけを 1135 より大きくしても届かない
/// (上げたければ Boa の `RuntimeLimits::set_stack_size_limit` も要る)。
/// 測り方は `stack_tests::the_native_stack_depth`
/// (`STACK_PROBE=1 cargo test --release` で走る)。
///
/// 深さは CPU の値段ではない。native の release で 20 万回の呼び出しが
/// 25ms で、深さ 156 でも 1020 でも 1 回あたりは同じ
/// (`cost_tests::the_cost_of_a_deep_recursion_page`)。深さが増やすのは
/// ヒープだけ。CPU を止めているのは [`LOOP_ITERATION_LIMIT`] と
/// [`SCRIPT_BUDGET`]。
///
/// React 18 のハイドレーションはこの上限をまったく使わない。reconciler は
/// 木を再帰ではなく `while (workInProgress !== null)` の 1 本のループで
/// 歩くので、**木の深さに関係なく上限 13 で足りる**
/// (`react_tests::the_recursion_limit_react_actually_needs`)
const RECURSION_LIMIT: usize = 160;

/// `<script>` の実行に使える実時間。これを過ぎたら、まだ走らせていない
/// `<script>` は飛ばす (走っているものは止められない)。
///
/// ループの上限は 1 フレームぶんなので、関数や `<script>` の数だけ使い回せる。
/// 実時間で見ておかないと、上限を守ったまま何十秒も使える
pub(crate) const SCRIPT_BUDGET: Duration = Duration::from_millis(1_500);

/// タイマーに使える実時間。`<script>` の予算とは別枠で持つ
const TIMER_BUDGET: Duration = Duration::from_millis(500);

/// 実行するタイマー (setTimeout / setInterval / requestAnimationFrame) の回数。
/// `setInterval` を張るページは永久にタイマーを出し続けるので、回数でも切る
const TIMER_ROUNDS: usize = 64;

/// タイマーを進める仮想時間の先。これより後ろに置かれたタイマーは実行しない。
/// スクリーンショットは「読み込み直後の絵」なので、1 秒より先は要らない
const VIRTUAL_TIME_HORIZON: Duration = Duration::from_millis(1_000);

/// JS を実行するかどうか。既定は実行する
static JS_ENABLED: AtomicBool = AtomicBool::new(true);

/// 直前の描画で JS が投げた、拾われなかった例外
static LAST_JS_ERRORS: Mutex<Vec<String>> = Mutex::new(Vec::new());

/// ページの `<script>` を実行するかどうかを切り替える。既定は実行する。
///
/// 実ページの崩れが JS のせいなのかを切り分けたいときに `false` にする。
/// wasm インスタンスに残るので、Workers では isolate が生きている間は有効
#[wasm_bindgen]
pub fn set_js_enabled(enabled: bool) {
    JS_ENABLED.store(enabled, Ordering::Relaxed);
}

/// いま JS を実行する設定になっているか
#[wasm_bindgen]
pub fn js_enabled() -> bool {
    JS_ENABLED.load(Ordering::Relaxed)
}

/// 直前の描画で JS が投げた、拾われなかった例外のメッセージ。
///
/// 実行そのものは失敗しても描画は続く (そこまでの DOM が絵になる) ので、
/// 「絵は出たが JS が途中で死んだ」を知るにはこれを見る。
/// ループの上限に当たったときも `RuntimeLimitError` としてここに出る。
/// 描画のたびに置き換わる
#[wasm_bindgen]
pub fn last_js_errors() -> Vec<String> {
    LAST_JS_ERRORS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
}

/// 外部スクリプト (`<script src>` と ES module の import) を資源の表から返す。
///
/// Rust 側から通信はしない。表に無ければ `Err` を返して、その URL を
/// `missed_resources` に控える。JS 側はそれを取ってきて `add_resource` で
/// 足し、もう 1 度描く (画像や CSS と同じ 2 パス)
struct TableScriptFetcher {
    net: Arc<TableNetProvider>,
}

impl ScriptFetcher for TableScriptFetcher {
    fn fetch(&self, url: &Url) -> Result<String, FetchError> {
        match self.net.text(url.as_str()) {
            Some(source) => Ok(source),
            None => Err(FetchError::InvalidData(format!(
                "not in the resource table: {url}"
            ))),
        }
    }
}

/// HTML を DOM にする。**まだ実行しない** (実行は [`run`])。
///
/// スクリプトから見えるレイアウトを先に作っておきたいので、
/// 組むところと走らせるところを分けてある
pub(crate) fn prepare(
    html: &str,
    config: DocumentConfig,
    net: Arc<TableNetProvider>,
) -> ScriptDocument {
    prepare_with_fetcher(html, config, TableScriptFetcher { net })
}

/// [`prepare`] の中身。外部スクリプトの引き先だけ差し替えられるようにしてある
/// (`session` は資源の表ではなく、その session が受け取ったバイト列から引く)。
///
/// 上限のうち **実時間の予算 (`with_deadline`) は組んだ時点から数え始める**。
/// 組んでから実行するまでに時間が経つ使い方 (`session`) では、実行の直前に
/// 貼り直す必要がある
pub(crate) fn prepare_with_fetcher(
    html: &str,
    config: DocumentConfig,
    fetcher: impl ScriptFetcher,
) -> ScriptDocument {
    prepare_with_limits(
        html,
        config,
        fetcher,
        LOOP_ITERATION_LIMIT,
        RECURSION_LIMIT,
        SCRIPT_BUDGET,
    )
}

/// [`prepare_with_fetcher`] の中身。上限を引数にしてある。
///
/// 本番はここを定数で呼ぶ。上限を動かして測るのはテストだけなので、
/// document を**組み立てる場所を 1 か所に保つ**ためにこれを通す
fn prepare_with_limits(
    html: &str,
    config: DocumentConfig,
    fetcher: impl ScriptFetcher,
    loop_iterations: u64,
    recursion: usize,
    budget: Duration,
) -> ScriptDocument {
    ScriptDocument::from_html(html, config)
        // タイマーの起き上がりを知らせる背景スレッドは要らない。
        // wasm32-unknown-unknown にはそもそもスレッドが無く、
        // `thread::Builder::spawn` は Err を返す (crate 側は expect で panic する)
        .without_timer_thread()
        // 時間は自分で進める。`setTimeout(f, 3000)` を実時間で待たない
        .with_virtual_time()
        // 暴走を止める上限 (どちらも vendor 側で足した口)
        .with_runtime_limits(loop_iterations, recursion)
        .with_deadline(web_time::Instant::now() + budget)
        // 外部スクリプトは呼び出し側が渡した引き先から
        .with_fetcher(fetcher)
}

/// `<script>` を文書順に実行し、溜まったタイマーを少しだけ回す。
///
/// 落ちないことを優先する。スクリプトが投げた例外は
/// `blitz-vibey-script` が拾って溜めるので、ここでは最後に
/// [`last_js_errors`] へ移すだけ
pub(crate) fn run(doc: &mut ScriptDocument) {
    *LAST_JS_ERRORS.lock().unwrap_or_else(|e| e.into_inner()) = run_collecting(doc);
}

/// [`run`] と同じことをして、拾われなかった例外を**返す**。
///
/// グローバルの [`LAST_JS_ERRORS`] は触らない。session は document を
/// 何ターンも生かしておくので、例外は「直前の描画のもの」ではなく
/// document ごとに持つ必要がある
pub(crate) fn run_collecting(doc: &mut ScriptDocument) -> Vec<String> {
    doc.execute_scripts();
    run_timers(doc, TIMER_ROUNDS);
    doc.take_js_errors()
}

/// 溜まっているタイマーを仮想時間で進める。回数と仮想時間の 2 つで切る。
///
/// タイマーを最大 `rounds` ターン進める。何ターン走ったかを返す。
///
/// 仮想時間の先 (`clock_now` から [`VIRTUAL_TIME_HORIZON`]) と実時間の
/// 予算 ([`TIMER_BUDGET`]) は**呼ぶたびに** 引き直す。session から何度も
/// 呼ぶと、仮想時間はその都度さらに先へ進む
pub(crate) fn run_timers(doc: &mut ScriptDocument, rounds: usize) -> u32 {
    let horizon = doc.clock_now() + VIRTUAL_TIME_HORIZON;
    let until = web_time::Instant::now() + TIMER_BUDGET;
    let mut ran = 0;
    for _ in 0..rounds {
        let Some(deadline) = doc.next_timer_deadline() else {
            break;
        };
        // 仮想時間の先か、実時間の予算のどちらかで切る
        if deadline > horizon || web_time::Instant::now() >= until {
            break;
        }
        // 実時間で待たずに、次のタイマーの時刻へ飛ぶ。
        // 順番は保たれる (仮想時間なので後ろのタイマーはまだ来ていない)
        doc.advance_clock_to(deadline);
        if !doc.poll(None) {
            break;
        }
        ran += 1;
    }
    ran
}

#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests {
    use super::*;
    use blitz_dom::BaseDocument;
    use blitz_traits::shell::{ColorScheme, Viewport};
    use std::collections::HashMap;

    /// 上限に当たるまでどれだけ回すかを測るテストなので、実時間の予算は
    /// 広く取っておく (ここで測りたいのは上限そのもの)
    const WIDE_BUDGET: Duration = Duration::from_secs(60);

    /// 表に持った文字列を `<script src>` に返す fetcher
    pub(super) struct MapFetcher(pub(super) HashMap<String, String>);

    impl ScriptFetcher for MapFetcher {
        fn fetch(&self, url: &Url) -> Result<String, FetchError> {
            self.0
                .get(url.as_str())
                .cloned()
                .ok_or_else(|| FetchError::InvalidData(format!("no such file: {url}")))
        }
    }

    pub(super) fn config() -> DocumentConfig {
        DocumentConfig {
            viewport: Some(Viewport::new(800, 600, 1.0, ColorScheme::Light)),
            base_url: Some("https://x.test/".to_string()),
            // wasm32 に合わせる (rayon のスレッドプールは無い)
            style_threading: blitz_dom::StyleThreading::Sequential,
            ..Default::default()
        }
    }

    /// 上限を渡して 1 ページ走らせる。`<script>` を全部実行して、
    /// タイマーを `rounds` 周まで回す。
    ///
    /// 返すのは (document, 拾われなかった例外, 実際に回ったタイマーの周)
    pub(super) fn run_page(
        html: &str,
        files: &[(&str, &str)],
        loop_iterations: u64,
        recursion: usize,
        rounds: usize,
    ) -> (ScriptDocument, Vec<String>, u32) {
        let fetcher = MapFetcher(
            files
                .iter()
                .map(|(name, body)| {
                    (format!("https://x.test/{name}"), (*body).to_string())
                })
                .collect(),
        );
        let mut doc = prepare_with_limits(
            html,
            config(),
            fetcher,
            loop_iterations,
            recursion,
            WIDE_BUDGET,
        );
        doc.inner_mut().resolve(0.0);
        doc.execute_scripts();
        let ran = run_timers(&mut doc, rounds);
        let errors = doc.take_js_errors();
        (doc, errors, ran)
    }

    /// `#out` に付いた属性を読む。JS の書いたものを Rust から確かめる口
    pub(super) fn attr(doc: &mut ScriptDocument, id: &str, name: &str) -> Option<String> {
        let doc: &BaseDocument = &doc.inner_mut();
        let node = doc.get_element_by_id(id)?;
        doc.get_node(node)?
            .attrs()?
            .iter()
            .find(|a| &*a.name.local == name)
            .map(|a| a.value.to_string())
    }

    /// 上限に当たった例外かどうか (Boa の `RuntimeLimitError`)
    pub(super) fn is_runtime_limit(errors: &[String]) -> bool {
        errors.iter().any(|e| e.contains("RuntimeLimitError"))
    }

    // === Task 1: 上限に当たると何が起きるのか ===

    /// 深さの上限は **ページの `try/catch` では拾えない**。
    ///
    /// Boa では `RuntimeLimitError` は `JsError` の中でも `EngineError` の側で、
    /// `is_catchable()` が `false` を返す
    /// (boa_engine 0.22 の `error/mod.rs`: "Engine error that cannot be caught
    /// from within ECMAScript code")。VM の `handle_error` は catch のハンドラを
    /// 探さずにフレームを全部畳んで Rust の呼び出し元まで返す。
    ///
    /// つまり `<script>` は**その場で終わる**。catch の中も、ループの残りも、
    /// try より後ろの行も走らない
    #[test]
    fn the_recursion_limit_is_not_catchable_by_the_page() {
        let html = r#"<p id="out"></p><script>
            var out = document.getElementById("out");
            out.setAttribute("data-start", "yes");
            function deep(n) { return n <= 0 ? 0 : deep(n - 1) + 1 }
            try {
              out.setAttribute("data-shallow", String(deep(10)));
              out.setAttribute("data-deep", String(deep(500)));
            } catch (e) {
              out.setAttribute("data-caught", String(e));
            }
            out.setAttribute("data-after-try", "yes");
            </script>"#;
        let (mut doc, errors, _) = run_page(html, &[], LOOP_ITERATION_LIMIT, 160, 8);

        // 上限に当たる前の代入は残る
        assert_eq!(attr(&mut doc, "out", "data-start").as_deref(), Some("yes"));
        assert_eq!(attr(&mut doc, "out", "data-shallow").as_deref(), Some("10"));

        // 深いほうは値が入らない。**catch も走らない**
        assert_eq!(attr(&mut doc, "out", "data-deep"), None);
        assert_eq!(
            attr(&mut doc, "out", "data-caught"),
            None,
            "the page's own catch must not see a RuntimeLimitError"
        );
        // try の後ろも走らない (スクリプトごと畳まれる)
        assert_eq!(attr(&mut doc, "out", "data-after-try"), None);

        // engine 側には残る
        assert!(is_runtime_limit(&errors), "{errors:?}");
        assert!(
            errors.iter().any(|e| e.contains("recursive calls")),
            "{errors:?}"
        );
    }

    /// 深さの上限で死ぬのは**その `<script>` 1 本だけ**。後ろの `<script>` は走る。
    ///
    /// `execute_scripts` は `<script>` ごとに `Context::eval` を呼び、`Err` を
    /// 記録して次に進む。Boa の context も汚れない (上限に当たったあとの
    /// 浅い呼び出しは通る)
    #[test]
    fn a_later_script_still_runs_after_the_recursion_limit() {
        let html = r#"<p id="out"></p>
            <script>
              function deep(n) { return n <= 0 ? 0 : deep(n - 1) + 1 }
              deep(500);
              document.getElementById("out").setAttribute("data-first", "finished");
            </script>
            <script>
              var out = document.getElementById("out");
              out.setAttribute("data-second", "ran");
              function deep2(n) { return n <= 0 ? 0 : deep2(n - 1) + 1 }
              out.setAttribute("data-second-depth", String(deep2(10)));
            </script>"#;
        let (mut doc, errors, _) = run_page(html, &[], LOOP_ITERATION_LIMIT, 160, 8);

        // 1 本目は最後まで行かない
        assert_eq!(attr(&mut doc, "out", "data-first"), None);
        // 2 本目は走る。context は使い回せる
        assert_eq!(attr(&mut doc, "out", "data-second").as_deref(), Some("ran"));
        assert_eq!(
            attr(&mut doc, "out", "data-second-depth").as_deref(),
            Some("10"),
            "the Boa context is not poisoned by a runtime limit error"
        );
        assert!(is_runtime_limit(&errors), "{errors:?}");
        assert_eq!(errors.len(), 1, "only the first script should fail: {errors:?}");
    }

    /// ループの上限も**同じ `EngineError`** なので、やはり拾えない。
    ///
    /// vendor 側のドキュメントは「ordinary JS exception」と書いているが、
    /// これは誤り。`RuntimeLimitError::LoopIteration` は
    /// `RuntimeLimitError::Recursion` と同じ enum の別の枝で、どちらも
    /// `EngineError::RuntimeLimit` に包まれる
    #[test]
    fn the_loop_limit_is_not_catchable_by_the_page_either() {
        let html = r#"<p id="out"></p><script>
            var out = document.getElementById("out");
            out.setAttribute("data-start", "yes");
            try {
              var i = 0;
              while (true) { i = i + 1 }
            } catch (e) {
              out.setAttribute("data-caught", String(e));
            }
            out.setAttribute("data-after-try", "yes");
            </script>
            <script>document.getElementById("out").setAttribute("data-second", "ran")</script>"#;
        let (mut doc, errors, _) = run_page(html, &[], 10_000, RECURSION_LIMIT, 8);

        assert_eq!(attr(&mut doc, "out", "data-start").as_deref(), Some("yes"));
        assert_eq!(
            attr(&mut doc, "out", "data-caught"),
            None,
            "the page's own catch must not see a RuntimeLimitError"
        );
        assert_eq!(attr(&mut doc, "out", "data-after-try"), None);
        // 後ろの `<script>` は走る
        assert_eq!(attr(&mut doc, "out", "data-second").as_deref(), Some("ran"));
        assert!(is_runtime_limit(&errors), "{errors:?}");
        assert!(
            errors.iter().any(|e| e.contains("iteration loops")),
            "{errors:?}"
        );
    }

    /// ループの回数は**フレームごとの通算**で、ループを抜けても 0 に戻らない。
    ///
    /// 上限 1000 のとき、600 回のループを 2 本続けて回すと 2 本目の途中で死ぬ。
    /// 同じ 600 回を別の関数に分ければ通る (フレームが変わるので数え直す)
    #[test]
    fn the_loop_budget_is_per_frame_and_never_resets() {
        let two_loops_in_one_frame = r#"<p id="out"></p><script>
            var out = document.getElementById("out");
            var i, n = 0;
            for (i = 0; i < 600; i++) { n = n + 1 }
            out.setAttribute("data-first-loop", String(n));
            for (i = 0; i < 600; i++) { n = n + 1 }
            out.setAttribute("data-second-loop", String(n));
            </script>"#;
        let (mut doc, errors, _) = run_page(two_loops_in_one_frame, &[], 1_000, RECURSION_LIMIT, 4);
        assert_eq!(
            attr(&mut doc, "out", "data-first-loop").as_deref(),
            Some("600")
        );
        assert_eq!(
            attr(&mut doc, "out", "data-second-loop"),
            None,
            "the second loop shares the first one's budget"
        );
        assert!(is_runtime_limit(&errors), "{errors:?}");

        // 同じ回数を関数に分ければ通る
        let two_loops_in_two_frames = r#"<p id="out"></p><script>
            var out = document.getElementById("out");
            var n = 0;
            function spin() { var i; for (i = 0; i < 600; i++) { n = n + 1 } }
            spin();
            spin();
            out.setAttribute("data-total", String(n));
            </script>"#;
        let (mut doc, errors, _) =
            run_page(two_loops_in_two_frames, &[], 1_000, RECURSION_LIMIT, 4);
        assert_eq!(
            attr(&mut doc, "out", "data-total").as_deref(),
            Some("1200"),
            "a fresh call frame gets a fresh loop budget: {errors:?}"
        );
        assert!(errors.is_empty(), "{errors:?}");
    }

    /// タイマーのコールバックの中で上限に当たっても、**黙って消えはしない**。
    /// `run_due_timers` が `report_js_error` に通すので `take_js_errors` に出る
    #[test]
    fn a_limit_inside_a_timer_callback_is_reported() {
        let html = r#"<p id="out"></p><script>
            setTimeout(function () {
              function deep(n) { return n <= 0 ? 0 : deep(n - 1) + 1 }
              deep(500);
              document.getElementById("out").setAttribute("data-timer", "finished");
            }, 10);
            setTimeout(function () {
              document.getElementById("out").setAttribute("data-later-timer", "ran");
            }, 20);
            </script>"#;
        let (mut doc, errors, ran) = run_page(html, &[], LOOP_ITERATION_LIMIT, 160, 16);
        assert!(ran >= 2, "both timers should have fired, ran {ran} round(s)");
        assert_eq!(attr(&mut doc, "out", "data-timer"), None);
        // 後ろのタイマーは走る
        assert_eq!(
            attr(&mut doc, "out", "data-later-timer").as_deref(),
            Some("ran")
        );
        assert!(is_runtime_limit(&errors), "{errors:?}");
        assert!(
            errors.iter().any(|e| e.contains("timer callback")),
            "the error should say it came from a timer: {errors:?}"
        );
    }

    /// 上限 160 のとき、素の自己再帰が**実際に何段まで行けるか**。
    ///
    /// Boa は `frames.len() - 1 + host_call_depth` を深さとして数え、
    /// `recursion_limit <= depth` で投げる。`<script>` の本体そのものが
    /// 1 フレーム使うので、JS から見える段数は上限より少し小さい
    #[test]
    fn the_usable_depth_is_a_few_frames_below_the_limit() {
        let deepest = deepest_plain_recursion(160);
        eprintln!("recursion limit 160 -> plain self-recursion reaches depth {deepest}");
        assert!(
            (150..160).contains(&deepest),
            "expected the usable depth just under the limit, got {deepest}"
        );
    }

    /// `limit` のとき素の自己再帰が通る最大の段数を二分探索で見つける
    fn deepest_plain_recursion(limit: usize) -> usize {
        let ok = |depth: usize| {
            let html = format!(
                r#"<p id="out"></p><script>
                function deep(n) {{ return n <= 0 ? 0 : deep(n - 1) + 1 }}
                document.getElementById("out").setAttribute("data-d", String(deep({depth})));
                </script>"#
            );
            let (mut doc, _, _) = run_page(&html, &[], LOOP_ITERATION_LIMIT, limit, 2);
            attr(&mut doc, "out", "data-d").is_some()
        };
        let (mut lo, mut hi) = (0usize, limit + 8);
        while lo + 1 < hi {
            let mid = (lo + hi) / 2;
            if ok(mid) {
                lo = mid;
            } else {
                hi = mid;
            }
        }
        lo
    }
}

/// React 18 の本物のバンドルを Boa の上で動かして、**ハイドレーションが
/// どれだけ深く再帰するか**を測る。
///
/// `crate/fixtures/` は .gitignore されているので、無ければ何もしない。
///
/// ```bash
/// curl -sfL -o crate/fixtures/react.production.min.js \
///   https://unpkg.com/react@18.3.1/umd/react.production.min.js
/// curl -sfL -o crate/fixtures/react-dom.production.min.js \
///   https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js
/// ```
#[cfg(all(test, not(target_arch = "wasm32")))]
mod react_tests {
    use super::tests::*;
    use super::*;

    const REACT: &str = "react.production.min.js";
    const REACT_DOM: &str = "react-dom.production.min.js";

    /// React の 2 本を読む。無ければ `None` (テストは skip する)
    fn react_bundles() -> Option<(String, String)> {
        let react = std::fs::read_to_string(format!("fixtures/{REACT}")).ok()?;
        let dom = std::fs::read_to_string(format!("fixtures/{REACT_DOM}")).ok()?;
        Some((react, dom))
    }

    /// サーバが吐いた形の入れ子。`depth` 段の `<div>` の底に `<span>`。
    /// React 側の `App` が返す木と 1 文字ずつ合わせる (合わないと
    /// ハイドレーションが諦めてクライアント描画に落ちる)
    fn ssr_markup(depth: usize) -> String {
        let mut html = String::new();
        for level in (1..=depth).rev() {
            html.push_str(&format!("<div class=\"d{level}\">"));
        }
        html.push_str("<span>leaf</span>");
        for _ in 0..depth {
            html.push_str("</div>");
        }
        html
    }

    /// ハイドレーションを走らせるページ。`#out` の属性に結果を書かせる
    fn hydration_page(depth: usize) -> String {
        format!(
            r#"<html><body>
<div id="root">{markup}</div>
<p id="out"></p>
<script src="/{REACT}"></script>
<script src="/{REACT_DOM}"></script>
<script>
  var out = document.getElementById("out");
  var root = document.getElementById("root");
  out.setAttribute("data-react", typeof React);
  out.setAttribute("data-react-dom", typeof ReactDOM);
  var firstBefore = root.firstChild;
  var leafBefore = firstBefore;
  while (leafBefore && leafBefore.firstChild) &#123; leafBefore = leafBefore.firstChild; &#125;
  function App(props) &#123;
    if (props.depth === 0) return React.createElement("span", null, "leaf");
    return React.createElement(
      "div",
      &#123; className: "d" + props.depth &#125;,
      React.createElement(App, &#123; depth: props.depth - 1 &#125;)
    );
  &#125;
  try &#123;
    ReactDOM.hydrateRoot(root, React.createElement(App, &#123; depth: {depth} &#125;), &#123;
      onRecoverableError: function (e) &#123;
        out.setAttribute("data-recoverable", String((e && e.message) || e));
      &#125;
    &#125;);
    out.setAttribute("data-hydrate-called", "yes");
  &#125; catch (e) &#123;
    out.setAttribute("data-threw", String((e && e.message) || e));
  &#125;
  setTimeout(function () &#123;
    var keys = Object.keys(root);
    out.setAttribute("data-container-key", String(keys.some(function (k) &#123;
      return k.indexOf("__reactContainer") === 0;
    &#125;)));
    out.setAttribute("data-reused-first", String(root.firstChild === firstBefore));
    out.setAttribute("data-reused-leaf", String(!!leafBefore && leafBefore.parentNode !== null));
    out.setAttribute("data-text", root.textContent);
    out.setAttribute("data-report", "done");
  &#125;, 400);
</script>
</body></html>"#,
            markup = ssr_markup(depth)
        )
        .replace("&#123;", "{")
        .replace("&#125;", "}")
    }

    /// 1 回のハイドレーションの結果
    #[derive(Debug)]
    struct Outcome {
        /// `setTimeout` に置いた報告が届いたか (= タイマーの周が足りたか)
        reported: bool,
        /// React が container に `__reactContainer...` を付けたか
        container_key: bool,
        /// サーバの吐いたノードを**使い回した**か (作り直していないか)
        reused: bool,
        /// `onRecoverableError` (= クライアント描画に落ちた) の内容
        recoverable: Option<String>,
        /// `hydrateRoot` がその場で投げた例外
        threw: Option<String>,
        /// 拾われなかった例外
        errors: Vec<String>,
        /// 実際に回ったタイマーの周
        rounds: u32,
        /// かかった実時間
        elapsed: Duration,
    }

    impl Outcome {
        /// ハイドレーションが**通った**と言えるか
        fn ok(&self) -> bool {
            self.reported
                && self.container_key
                && self.reused
                && self.recoverable.is_none()
                && self.threw.is_none()
                && self.errors.is_empty()
        }
    }

    fn hydrate(depth: usize, recursion: usize, loop_iterations: u64, rounds: usize) -> Outcome {
        let (react, dom) = react_bundles().expect("react bundles");
        let html = hydration_page(depth);
        let t = std::time::Instant::now();
        let (mut doc, errors, ran) = run_page(
            &html,
            &[(REACT, &react), (REACT_DOM, &dom)],
            loop_iterations,
            recursion,
            rounds,
        );
        let elapsed = t.elapsed();
        let mut get = |name: &str| attr(&mut doc, "out", name);
        Outcome {
            reported: get("data-report").as_deref() == Some("done"),
            container_key: get("data-container-key").as_deref() == Some("true"),
            reused: get("data-reused-first").as_deref() == Some("true")
                && get("data-reused-leaf").as_deref() == Some("true"),
            recoverable: get("data-recoverable"),
            threw: get("data-threw"),
            errors,
            rounds: ran,
            elapsed,
        }
    }

    /// まず React が Boa の上で**読み込めている**ことを確かめる。
    /// ここで転ぶなら深さの話ではない
    #[test]
    fn the_react_bundles_load_at_all() {
        let Some((react, dom)) = react_bundles() else {
            eprintln!("fixtures/{REACT} が無いので skip");
            return;
        };
        let html = format!(
            r#"<p id="out"></p>
            <script src="/{REACT}"></script>
            <script src="/{REACT_DOM}"></script>
            <script>
              var out = document.getElementById("out");
              out.setAttribute("data-react", typeof React);
              out.setAttribute("data-version", React.version);
              out.setAttribute("data-react-dom", typeof ReactDOM);
              out.setAttribute("data-hydrate-root", typeof ReactDOM.hydrateRoot);
            </script>"#
        );
        let (mut doc, errors, _) = run_page(
            &html,
            &[(REACT, &react), (REACT_DOM, &dom)],
            LOOP_ITERATION_LIMIT,
            RECURSION_LIMIT,
            4,
        );
        eprintln!(
            "React {:?} / ReactDOM {:?} / hydrateRoot {:?} / errors {:?}",
            attr(&mut doc, "out", "data-version"),
            attr(&mut doc, "out", "data-react-dom"),
            attr(&mut doc, "out", "data-hydrate-root"),
            errors
        );
        assert_eq!(
            attr(&mut doc, "out", "data-version").as_deref(),
            Some("18.3.1"),
            "errors: {errors:?}"
        );
        assert_eq!(
            attr(&mut doc, "out", "data-hydrate-root").as_deref(),
            Some("function")
        );
    }

    /// 本番の上限 (深さ 160 / ループ 50 万) のまま、React 18 の
    /// ハイドレーションが通るか。**通れば深さの上限は react.dev の原因ではない**
    #[test]
    fn react_hydration_under_the_shipped_limits() {
        if react_bundles().is_none() {
            eprintln!("fixtures/{REACT} が無いので skip");
            return;
        }
        for depth in [1usize, 5, 20, 50] {
            let outcome = hydrate(depth, RECURSION_LIMIT, LOOP_ITERATION_LIMIT, 256);
            eprintln!(
                "depth {depth}: {} timer round(s), {:?} wall, {outcome:?}",
                outcome.rounds, outcome.elapsed
            );
            assert!(
                outcome.ok(),
                "hydration at tree depth {depth} should complete under the shipped limits: {outcome:?}"
            );
        }
    }

    /// React のハイドレーションが通る**最小の深さの上限**を測る。
    /// これが「React が要る深さ」
    #[test]
    fn the_recursion_limit_react_actually_needs() {
        if std::env::var("REACT_PROBE").is_err() {
            eprintln!("REACT_PROBE=1 を付けたときだけ測る (二分探索で何十回も走らせる)");
            return;
        }
        if react_bundles().is_none() {
            eprintln!("fixtures/{REACT} が無いので skip");
            return;
        }
        for depth in [5usize, 20, 50] {
            let needed = smallest_working(depth, |limit| {
                hydrate(depth, limit, LOOP_ITERATION_LIMIT, 256).ok()
            });
            eprintln!("tree depth {depth}: React hydrates with recursion limit >= {needed:?}");
            assert!(
                needed.is_some_and(|n| n <= RECURSION_LIMIT),
                "tree depth {depth} needs a recursion limit of {needed:?}, shipped is {RECURSION_LIMIT}"
            );
        }
    }

    /// React のハイドレーションが通る**最小のループの上限**も測る。
    ///
    /// React 18 の reconciler は木を再帰ではなく `while (workInProgress !== null)`
    /// の 1 本のループで歩く。だからループの上限のほうが木の大きさに比例する。
    /// 木を深くして傾きを見る
    #[test]
    fn the_loop_limit_react_actually_needs() {
        if std::env::var("REACT_PROBE").is_err() {
            eprintln!("REACT_PROBE=1 を付けたときだけ測る (二分探索で何十回も走らせる)");
            return;
        }
        if react_bundles().is_none() {
            eprintln!("fixtures/{REACT} が無いので skip");
            return;
        }
        let mut measured = Vec::new();
        for depth in [5usize, 20, 50, 100] {
            let needed = smallest_working_u64(|limit| {
                hydrate(depth, RECURSION_LIMIT, limit, 256).ok()
            });
            eprintln!("tree depth {depth}: React hydrates with loop limit >= {needed:?}");
            measured.push((depth, needed));
            assert!(
                needed.is_some_and(|n| n <= LOOP_ITERATION_LIMIT),
                "tree depth {depth} needs a loop limit of {needed:?}, shipped is {LOOP_ITERATION_LIMIT}"
            );
        }
        // 傾きから、上限 50 万に当たる木の大きさを見積もる。
        // 小さい木では固定費のほうが大きいので、大きいほうの 2 点で見る
        if let (Some((d0, Some(n0))), Some((d1, Some(n1)))) =
            (measured.get(measured.len() - 2), measured.last())
        {
            let per_level = (n1 - n0) as f64 / (d1 - d0) as f64;
            eprintln!(
                "loop iterations per tree level: {per_level:.1} -> \
                 the shipped limit of {LOOP_ITERATION_LIMIT} is reached at about {} levels",
                (LOOP_ITERATION_LIMIT as f64 / per_level) as u64
            );
        }
    }

    /// **これが「絵は白いのに JS のエラーが 0 件」の作り方。**
    ///
    /// React 18 の `hydrateRoot` は、ハイドレーションの最初の描画で投げられた
    /// 例外を**自分で拾って**クライアント描画にやり直す。知らせ方は
    /// `onRecoverableError` で、既定では `reportError` / `console.error`。
    /// blitz-vibey-script は console を `log` クレートに流すだけで
    /// `take_js_errors` には入れないので、**engine 側には何も残らない**。
    ///
    /// react.dev の `__NEXT_DATA__` は `"content":"[]"` で、本文はサーバが
    /// 吐いた HTML の中にしか無い。だからクライアント描画にやり直された
    /// 時点で本文はどこからも復元できない = 白いページ + エラー 0 件
    #[test]
    fn an_error_during_hydration_wipes_the_server_html_and_reports_nothing() {
        if react_bundles().is_none() {
            eprintln!("fixtures/{REACT} が無いので skip");
            return;
        }
        let (react, dom) = react_bundles().unwrap();

        // 1 度目の描画だけ投げる。2 度目 (クライアント描画) は通る。
        // クライアント側は本文を持っていない (react.dev と同じ形)
        let html = format!(
            r#"<html><body>
<div id="root"><p>server rendered body text</p></div>
<script src="/{REACT}"></script>
<script src="/{REACT_DOM}"></script>
<script>
  var thrown = false;
  function App() {{
    if (!thrown) {{ thrown = true; throw new Error("a missing Web API"); }}
    return React.createElement("p", null, "");
  }}
  ReactDOM.hydrateRoot(document.getElementById("root"), React.createElement(App));
</script>
</body></html>"#
        );

        let (mut doc, errors, rounds) = run_page(
            &html,
            &[(REACT, &react), (REACT_DOM, &dom)],
            LOOP_ITERATION_LIMIT,
            RECURSION_LIMIT,
            256,
        );
        let text = text_of(&mut doc, "root");
        eprintln!("after hydration: #root text {text:?}, {rounds} round(s), errors {errors:?}");

        // 本文は消えている
        assert!(
            !text.contains("server rendered body text"),
            "React should have replaced the server HTML, got {text:?}"
        );
        // **なのに engine 側には何も残らない**
        assert!(
            errors.is_empty(),
            "this is the point of the test: the wipe is silent, but got {errors:?}"
        );
    }

    /// `onRecoverableError` を渡せば、同じことが見える。
    /// 「黙っている」のは engine が console を集めていないからで、
    /// React が黙っているからではない
    #[test]
    fn the_same_wipe_is_visible_through_on_recoverable_error() {
        if react_bundles().is_none() {
            eprintln!("fixtures/{REACT} が無いので skip");
            return;
        }
        let (react, dom) = react_bundles().unwrap();
        let html = format!(
            r#"<html><body>
<div id="root"><p>server rendered body text</p></div>
<p id="out"></p>
<script src="/{REACT}"></script>
<script src="/{REACT_DOM}"></script>
<script>
  var out = document.getElementById("out");
  var thrown = false;
  function App() {{
    if (!thrown) {{ thrown = true; throw new Error("a missing Web API"); }}
    return React.createElement("p", null, "");
  }}
  ReactDOM.hydrateRoot(document.getElementById("root"), React.createElement(App), {{
    onRecoverableError: function (e) {{
      out.setAttribute("data-recoverable", String((e && e.message) || e));
    }}
  }});
</script>
</body></html>"#
        );
        let (mut doc, errors, _) = run_page(
            &html,
            &[(REACT, &react), (REACT_DOM, &dom)],
            LOOP_ITERATION_LIMIT,
            RECURSION_LIMIT,
            256,
        );
        let recoverable = attr(&mut doc, "out", "data-recoverable");
        eprintln!("onRecoverableError: {recoverable:?}");
        // production ビルドなので番号だけ。#423 は
        // "There was an error while hydrating. ... the entire root will
        //  switch to client rendering." (= 本文を捨ててやり直した、の通知)
        assert!(
            recoverable
                .as_deref()
                .is_some_and(|m| m.contains("Minified React error #423")),
            "React should report the hydration fallback as #423, got {recoverable:?} \
             (engine-side errors: {errors:?})"
        );
        assert!(errors.is_empty(), "{errors:?}");
    }

    /// 要素の `textContent`
    fn text_of(doc: &mut ScriptDocument, id: &str) -> String {
        let inner: &blitz_dom::BaseDocument = &doc.inner_mut();
        inner
            .get_element_by_id(id)
            .and_then(|node| inner.get_node(node))
            .map(|node| node.text_content())
            .unwrap_or_default()
    }

    /// `ok(limit)` が真になる最小の `limit` を二分探索する (上は 512 = Boa の既定)
    fn smallest_working(_depth: usize, ok: impl Fn(usize) -> bool) -> Option<usize> {
        let (mut lo, mut hi) = (0usize, 512usize);
        if !ok(hi) {
            return None;
        }
        while lo + 1 < hi {
            let mid = (lo + hi) / 2;
            if ok(mid) {
                hi = mid;
            } else {
                lo = mid;
            }
        }
        Some(hi)
    }

    /// ループの上限版。上は 50 万 (本番の値)
    fn smallest_working_u64(ok: impl Fn(u64) -> bool) -> Option<u64> {
        let (mut lo, mut hi) = (0u64, LOOP_ITERATION_LIMIT);
        if !ok(hi) {
            return None;
        }
        while lo + 1 < hi {
            let mid = lo + (hi - lo) / 2;
            if ok(mid) {
                hi = mid;
            } else {
                lo = mid;
            }
        }
        Some(hi)
    }
}

/// 深さの上限を上げたときに、**ホストのスタックが先に尽きないか**を測る。
///
/// wasm32-unknown-unknown のスタックは固定 (wasm-ld の既定 1 MB。この
/// リポジトリは `-C link-arg=-zstack-size` を渡していないので既定のまま)。
/// スタックの溢れは JS の例外ではなく wasm のトラップ =
/// **Worker まるごとの abort** なので、拾える上限より明確に悪い。
///
/// ところが Boa 0.22 の VM は JS の呼び出しでホストのスタックを伸ばさない。
/// `Vm::run` は 1 本の `while` ループで、呼び出しはヒープの `Vec`
/// (`vm.frames`) にフレームを積むだけ (`boa_engine` の `vm/mod.rs`)。
/// ホストのスタックが伸びるのは **ホスト側から VM に再入するとき**だけで、
/// それが `check_runtime_limits` の `host_call_depth`
/// (`object/operations.rs` が accessor や native 関数の呼び出しで数える)。
///
/// なので 2 つ別に測る。素の自己再帰と、getter の中から自分を読む再帰。
///
/// スタックの溢れは Rust では捕まえられない (abort する) ので、
/// **自分自身を子プロセスとして起こして**生き死にを見る。1 MB の
/// スタックを張ったスレッドの上で走らせる = wasm の既定と同じ幅。
///
/// native のフレームは wasm のフレームと同じ大きさではないので、これは
/// **wasm の代理の測定**。それでも「素の再帰はスタックを使わない」
/// 「accessor の再帰は使う」という形は engine の作りから来ているので同じ
#[cfg(all(test, not(target_arch = "wasm32")))]
mod stack_tests {
    use super::tests::*;
    use super::*;

    /// 親が子に渡す envvar。`<スタックのバイト数>:<段数>:<plain|host>`
    const PROBE: &str = "BOA_STACK_PROBE";

    /// 素の自己再帰。フレームはヒープの `Vec` に積まれる
    fn plain_page(depth: usize) -> String {
        format!(
            r#"<p id="out"></p><script>
            function deep(n) {{ return n <= 0 ? 0 : deep(n - 1) + 1 }}
            document.getElementById("out").setAttribute("data-d", String(deep({depth})));
            </script>"#
        )
    }

    /// getter の中から自分を読む再帰。ホスト (`object/operations.rs`) が
    /// VM に再入するので、こちらはホストのスタックを伸ばす
    fn host_page(depth: usize) -> String {
        format!(
            r#"<p id="out"></p><script>
            var obj = {{}}, n = 0;
            Object.defineProperty(obj, "x", {{ get: function () {{
              n = n + 1;
              if (n >= {depth}) return n;
              return obj.x;
            }} }});
            document.getElementById("out").setAttribute("data-d", String(obj.x));
            </script>"#
        )
    }

    /// 子プロセスとして起きたときだけ意味のある本体。
    /// 生き延びたら `survived` を出して 0 で終わる。スタックが尽きたら
    /// プロセスごと落ちる (それを親が見る)
    #[test]
    #[ignore = "親 (the_native_stack_depth) が子プロセスとして呼ぶ"]
    fn stack_probe() {
        let Ok(spec) = std::env::var(PROBE) else {
            eprintln!("{PROBE} が無いので何もしない");
            return;
        };
        let parts: Vec<&str> = spec.split(':').collect();
        let stack: usize = parts[0].parse().unwrap();
        let depth: usize = parts[1].parse().unwrap();
        let kind = parts[2].to_string();

        let handle = std::thread::Builder::new()
            .stack_size(stack)
            .spawn(move || {
                let html = match kind.as_str() {
                    "plain" => plain_page(depth),
                    "host" => host_page(depth),
                    other => panic!("unknown probe kind {other}"),
                };
                // ここで測りたいのはスタックなので、engine の上限は全部外す
                // (`with_runtime_limits` が触れない `stack_size` だけは残る)
                let (mut doc, errors, _) =
                    run_page(&html, &[], u64::MAX, usize::MAX, 2);
                (attr(&mut doc, "out", "data-d"), errors)
            })
            .unwrap();
        let (reached, errors) = handle.join().unwrap();
        match reached {
            Some(_) => println!("REACHED stack={stack} depth={depth}"),
            // 上限に当たった (JS の例外として拾えた) = スタックは生きている
            None => println!("LIMIT stack={stack} depth={depth} errors={errors:?}"),
        }
    }

    /// 子プロセスの結末
    #[derive(Debug, PartialEq, Eq)]
    enum Probe {
        /// その段数まで走り切った
        Reached,
        /// engine の上限に当たった (拾える。プロセスは生きている)
        Limit,
        /// プロセスが落ちた (スタックの溢れ = wasm ならトラップ)
        Crashed,
    }

    fn probe(stack: usize, depth: usize, kind: &str) -> Probe {
        let exe = std::env::current_exe().expect("test binary");
        let out = std::process::Command::new(exe)
            .args([
                "--exact",
                "script::stack_tests::stack_probe",
                "--ignored",
                "--nocapture",
            ])
            .env(PROBE, format!("{stack}:{depth}:{kind}"))
            .output()
            .expect("spawn the probe");
        let stdout = String::from_utf8_lossy(&out.stdout);
        if stdout.contains("REACHED") {
            Probe::Reached
        } else if stdout.contains("LIMIT") {
            Probe::Limit
        } else {
            Probe::Crashed
        }
    }

    /// `kind` の再帰が `cap` までの間にどこで走り切れなくなるかを挟む。
    /// 返すのは (最後に走り切れた段数, そこで何が起きたか)
    fn ceiling(kind: &str, cap: usize) -> (usize, Probe) {
        const STACK: usize = 1 << 20;
        let mut lo = 8usize;
        assert_eq!(probe(STACK, lo, kind), Probe::Reached, "{kind}: {lo} must fit");
        let mut hi = lo * 2;
        let mut outcome = Probe::Reached;
        while hi <= cap {
            match probe(STACK, hi, kind) {
                Probe::Reached => {
                    lo = hi;
                    hi *= 2;
                }
                other => {
                    outcome = other;
                    break;
                }
            }
        }
        if hi > cap {
            return (lo, Probe::Reached);
        }
        while lo + 1 < hi {
            let mid = (lo + hi) / 2;
            match probe(STACK, mid, kind) {
                Probe::Reached => lo = mid,
                other => {
                    hi = mid;
                    outcome = other;
                }
            }
        }
        (lo, outcome)
    }

    /// 1 MB (wasm の既定と同じ幅) のスタックで、それぞれの再帰が何段まで行けるか、
    /// そして**止まり方が「拾える上限」なのか「プロセスの死」なのか**。
    ///
    /// `STACK_PROBE=1 cargo test --release the_native_stack_depth -- --nocapture`
    /// で走らせる (子プロセスを何十個も起こすので既定では skip)
    #[test]
    fn the_native_stack_depth() {
        if std::env::var("STACK_PROBE").is_err() {
            eprintln!("STACK_PROBE=1 を付けたときだけ測る (子プロセスを何十個も起こす)");
            return;
        }

        // 素の再帰。Boa の上限を外しても、1 MB のスタックは割れない。
        // 先に当たるのは Boa 自身の**値スタックの上限** (`stack_size`、既定
        // 10240 スロット) で、これも拾える `RuntimeLimitError`
        let (plain_depth, plain_end) = ceiling("plain", 262_144);
        eprintln!(
            "1 MB stack, plain self-recursion: runs to depth {plain_depth}, then {plain_end:?}"
        );
        assert_eq!(
            plain_end,
            Probe::Limit,
            "plain JS recursion must end in a catchable limit, not a dead process"
        );

        // getter から VM に再入する形。ここはホストのスタックを伸ばす
        let (host_depth, host_end) = ceiling("host", 262_144);
        eprintln!(
            "1 MB stack, getter re-entering the VM: runs to depth {host_depth}, then {host_end:?} \
             (~{} bytes of native stack per frame if it crashed)",
            (1usize << 20) / host_depth.max(1)
        );

        // 出荷している上限は、素の再帰では余裕の内側
        assert!(
            plain_depth > RECURSION_LIMIT,
            "the shipped recursion limit {RECURSION_LIMIT} must be reachable, \
             but plain recursion stopped at {plain_depth}"
        );
        // getter の形は 1 段が値スタックを多く食うので浅いところで止まる。
        // 大事なのは**止まり方**で、プロセスが死んでいなければスタックは無事
        eprintln!(
            "host-re-entrant form: {host_depth} levels, ended in {host_end:?} \
             (a Limit means Boa's own value stack fired before the native one)"
        );
    }
}

/// 上限に当たるページが**いくらの CPU を使うのか**を測る。
///
/// 上限を上げるかどうかは「上げたときに最悪いくら払うか」で決める。
/// native の数字なので wasm ではもっと遅いが、上限どうしの比は見える
#[cfg(all(test, not(target_arch = "wasm32")))]
mod cost_tests {
    use super::tests::*;
    use super::*;

    /// `<script>` の実行だけを測る (パースとレイアウトを外に出す)
    fn time_scripts(html: &str, loop_iterations: u64, recursion: usize) -> (Duration, Vec<String>) {
        let mut doc = prepare_with_limits(
            html,
            config(),
            MapFetcher(Default::default()),
            loop_iterations,
            recursion,
            Duration::from_secs(60),
        );
        doc.inner_mut().resolve(0.0);
        let t = std::time::Instant::now();
        doc.execute_scripts();
        let elapsed = t.elapsed();
        (elapsed, doc.take_js_errors())
    }

    /// 深さの上限ちょうどまで潜って帰るページと、上限を割るページの実時間。
    ///
    /// **native の release で測った数字。** wasm はもっと遅いので絶対値では
    /// なく、上限どうしの比と「上限を割るほうが安い」ことを見る
    #[test]
    fn the_cost_of_a_deep_recursion_page() {
        // 何もしないページ = パース以外の下敷き
        let (floor, _) = time_scripts("<p>x</p><script>1</script>", LOOP_ITERATION_LIMIT, 160);
        eprintln!("empty script: {floor:?}");

        for limit in [RECURSION_LIMIT, 512, 1_024] {
            // 上限の 1 つ下まで潜って帰るのを 200 回 (成功する側の最悪)
            let just_under = limit - 4;
            let html = format!(
                r#"<p id="out"></p><script>
                function deep(n) {{ return n <= 0 ? 0 : deep(n - 1) + 1 }}
                var total = 0, i;
                for (i = 0; i < 200; i++) {{ total = total + deep({just_under}) }}
                document.getElementById("out").setAttribute("data-total", String(total));
                </script>"#
            );
            let (returns, errors) = time_scripts(&html, LOOP_ITERATION_LIMIT, limit);
            assert!(errors.is_empty(), "should have returned: {errors:?}");

            // 上限を割る (失敗する側)。当たった瞬間に畳まれるので安い
            let (overflows, errors) = time_scripts(
                r#"<script>function deep(n) { return deep(n + 1) } deep(0)</script>"#,
                LOOP_ITERATION_LIMIT,
                limit,
            );
            assert!(is_runtime_limit(&errors), "{errors:?}");

            eprintln!(
                "recursion limit {limit}: 200 x depth-{just_under} ({} calls) {returns:?}, \
                 one overflow {overflows:?}",
                200 * just_under
            );
        }

        // ループの上限をまるごと使い切るページ (これがいちばん高い)
        let (spin, errors) = time_scripts(
            r#"<script>while (true) {}</script>"#,
            LOOP_ITERATION_LIMIT,
            RECURSION_LIMIT,
        );
        assert!(is_runtime_limit(&errors), "{errors:?}");
        eprintln!("one frame spending the whole loop budget ({LOOP_ITERATION_LIMIT}): {spin:?}");
    }

    /// **タイマーの上限は黙って切る。** 例外にならないので
    /// `last_js_errors` を見ても分からない。
    ///
    /// 「絵が白いのに JS のエラーが 0 件」を作れるのはここ。
    /// `<script>` の実時間の予算 (`SCRIPT_BUDGET`) は
    /// "out of script budget" を残すので、こちらだけが黙っている
    #[test]
    fn running_out_of_timer_rounds_is_silent() {
        // 1 周ごとに 1 つずつ進む鎖。10 周ぶん置いて 3 周だけ回す
        let html = r#"<p id="out"></p><script>
            var out = document.getElementById("out");
            var n = 0;
            function step() {
              n = n + 1;
              out.setAttribute("data-steps", String(n));
              if (n < 10) { setTimeout(step, 1) }
              else { out.setAttribute("data-done", "yes") }
            }
            setTimeout(step, 1);
            </script>"#;

        let (mut doc, errors, ran) = run_page(html, &[], LOOP_ITERATION_LIMIT, RECURSION_LIMIT, 3);
        assert_eq!(ran, 3, "should have stopped at the round limit");
        assert_eq!(attr(&mut doc, "out", "data-steps").as_deref(), Some("3"));
        assert_eq!(
            attr(&mut doc, "out", "data-done"),
            None,
            "the chain should not have finished"
        );
        assert!(
            errors.is_empty(),
            "running out of timer rounds records nothing: {errors:?}"
        );

        // 周を足せば終わる
        let (mut doc, errors, _) = run_page(html, &[], LOOP_ITERATION_LIMIT, RECURSION_LIMIT, 32);
        assert_eq!(attr(&mut doc, "out", "data-done").as_deref(), Some("yes"));
        assert!(errors.is_empty(), "{errors:?}");
    }

    /// `<script>` の予算を使い切ったときは、**飛ばした本数が例外に残る**
    #[test]
    fn running_out_of_the_script_budget_is_reported() {
        let html = r#"<p id="out"></p>
            <script>document.getElementById("out").setAttribute("data-first", "ran")</script>
            <script>document.getElementById("out").setAttribute("data-second", "ran")</script>"#;
        let fetcher = MapFetcher(Default::default());
        // 予算を 0 にすると 1 本目から飛ばす
        let mut doc = prepare_with_limits(
            html,
            config(),
            fetcher,
            LOOP_ITERATION_LIMIT,
            RECURSION_LIMIT,
            Duration::ZERO,
        );
        doc.inner_mut().resolve(0.0);
        doc.execute_scripts();
        let errors = doc.take_js_errors();
        assert_eq!(attr(&mut doc, "out", "data-first"), None);
        assert!(
            errors.iter().any(|e| e.contains("out of script budget")),
            "{errors:?}"
        );
    }
}

/// ブラウザの並べ方と `execute_scripts` の並べ方の差。
///
/// 「エラーは 0 件なのにページが白い」を作れるのは上限だけではない。
/// **走らせる順**が browser と違えば、エラーを出さずに壊れる
#[cfg(all(test, not(target_arch = "wasm32")))]
mod order_tests {
    use super::tests::*;
    use super::*;

    /// **`defer` を見ていない。** `collect_scripts` は `script` 要素を
    /// 文書順に集めるだけで、`defer` / `async` 属性を読まない
    /// (`vendor/blitz-vibey-script/src/document.rs` の `collect_scripts`)。
    ///
    /// ブラウザは `defer` を「文書を読み終えたあと、`DOMContentLoaded` の前」に
    /// 回すので、`defer` の外部スクリプトと素のインラインが混ざったページでは
    /// 順が入れ替わる。`crate/fixtures/todomvc.html` がまさにこの形
    /// (`app.bundle.js` が defer、`base.js` が素)
    #[test]
    fn defer_is_not_honoured() {
        // ブラウザなら: base.js (素) -> app.js (defer)。
        // ここでは文書順なので app.js が先に走る
        let html = r#"<p id="out"></p>
            <script defer src="/app.js"></script>
            <script src="/base.js"></script>"#;
        let files = [
            (
                "app.js",
                r#"document.getElementById("out").setAttribute("data-order",
                    (typeof BASE === "undefined" ? "app-first" : "base-first"))"#,
            ),
            ("base.js", "var BASE = 1"),
        ];
        let (mut doc, errors, _) =
            run_page(html, &files, LOOP_ITERATION_LIMIT, RECURSION_LIMIT, 4);
        assert!(errors.is_empty(), "{errors:?}");
        assert_eq!(
            attr(&mut doc, "out", "data-order").as_deref(),
            Some("app-first"),
            "defer is ignored: the deferred script runs in document order"
        );
    }

    /// マイクロタスクはタイマーの周のあいだに流れている。
    /// `run_due_timers` が毎周 `run_jobs` を呼ぶので、
    /// 「マクロタスクで起きて、あとは await で進む」形は進む
    /// (React 18 のスケジューラがこの形)
    #[test]
    fn microtasks_are_pumped_between_timer_rounds() {
        let html = r#"<p id="out"></p><script>
            var out = document.getElementById("out");
            var log = [];
            setTimeout(function () {
              log.push("macro");
              Promise.resolve()
                .then(function () { log.push("micro1") })
                .then(function () { log.push("micro2") })
                .then(function () { out.setAttribute("data-log", log.join(",")) });
            }, 1);
            </script>"#;
        let (mut doc, errors, _) = run_page(html, &[], LOOP_ITERATION_LIMIT, RECURSION_LIMIT, 4);
        assert!(errors.is_empty(), "{errors:?}");
        assert_eq!(
            attr(&mut doc, "out", "data-log").as_deref(),
            Some("macro,micro1,micro2"),
            "promise jobs should drain inside the timer round"
        );
    }

    /// 実行済みの `<script>` は DOM に残る (ブラウザと同じ)。
    /// `document.getElementsByTagName('script')[0]` を使う定番のスニペットが
    /// 生きるかどうかの確認
    #[test]
    fn executed_scripts_stay_in_the_dom() {
        let html = r#"<p id="out"></p><script>
            document.getElementById("out").setAttribute("data-scripts",
              String(document.getElementsByTagName("script").length));
            </script>"#;
        let (mut doc, errors, _) = run_page(html, &[], LOOP_ITERATION_LIMIT, RECURSION_LIMIT, 2);
        assert!(errors.is_empty(), "{errors:?}");
        assert_eq!(attr(&mut doc, "out", "data-scripts").as_deref(), Some("1"));
    }
}

/// 実物の `react.dev` を native で走らせて、**本文が消えるところを見る**。
///
/// 上限が原因ではないことは [`react_tests`] で分かった。では何が消しているのか。
/// 手元に落とした `react.dev` 一式 (HTML + `<script src>` 10 本) を
/// そのまま食わせて、JS を走らせる前と後で本文の量を比べる。
///
/// `crate/fixtures/` は .gitignore されているので、無ければ何もしない。
///
/// ```bash
/// # crate/fixtures/reactdev/{page.html, manifest.tsv, files/*.js} を用意して
/// REACTDEV_PROBE=1 cargo test --release reactdev -- --nocapture
/// ```
#[cfg(all(test, not(target_arch = "wasm32")))]
mod reactdev_tests {
    use super::tests::*;
    use super::*;
    use std::collections::HashMap;

    const DIR: &str = "fixtures/reactdev";

    /// 絶対 URL の表から返す fetcher
    struct UrlFetcher(HashMap<String, String>);

    impl ScriptFetcher for UrlFetcher {
        fn fetch(&self, url: &Url) -> Result<String, FetchError> {
            self.0
                .get(url.as_str())
                .cloned()
                .ok_or_else(|| FetchError::InvalidData(format!("not in the fixture: {url}")))
        }
    }

    /// (HTML, URL -> 中身) を読む。無ければ `None`
    fn fixture() -> Option<(String, HashMap<String, String>)> {
        let html = std::fs::read_to_string(format!("{DIR}/page.html")).ok()?;
        let manifest = std::fs::read_to_string(format!("{DIR}/manifest.tsv")).ok()?;
        let mut files = HashMap::new();
        for line in manifest.lines() {
            let (url, name) = line.split_once('\t')?;
            let body = std::fs::read_to_string(format!("{DIR}/{name}")).ok()?;
            files.insert(url.to_string(), body);
        }
        Some((html, files))
    }

    /// `defer` の付いた `<script>` を `</body>` の直前へ移す。
    /// ブラウザの並べ方 (defer は文書を読み終えたあと) に合わせる
    fn move_defer_to_the_end(html: &str) -> String {
        let mut rest = String::with_capacity(html.len());
        let mut deferred = String::new();
        let mut cursor = 0;
        while let Some(start) = html[cursor..].find("<script").map(|i| cursor + i) {
            let Some(end) = html[start..].find("</script>").map(|i| start + i + 9) else {
                break;
            };
            let tag = &html[start..end];
            let open_end = tag.find('>').unwrap_or(tag.len());
            rest.push_str(&html[cursor..start]);
            if tag[..open_end].contains("defer") {
                deferred.push_str(tag);
            } else {
                rest.push_str(tag);
            }
            cursor = end;
        }
        rest.push_str(&html[cursor..]);
        match rest.rfind("</body>") {
            Some(at) => format!("{}{deferred}{}", &rest[..at], &rest[at..]),
            None => format!("{rest}{deferred}"),
        }
    }

    /// `<body>` の文字数と、拾われなかった例外
    fn body_text_len(html: &str, files: &HashMap<String, String>, run_js: bool) -> (usize, Vec<String>) {
        let config = DocumentConfig {
            viewport: Some(blitz_traits::shell::Viewport::new(
                1000,
                800,
                1.0,
                blitz_traits::shell::ColorScheme::Light,
            )),
            base_url: Some("https://react.dev/".to_string()),
            style_threading: blitz_dom::StyleThreading::Sequential,
            ..Default::default()
        };
        let mut doc = prepare_with_limits(
            html,
            config,
            UrlFetcher(files.clone()),
            LOOP_ITERATION_LIMIT,
            RECURSION_LIMIT,
            SCRIPT_BUDGET,
        );
        doc.inner_mut().resolve(0.0);
        let mut errors = Vec::new();
        if run_js {
            doc.execute_scripts();
            run_timers(&mut doc, TIMER_ROUNDS);
            errors = doc.take_js_errors();
        }
        let inner: &blitz_dom::BaseDocument = &doc.inner_mut();
        let len = inner
            .query_selector("body")
            .ok()
            .flatten()
            .and_then(|node| inner.get_node(node))
            .map(|node| node.text_content().trim().chars().count())
            .unwrap_or(0);
        (len, errors)
    }

    /// Worker が差し込んでいる shim (`src/polyfill.js` の `POLYFILL`) を
    /// `<head>` の頭に入れる。本番と同じ顔で走らせるため。
    ///
    /// ```bash
    /// node -e "import('./src/polyfill.js').then(m=>process.stdout.write(m.POLYFILL))" \
    ///   > crate/fixtures/reactdev/polyfill.js
    /// ```
    fn inject_polyfill(html: &str) -> String {
        let Ok(js) = std::fs::read_to_string(format!("{DIR}/polyfill.js")) else {
            return html.to_string();
        };
        let tag = format!("<script>{js}</script>");
        match html.find("<head>") {
            Some(at) => format!("{}{tag}{}", &html[..at + 6], &html[at + 6..]),
            None => format!("{tag}{html}"),
        }
    }

    /// 文書順のまま走らせたときと、`defer` をブラウザの位置に直したときで
    /// 本文が残るかを比べる
    #[test]
    fn reactdev_body_survival() {
        if std::env::var("REACTDEV_PROBE").is_err() {
            eprintln!("REACTDEV_PROBE=1 を付けたときだけ測る (実ページ 1 枚を走らせる)");
            return;
        }
        let Some((html, files)) = fixture() else {
            eprintln!("{DIR} が無いので skip");
            return;
        };

        let (no_js, _) = body_text_len(&html, &files, false);
        eprintln!("js off             : body {no_js} chars");

        let t = std::time::Instant::now();
        let (doc_order, errors) = body_text_len(&html, &files, true);
        eprintln!(
            "js on, doc order   : body {doc_order} chars in {:?}, errors {errors:?}",
            t.elapsed()
        );

        let browser_order_html = move_defer_to_the_end(&html);
        let t = std::time::Instant::now();
        let (browser_order, errors) = body_text_len(&browser_order_html, &files, true);
        eprintln!(
            "js on, defer last  : body {browser_order} chars in {:?}, errors {errors:?}",
            t.elapsed()
        );

        // 本番と同じ shim を入れる。エラーが減っても本文が戻らないなら、
        // 消しているのは「足りない Web API」ではなく React のやり直し
        let with_polyfill = inject_polyfill(&html);
        let t = std::time::Instant::now();
        let (polyfilled, errors) = body_text_len(&with_polyfill, &files, true);
        eprintln!(
            "js on, + polyfill  : body {polyfilled} chars in {:?}, errors {errors:?}",
            t.elapsed()
        );

        let with_both = inject_polyfill(&browser_order_html);
        let (both, errors) = body_text_len(&with_both, &files, true);
        eprintln!("js on, both fixes  : body {both} chars, errors {errors:?}");

        assert!(no_js > 1_000, "the server HTML should have a body: {no_js}");
        // shim が無いと、インラインの 1 本が `matchMedia` で落ちて本文が減る
        assert!(
            doc_order < no_js * 2 / 3,
            "without the shim React should have replaced most of the body: \
             {no_js} -> {doc_order} chars"
        );
        // **shim を入れると本文は残る。** つまり本文を消していたのは
        // 上限でも `defer` の順でもなく、足りない Web API だった
        assert!(
            polyfilled > no_js * 9 / 10,
            "with the shim the body should survive: {no_js} -> {polyfilled} chars"
        );
        // `defer` の並べ直しはどちらの場合も効かない
        assert_eq!(doc_order, browser_order, "moving defer last changes nothing");
        assert_eq!(polyfilled, both, "moving defer last changes nothing");
    }
}
