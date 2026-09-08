//! document を 1 つ生かしたまま、サブリソースを**後から**受け取る。
//!
//! `net.rs` の表は「描く前に JS が全部渡してある」前提で、引けなかった URL は
//! 空のバイト列で答えてから `missed_resources` に控える。JS はそれを取ってきて
//! 表に足し、**document を組み直して**もう 1 度描く。段が増えるたびに全文の
//! パースが 1 回増える (`@import` が 3 段あるページは 4 回パースする)。
//!
//! こちらは document を 1 つだけ組み、`NetProvider::fetch` に来た
//! `Box<dyn NetHandler>` を**手元に置いたまま返る**。JS は `sess_pending` で
//! 待っている URL を見て、取ってきたバイト列を `sess_provide` で渡す。そこで
//! 初めて handler を呼ぶので、blitz-dom から見れば「応答が遅れて届いた」だけ。
//! document は組み直さない。
//!
//! `NetHandler` は `Send + Sync + 'static` なので、handler を `Mutex<Vec<_>>` に
//! 溜めておける (`BaseDocument` のほうは `Send` ではないので、document 自体は
//! `dom.rs` と同じく `thread_local!` の slot 表に置く)。
//!
//! この経路は後で CDP の session の下敷きにする。JS の turn を何度もまたいで
//! 同じ document が生き続ける、というのがここで欲しい性質。
//!
//! ```js
//! const doc = sess_open(html, base, 800, 600, true);
//! for (let i = 0; i < 8; i++) {
//!   const urls = sess_pending(doc);
//!   if (urls.length === 0) break;
//!   for (const url of urls) {
//!     try { sess_provide(doc, url, new Uint8Array(await (await fetch(url)).arrayBuffer())); }
//!     catch { sess_fail(doc, url); }
//!   }
//!   if (sess_settle(doc) === 0) break;
//! }
//! sess_run_scripts(doc);   // <script src> の中身が届いてから
//! const rgba = sess_paint(doc);
//! sess_close(doc);
//! ```
//!
//! # 待たせてよい URL と、待たせてはいけない URL
//!
//! 応答せずに handler を捨てると `<head>` の `<link rel="stylesheet">` が
//! `pending_critical_resources` に残り、`doc.resolve` が先頭で早期 return して
//! **永久に何も描かなくなる** (`net.rs` の頭に書いたのと同じ話)。待たせるのは
//! 「JS があとで答えてくれる」という約束の上でだけ成り立つので、
//!
//! - `data:` は通信ではないのでその場で解く
//! - `http(s)` でない scheme は待たせない。待たせると JS が取りに行けない URL が
//!   `sess_pending` に出て、ループが終わらなくなる
//! - すでに手元にある URL (この session に渡されたもの、`add_resource` で
//!   先に渡されたもの) も待たせない
//! - 待ちの数には上限を置く ([`MAX_DEFERRED`])。超えたぶんは空で答える
//!
//! そして JS 側は、取れなかった URL には必ず `sess_fail` を返す。
//!
//! # `<script src>` も `sess_pending` に出る
//!
//! blitz-dom は `<script>` を取りに行かない (`NetProvider` を通らない)。外部
//! スクリプトの中身は `blitz-vibey-script` の `ScriptFetcher` が**同期で**引く。
//! 引けなければその `<script>` は黙って飛ばされ、`execute_scripts` は 2 度目を
//! 走らせないので、あとで中身が届いても手遅れになる。
//!
//! なので `sess_open` の時点で `<script src>` の URL を待ちに並べておく。
//! handler は無いが `sess_pending` には出るので、JS は資源と同じループで
//! 取ってきて `sess_provide` できる。**`sess_pending` が空になってから
//! `sess_run_scripts` を呼ぶこと**が、この設計での約束になる。

use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use anyrender::{ImageRenderer, PaintScene};
use anyrender_vello_cpu::VelloCpuImageRenderer;
use blitz_dom::{BaseDocument, Document, DocumentConfig, FontContext, StyleThreading};
use blitz_traits::net::{Bytes, NetHandler, NetProvider, Request};
use blitz_traits::shell::{ColorScheme, Viewport};
use blitz_vibey_script::{FetchError, ScriptDocument, ScriptFetcher};
use kurbo::{Affine, Rect};
use peniko::{Color, Fill};
use url::Url;
use wasm_bindgen::prelude::*;

/// 1 つの document が同時に待たせられる handler の数。
///
/// 悪意のあるページは `<img>` を 100 万個書ける。待ちは JS が答えるまで
/// 残るので、上限を置かないと wasm のメモリがそれだけで埋まる。超えたぶんは
/// 待たせずに空で答える (= その資源は無かったことになる)。`sess_pending` にも
/// 出ないので、JS からは「そんな URL は要求されなかった」ように見える
const MAX_DEFERRED: usize = 256;

/// `resolve` を回す回数の上限。`crate::settle` と同じ
const SETTLE_ROUNDS: usize = 4;

/// document ごとに溜める JS の例外の数。Boa 側も drain の間に 256 までしか
/// 持たないので、こちらも同じところで切る
const MAX_JS_ERRORS: usize = 256;

/// 応答を待っている要求 1 つ
struct Wait {
    /// JS に見せる鍵。fragment を落としたもの (`net.rs` の表と同じ形)。
    /// SVG sprite の `icons.svg#a` と `icons.svg#b` はこれで 1 本にまとまる
    key: String,
    /// blitz-dom が組んだ `Request` の URL そのまま。
    ///
    /// handler に渡すのは**必ずこちら**。blitz-dom はこの文字列を鍵に
    /// 「この画像を待っているノード」を引く (`pending_images`) ので、
    /// 鍵のほうを渡すと画像は読めているのにどのノードにも入らない
    url: String,
    /// 応答を待っている handler。`<script src>` の待ちだけ `None`
    /// (blitz-dom は script を取りに行かないので handler が無い)
    handler: Option<Box<dyn NetHandler>>,
}

/// 応答を遅らせる `NetProvider`。
///
/// `TableNetProvider` は表を引いて `fetch` の中で答えを出しきるが、こちらは
/// 手元に無いものを**答えずに持っておく**。答えるのは `sess_provide` /
/// `sess_fail` が呼ばれたとき
pub struct DeferredNetProvider {
    /// この session に届いたバイト列。鍵は fragment を落とした絶対 URL。
    ///
    /// 同じ URL が 2 度要求されることはある (JS が `<img>` を作り直した、
    /// SVG sprite を別の fragment で参照した)。届いたものを覚えておかないと
    /// 待ちに並び直して、JS に同じ URL をもう 1 度取らせてしまう
    table: Mutex<HashMap<String, Bytes>>,
    /// 応答を待っている要求。要求された順
    waits: Mutex<Vec<Wait>>,
    /// `fetch` が呼ばれた回数。`resolve` を何周回すかの目印 (`crate::settle` と同じ)
    fetches: AtomicUsize,
    /// 上限に当たって空で答えた数 (確認用)
    dropped: AtomicUsize,
}

impl DeferredNetProvider {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            table: Mutex::new(HashMap::new()),
            waits: Mutex::new(Vec::new()),
            fetches: AtomicUsize::new(0),
            dropped: AtomicUsize::new(0),
        })
    }

    /// `fetch` が呼ばれた回数
    fn fetches(&self) -> usize {
        self.fetches.load(Ordering::Relaxed)
    }

    /// 上限に当たって空で答えた数
    #[cfg_attr(not(test), allow(dead_code))]
    fn dropped(&self) -> usize {
        self.dropped.load(Ordering::Relaxed)
    }

    /// 手元にあるバイト列を引く。この session に届いたものが先、次に
    /// グローバルの表 (`add_resource`)。
    ///
    /// lock はこの関数の中で閉じる。返り値をもらってから handler を呼ぶこと
    /// (`net.rs` の `record_miss` と同じ理由。stylesheet を返すと blitz-dom が
    /// `@import` や `@font-face` のために `fetch` を再入する)
    fn known(&self, key: &str) -> Option<Bytes> {
        let found = {
            let table = self.table.lock().unwrap_or_else(|e| e.into_inner());
            table.get(key).cloned()
        };
        found.or_else(|| crate::net::global_lookup(key))
    }

    /// JS が取りに行ける URL か。待たせてよいのは http(s) だけ
    fn fetchable(key: &str) -> bool {
        key.starts_with("http://") || key.starts_with("https://")
    }

    /// 待ちに 1 つ積む。上限に当たったら handler を**呼び出し側に返す**。
    ///
    /// 返すのは、lock を持ったまま handler を呼ばないため
    /// (`fetch` は handler の中から再入する)
    fn stash(&self, wait: Wait) -> Option<Box<dyn NetHandler>> {
        let mut waits = self.waits.lock().unwrap_or_else(|e| e.into_inner());
        if waits.len() >= MAX_DEFERRED {
            drop(waits);
            self.dropped.fetch_add(1, Ordering::Relaxed);
            return wait.handler;
        }
        waits.push(wait);
        None
    }

    /// handler を持たない待ちを足す (`<script src>` 用)。
    ///
    /// もう手元にあるもの、JS が取りに行けないもの、すでに並んでいるものは足さない
    fn want(&self, url: &str) {
        let key = crate::net::normalize(url);
        if !Self::fetchable(&key) || self.known(&key).is_some() {
            return;
        }
        {
            let waits = self.waits.lock().unwrap_or_else(|e| e.into_inner());
            if waits.iter().any(|w| w.key == key) {
                return;
            }
        }
        let url = key.clone();
        self.stash(Wait {
            key,
            url,
            handler: None,
        });
    }

    /// 待っている URL。要求された順、重複なし
    fn pending(&self) -> Vec<String> {
        let waits = self.waits.lock().unwrap_or_else(|e| e.into_inner());
        let mut urls: Vec<String> = Vec::new();
        for wait in waits.iter() {
            if !urls.iter().any(|url| *url == wait.key) {
                urls.push(wait.key.clone());
            }
        }
        urls
    }

    /// 待っている URL 1 つに答える。handler を持っていたら `true`。
    ///
    /// - 同じ URL を待っている handler は**全部**答える (SVG sprite を別の
    ///   fragment で参照した、同じ画像を 2 箇所に置いた、といった場合)
    /// - handler を呼ぶ前に必ず lock を手放す。stylesheet を返すと blitz-dom が
    ///   `@import` と `@font-face` のために `fetch` を再入するので、待ちの lock を
    ///   持ったまま呼ぶと自分自身と競合して固まる
    /// - 待っていない URL でも表には残す。あとで要求されたときに待たせずに
    ///   答えられる (待たせると JS が同じ URL をもう 1 度取ることになる)
    fn provide(&self, url: &str, bytes: Bytes) -> bool {
        let key = crate::net::normalize(url);
        {
            let mut table = self.table.lock().unwrap_or_else(|e| e.into_inner());
            table.insert(key.clone(), bytes.clone());
        }

        let taken = {
            let mut waits = self.waits.lock().unwrap_or_else(|e| e.into_inner());
            let (taken, kept): (Vec<Wait>, Vec<Wait>) =
                std::mem::take(&mut *waits).into_iter().partition(|w| w.key == key);
            *waits = kept;
            taken
        };

        let mut answered = false;
        for wait in taken {
            // `<script src>` の待ちには handler が無い。表に入れた時点で済み
            if let Some(handler) = wait.handler {
                answered = true;
                handler.bytes(wait.url, bytes.clone());
            }
        }
        answered
    }

    /// 待っている handler を答えずに捨てる。
    ///
    /// document を捨てるときに呼ぶ。stylesheet の handler は
    /// `Arc<dyn NetProvider>` (= この provider) を抱えているので、handler を
    /// 持ったまま provider を落とそうとすると輪になってどちらも解放されない
    fn forget(&self) {
        self.waits
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clear();
    }

    /// 外部スクリプトの中身を文字列で引く。
    ///
    /// 引けなかったら待ちに並べて `None`。ただし `execute_scripts` は 2 度目を
    /// 走らせないので、ここに落ちた `<script>` はもう実行されない
    /// (`sess_pending` が空になるまで待ってから `sess_run_scripts` を呼ぶこと)
    fn text(&self, url: &str) -> Option<String> {
        let key = crate::net::normalize(url);
        match self.known(&key) {
            Some(bytes) => Some(String::from_utf8_lossy(&bytes).into_owned()),
            None => {
                self.want(&key);
                None
            }
        }
    }
}

impl NetProvider for DeferredNetProvider {
    fn fetch(&self, _doc_id: usize, request: Request, handler: Box<dyn NetHandler>) {
        self.fetches.fetch_add(1, Ordering::Relaxed);
        let url = request.url.as_str().to_string();

        // data: URL は「通信」ではないので、ここで解いてしまう
        // (`TableNetProvider::lookup` と同じ。JS には見せない)
        if url.starts_with("data:") {
            let bytes = data_url::DataUrl::process(&url)
                .ok()
                .and_then(|data| data.decode_to_vec().ok())
                .map(|(bytes, _)| Bytes::from(bytes))
                .unwrap_or_default();
            handler.bytes(url, bytes);
            return;
        }

        let key = crate::net::strip_fragment(&url).to_string();

        // もう手元にあるものは待たせない
        if let Some(bytes) = self.known(&key) {
            handler.bytes(url, bytes);
            return;
        }

        // JS が取りに行けない scheme は待たせない。`base_url` を渡さなかった
        // ときの `https://inline.invalid/...` のように、取りに行っても無駄な
        // ものもあるが、それは JS が `sess_fail` で返せばよい
        if !Self::fetchable(&key) {
            handler.bytes(url, Bytes::new());
            return;
        }

        // ここから先が「答えずに返る」経路。上限に当たったら空で答える
        // (答えないまま捨てると `<head>` の stylesheet がページを止める)
        let wait = Wait {
            key,
            url: url.clone(),
            handler: Some(handler),
        };
        if let Some(handler) = self.stash(wait) {
            handler.bytes(url, Bytes::new());
        }
    }
}

/// 外部スクリプト (`<script src>` と ES module の import) を、この session に
/// 届いたバイト列から返す
struct SessionScriptFetcher {
    net: Arc<DeferredNetProvider>,
}

impl ScriptFetcher for SessionScriptFetcher {
    fn fetch(&self, url: &Url) -> Result<String, FetchError> {
        match self.net.text(url.as_str()) {
            Some(source) => Ok(source),
            None => Err(FetchError::InvalidData(format!(
                "not provided to this session: {url}"
            ))),
        }
    }
}

/// 開いている document 1 つ。
///
/// JS を走らせるかどうかで持ち物が変わる。`blitz-vibey-script` は
/// `BaseDocument` を `Rc<RefCell<_>>` で抱えてしまって取り出せないので、
/// JS 有りのときは `ScriptDocument` のまま持つ
enum Doc {
    Plain(BaseDocument),
    /// JS 有り。`with_deadline` が `self` を取るので、実時間の予算を貼り直す
    /// あいだだけ抜き出せるように `Option` にしてある (`None` はその瞬間だけ)
    Script(Option<ScriptDocument>),
}

impl Doc {
    /// スタイル・レイアウト・描画に使う共通の口
    fn document(&mut self) -> Option<&mut dyn Document> {
        match self {
            Doc::Plain(doc) => Some(doc),
            Doc::Script(slot) => slot.as_mut().map(|doc| doc as &mut dyn Document),
        }
    }

    /// JS の context。JS 無しで開いた document では `None`
    fn script(&mut self) -> Option<&mut ScriptDocument> {
        match self {
            Doc::Plain(_) => None,
            Doc::Script(slot) => slot.as_mut(),
        }
    }
}

/// 開いている session 1 つ
struct Page {
    doc: Doc,
    /// この document の応答を預かっている provider
    net: Arc<DeferredNetProvider>,
    width: u32,
    height: u32,
    /// `sess_run_scripts` を通したか。2 度目は走らせない
    scripts_ran: bool,
    /// この document で拾われなかった JS の例外。turn をまたいで溜まる
    /// (グローバルの `last_js_errors` は描画ごとに置き換わるので使えない)
    js_errors: Vec<String>,
}

impl Drop for Page {
    fn drop(&mut self) {
        // 待っている handler を先に捨てる。handler は provider を抱えていて、
        // provider は handler を抱えているので、そのままでは輪が残る
        self.net.forget();
    }
}

/// 開いている session の表。`dom.rs` の `SLOTS` と同じ形だが**別の表**
/// (handle の番号は混ざらない)。`0` は `sess_open` の失敗を表すので使わない
struct Slots {
    pages: HashMap<u32, Page>,
    next: u32,
}

thread_local! {
    static SLOTS: RefCell<Slots> = RefCell::new(Slots {
        pages: HashMap::new(),
        next: 1,
    });
}

/// session を借りて何かする。handle が無ければ `R` の既定値を返す
/// (`sess_close` した handle を JS が使い続けても「無い」が返るだけ)
fn with<R: Default>(doc: u32, f: impl FnOnce(&mut Page) -> R) -> R {
    SLOTS.with(|slots| {
        let mut slots = slots.borrow_mut();
        match slots.pages.get_mut(&doc) {
            Some(page) => f(page),
            None => R::default(),
        }
    })
}

// === ライフサイクル ===

/// document を開く。**`<script>` は実行しない** ([`sess_run_scripts`] が実行する)。
///
/// サブリソースは表から引かずに**応答を待たせる**。開いた直後に
/// `sess_pending` を読むと、`<head>` の stylesheet や `<img>` のように
/// パースの時点で要求された URL が並んでいる。
///
/// - 返り値は 0 でない document handle。失敗したら 0 で、理由は `last_panic()`
/// - `run_js` を真にすると Boa の context 付きで組む。`<script>` の実行は
///   `sess_run_scripts` まで待つ。`<script src>` の中身は資源のループが
///   1 周してからでないと手元に無いので、ここで走らせると外部スクリプトが
///   丸ごと飛ばされる (`execute_scripts` は 2 度目を走らせない)
/// - フォントは `add_font` で先に渡しておく。サブリソースは `add_resource` で
///   先に渡してもよい (渡してあるものは待たせずに返す)
#[wasm_bindgen]
pub fn sess_open(html: &str, base_url: &str, width: u32, height: u32, run_js: bool) -> u32 {
    if width == 0 || height == 0 || width > crate::dom::MAX_SIDE || height > crate::dom::MAX_SIDE {
        // 描画面が作れない大きさ。panic させずに 0 で返し、理由だけ残す
        if let Ok(mut slot) = crate::LAST_PANIC.lock() {
            *slot = Some(format!(
                "sess_open: viewport {width}x{height} is out of range (1..={})",
                crate::dom::MAX_SIDE
            ));
        }
        return 0;
    }
    open_with(
        html,
        base_url,
        crate::current_font_ctx(),
        width,
        height,
        run_js,
    )
}

/// `sess_open` の本体。`FontContext` を外から渡す
/// (テストがグローバルのフォント表を触らずに開くための口)
fn open_with(
    html: &str,
    base_url: &str,
    font_ctx: FontContext,
    width: u32,
    height: u32,
    run_js: bool,
) -> u32 {
    let net = DeferredNetProvider::new();
    let config = DocumentConfig {
        viewport: Some(Viewport::new(width, height, 1.0, ColorScheme::Light)),
        base_url: Some(crate::base_url_or_fallback(base_url)),
        font_ctx: Some(font_ctx),
        net_provider: Some(net.clone()),
        // wasm32 には rayon のスレッドプールが無いので並列トラバースは使えない
        style_threading: StyleThreading::Sequential,
        // innerHTML への代入で断片を組む parser (`dom.rs` と同じ理由)
        html_parser_provider: Some(Arc::new(blitz_html::HtmlProvider)),
        ..Default::default()
    };

    let doc = if run_js {
        let script_doc = crate::script::prepare_with_fetcher(
            html,
            config,
            SessionScriptFetcher { net: net.clone() },
        );
        // `<script src>` は blitz-dom の `NetProvider` を通らない。実行の
        // ときに手元に無いとその script は飛ばされてしまうので、開いた時点で
        // 待ちに並べて JS に取ってこさせる
        for url in script_doc.external_script_urls() {
            net.want(url.as_str());
        }
        Doc::Script(Some(script_doc))
    } else {
        Doc::Plain(BaseDocument::from(blitz_html::HtmlDocument::from_html(
            html, config,
        )))
    };

    let mut page = Page {
        doc,
        net,
        width,
        height,
        scripts_ran: false,
        js_errors: Vec::new(),
    };
    // 手元にあるぶんだけで 1 度落ち着かせる。`<head>` の stylesheet を
    // 待たせている間は `resolve` が先頭で早期 return するので、ここは
    // 何もしないことも多い
    settle(&mut page);

    SLOTS.with(|slots| {
        let mut slots = slots.borrow_mut();
        let doc = slots.next;
        slots.next += 1;
        slots.pages.insert(doc, page);
        doc
    })
}

/// 取得が増えなくなるまで `resolve` を回す (`crate::settle` と同じ形)。
///
/// 待たせている資源はこの turn では届かないので、ここで進むのは
/// 「もう手元にあるもの」だけ。`sess_provide` で届いたぶんが絵に入るのは
/// 次の `resolve` の頭なので、渡したあとに 1 度これを回す必要がある
fn settle(page: &mut Page) {
    for _ in 0..SETTLE_ROUNDS {
        let before = page.net.fetches();
        if let Some(doc) = page.doc.document() {
            doc.inner_mut().resolve(0.0);
        }
        if page.net.fetches() == before {
            break;
        }
    }
}

/// まだ応答を待っている URL。要求された順、重複なし。
///
/// - fragment を落とした絶対 URL (`fetch` にそのまま渡せる http / https)
/// - `data:` は Rust 側で解くので入らない
/// - SVG sprite の `icons.svg#a` と `icons.svg#b` は 1 本にまとまる
/// - `<script src>` の URL も入る (blitz-dom は script を取りに行かないので、
///   `sess_open` が並べておく)
///
/// JS はこれを取ってきて `sess_provide` か `sess_fail` で全部答える。
/// **1 つでも答えないまま置くと、`<head>` の stylesheet を待っている
/// document は永久に描かれない**
#[wasm_bindgen]
pub fn sess_pending(doc: u32) -> Vec<String> {
    with(doc, |page| page.net.pending())
}

/// 待っている URL 1 つに中身を渡す。handler を持っていた (= blitz-dom が
/// 実際に待っていた) なら `true`。
///
/// - `url` は `sess_pending` が返した文字列をそのまま渡す
/// - 同じ URL を待っている handler は全部答える
/// - 待っていない URL でも中身は覚える。あとで要求されたときに待たせずに返す
/// - `<script src>` の待ちには handler が無いので `false` が返る
///   (中身は覚えているので `sess_run_scripts` から引ける)
///
/// 渡した中身が絵に入るのは次の `sess_settle` から
#[wasm_bindgen]
pub fn sess_provide(doc: u32, url: &str, bytes: &[u8]) -> bool {
    with(doc, |page| {
        page.net.provide(url, Bytes::from(bytes.to_vec()))
    })
}

/// 待っている URL 1 つに「取れなかった」と答える (空のバイト列で答える)。
///
/// 取れなかったからといって黙って捨ててはいけない。`<head>` の
/// `<link rel="stylesheet">` は `pending_critical_resources` に残り、
/// `doc.resolve` が「まだ描いてはいけない」と判断して**永久に何も描かなくなる**
/// (`net.rs` の頭に書いたのと同じ話)。
///
/// 空の CSS は中身の無い stylesheet として読まれ、画像はデコードに失敗して
/// 「読めなかった画像」になり、フォントは形式不明として捨てられる。
/// どれも描画は続く
#[wasm_bindgen]
pub fn sess_fail(doc: u32, url: &str) -> bool {
    with(doc, |page| page.net.provide(url, Bytes::new()))
}

/// スタイルとレイアウトを取り直して、**まだ待っている URL の数**を返す。
///
/// `sess_provide` で渡した中身はここで document に入る。入った結果として
/// 新しい URL が要求されることがある (外部 CSS の中の `@import` や
/// `background-image`、`@font-face` の web font は、その CSS が届いて初めて
/// 読める)。なので JS は 0 になるまで `sess_pending` → `sess_provide` →
/// `sess_settle` を回す
#[wasm_bindgen]
pub fn sess_settle(doc: u32) -> u32 {
    with(doc, |page| {
        settle(page);
        page.net.pending().len() as u32
    })
}

/// ページの `<script>` を Boa で実行する。JS 無しで開いた document では `false`。
///
/// 2 度呼んでも 2 度は走らない (`execute_scripts` 自身も同じ約束を持っている)。
/// 走らせる前に**実時間の予算を貼り直す**。`sess_open` から実際の実行までに
/// JS が資源を取りに行っている (実時間で数秒) ので、組んだ時点の予算のままだと
/// 1 本も実行されずに「out of script budget」だけが残る。
///
/// `<script src>` の中身は `sess_provide` で渡してあること。手元に無い
/// スクリプトは飛ばされ、`sess_js_errors` にその旨が残る
#[wasm_bindgen]
pub fn sess_run_scripts(doc: u32) -> bool {
    with(doc, |page| {
        refresh_deadline(&mut page.doc);
        let Some(script_doc) = page.doc.script() else {
            return false;
        };
        if page.scripts_ran {
            return true;
        }
        let errors = crate::script::run_collecting(script_doc);
        page.scripts_ran = true;
        record_errors(page, errors);
        true
    })
}

/// この document の JS context で文字列を評価する。JS context が無ければ `false`。
///
/// `sess_run_scripts` のあとの document でも動く (同じ context がそのまま
/// 残っている)。CDP の `Runtime.evaluate` の下敷き。
///
/// 返すのは「評価できる document だったか」だけ。値は返らないので、結果は
/// DOM に書き出して読むか、`sess_paint` で見る。例外は `sess_js_errors` に出る
#[wasm_bindgen]
pub fn sess_eval(doc: u32, code: &str) -> bool {
    with(doc, |page| {
        refresh_deadline(&mut page.doc);
        let Some(script_doc) = page.doc.script() else {
            return false;
        };
        script_doc.eval(code);
        let errors = script_doc.take_js_errors();
        record_errors(page, errors);
        true
    })
}

/// 溜まっているタイマー (setTimeout / setInterval / requestAnimationFrame) を
/// 仮想時間で進める。最大 `limit` ターン回して、実際に何か走ったターンの数を返す。
///
/// 時間は実時間では待たない。次のタイマーの時刻へ飛ぶだけ。進める先は
/// **呼ぶたびに** 「いまの仮想時計 + 1 秒」で引き直すが、時計はタイマーが
/// 走ったときにしか進まない。つまり `setTimeout(f, 5000)` のように 1 秒より
/// 先に置かれたタイマーは、その間に走るタイマーが無ければ何度呼んでも走らない
/// (スクリーンショットは「読み込み直後の絵」なので、そこは切ってある)。
///
/// `sess_run_scripts` も最後にタイマーを 1 度回すので、`<script>` を走らせた
/// 直後に溜まっているぶんはそこで消えている。ここで回るのは、そのときの
/// 地平の外にあったタイマーと、走ったタイマーが新しく張ったタイマー。
///
/// `<script>` を走らせる前に呼んでも何も起きない (タイマーを張るのは JS なので、
/// 実行前に溜まっているタイマーは 1 つも無い)
#[wasm_bindgen]
pub fn sess_run_timers(doc: u32, limit: u32) -> u32 {
    with(doc, |page| {
        refresh_deadline(&mut page.doc);
        let Some(script_doc) = page.doc.script() else {
            return 0;
        };
        let ran = crate::script::run_timers(script_doc, limit as usize);
        let errors = script_doc.take_js_errors();
        record_errors(page, errors);
        ran
    })
}

/// いまの DOM を RGBA8 に描く。返り値は `width * height * 4` バイト
/// (`dom_paint` と同じ中身)。handle が無ければ空の `Vec`。
///
/// 待っている `<head>` の stylesheet が 1 つでもあると、blitz-dom は
/// レイアウトを付けないので**白い絵**になる。描く前に `sess_pending` を
/// 空にすること
#[wasm_bindgen]
pub fn sess_paint(doc: u32) -> Vec<u8> {
    with(doc, |page| {
        let (width, height) = (page.width, page.height);
        let Some(document) = page.doc.document() else {
            return Vec::new();
        };
        let mut renderer = VelloCpuImageRenderer::new(width, height);
        let mut buf = Vec::new();
        renderer.render_to_vec(
            |scene| {
                // blitz-paint は html / body に background があるときだけページ
                // 背景を塗る。無指定だと透明のままなので、先に白で敷く
                scene.fill(
                    Fill::NonZero,
                    Affine::IDENTITY,
                    Color::WHITE,
                    None,
                    &Rect::new(0.0, 0.0, width as f64, height as f64),
                );
                blitz_paint::paint_scene(
                    scene,
                    &mut document.inner_mut(),
                    1.0,
                    width,
                    height,
                    0,
                    0,
                );
            },
            &mut buf,
        );
        buf
    })
}

/// この document で拾われなかった JS の例外。
///
/// グローバルの `last_js_errors` は描画のたびに置き換わるが、session は
/// 1 つの document を何ターンも生かすので、こちらは document ごとに
/// **溜める** (`sess_run_scripts` / `sess_eval` / `sess_run_timers` のぶんが
/// 順に並ぶ)。読んでも消えない。上限は 256 で、古いものから落ちる
#[wasm_bindgen]
pub fn sess_js_errors(doc: u32) -> Vec<String> {
    with(doc, |page| {
        // eval や タイマーの中で投げられて、まだ移していないものを拾う
        if let Some(script_doc) = page.doc.script() {
            let errors = script_doc.take_js_errors();
            record_errors(page, errors);
        }
        page.js_errors.clone()
    })
}

/// document を捨てる。handle はもう使えない (使っても panic はしない)
#[wasm_bindgen]
pub fn sess_close(doc: u32) {
    SLOTS.with(|slots| {
        slots.borrow_mut().pages.remove(&doc);
    })
}

/// 開いている session の数 (取りこぼしの確認用)
#[wasm_bindgen]
pub fn sess_open_count() -> u32 {
    SLOTS.with(|slots| slots.borrow().pages.len() as u32)
}

/// `<script>` の実行に使える実時間を貼り直す。
///
/// `script::prepare` は**組んだ時点から**予算を数え始める。session では
/// 組んでから実行するまでに JS が資源を取りに行くので、そのままでは
/// `sess_run_scripts` に入る前に予算が尽きている。`with_deadline` は `self` を
/// 取るので、いったん抜き出して戻す
fn refresh_deadline(doc: &mut Doc) {
    if let Doc::Script(slot) = doc {
        if let Some(script_doc) = slot.take() {
            *slot = Some(
                script_doc
                    .with_deadline(web_time::Instant::now() + crate::script::SCRIPT_BUDGET),
            );
        }
    }
}

/// JS の例外を document に溜める。上限を超えたら古いものから落とす
fn record_errors(page: &mut Page, errors: Vec<String>) {
    page.js_errors.extend(errors);
    if page.js_errors.len() > MAX_JS_ERRORS {
        let excess = page.js_errors.len() - MAX_JS_ERRORS;
        page.js_errors.drain(0..excess);
    }
}

#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests {
    use super::*;
    use parley::fontique::{Collection, CollectionOptions, SourceCache};

    const RED: [u8; 4] = [255, 0, 0, 255];
    const BLUE: [u8; 4] = [0, 0, 255, 255];
    const GREEN: [u8; 4] = [0, 255, 0, 255];

    const GREEN_CSS: &str = "body { margin: 0; background: #00ff00 }";

    /// 8x8 の赤い PNG (`crate/fixtures/` は .gitignore されているので埋め込む)
    const RED_PNG: &str = concat!(
        "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR42mP4z8CAFTEMLQkAKP8/wc53yE8AAAAA",
        "SUVORK5CYII="
    );
    const RED_SVG: &str = r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"
        width="8" height="8"><rect width="8" height="8" fill="#ff0000"/></svg>"##;

    /// この module のテストが使う base URL。`net.rs` 側のテストが
    /// `add_resource` で触るグローバルの表と鍵がぶつからないように、
    /// host を分けてある (cargo test はスレッド並列)
    const BASE: &str = "https://s.test/";

    fn b64(s: &str) -> Vec<u8> {
        let url = format!("data:application/octet-stream;base64,{s}");
        data_url::DataUrl::process(&url)
            .unwrap()
            .decode_to_vec()
            .unwrap()
            .0
    }

    /// フォントを 1 本も持たない `FontContext`。この module は色だけを見る
    fn no_fonts() -> FontContext {
        FontContext {
            collection: Collection::new(CollectionOptions {
                shared: false,
                system_fonts: false,
            }),
            source_cache: SourceCache::default(),
        }
    }

    /// グローバルのフォント表を触らずに session を開く
    fn open(html: &str, run_js: bool, width: u32, height: u32) -> u32 {
        open_with(html, BASE, no_fonts(), width, height, run_js)
    }

    fn px(buf: &[u8], width: u32, x: u32, y: u32) -> [u8; 4] {
        let i = ((y * width + x) * 4) as usize;
        [buf[i], buf[i + 1], buf[i + 2], buf[i + 3]]
    }

    /// 白でない画素の数
    fn inked(buf: &[u8]) -> usize {
        buf.chunks(4).filter(|p| p[..3] != [255, 255, 255]).count()
    }

    /// 赤寄りの画素
    fn reddish(buf: &[u8]) -> usize {
        buf.chunks(4)
            .filter(|p| {
                let (r, g, b) = (p[0] as i32, p[1] as i32, p[2] as i32);
                r > 100 && r > g + 40 && r > b + 40
            })
            .count()
    }

    /// 受け入れテスト: `<head>` の stylesheet を待たせておいて、あとから渡すと
    /// **同じ document のまま** CSS が効く。
    ///
    /// 渡すまでの間は 1 画素も塗られない。blitz-dom は `<head>` の stylesheet を
    /// 「描画をブロックする資源」として数え、応答が来るまで `resolve` を
    /// 止めるので、遅らせるとちゃんと絵も遅れる
    #[test]
    fn a_stylesheet_can_arrive_after_the_document_is_open() {
        let (w, h) = (40u32, 40u32);
        let html = r#"<html><head><link rel="stylesheet" href="/s.css"></head><body></body></html>"#;
        let doc = open(html, false, w, h);
        assert_ne!(doc, 0);
        assert_eq!(sess_pending(doc), vec!["https://s.test/s.css"]);

        // 待たせている間はレイアウトが付かないので、白のまま
        let before = sess_paint(doc);
        assert_eq!(before.len(), (w * h * 4) as usize);
        assert_eq!(inked(&before), 0, "待っている間は描かない");

        assert!(sess_provide(doc, "https://s.test/s.css", GREEN_CSS.as_bytes()));
        assert_eq!(sess_settle(doc), 0, "答えたら待ちは残らない");

        let after = sess_paint(doc);
        assert_eq!(px(&after, w, 20, 20), GREEN, "渡した CSS が効くこと");
        sess_close(doc);
    }

    /// 取れなかった URL に `sess_fail` で答えると、ページは描かれる。
    ///
    /// 答えずに置くと `pending_critical_resources` が残って永久に白いままになる
    /// (この実装で一番危ないところ。`net.rs` の頭と同じ話)
    #[test]
    fn a_failed_resource_lets_the_page_paint() {
        let (w, h) = (40u32, 40u32);
        let html = r#"<html><head><link rel="stylesheet" href="/missing.css">
            <style>body { margin: 0; background: #00ff00 }</style></head><body></body></html>"#;
        let doc = open(html, false, w, h);
        assert_eq!(sess_pending(doc), vec!["https://s.test/missing.css"]);
        assert_eq!(inked(&sess_paint(doc)), 0, "答える前は白");

        assert!(sess_fail(doc, "https://s.test/missing.css"));
        assert_eq!(sess_settle(doc), 0);
        assert_eq!(px(&sess_paint(doc), w, 20, 20), GREEN, "空で答えれば描き続ける");
        sess_close(doc);
    }

    /// `data:` の画像は待たせずにその場で解く (JS に見せる意味が無い)。
    /// 画像は描画をブロックしないので、待たせても絵は出る
    #[test]
    fn data_urls_never_show_up_as_pending() {
        let (w, h) = (40u32, 48u32);
        let html = format!(
            r#"<body style="margin:0"><img src="data:image/png;base64,{RED_PNG}" width="40" height="40">
            <img src="/late.png" width="8" height="8"></body>"#
        );
        let doc = open(&html, false, w, h);
        assert_eq!(
            sess_pending(doc),
            vec!["https://s.test/late.png"],
            "data: は入らない"
        );
        assert_eq!(px(&sess_paint(doc), w, 20, 20), RED, "data: はその場で解けている");
        sess_close(doc);
    }

    /// SVG sprite のように同じ URL を別の fragment で参照しても、取得は 1 本に
    /// まとまり、1 回の `sess_provide` で**両方の待ちに答える**
    #[test]
    fn one_fetch_answers_every_fragment_of_the_same_url() {
        let (w, h) = (20u32, 20u32);
        let html = r#"<body style="margin:0">
            <div><img src="/i.svg#a" width="8" height="8" style="display:block"></div>
            <div><img src="/i.svg#b" width="8" height="8" style="display:block"></div>
            </body>"#;
        let doc = open(html, false, w, h);
        assert_eq!(sess_pending(doc), vec!["https://s.test/i.svg"], "1 本にまとまる");

        assert!(sess_provide(doc, "https://s.test/i.svg", RED_SVG.as_bytes()));
        assert_eq!(sess_settle(doc), 0);

        let buf = sess_paint(doc);
        assert_eq!(px(&buf, w, 4, 4), RED, "1 つめの img");
        assert_eq!(px(&buf, w, 4, 12), RED, "2 つめの img も同じ 1 本で塗れる");
        sess_close(doc);
    }

    /// JS が `add_resource` で先に渡してあった資源は待たせない
    /// (「先に全部渡す」と「要求されてから渡す」を混ぜられる)
    #[test]
    fn resources_supplied_in_advance_are_not_deferred() {
        let _guard = crate::net::GLOBAL.lock().unwrap_or_else(|e| e.into_inner());
        let (w, h) = (40u32, 40u32);
        crate::net::clear_resources();
        crate::net::add_resource("https://s.test/pre.css", GREEN_CSS.into());

        let html = r#"<html><head><link rel="stylesheet" href="/pre.css"></head><body></body></html>"#;
        let doc = open(html, false, w, h);
        assert!(sess_pending(doc).is_empty(), "{:?}", sess_pending(doc));
        assert_eq!(px(&sess_paint(doc), w, 20, 20), GREEN, "開いた時点で効いている");
        sess_close(doc);
        crate::net::clear_resources();
    }

    /// 待ちの数には上限がある。超えたぶんは待たせずに空で答えるので、
    /// `sess_pending` にも出てこない
    #[test]
    fn deferrals_are_capped() {
        let count = MAX_DEFERRED + 40;
        let mut html = String::from(r#"<body style="margin:0">"#);
        for i in 0..count {
            html.push_str(&format!(r#"<img src="/i{i}.png" width="1" height="1">"#));
        }
        html.push_str("</body>");

        let doc = open(&html, false, 40, 40);
        assert_eq!(sess_pending(doc).len(), MAX_DEFERRED);
        // 超えたぶんは空で答えている (`<img>` 1 つに `fetch` 1 回なので
        // ちょうど差のぶん。他の資源が混ざっても増える側にしかずれない)
        let dropped = with(doc, |page| page.net.dropped());
        assert!(dropped >= count - MAX_DEFERRED, "{dropped} dropped");
        sess_close(doc);
    }

    /// `<script src>` は blitz-dom の `NetProvider` を通らないので、
    /// `sess_open` が待ちに並べておく。JS が渡してから `sess_run_scripts`
    #[test]
    fn an_external_script_is_pending_until_it_is_provided() {
        let (w, h) = (20u32, 20u32);
        let html = r#"<body style="margin:0"><script src="/app.js"></script></body>"#;
        let doc = open(html, true, w, h);
        assert_eq!(sess_pending(doc), vec!["https://s.test/app.js"]);

        // handler は無い (blitz-dom は待っていない) ので false が返るが、中身は覚える
        let code = b"document.body.setAttribute('style', 'margin:0;background:#ff0000')";
        assert!(!sess_provide(doc, "https://s.test/app.js", code));
        assert_eq!(sess_settle(doc), 0, "渡せば待ちは消える");

        assert!(sess_run_scripts(doc));
        sess_settle(doc);
        assert_eq!(px(&sess_paint(doc), w, 10, 10), RED, "外部スクリプトが走ること");
        assert!(sess_js_errors(doc).is_empty(), "{:?}", sess_js_errors(doc));
        sess_close(doc);
    }

    /// `sess_eval` は `<script>` を走らせたあとの context でも DOM を書き換えられる
    /// (CDP の `Runtime.evaluate` の下敷き)
    #[test]
    fn eval_mutates_the_dom_after_the_scripts_have_run() {
        let (w, h) = (20u32, 20u32);
        let html = r#"<body style="margin:0"><script>
            document.body.setAttribute('style', 'margin:0;background:#0000ff')
            </script></body>"#;
        let doc = open(html, true, w, h);
        assert!(sess_run_scripts(doc));
        sess_settle(doc);
        assert_eq!(px(&sess_paint(doc), w, 10, 10), BLUE, "ページの script が効く");

        assert!(sess_eval(
            doc,
            "document.body.setAttribute('style', 'margin:0;background:#00ff00')"
        ));
        sess_settle(doc);
        assert_eq!(px(&sess_paint(doc), w, 10, 10), GREEN, "eval が効く");
        assert!(sess_js_errors(doc).is_empty(), "{:?}", sess_js_errors(doc));

        // JS 無しで開いた document には context が無い
        let plain = open("<p>x</p>", false, 20, 20);
        assert!(!sess_eval(plain, "1 + 1"));
        assert!(!sess_run_scripts(plain));
        assert_eq!(sess_run_timers(plain, 4), 0);
        sess_close(plain);
        sess_close(doc);
    }

    /// `sess_run_scripts` を 2 度呼んでも 2 度は走らない
    #[test]
    fn running_the_scripts_twice_does_not_run_them_twice() {
        let (w, h) = (20u32, 20u32);
        let html = r#"<body style="margin:0"><script>
            var d = document.createElement('div');
            d.setAttribute('style', 'width:8px;height:8px;background:#ff0000');
            document.body.appendChild(d);
            </script></body>"#;
        let doc = open(html, true, w, h);
        assert!(sess_run_scripts(doc));
        sess_settle(doc);
        let once = reddish(&sess_paint(doc));
        assert!(once > 40, "8x8 の赤い箱が 1 つ塗られること: {once}");

        assert!(sess_run_scripts(doc), "JS document ではあるので true");
        sess_settle(doc);
        assert_eq!(reddish(&sess_paint(doc)), once, "箱は増えない");
        sess_close(doc);
    }

    /// タイマーは仮想時間で回る (実時間では待たない)。`sess_run_timers` は
    /// 走ったターンの数を返す。
    ///
    /// 進めるのは「いまの仮想時計 + 1 秒」まで。時計はタイマーが走ったときにしか
    /// 進まないので、`sess_run_scripts` の時点から 1 秒より先に置かれた
    /// タイマーは、そこまでの間にタイマーが 1 つも走らなければ届かない。
    /// ここでは 500ms のタイマーの中から 800ms のタイマーを張って、
    /// 2 つめが `sess_run_scripts` の地平の外に出るようにしている
    #[test]
    fn timers_run_on_demand() {
        let (w, h) = (20u32, 20u32);
        let html = r#"<body style="margin:0"><script>
            setTimeout(function () {
              document.body.setAttribute('style', 'margin:0;background:#0000ff');
              setTimeout(function () {
                document.body.setAttribute('style', 'margin:0;background:#00ff00');
              }, 800);
            }, 500);
            </script></body>"#;
        let doc = open(html, true, w, h);
        assert!(sess_run_scripts(doc));
        sess_settle(doc);
        // `sess_run_scripts` は溜まっているタイマーをそこで 1 度回す
        assert_eq!(px(&sess_paint(doc), w, 10, 10), BLUE, "1 つめは実行の勢いで走る");

        assert_eq!(sess_run_timers(doc, 4), 1, "2 つめはここで走る");
        sess_settle(doc);
        assert_eq!(px(&sess_paint(doc), w, 10, 10), GREEN);
        assert_eq!(sess_run_timers(doc, 4), 0, "もう溜まっていない");
        assert!(sess_js_errors(doc).is_empty(), "{:?}", sess_js_errors(doc));
        sess_close(doc);
    }

    /// `sess_open` から `sess_run_scripts` までに時間が経っていても
    /// `<script>` は走る。
    ///
    /// `script::prepare` は**組んだ時点から** `<script>` の実行に使える実時間を
    /// 数え始める (1.5 秒)。session では組んでから実行するまでに JS が資源を
    /// 取りに行く (実ページなら実時間で数秒) ので、予算を貼り直さないと
    /// 1 本も走らずに「out of script budget」だけが残る。
    /// native のテストでしか確かめられない (wasm では実時間を止められない)
    #[test]
    fn the_script_budget_is_refreshed_at_run_time() {
        let (w, h) = (20u32, 20u32);
        let html = r#"<body style="margin:0"><script>
            document.body.setAttribute('style', 'margin:0;background:#00ff00')
            </script></body>"#;
        let doc = open(html, true, w, h);
        // 組んだ時点の予算 (1.5 秒) を使い切ってから走らせる
        std::thread::sleep(crate::script::SCRIPT_BUDGET + std::time::Duration::from_millis(100));
        assert!(sess_run_scripts(doc));
        sess_settle(doc);
        assert_eq!(px(&sess_paint(doc), w, 10, 10), GREEN, "予算切れで飛ばされていないこと");
        assert!(sess_js_errors(doc).is_empty(), "{:?}", sess_js_errors(doc));
        sess_close(doc);
    }

    /// JS の例外は document ごとに溜まる (読んでも消えない)
    #[test]
    fn js_errors_are_kept_per_document() {
        let doc = open("<p>x</p><script>throw new Error('boom')</script>", true, 20, 20);
        assert!(sess_run_scripts(doc));
        let errors = sess_js_errors(doc);
        assert!(errors.iter().any(|e| e.contains("boom")), "{errors:?}");
        // eval の例外も足される
        assert!(sess_eval(doc, "null.foo"));
        assert!(sess_js_errors(doc).len() > errors.len());
        sess_close(doc);
    }

    /// `sess_open` から `sess_close` までで slot が残らない。
    /// 捨てた handle を使っても panic しない
    #[test]
    fn handles_do_not_leak() {
        let before = sess_open_count();
        let a = open("<p>a</p>", false, 20, 20);
        let b = open(r#"<html><head><link rel="stylesheet" href="/s.css"></head></html>"#, false, 20, 20);
        assert_ne!(a, b);
        assert_eq!(sess_open_count(), before + 2);

        // b は handler を持ったまま閉じる。stylesheet の handler は provider を
        // 抱えているので、閉じるときに待ちを捨てないと provider と handler が
        // 輪になって、document ごと解放されない
        assert_eq!(sess_pending(b).len(), 1);
        let net = with(b, |page| Some(page.net.clone())).unwrap();
        sess_close(a);
        sess_close(b);
        assert_eq!(sess_open_count(), before);
        assert_eq!(Arc::strong_count(&net), 1, "provider が解放されていない");

        // 捨てた handle も存在しない handle も「無い」を返すだけ
        for doc in [a, b, 999_999] {
            assert!(sess_pending(doc).is_empty());
            assert!(sess_paint(doc).is_empty());
            assert!(!sess_provide(doc, "https://s.test/x.css", b"x"));
            assert!(!sess_fail(doc, "https://s.test/x.css"));
            assert_eq!(sess_settle(doc), 0);
            assert!(!sess_run_scripts(doc));
            assert!(!sess_eval(doc, "1 + 1"));
            assert_eq!(sess_run_timers(doc, 4), 0);
            assert!(sess_js_errors(doc).is_empty());
            sess_close(doc);
        }
    }

    /// 大きさが取れないビューポートは 0 で返し、理由を残す (`dom_open` と同じ)
    #[test]
    fn bad_viewport_is_reported() {
        let _guard = crate::net::GLOBAL.lock().unwrap_or_else(|e| e.into_inner());
        crate::last_panic();
        assert_eq!(sess_open("<p>x</p>", "", 0, 100, false), 0);
        let why = crate::last_panic().unwrap_or_default();
        assert!(why.contains("out of range"), "{why}");
        assert_eq!(sess_open("<p>x</p>", "", 100, 70_000, false), 0);
        assert!(crate::last_panic().is_some());
    }

    /// 待たせた stylesheet に答えると、その handler の中から blitz-dom が
    /// **さらに `fetch` を呼ぶ** (CSS の中の画像、`@import`、`@font-face`)。
    /// `sess_provide` が待ちの lock を持ったまま handler を呼んでいたら固まる。
    ///
    /// CSS の中から参照される画像は、その CSS が届いて初めて読めるので、
    /// 待ちは 1 周では終わらない。document は組み直さないまま次の待ちが増える
    #[test]
    fn a_late_stylesheet_asks_for_the_images_inside_it() {
        let (w, h) = (40u32, 40u32);
        let html = r#"<html><head><link rel="stylesheet" href="/s.css"></head>
            <body><div class="hero"></div></body></html>"#;
        let css = r#"body { margin: 0 }
            .hero { width: 40px; height: 40px;
                    background-image: url(/bg.png); background-size: cover }"#;

        let doc = open(html, false, w, h);
        assert_eq!(sess_pending(doc), vec!["https://s.test/s.css"]);

        // 1 周目: CSS を渡すと、その中の画像が新しい待ちになる
        assert!(sess_provide(doc, "https://s.test/s.css", css.as_bytes()));
        assert_eq!(sess_settle(doc), 1);
        assert_eq!(sess_pending(doc), vec!["https://s.test/bg.png"]);

        // 2 周目: 画像を渡すと絵になる。document は 1 度も組み直していない
        assert!(sess_provide(doc, "https://s.test/bg.png", &b64(RED_PNG)));
        assert_eq!(sess_settle(doc), 0);
        assert_eq!(px(&sess_paint(doc), w, 20, 20), RED);
        sess_close(doc);
    }

    /// **blitz-dom の限界**: あとから届いた `@import` 先の CSS は当たらない。
    ///
    /// 親の stylesheet を渡した時点で `@import` の要求は出る (待ちに並ぶ) が、
    /// 親はもう「import は pending」の形で stylist に入っている。届いた中身は
    /// `ImportRule` に書き込まれるだけで、blitz-dom はその応答
    /// (`Resource::None`) を「何もしない」で受けるので、カスケードを
    /// 組み直さない。つまり `@import` の中の宣言は絵に出ない。
    ///
    /// 出したければ `sess_open` より先に `add_resource` で渡しておく。
    /// 先に手元にあれば、親のパースの途中で同期的に解決する
    #[test]
    fn an_imported_stylesheet_that_arrives_late_does_not_apply() {
        let _guard = crate::net::GLOBAL.lock().unwrap_or_else(|e| e.into_inner());
        let (w, h) = (40u32, 40u32);
        let html = r#"<html><head><link rel="stylesheet" href="/s.css"></head><body></body></html>"#;
        let outer = r#"@import "/more.css";"#;

        // あとから渡した場合: 要求はされるが、届いた中身は当たらない
        crate::net::clear_resources();
        let doc = open(html, false, w, h);
        assert!(sess_provide(doc, "https://s.test/s.css", outer.as_bytes()));
        assert_eq!(sess_settle(doc), 1, "`@import` 先が待ちに並ぶ");
        assert_eq!(sess_pending(doc), vec!["https://s.test/more.css"]);
        assert!(sess_provide(doc, "https://s.test/more.css", GREEN_CSS.as_bytes()));
        assert_eq!(sess_settle(doc), 0);
        assert_eq!(inked(&sess_paint(doc)), 0, "遅れて届いた `@import` 先は当たらない");
        sess_close(doc);

        // 先に渡してあった場合: 親をパースする途中で解決するので当たる
        crate::net::add_resource("https://s.test/more.css", GREEN_CSS.into());
        let doc = open(html, false, w, h);
        assert!(sess_provide(doc, "https://s.test/s.css", outer.as_bytes()));
        assert_eq!(sess_settle(doc), 0, "`@import` 先は待ちにならない");
        assert_eq!(px(&sess_paint(doc), w, 20, 20), GREEN, "先に渡せば当たる");
        sess_close(doc);
        crate::net::clear_resources();

        // インラインの `<style>` の中の `@import` も同じ。こちらは開いた時点で
        // 待ちに並ぶので、JS からは「取ってきて渡せば効くはず」に見えるのに効かない
        let styled = r#"<html><head><style>@import "/more.css";</style></head><body></body></html>"#;
        let doc = open(styled, false, w, h);
        assert_eq!(sess_pending(doc), vec!["https://s.test/more.css"]);
        assert!(sess_provide(doc, "https://s.test/more.css", GREEN_CSS.as_bytes()));
        assert_eq!(sess_settle(doc), 0);
        assert_eq!(inked(&sess_paint(doc)), 0, "`<style>` の `@import` でも当たらない");
        sess_close(doc);
    }

    /// あとから届いた **top-level の** stylesheet は、その中の `@font-face` まで
    /// 効く。web font の URL は CSS が届いて初めて分かるので待ちが 1 周増える
    /// (フォントを 1 本も登録していないので、届かなければ 1 画素も塗られない)
    #[test]
    fn a_late_stylesheet_can_bring_its_own_web_font() {
        let (w, h) = (300u32, 80u32);
        let html = r#"<html><head><link rel="stylesheet" href="/s.css"></head>
            <body><p>Hello</p></body></html>"#;
        let css = r#"@font-face { font-family: probe; src: url(/f.ttf) format("truetype") }
            body { margin: 0 } p { margin: 0; font-size: 40px; font-family: probe }"#;
        let Ok(ttf) = std::fs::read(crate::font_file("sans-regular.ttf")) else {
            return;
        };

        let doc = open(html, false, w, h);
        assert!(sess_provide(doc, "https://s.test/s.css", css.as_bytes()));
        assert_eq!(sess_settle(doc), 1);
        assert_eq!(sess_pending(doc), vec!["https://s.test/f.ttf"]);

        assert!(sess_provide(doc, "https://s.test/f.ttf", &ttf));
        assert_eq!(sess_settle(doc), 0);
        assert!(inked(&sess_paint(doc)) > 200, "web font で文字が出ること");
        sess_close(doc);
    }


    /// 実ページで、待ちが空になるまでに何周かかるか。
    ///
    /// `crate/fixtures/` は .gitignore されているので、無ければ何もしない。
    /// 資源は取りに行けないので全部 `sess_fail` で答える (それでも描けること)。
    ///
    /// ここはフォントを持たないので、文字以外に何も塗らない todomvc は見ない
    /// (`net.rs` 側のテストと同じ理由)
    #[test]
    fn bundled_fixtures_settle_in_a_few_rounds() {
        let (w, h) = (400u32, 300u32);
        for name in ["example", "aiji42", "mdn", "wikipedia", "kitesurf"] {
            let Ok(html) = std::fs::read_to_string(format!("fixtures/{name}.html")) else {
                continue;
            };
            let doc = open(&html, false, w, h);
            let mut rounds = 0;
            let mut answered = 0;
            loop {
                let urls = sess_pending(doc);
                if urls.is_empty() {
                    break;
                }
                for url in &urls {
                    sess_fail(doc, url);
                    answered += 1;
                }
                rounds += 1;
                if sess_settle(doc) == 0 || rounds >= 8 {
                    break;
                }
            }
            let n = inked(&sess_paint(doc));
            eprintln!("{name}: {rounds} rounds, {answered} urls, {n} inked pixels");
            assert!(rounds < 8, "{name}: 待ちが 8 周で収まらない");
            assert!(n > 100, "{name}: 描けていない ({n} inked pixels)");
            sess_close(doc);
        }
    }
}
