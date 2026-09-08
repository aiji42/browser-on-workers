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
//! Worker は 500 を返す。JS を切れば描ける

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
/// Boa の既定は無制限。超えると `RuntimeLimitError` が JS の例外として飛ぶ。
/// **数え方はフレームごとの通算**で、ループを抜けても 0 に戻らない。つまり
/// 1 つの関数の中のループは全部でこの予算を分け合う。実ページの初期化に
/// 何十万回もループするものは無い一方、`while (true) {}` はここで死ぬ。
///
/// 50 万回は wasm で 150ms ほど (手元の計測。`for (;;) {}` が 200 万回で
/// 1.3 秒だった)。フレームごとの予算なので、関数の数だけ使い回せる。
/// それを止めるのが [`SCRIPT_BUDGET`]
const LOOP_ITERATION_LIMIT: u64 = 500_000;

/// JS の呼び出しの深さ。Boa の既定は 512。
///
/// Boa は JS の呼び出しをホストのスタックの再帰で実装しているので、深いほう
/// から先に wasm のスタックが尽きる。スタックの溢れは JS の例外ではなく
/// wasm のトラップ (助けようが無い) なので、Boa の上限を先に当てる
const RECURSION_LIMIT: usize = 160;

/// `<script>` の実行に使える実時間。これを過ぎたら、まだ走らせていない
/// `<script>` は飛ばす (走っているものは止められない)。
///
/// ループの上限は 1 フレームぶんなので、関数や `<script>` の数だけ使い回せる。
/// 実時間で見ておかないと、上限を守ったまま何十秒も使える
const SCRIPT_BUDGET: Duration = Duration::from_millis(1_500);

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
    ScriptDocument::from_html(html, config)
        // タイマーの起き上がりを知らせる背景スレッドは要らない。
        // wasm32-unknown-unknown にはそもそもスレッドが無く、
        // `thread::Builder::spawn` は Err を返す (crate 側は expect で panic する)
        .without_timer_thread()
        // 時間は自分で進める。`setTimeout(f, 3000)` を実時間で待たない
        .with_virtual_time()
        // 暴走を止める上限 (どちらも vendor 側で足した口)
        .with_runtime_limits(LOOP_ITERATION_LIMIT, RECURSION_LIMIT)
        .with_deadline(web_time::Instant::now() + SCRIPT_BUDGET)
        // 外部スクリプトは資源の表から
        .with_fetcher(TableScriptFetcher { net })
}

/// `<script>` を文書順に実行し、溜まったタイマーを少しだけ回す。
///
/// 落ちないことを優先する。スクリプトが投げた例外は
/// `blitz-vibey-script` が拾って溜めるので、ここでは最後に
/// [`last_js_errors`] へ移すだけ
pub(crate) fn run(doc: &mut ScriptDocument) {
    doc.execute_scripts();
    drain_timers(doc);
    *LAST_JS_ERRORS.lock().unwrap_or_else(|e| e.into_inner()) = doc.take_js_errors();
}

/// 溜まっているタイマーを仮想時間で進める。回数と仮想時間の 2 つで切る
fn drain_timers(doc: &mut ScriptDocument) {
    let horizon = doc.clock_now() + VIRTUAL_TIME_HORIZON;
    let until = web_time::Instant::now() + TIMER_BUDGET;
    for _ in 0..TIMER_ROUNDS {
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
    }
}
