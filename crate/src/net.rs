//! サブリソース (画像・外部 CSS・web font) を、**JS が先に渡した表から**返す。
//!
//! Workers の中では Rust から直接 fetch できない。ネットワークは JS 側 1 箇所
//! (`src/outbound.js`) に閉じてあるので、Rust は「URL → バイト列」の表を引くだけにする。
//!
//! 使い方は `add_font` と同じ。描画の前に `add_resource` を必要な回数だけ呼び、
//! `render_png_rgba` はそのときの表を見る。
//!
//! ```js
//! add_resource("https://example.com/logo.png", new Uint8Array(bytes));
//! const rgba = render_png_rgba(html, "https://example.com/", 800, 600);
//! ```
//!
//! # 表に無い URL
//!
//! `NetHandler` には成功の口 (`bytes`) しか無い。応答せずに handler を捨てると、
//! `<head>` の `<link rel="stylesheet">` が `pending_critical_resources` に
//! 残ったままになり、`doc.resolve` が「まだ描いてはいけない」と判断して
//! **永久に何も描かなくなる** (blitz-dom の `resolve` は先頭でそれを見て早期 return する)。
//!
//! なので表に無い URL には**空のバイト列で応答する**。空の CSS は中身の無い
//! stylesheet として読まれ、画像はデコードに失敗して「読めなかった画像」になり、
//! フォントは形式不明として捨てられる。どれも描画は続く。
//!
//! # 取りこぼした URL を数える (2 パス描画)
//!
//! CSS の中から参照される画像 (`background-image: url(...)`) は、どのセレクタが
//! 当たるかがカスケードとレイアウトの後にしか決まらないので、HTML を先に走査する
//! やり方では集まらない。そこで**要求されたが表に無かった URL を控えておく**。
//!
//! `render_png_rgba` は描き終わりにその記録を `missed_resources` に置く。JS は
//! それを取って fetch し、`add_resource` で表に足して**もう 1 度描く**。
//! 描画のたびに `BaseDocument` を作り直すので、2 回目は同じ URL をもう一度要求する
//! (blitz-dom は「取得に失敗した URL」をプロセスに残さない。記録はどれも document の中)。
//!
//! ```js
//! clear_resources();
//! render_png_rgba(html, base, w, h);            // 1 回目: 取りこぼしを数えるために描く
//! for (const url of missed_resources()) {
//!   add_resource(url, new Uint8Array(await (await fetch(url)).arrayBuffer()));
//! }
//! const rgba = render_png_rgba(html, base, w, h); // 2 回目: これが絵になる
//! ```

use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use blitz_traits::net::{Bytes, NetHandler, NetProvider, Request};
use wasm_bindgen::prelude::*;

/// JS が `add_resource` で溜めた表。キーは正規化した絶対 URL (fragment を落としたもの)
static RESOURCES: Mutex<Option<HashMap<String, Bytes>>> = Mutex::new(None);

/// **直前の** `render_png_rgba` が取りこぼした URL。`missed_resources` で JS が読む。
/// 描画ごとに置き換わる (溜まらない) ので、2 回目の描画のあとに空なら全部埋まったということ
static MISSES: Mutex<Vec<String>> = Mutex::new(Vec::new());

/// グローバル (フォントと資源の表) を触るテストの直列化。`lib.rs` 側のテストからも取るので
/// tests module の外に置く
#[cfg(all(test, not(target_arch = "wasm32")))]
pub(crate) static GLOBAL: Mutex<()> = Mutex::new(());

/// 表を引く `NetProvider`。バイト列は手元にあるので、`fetch` の中で handler を
/// そのまま呼んで同期的に解決する。応答は blitz-dom の mpsc に積まれるだけなので、
/// `fetch` の中から呼んでも DOM には触らない
pub struct TableNetProvider {
    /// 描画 1 回ぶんのスナップショット。`fetch` は lock を取らない。
    ///
    /// stylesheet を返すと、その中の `@import` や `@font-face` のために blitz-dom が
    /// **`fetch` の中からさらに `fetch` を呼ぶ**。ここで `RESOURCES` の Mutex を
    /// 取っていると自分自身と競合して固まるので、表は描画の入口で 1 度だけコピーしておく
    table: Arc<HashMap<String, Bytes>>,
    /// `fetch` が呼ばれた回数。取得が増えなくなったら描画ループを止める目印に使う
    fetches: AtomicUsize,
    /// 要求されたが表に無かった URL。要求された順、重複なし。
    /// JS がこれを取得して `add_resource` で足し、もう 1 度描く
    misses: Mutex<Vec<String>>,
}

impl TableNetProvider {
    /// 表を渡して作る
    fn with_table(table: HashMap<String, Bytes>) -> Arc<Self> {
        Arc::new(Self {
            table: Arc::new(table),
            fetches: AtomicUsize::new(0),
            misses: Mutex::new(Vec::new()),
        })
    }

    /// いまの表をコピーして作る
    pub fn current() -> Arc<Self> {
        let guard = RESOURCES.lock().unwrap_or_else(|e| e.into_inner());
        let table = guard.as_ref().cloned().unwrap_or_default();
        Self::with_table(table)
    }

    /// 表が空のもの (資源を渡されなかったとき用)
    pub fn empty() -> Arc<Self> {
        Self::with_table(HashMap::new())
    }

    /// `fetch` が呼ばれた回数
    pub fn fetches(&self) -> usize {
        self.fetches.load(Ordering::Relaxed)
    }

    /// 表から `<script src>` や ES module の中身を文字列で引く。
    ///
    /// 引けなかったら `None` を返し、その URL を取りこぼしに控える
    /// (画像や CSS と同じ扱いなので、次のパスで JS 側が足してくれる)。
    /// UTF-8 でないバイトは置換文字にする。落とすよりは残したほうがよい
    pub(crate) fn text(&self, url: &str) -> Option<String> {
        let bytes = self.lookup(url)?;
        Some(String::from_utf8_lossy(&bytes).into_owned())
    }

    /// 表から引けなかった URL。要求された順、重複なし
    pub fn misses(&self) -> Vec<String> {
        self.misses.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    /// 表 (と data: URL) から中身を引く。無ければ `None` を返し、その URL を控える
    fn lookup(&self, url: &str) -> Option<Bytes> {
        // data: URL は「通信」ではないので、ここで解いてしまう。JS 側に渡す必要は無い
        if url.starts_with("data:") {
            let data = data_url::DataUrl::process(url).ok()?;
            let (bytes, _) = data.decode_to_vec().ok()?;
            return Some(Bytes::from(bytes));
        }
        let key = strip_fragment(url);
        match self.table.get(key) {
            Some(bytes) => Some(bytes.clone()),
            None => {
                self.record_miss(key);
                None
            }
        }
    }

    /// 取りこぼしを控える。
    ///
    /// - 控えるのは**表と同じ鍵** (fragment を落としたもの)。SVG sprite の
    ///   `icons.svg#a` と `icons.svg#b` は 1 本の取得にまとまり、そのまま
    ///   `add_resource` の鍵として戻ってくる
    /// - JS が `fetch` に渡せるものだけ。scheme が http(s) でないものは控えない
    ///   (`data:` はここに来ないが、`base_url` を渡さなかったときの
    ///   `https://inline.invalid/...` のように、取りに行っても無駄なものはある)
    /// - lock はこの関数の中で閉じる。`fetch` は stylesheet の `@import` や
    ///   `@font-face` のために**自分自身を再入する**ので、handler を呼ぶ間 lock を
    ///   持っていると自分と競合して固まる
    fn record_miss(&self, key: &str) {
        if !(key.starts_with("http://") || key.starts_with("https://")) {
            return;
        }
        let mut misses = self.misses.lock().unwrap_or_else(|e| e.into_inner());
        if !misses.iter().any(|u| u == key) {
            misses.push(key.to_string());
        }
    }
}

impl NetProvider for TableNetProvider {
    fn fetch(&self, _doc_id: usize, request: Request, handler: Box<dyn NetHandler>) {
        self.fetches.fetch_add(1, Ordering::Relaxed);

        // handler に渡す URL は **blitz-dom が組んだ Request の URL そのまま**。
        // blitz-dom はこの文字列を鍵に「この画像を待っているノード」を引く
        // (`pending_images`)。表のキー (fragment を落としたもの) を渡すと、
        // 画像は読めているのにどのノードにも入らない
        let resolved_url = request.url.as_str().to_string();
        let bytes = self.lookup(&resolved_url).unwrap_or_default();
        handler.bytes(resolved_url, bytes);
    }
}

/// URL を正規化して表のキーにする。fragment (`#...`) は資源の中身に関係しないので落とす。
///
/// JS の `new URL(href, base).toString()` と Rust の `Url::join` はどちらも
/// WHATWG URL の実装なので、同じ絶対 URL を組む。ただし `https://example.com` のように
/// path の無いものは JS 側で `https://example.com/` になるので、こちら側も `Url::parse`
/// を通して同じ形に揃えておく (揃えないと末尾のスラッシュだけで外れる)
fn normalize(url: &str) -> String {
    match url::Url::parse(url) {
        Ok(u) => strip_fragment(u.as_str()).to_string(),
        // 絶対 URL として読めないものは、渡された文字列のまま鍵にする
        Err(_) => strip_fragment(url).to_string(),
    }
}

fn strip_fragment(url: &str) -> &str {
    match url.split_once('#') {
        Some((head, _)) => head,
        None => url,
    }
}

/// サブリソースを 1 つ登録する。`render_png_rgba` より先に、資源ごとに 1 回呼ぶ。
///
/// - `url` は**絶対 URL**。HTML の中の `src` / `href` を `new URL(href, baseUrl)` で
///   解決したものを渡す。相対 URL を渡しても、Blitz が組む URL とは一致しない
/// - `bytes` は取得した中身をそのまま。画像は PNG / JPEG / GIF / WebP / SVG、
///   CSS と web font もこの表から返る
/// - 戻り値は実際に鍵にした文字列。JS 側で URL の正規化がずれていないかの確認に使える
/// - 同じ URL を 2 度渡すと後のほうが残る
///
/// `data:` URL は表に入れなくてよい。Rust 側で解く
#[wasm_bindgen]
pub fn add_resource(url: &str, bytes: Vec<u8>) -> String {
    let key = normalize(url);
    let mut guard = RESOURCES.lock().unwrap_or_else(|e| e.into_inner());
    guard
        .get_or_insert_with(HashMap::new)
        .insert(key.clone(), Bytes::from(bytes));
    key
}

/// 登録した資源を全部捨てる。ページごとに呼ぶ
/// (Workers の isolate はリクエストをまたいで生きるので、呼ばないと前のページの画像が残る)。
/// `missed_resources` の記録も一緒に捨てる
#[wasm_bindgen]
pub fn clear_resources() {
    *RESOURCES.lock().unwrap_or_else(|e| e.into_inner()) = None;
    MISSES.lock().unwrap_or_else(|e| e.into_inner()).clear();
}

/// **直前の `render_png_rgba` が要求したのに表に無かった** URL。
///
/// これを fetch して `add_resource` で足し、もう 1 度描くと、CSS の中から
/// 参照される画像 (`background-image`) や `@import` した CSS、`@font-face` の
/// web font まで絵に入る。HTML を走査するだけでは集まらないもの。
///
/// - `fetch` にそのまま渡せる絶対 URL (http / https)。要求された順、重複なし
/// - `data:` は Rust 側で解くので入らない
/// - 描画のたびに置き換わる。空になったら足すものは無い
/// - `render_png_rgba` を通らない描画 (native のテスト) では更新されない
#[wasm_bindgen]
pub fn missed_resources() -> Vec<String> {
    MISSES.lock().unwrap_or_else(|e| e.into_inner()).clone()
}

/// 1 回の描画で取りこぼした URL を `missed_resources` に置く。
/// `render_png_rgba` が描き終わりに呼ぶ
pub(crate) fn publish_misses(net: &TableNetProvider) {
    *MISSES.lock().unwrap_or_else(|e| e.into_inner()) = net.misses();
}

/// 登録済みの URL (確認用。順序は決まらない)
#[wasm_bindgen]
pub fn resource_urls() -> Vec<String> {
    let guard = RESOURCES.lock().unwrap_or_else(|e| e.into_inner());
    match guard.as_ref() {
        Some(table) => table.keys().cloned().collect(),
        None => Vec::new(),
    }
}

#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests {
    use super::*;
    use crate::render_with;
    use blitz_dom::FontContext;
    use parley::fontique::{Collection, CollectionOptions, SourceCache};

    const RED: [u8; 4] = [255, 0, 0, 255];
    const BLUE: [u8; 4] = [0, 0, 255, 255];
    const GREEN: [u8; 4] = [0, 255, 0, 255];
    const WHITE: [u8; 4] = [255, 255, 255, 255];

    // テストに使う画像は base64 で埋め込む (`crate/fixtures/` は .gitignore されているので、
    // ファイルに置くと clone した先で消える)。どれも 8x8 の単色
    const RED_PNG: &str = concat!(
        "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR42mP4z8CAFTEMLQkAKP8/wc53yE8AAAAA",
        "SUVORK5CYII="
    );
    const BLUE_PNG: &str = concat!(
        "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEElEQVR42mNgYPiPAw0pCQCpcD/B/MtF/AAAAABJ",
        "RU5ErkJggg=="
    );
    const RED_GIF: &str = "R0lGODdhCAAIAJEAAAAAAP8AAP///wAAACH5BAQAAAAALAAAAAAIAAgAAAIHjI+py+1dAAA7";
    const RED_JPEG: &str = concat!(
        "/9j/wAARCAAIAAgDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUF",
        "BAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdI",
        "SUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJ",
        "ytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREA",
        "AgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2",
        "Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3",
        "uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9sAQwAPDw8PDw8aDw8aJBoaGiQxJCQkJDE+MTEx",
        "MTE+Sz4+Pj4+PktLS0tLS0tLWlpaWlpaaWlpaWl2dnZ2dnZ2dnZ2/9sAQwESExMeHB40HBw0e1RFVHt7e3t7e3t7e3t7",
        "e3t7e3t7e3t7e3t7e3t7e3t7e3t7e3t7e3t7e3t7e3t7e3t7/90ABAAB/9oADAMBAAIRAxEAPwDDooorzD7g/9k="
    );
    const RED_SVG: &str = r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"
        width="8" height="8"><rect width="8" height="8" fill="#ff0000"/></svg>"##;
    const GREEN_CSS: &str = "body { margin: 0; background: #00ff00 }";

    /// base64 を解く。data-url は依存に入っているので、これだけのために crate は足さない
    fn b64(s: &str) -> Vec<u8> {
        let url = format!("data:application/octet-stream;base64,{s}");
        data_url::DataUrl::process(&url)
            .unwrap()
            .decode_to_vec()
            .unwrap()
            .0
    }

    /// フォントを 1 本も持たない `FontContext`。この module のテストは色だけを見るので
    /// 文字は要らない (フォントまわりは `lib.rs` 側のテストが見る)
    fn no_fonts() -> FontContext {
        FontContext {
            collection: Collection::new(CollectionOptions {
                shared: false,
                system_fonts: false,
            }),
            source_cache: SourceCache::default(),
        }
    }

    /// (URL, 中身) の列から表を作る
    fn net(entries: &[(&str, Vec<u8>)]) -> Arc<TableNetProvider> {
        let table = entries
            .iter()
            .map(|(url, bytes)| (normalize(url), Bytes::from(bytes.clone())))
            .collect();
        TableNetProvider::with_table(table)
    }

    fn px(buf: &[u8], width: u32, x: u32, y: u32) -> [u8; 4] {
        let i = ((y * width + x) * 4) as usize;
        [buf[i], buf[i + 1], buf[i + 2], buf[i + 3]]
    }

    /// 白でない画素の数
    fn inked(buf: &[u8], w: u32, h: u32) -> usize {
        (0..h)
            .flat_map(|y| (0..w).map(move |x| (x, y)))
            .filter(|&(x, y)| px(buf, w, x, y) != WHITE)
            .count()
    }

    const IMG_HTML: &str =
        r#"<body style="margin:0"><img src="https://x.test/a.png" width="60" height="60"></body>"#;

    /// `<img>` の中身を表から返すと、実際にその色が塗られる
    #[test]
    fn image_from_table_is_painted() {
        let (w, h) = (60u32, 60u32);
        let buf = render_with(
            IMG_HTML,
            "https://x.test/",
            no_fonts(),
            net(&[("https://x.test/a.png", b64(RED_PNG))]),
            w,
            h,
        );
        assert_eq!(px(&buf, w, 30, 30), RED, "img should be red");
    }

    /// 表が空だと、同じ HTML でも画像の場所は白のまま (落ちない)
    #[test]
    fn missing_image_leaves_the_box_empty() {
        let (w, h) = (60u32, 60u32);
        let buf = render_with(
            IMG_HTML,
            "https://x.test/",
            no_fonts(),
            TableNetProvider::empty(),
            w,
            h,
        );
        assert_eq!(px(&buf, w, 30, 30), WHITE);
    }

    /// 相対 URL の `src` は base_url で解決されるので、表のキーは絶対 URL
    #[test]
    fn relative_src_resolves_against_base_url() {
        let (w, h) = (40u32, 40u32);
        let html = r#"<body style="margin:0"><img src="img/a.png" width="40" height="40"></body>"#;
        let buf = render_with(
            html,
            "https://x.test/post/",
            no_fonts(),
            net(&[("https://x.test/post/img/a.png", b64(BLUE_PNG))]),
            w,
            h,
        );
        assert_eq!(px(&buf, w, 20, 20), BLUE);
    }

    /// path の無い URL (`https://x.test`) を渡しても、Blitz が組む `https://x.test/`
    /// と突き合わせられる。fragment 付きも同じ資源として引ける
    #[test]
    fn urls_are_normalized_on_both_sides() {
        assert_eq!(normalize("https://x.test"), "https://x.test/");
        assert_eq!(normalize("https://x.test/a.svg#icon"), "https://x.test/a.svg");
        assert_eq!(normalize("https://x.test/a?b=1&c=2"), "https://x.test/a?b=1&c=2");

        let (w, h) = (40u32, 40u32);
        let html = r#"<body style="margin:0"><img src="/a.png#frag" width="40" height="40"></body>"#;
        let buf = render_with(
            html,
            "https://x.test/",
            no_fonts(),
            net(&[("https://x.test/a.png", b64(RED_PNG))]),
            w,
            h,
        );
        assert_eq!(px(&buf, w, 20, 20), RED);
    }

    /// CSS の `background-image` も表から返る。これはレイアウトの途中で取りに来るので、
    /// 1 度目の resolve では間に合わない (描画が resolve を 2 週目まで回している証拠)
    #[test]
    fn background_image_from_table_is_painted() {
        let (w, h) = (40u32, 40u32);
        let html = r#"<body style="margin:0"><div style="width:40px;height:40px;
            background-image:url(/bg.png);background-size:cover"></div></body>"#;
        let buf = render_with(
            html,
            "https://x.test/",
            no_fonts(),
            net(&[("https://x.test/bg.png", b64(BLUE_PNG))]),
            w,
            h,
        );
        assert_eq!(px(&buf, w, 20, 20), BLUE);
    }

    /// data: URL は表に無くても描ける
    #[test]
    fn data_url_is_decoded_without_the_table() {
        let (w, h) = (40u32, 40u32);
        let html = format!(
            r#"<body style="margin:0"><img src="data:image/png;base64,{RED_PNG}" width="40" height="40"></body>"#
        );
        let buf = render_with(
            &html,
            "https://x.test/",
            no_fonts(),
            TableNetProvider::empty(),
            w,
            h,
        );
        assert_eq!(px(&buf, w, 20, 20), RED);
    }

    /// `<head>` の `<link rel="stylesheet">` が表に無くても、ページは描かれる。
    ///
    /// blitz-dom は `<head>` の stylesheet を「描画をブロックする資源」として数え、
    /// 応答が来るまで `resolve` を止める。表に無い URL に黙って応答しないと、
    /// ここが真っ白になる (この実装で一番危ないところ)
    #[test]
    fn missing_head_stylesheet_does_not_block_rendering() {
        let (w, h) = (40u32, 40u32);
        let html = r#"<html><head><link rel="stylesheet" href="/missing.css">
            <style>body { margin: 0; background: #00ff00 }</style></head><body></body></html>"#;
        let providers = [
            TableNetProvider::empty(),
            // 別の URL だけが表にある場合も同じ
            net(&[("https://x.test/other.css", GREEN_CSS.into())]),
        ];
        for provider in providers {
            let buf = render_with(html, "https://x.test/", no_fonts(), provider, w, h);
            assert_eq!(px(&buf, w, 20, 20), GREEN, "page must not stay blank");
        }
    }

    /// 表から返した CSS が効く (JS が `<style>` に差し込まなくても届く経路)
    #[test]
    fn external_stylesheet_from_table_is_applied() {
        let (w, h) = (40u32, 40u32);
        let html = r#"<html><head><link rel="stylesheet" href="/s.css"></head><body></body></html>"#;
        let buf = render_with(
            html,
            "https://x.test/",
            no_fonts(),
            net(&[("https://x.test/s.css", GREEN_CSS.into())]),
            w,
            h,
        );
        assert_eq!(px(&buf, w, 20, 20), GREEN);
    }

    /// デコードできる画像の形式。image クレートの feature は依存の合成で決まっていて
    /// (anyrender_svg が png / jpeg / gif / webp を立てる)、この crate では指定していない。
    /// SVG は image ではなく usvg が読む。
    ///
    /// WebP もこの経路で描けることは確認したが、単色の最小ファイルを作る手段が
    /// 手元に無いのでここでは見ていない。AVIF は**読めない** (`image` の avif 復号は
    /// `avif-native` = C の libdav1d で、wasm32 では作れない)
    #[test]
    fn decodable_image_formats() {
        let (w, h) = (40u32, 40u32);
        let html = r#"<body style="margin:0"><img src="https://x.test/a" width="40" height="40"></body>"#;
        for (name, bytes) in [
            ("png", b64(RED_PNG)),
            ("jpeg", b64(RED_JPEG)),
            ("gif", b64(RED_GIF)),
            ("svg", RED_SVG.into()),
        ] {
            let buf = render_with(
                html,
                "https://x.test/",
                no_fonts(),
                net(&[("https://x.test/a", bytes)]),
                w,
                h,
            );
            let p = px(&buf, w, 20, 20);
            // JPEG は非可逆なので少しずれる
            let red_ish = p[3] == 255 && p[0] > 200 && p[1] < 60 && p[2] < 60;
            assert!(red_ish, "{name} should decode to red, got {p:?}");
        }
    }

    /// `@font-face` の web font も表から返る。ここでは `fonts/` の TTF を使うが、
    /// woff2 でも描けることは確認した (blitz-dom の `woff` feature が既定で入っていて、
    /// wuff が Rust の中で Brotli をほどく。JS 側で woff2 を扱えないのとは別の話)
    #[test]
    fn web_font_from_table_is_used() {
        let (w, h) = (300u32, 80u32);
        let html = r#"<html><head><style>
            @font-face { font-family: probe; src: url(/f.ttf) format("truetype") }
            body { margin: 0 } p { margin: 0; font-size: 40px; font-family: probe }
            </style></head><body><p>Hello</p></body></html>"#;
        let Ok(ttf) = std::fs::read(&crate::font_file("sans-regular.ttf")) else { return };

        // フォントは 1 本も登録していないので、表から届かなければ 1 画素も塗られない
        let served = render_with(
            html,
            "https://x.test/",
            no_fonts(),
            net(&[("https://x.test/f.ttf", ttf)]),
            w,
            h,
        );
        let missing = render_with(html, "https://x.test/", no_fonts(), TableNetProvider::empty(), w, h);
        assert_eq!(inked(&missing, w, h), 0, "no font, no glyphs");
        assert!(inked(&served, w, h) > 200, "web font should paint glyphs");
    }

    /// 資源を渡さないときに、実ページが**白いまま**になっていないこと。
    ///
    /// この実装を入れると `<head>` の `<link rel="stylesheet">` が
    /// 「描画をブロックする資源」として数えられるようになる (`DummyNetProvider` の
    /// ときは数えられなかった)。応答を返し損ねると全ページが真っ白になるので、
    /// リポジトリに置いた実ページで見る (`crate/fixtures/` は .gitignore されて
    /// いるので、無ければ何もしない)。
    ///
    /// 手元で確かめた限り、表が空のときの出力は `DummyNetProvider` のときと
    /// 1 バイトも変わらなかった (6 ページ、400x300、フォント込み)。
    ///
    /// ここはフォントを持たないので、文字以外に何も塗らない todomvc は見ない
    #[test]
    fn bundled_fixtures_are_not_blank_without_resources() {
        let (w, h) = (400u32, 300u32);
        for name in ["example", "aiji42", "mdn", "wikipedia", "kitesurf"] {
            let Ok(html) = std::fs::read_to_string(format!("fixtures/{name}.html")) else {
                continue;
            };
            let buf = render_with(
                &html,
                "https://example.com/",
                no_fonts(),
                TableNetProvider::empty(),
                w,
                h,
            );
            let n = inked(&buf, w, h);
            assert!(n > 100, "{name} should still paint, got {n} inked pixels");
        }
    }

    /// 実ページを、画像を渡して JS と同じ経路 (`add_resource` + `render_png_rgba`) で描く。
    ///
    /// ```sh
    /// node scripts/fetch-page.mjs https://en.wikipedia.org/wiki/Main_Page /tmp/enwiki
    /// PAGE_DIR=/tmp/enwiki RENDER_DUMP_DIR=/tmp cargo test page_with_images -- --nocapture
    /// ```
    ///
    /// `PAGE_DIR` には `page.html` (外部 CSS を差し込んだもの)、`base.txt` (ページの URL)、
    /// `manifest.tsv` (絶対 URL \t ファイル名) と資源のファイルが入っている
    #[test]
    fn page_with_images() {
        let Ok(dir) = std::env::var("PAGE_DIR") else { return };
        let _guard = GLOBAL.lock().unwrap_or_else(|e| e.into_inner());

        let read = |name: &str| std::fs::read_to_string(format!("{dir}/{name}")).unwrap();
        let html = read("page.html");
        let base = read("base.txt").trim().to_string();

        crate::clear_fonts();
        for (path, family) in [
            (&crate::font_file("sans-regular.ttf"), "sans"),
            (&crate::font_file("sans-bold.ttf"), "sans"),
            (&crate::font_file("jp-regular.ttf"), "jp"),
        ] {
            crate::add_font(std::fs::read(path).unwrap(), family);
        }

        clear_resources();
        let manifest = read("manifest.tsv");
        let mut n = 0;
        for line in manifest.lines() {
            let Some((url, file)) = line.split_once('\t') else { continue };
            let Ok(bytes) = std::fs::read(format!("{dir}/{file}")) else { continue };
            add_resource(url, bytes);
            n += 1;
        }

        let (w, h) = (1000u32, 1400u32);
        let t = std::time::Instant::now();
        let buf = crate::render_png_rgba(&html, &base, w, h);
        eprintln!(
            "{base}: {n} resources, {} inked pixels, {:?}",
            inked(&buf, w, h),
            t.elapsed()
        );
        if let Ok(out) = std::env::var("RENDER_DUMP_DIR") {
            std::fs::write(format!("{out}/page_{w}x{h}.rgba"), &buf).unwrap();
        }
        clear_resources();
        crate::clear_fonts();
    }

    /// CSS の中から参照される画像は、表に無ければ記録に残る。
    ///
    /// これが 2 パス描画の入口。`background-image` の URL は HTML の `<img src>` を
    /// 走査しても出てこないので、「要求されたのに無かった」を数えるしかない
    #[test]
    fn css_image_miss_is_recorded() {
        let html = r#"<body style="margin:0"><div style="width:40px;height:40px;
            background-image:url(/bg.png);background-size:cover"></div></body>"#;
        let provider = TableNetProvider::empty();
        render_with(html, "https://x.test/", no_fonts(), provider.clone(), 40, 40);
        assert_eq!(provider.misses(), vec!["https://x.test/bg.png"]);
    }

    /// 記録は表と同じ鍵 (fragment を落としたもの) なので、SVG sprite の
    /// `#a` `#b` は 1 本にまとまる。`data:` は Rust 側で解けるので入らない
    #[test]
    fn misses_are_deduped_and_exclude_data_urls() {
        let html = format!(
            r#"<body style="margin:0">
            <img src="/i.svg#a" width="8" height="8">
            <img src="/i.svg#b" width="8" height="8">
            <img src="data:image/png;base64,{RED_PNG}" width="8" height="8">
            </body>"#
        );
        let provider = TableNetProvider::empty();
        render_with(&html, "https://x.test/", no_fonts(), provider.clone(), 40, 40);
        assert_eq!(provider.misses(), vec!["https://x.test/i.svg"]);
    }

    /// 2 パス: 外部 CSS が参照する画像を、1 回目の記録から足して 2 回目で描く。
    ///
    /// 1 回目に stylesheet を表から返しておくのは、`fetch` の中から `@import` や
    /// `@font-face` のためにもう一度 `fetch` が呼ばれる経路を通すため (記録の lock を
    /// handler の呼び出しまで持っていると、ここで固まる)
    #[test]
    fn two_passes_fill_in_a_css_image() {
        let (w, h) = (40u32, 40u32);
        let html = r#"<html><head><link rel="stylesheet" href="/s.css"></head>
            <body><div class="hero"></div></body></html>"#;
        let css = r#"@import "/more.css";
            body { margin: 0 }
            .hero { width: 40px; height: 40px;
                    background-image: url(/bg.png); background-size: cover }"#;
        let sheet = || ("https://x.test/s.css", Vec::from(css));

        // 1 回目: CSS だけを渡して描く。bg.png がどこから参照されているかは
        // カスケードが終わるまで分からないので、ここでは白のまま
        let first = net(&[sheet()]);
        let buf = render_with(html, "https://x.test/", no_fonts(), first.clone(), w, h);
        assert_eq!(px(&buf, w, 20, 20), WHITE, "1 回目は画像が無いので白");
        let missed = first.misses();
        assert!(
            missed.contains(&"https://x.test/bg.png".to_string()),
            "CSS から参照される画像が記録に出ること: {missed:?}"
        );
        // @import した先も同じ記録に出る (JS はこれも取ってきて足せる)
        assert!(missed.contains(&"https://x.test/more.css".to_string()), "{missed:?}");
        eprintln!("1 回目の取りこぼし: {missed:?}");

        // 2 回目: 記録に出た URL を「取得して」表に足し、もう 1 度描く。
        // Document は描画ごとに作り直すので、同じ URL がもう一度要求される
        let mut entries = vec![sheet()];
        for url in &missed {
            if url.ends_with(".png") {
                entries.push((url.as_str(), b64(BLUE_PNG)));
            } else {
                entries.push((url.as_str(), Vec::new()));
            }
        }
        let second = net(&entries);
        let buf = render_with(html, "https://x.test/", no_fonts(), second.clone(), w, h);
        assert_eq!(px(&buf, w, 20, 20), BLUE, "2 回目は CSS の画像が塗られる");
        assert_eq!(second.misses(), Vec::<String>::new(), "足したら取りこぼしは無くなる");
    }

    /// 表に足すと、次の回に**新しい取りこぼしが出てくる**ことがある。
    ///
    /// CSS の中の URL は、その CSS が表に入って初めて読める。`@import` が
    /// 何段か続くページでは 2 パスでは足りないので、JS 側は
    /// `missed_resources()` が空になるまで (または上限まで) 回すのがよい
    #[test]
    fn resources_inside_css_need_another_round() {
        let (w, h) = (40u32, 40u32);
        let html = r#"<html><head><link rel="stylesheet" href="/s.css"></head>
            <body><div class="hero"></div></body></html>"#;
        let outer = ("https://x.test/s.css", Vec::from(r#"@import "/more.css";"#));
        let inner = (
            "https://x.test/more.css",
            Vec::from(
                r#"body { margin: 0 }
                .hero { width: 40px; height: 40px;
                        background-image: url(/deep.png); background-size: cover }"#,
            ),
        );

        // 1 回目: s.css だけ。deep.png はまだ誰も知らない
        let first = net(&[outer.clone()]);
        render_with(html, "https://x.test/", no_fonts(), first.clone(), w, h);
        assert_eq!(first.misses(), vec!["https://x.test/more.css"]);

        // 2 回目: @import 先が読めたので、その中の画像が記録に出る
        let second = net(&[outer.clone(), inner.clone()]);
        let buf = render_with(html, "https://x.test/", no_fonts(), second.clone(), w, h);
        assert_eq!(px(&buf, w, 20, 20), WHITE);
        assert_eq!(second.misses(), vec!["https://x.test/deep.png"]);

        // 3 回目: 全部そろって描ける
        let third = net(&[outer, inner, ("https://x.test/deep.png", b64(BLUE_PNG))]);
        let buf = render_with(html, "https://x.test/", no_fonts(), third.clone(), w, h);
        assert_eq!(px(&buf, w, 20, 20), BLUE);
        assert_eq!(third.misses(), Vec::<String>::new());
    }

    /// JS が通る経路 (`add_resource` / `missed_resources` / `render_png_rgba`) で
    /// 2 パスが回る。フォントは登録しないので、見るのは画像の色だけ
    #[test]
    fn missed_resources_drives_the_second_pass() {
        let _guard = GLOBAL.lock().unwrap_or_else(|e| e.into_inner());
        let (w, h) = (40u32, 40u32);
        let html = r#"<html><head><style>body { margin: 0 }
            .hero { width: 40px; height: 40px;
                    background-image: url(/bg.png); background-size: cover }
            </style></head><body><div class="hero"></div></body></html>"#;

        clear_resources();
        assert!(missed_resources().is_empty());

        let buf = crate::render_png_rgba(html, "https://x.test/", w, h);
        assert_eq!(px(&buf, w, 20, 20), WHITE);
        assert_eq!(missed_resources(), vec!["https://x.test/bg.png"]);

        for url in missed_resources() {
            add_resource(&url, b64(RED_PNG));
        }
        let buf = crate::render_png_rgba(html, "https://x.test/", w, h);
        assert_eq!(px(&buf, w, 20, 20), RED, "2 回目で画像が出ること");
        assert!(missed_resources().is_empty(), "残りは無い");

        clear_resources();
        assert!(missed_resources().is_empty(), "clear_resources で記録も消える");
    }

    /// wasm-bindgen 向けの入口 (グローバルの表) も一通り動く
    #[test]
    fn global_table_roundtrip() {
        let _guard = GLOBAL.lock().unwrap_or_else(|e| e.into_inner());
        clear_resources();
        assert!(resource_urls().is_empty());
        // path の無い URL は `https://x.test/` に揃えて鍵にする
        assert_eq!(add_resource("https://x.test", b64(RED_PNG)), "https://x.test/");
        assert_eq!(resource_urls(), vec!["https://x.test/"]);

        let provider = TableNetProvider::current();
        assert!(provider.lookup("https://x.test/").is_some());
        assert!(provider.lookup("https://y.test/").is_none());
        assert_eq!(provider.fetches(), 0);
        // 引けなかったぶんだけが記録に残る
        assert_eq!(provider.misses(), vec!["https://y.test/"]);

        // 描画の途中で表を差し替えても、その描画は始めにコピーした表で最後まで進む
        clear_resources();
        assert!(provider.lookup("https://x.test/").is_some());
        assert!(TableNetProvider::current().lookup("https://x.test/").is_none());
    }
}
