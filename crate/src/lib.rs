//! Kitesurf が公開情報で挙げている構成 (Blitz + Stylo + Parley) を、
//! そのまま wasm32-unknown-unknown に載せて HTML を絵にする。
//!
//! 第 1 段: blitz-html で HTML をパースし、Stylo にスタイルを解決させる (`parse_and_resolve`)。
//! 第 2 段: blitz-paint + vello_cpu で RGBA のピクセル列に描く (`render_png_rgba`)。

use std::sync::{Arc, Mutex};

use anyrender::{ImageRenderer, PaintScene};
use anyrender_vello_cpu::VelloCpuImageRenderer;
use blitz_dom::{BaseDocument, Document, DocumentConfig, FontContext, StyleThreading};
use blitz_traits::shell::{ColorScheme, Viewport};
use kurbo::{Affine, Rect};
use parley::fontique::{
    Blob, Collection, CollectionOptions, FamilyId, FontInfoOverride, GenericFamily, Script,
    SourceCache,
};
use peniko::{Color, Fill};
use wasm_bindgen::prelude::*;

/// サブリソース (画像・外部 CSS・web font) を JS が渡した表から返す `NetProvider`。
/// 入口は `add_resource` / `clear_resources`
pub mod net;
use net::TableNetProvider;

/// ページの `<script>` を Boa で実行する。入口は `set_js_enabled` / `last_js_errors`
pub mod script;

/// テストが読むフォントの場所。`scripts/build-fonts.mjs` の出力先は
/// `public/fonts/` (Worker が Static Assets として配る場所) だが、
/// 以前は `fonts/` だったので、両方を見る
#[cfg(all(test, not(target_arch = "wasm32")))]
pub fn font_file(name: &str) -> String {
    let candidates = [format!("../public/fonts/{name}"), format!("../fonts/{name}")];
    candidates
        .iter()
        .find(|path| std::path::Path::new(path).exists())
        .cloned()
        .unwrap_or_else(|| candidates[0].clone())
}

/// 直前の panic のメッセージ。panic hook が書き、`last_panic` で JS から取り出す
static LAST_PANIC: Mutex<Option<String>> = Mutex::new(None);

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = console, js_name = error)]
    fn console_error(s: &str);
}

/// wasm-bindgen の init 時に呼ばれる。panic のメッセージを外に残す。
///
/// wasm32-unknown-unknown は unwind できない (target 自体が abort 固定で、
/// `panic = "unwind"` にしても `catch_unwind` は何も捕まえない)。panic は最終的に
/// `unreachable` 命令でトラップし、JS 側には `RuntimeError: unreachable` しか届かない。
/// そこで abort の前に走る panic hook で
///   1. `console.error` にメッセージ (発生箇所の file:line 入り) を流し、
///   2. `LAST_PANIC` に控える。
/// 呼び出し側は `RuntimeError` を受けたら `last_panic()` で中身を取り出せる。
///
/// hook の中から `wasm_bindgen::throw_str` で JS の例外を投げる手もあるが、hook から
/// 抜けないと std の「panic 処理中」フラグが立ったままになり、同じインスタンスでの
/// 2 度目の panic は hook を通らず即 abort になる。wasm-bindgen の glue は
/// インスタンスを 1 つしか持たず (`init` を呼び直しても同じものが返る) Workers の
/// isolate はリクエストをまたいで生きるので、hook は素直に return して abort に任せる。
///
/// トラップの後も wasm のメモリは残っている。abort は hook の処理が終わってから
/// 呼ばれるので、`last_panic()` で `LAST_PANIC` を読むのは安全。ただし panic を
/// 起こした描画の途中状態 (借用中の RefCell 等) は捨てられずに残るので、
/// 次の描画が連鎖して panic する可能性はある。それも同じ経路でメッセージが出る
#[wasm_bindgen(start)]
pub fn init() {
    #[cfg(target_arch = "wasm32")]
    std::panic::set_hook(Box::new(|info| {
        // Display は "panicked at <file>:<line>:<col>:\n<message>" の形
        let msg = info.to_string();
        console_error(&format!("[kitesurf_clone] {msg}"));
        if let Ok(mut slot) = LAST_PANIC.lock() {
            *slot = Some(msg);
        }
    }));
}

/// 直前の panic のメッセージを取り出す (取り出すと消える)。無ければ `None` (JS では `undefined`)。
/// `render_png_rgba` が `RuntimeError: unreachable` で落ちた直後に呼ぶ
#[wasm_bindgen]
pub fn last_panic() -> Option<String> {
    LAST_PANIC.lock().ok().and_then(|mut slot| slot.take())
}

/// 相対 URL を解決する起点。blitz-dom の既定は `data:text/css;charset=utf-8;base64,` で、
/// これは base になれない URL なので、`<link href="/x.css">` のような相対参照が 1 つでも
/// あると `resolve_url` が panic する。ページの URL が無い (インライン HTML) ときは
/// 適当な絶対 URL を敷いて、少なくとも落ちないようにする
const FALLBACK_BASE_URL: &str = "https://inline.invalid/";

fn base_url_or_fallback(base_url: &str) -> String {
    match url::Url::parse(base_url) {
        Ok(u) if !u.cannot_be_a_base() => u.to_string(),
        _ => FALLBACK_BASE_URL.to_string(),
    }
}

/// HTML を渡してノード数を返す。ここが通れば
/// html5ever + Stylo + Taffy が wasm32 で動いていることになる。
pub fn parse_and_resolve(html: &str) -> usize {
    let mut doc: BaseDocument = blitz_html::HtmlDocument::from_html(
        html,
        DocumentConfig {
            base_url: Some(FALLBACK_BASE_URL.to_string()),
            // wasm32 には rayon のスレッドプールが無いので並列トラバースは使えない
            style_threading: StyleThreading::Sequential,
            ..Default::default()
        },
    )
    .into();
    doc.resolve(0.0);
    doc.root_element().children.len()
}

/// CSS の generic family 全部。fontique には `ALL` 定数が無いので列挙する
const GENERIC_FAMILIES: [GenericFamily; 13] = [
    GenericFamily::Serif,
    GenericFamily::SansSerif,
    GenericFamily::Monospace,
    GenericFamily::Cursive,
    GenericFamily::Fantasy,
    GenericFamily::SystemUi,
    GenericFamily::UiSerif,
    GenericFamily::UiSansSerif,
    GenericFamily::UiMonospace,
    GenericFamily::UiRounded,
    GenericFamily::Emoji,
    GenericFamily::Math,
    GenericFamily::FangSong,
];

/// script ごとの fallback。Parley は「指定された family に無い文字」を script 単位の
/// fallback で探すので、ここが空だと日本語や記号が 0 幅になる。
///
/// 右はその script の代表文字。これを持っている family を fallback の先頭に置く
/// (`Hani` / `Hira` / `Kana` は日本語フォントが先、`Latn` は Latin フォントが先になる)。
/// `None` の script (共通記号など) は登録順のまま
const FALLBACK_SCRIPTS: [([u8; 4], Option<char>); 14] = [
    (*b"Latn", Some('a')),
    (*b"Cyrl", Some('а')),
    (*b"Grek", Some('α')),
    (*b"Hani", Some('日')),
    (*b"Hira", Some('あ')),
    (*b"Kana", Some('ア')),
    (*b"Hang", Some('한')),
    (*b"Arab", Some('ا')),
    (*b"Hebr", Some('א')),
    (*b"Deva", Some('क')),
    (*b"Thai", Some('ก')),
    (*b"Zyyy", None),
    (*b"Zinh", None),
    (*b"Zzzz", None),
];

/// 登録済みのフォント。`add_font` で増え、`render_png_rgba` が毎回ここから `FontContext` を組む。
///
/// (バイト列, family 名) の列。バイト列は `Blob` (Arc) なので `FontContext` を組み直しても
/// フォント本体はコピーされない
struct FontRegistry {
    fonts: Vec<(Blob<u8>, String)>,
    /// `fonts` から組んだ `FontContext`。`add_font` のたびに作り直す。
    /// `render_png_rgba` はこれを clone して blitz-dom に渡す (Collection の clone は
    /// family の表をコピーするだけで、フォントのバイト列は Arc の共有)
    ctx: FontContext,
}

static FONTS: Mutex<Option<FontRegistry>> = Mutex::new(None);

/// フォントを 1 本登録する。`render_png_rgba` より先に、フォントごとに 1 回ずつ呼ぶ。
///
/// - `bytes` は TTF / OTF / TTC の中身
/// - `family` はこのフォントを入れる family の名前。**フォントファイルの中の名前は使わない**。
///   同じ `family` で regular と bold を登録すると、1 つの family の中で weight が解決される。
///   別の文字集合のフォント (Latin と日本語など) は必ず別の `family` にする。同じ family に
///   入れると、weight の一致で 1 本だけが選ばれて、もう 1 本の文字が消える
/// - 登録した順が優先順位になる。CSS の `sans-serif` などは、先に登録した family から順に
///   文字を探す。Latin を先、日本語を後に登録すればよい (どちらも持っている文字は Latin で出る)
/// - 戻り値は登録できた face の数。0 ならフォントとして読めなかった (何も登録されない)
///
/// 登録は wasm インスタンスに残る。Workers では isolate が生きている間は有効なので、
/// 初期化のときに 1 度だけ呼ぶ (2 度呼ぶと同じ face が 2 つ入る)
#[wasm_bindgen]
pub fn add_font(bytes: Vec<u8>, family: &str) -> usize {
    let blob = Blob::new(Arc::new(bytes));
    let mut guard = FONTS.lock().unwrap_or_else(|e| e.into_inner());
    let mut fonts = guard.take().map(|r| r.fonts).unwrap_or_default();
    fonts.push((blob, family.to_string()));
    let (mut ctx, counts) = build_font_ctx(&fonts);
    let added = counts.last().copied().unwrap_or(0);
    if added == 0 {
        // フォントとして読めなかったものは残さない (family 名だけが残ると紛らわしい)
        fonts.pop();
        ctx = build_font_ctx(&fonts).0;
    }
    *guard = Some(FontRegistry { fonts, ctx });
    added
}

/// 登録したフォントを全部消す
#[wasm_bindgen]
pub fn clear_fonts() {
    *FONTS.lock().unwrap_or_else(|e| e.into_inner()) = None;
}

/// 登録済みの family 名を登録順に返す (確認用)
#[wasm_bindgen]
pub fn font_families() -> Vec<String> {
    let guard = FONTS.lock().unwrap_or_else(|e| e.into_inner());
    let mut names: Vec<String> = Vec::new();
    if let Some(r) = guard.as_ref() {
        for (_, family) in &r.fonts {
            if !names.contains(family) {
                names.push(family.clone());
            }
        }
    }
    names
}

/// 登録済みのフォントから `FontContext` を取り出す。何も登録されていなければ空のもの
/// (リストの黒丸だけ描ける) を返す
fn current_font_ctx() -> FontContext {
    let guard = FONTS.lock().unwrap_or_else(|e| e.into_inner());
    match guard.as_ref() {
        Some(r) => r.ctx.clone(),
        None => build_font_ctx(&[]).0,
    }
}

/// 渡されたフォントだけで完結する `FontContext` を組む。
///
/// wasm32 には OS のフォントが無い。fontique は `system_fonts: true` でも
/// wasm32 ではダミーのバックエンドになるだけだが、generic family (sans-serif など) と
/// script fallback が空のままなので、渡されたフォントを全部に結び付ける必要がある。
///
/// 戻り値の 2 つ目は、`fonts` の各要素から登録できた face の数
fn build_font_ctx(fonts: &[(Blob<u8>, String)]) -> (FontContext, Vec<usize>) {
    let mut collection = Collection::new(CollectionOptions {
        shared: false,
        system_fonts: false,
    });

    // family は呼び出し側の名前で作る。ファイルの中の名前 (name テーブル) は見ない。
    // Noto Sans JP の Latin サブセットと日本語サブセットは中の名前が同じなので、
    // それに任せると 1 つの family に混ざって weight の一致で片方しか選ばれなくなる
    let mut family_ids: Vec<FamilyId> = Vec::new();
    let mut counts = Vec::with_capacity(fonts.len());
    for (blob, family) in fonts {
        let registered = collection.register_fonts(
            blob.clone(),
            Some(FontInfoOverride {
                family_name: Some(family),
                ..Default::default()
            }),
        );
        counts.push(registered.iter().map(|(_, faces)| faces.len()).sum());
        for (id, _) in registered {
            if !family_ids.contains(&id) {
                family_ids.push(id);
            }
        }
    }

    // generic family は登録順。先に登録した family から順に文字を探す
    for generic in GENERIC_FAMILIES {
        collection.set_generic_families(generic, family_ids.iter().copied());
    }

    // script fallback は、その script の代表文字を持つ family を先頭に寄せる。
    // 順序は安定なので、同じ側に入った family どうしは登録順のまま
    for (script, probe) in FALLBACK_SCRIPTS {
        let ordered: Vec<FamilyId> = match probe {
            Some(ch) => {
                let (covering, rest): (Vec<FamilyId>, Vec<FamilyId>) = family_ids
                    .iter()
                    .copied()
                    .partition(|&id| family_covers(&mut collection, id, ch));
                covering.into_iter().chain(rest).collect()
            }
            None => family_ids.clone(),
        };
        collection.set_fallbacks(Script::from_bytes(script), ordered.into_iter());
    }

    // blitz-dom は font_ctx を渡されなかったときだけ、リストの黒丸用フォントを自分で登録する。
    // 自前の font_ctx を渡すとその経路を通らないので、ここで登録しておく
    collection.register_fonts(Blob::new(Arc::new(blitz_dom::BULLET_FONT) as _), None);

    (
        FontContext {
            collection,
            source_cache: SourceCache::default(),
        },
        counts,
    )
}

/// family の中のどれかの face が `ch` のグリフを持っているか
fn family_covers(collection: &mut Collection, id: FamilyId, ch: char) -> bool {
    let Some(family) = collection.family(id) else { return false };
    family.fonts().iter().any(|font| {
        // メモリから登録したフォントなので load は Blob をそのまま返す (キャッシュ不要)
        font.load(None)
            .and_then(|data| font.charmap_index().charmap(data.as_ref()).and_then(|cm| cm.map(ch)))
            .is_some_and(|g| g != 0)
    })
}

/// HTML を `width` x `height` のビューポートに描き、RGBA8 のピクセル列を返す。
///
/// - 戻り値は `width * height * 4` バイト。左上から行優先、1 ピクセル = R, G, B, A
/// - 背景は白で塗ってから描くので全ピクセルの A は 255。vello_cpu の出力は
///   premultiplied RGBA だが、A = 255 なら straight と一致するので JS 側で
///   そのまま PNG にできる
/// - `base_url` はページの URL。`<link href>` や `<img src>` の相対参照を解決する起点に
///   なる。取得はしないが、解決できないと blitz-dom が panic するので必ず絶対 URL を渡す。
///   インライン HTML のように URL が無いときは空文字でよい (内部で仮の URL を敷く)
/// - フォントは先に `add_font` で登録しておく。CSS の font-family が何を指していても、
///   登録したフォントの中から文字を持つものに落ちる。何も登録していないと文字は描かれない
/// - vello_cpu の描画面は u16 なので、辺の長さは 65535 まで
/// - サブリソース (画像・外部 CSS・web font) は**先に `add_resource` で渡した表からだけ**
///   届く。Rust 側から通信はしない。表に無いものは無かったものとして描く
///   (画像はその場所が空き、CSS は当たらない)
/// - 表に無かった URL は `missed_resources` に残る。JS はそれを取ってきて
///   `add_resource` で足し、もう 1 度これを呼ぶ (CSS の中から参照される画像は
///   この 2 パスでしか拾えない)
/// - ページの `<script>` は Boa で実行する。`set_js_enabled(false)` で切れる。
///   外部スクリプト (`<script src>`) も資源の表から引く (表に無ければ
///   `missed_resources` に出るので、2 パス目で当たる)。
///   拾われなかった例外は `last_js_errors` に出る
#[wasm_bindgen]
pub fn render_png_rgba(html: &str, base_url: &str, width: u32, height: u32) -> Vec<u8> {
    render_maybe_js(html, base_url, width, height, script::js_enabled())
}

/// `render_png_rgba` と同じだが、ページの `<script>` を実行しない。
///
/// 実ページの崩れが JS のせいなのかを 1 回だけ切り分けたいときに使う
/// (`set_js_enabled` と違って設定を残さない)
#[wasm_bindgen]
pub fn render_png_rgba_no_js(html: &str, base_url: &str, width: u32, height: u32) -> Vec<u8> {
    render_maybe_js(html, base_url, width, height, false)
}

fn render_maybe_js(html: &str, base_url: &str, width: u32, height: u32, js: bool) -> Vec<u8> {
    let net = TableNetProvider::current();
    let buf = render_with_opts(
        html,
        base_url,
        current_font_ctx(),
        net.clone(),
        width,
        height,
        js,
    );
    // 何を取りこぼしたかを JS から読めるところに置く。次の描画で置き換わる
    net::publish_misses(&net);
    buf
}

/// `FontContext` を外から渡す (フォントまわりのテストはグローバルを触らずにこれを使う)。
/// サブリソースの表は空
#[cfg_attr(not(test), allow(dead_code))]
fn render_with_ctx(
    html: &str,
    base_url: &str,
    font_ctx: FontContext,
    width: u32,
    height: u32,
) -> Vec<u8> {
    render_with(
        html,
        base_url,
        font_ctx,
        TableNetProvider::empty(),
        width,
        height,
    )
}

/// `render_png_rgba` の本体 (JS 無し)。`FontContext` とサブリソースの表を外から渡す
fn render_with(
    html: &str,
    base_url: &str,
    font_ctx: FontContext,
    net: Arc<TableNetProvider>,
    width: u32,
    height: u32,
) -> Vec<u8> {
    render_with_opts(html, base_url, font_ctx, net, width, height, false)
}

/// 描画の本体。`js` が真ならページの `<script>` を実行する。
///
/// JS を実行するときは `blitz-vibey-script` が `BaseDocument` を抱えてしまう
/// (中の `Rc<RefCell<_>>` は取り出せない) ので、どちらの場合も blitz-dom の
/// `Document` (= `BaseDocument` を貸してくれるもの) として扱う
fn render_with_opts(
    html: &str,
    base_url: &str,
    font_ctx: FontContext,
    net: Arc<TableNetProvider>,
    width: u32,
    height: u32,
    js: bool,
) -> Vec<u8> {
    let config = DocumentConfig {
        viewport: Some(Viewport::new(width, height, 1.0, ColorScheme::Light)),
        base_url: Some(base_url_or_fallback(base_url)),
        font_ctx: Some(font_ctx),
        net_provider: Some(net.clone()),
        // wasm32 には rayon のスレッドプールが無いので並列トラバースは使えない
        style_threading: StyleThreading::Sequential,
        ..Default::default()
    };

    let mut page: Box<dyn Document> = if js {
        // 実行の前に 1 度スタイルとレイアウトを付ける
        // (`offsetWidth` のようにレイアウトを読むスクリプトのため)
        let mut doc = script::prepare(html, config, net.clone());
        settle(&mut doc, &net);
        // ここで初めて JS が走る。DOM が変わる
        script::run(&mut doc);
        Box::new(doc)
    } else {
        Box::new(BaseDocument::from(blitz_html::HtmlDocument::from_html(
            html, config,
        )))
    };

    // JS の前に 1 度落ち着かせてあっても、JS が足したノードのために
    // もう 1 度回す (JS 無しのときはこれが 1 度目)
    settle(&mut *page, &net);

    let mut renderer = VelloCpuImageRenderer::new(width, height);
    let mut buf = Vec::new();
    renderer.render_to_vec(
        |scene| {
            // blitz-paint は html / body に background が指定されているときだけ
            // ページ背景を塗る。無指定なら透明のままになるので、先に白で敷く
            scene.fill(
                Fill::NonZero,
                Affine::IDENTITY,
                Color::WHITE,
                None,
                &Rect::new(0.0, 0.0, width as f64, height as f64),
            );
            blitz_paint::paint_scene(scene, &mut page.inner_mut(), 1.0, width, height, 0, 0);
        },
        &mut buf,
    );
    buf
}

/// 取得が増えなくなるまで `resolve` を回す。
///
/// 資源の取得は同期的に済んでいるが、応答は blitz-dom のメッセージ列に積まれるだけ。
/// 取り込むのは次の `resolve` の頭なので、1 回では絵に入らない。
///
/// しかも取得が始まる時点が資源によって違う。`<img src>` は DOM を組む途中、
/// CSS の `background-image` はレイアウトの途中、`@font-face` は外部 CSS を
/// 読み終えたあと。取得が増えなくなるまで回す (上限 4 週)
fn settle(page: &mut dyn Document, net: &TableNetProvider) {
    for _ in 0..4 {
        let before = net.fetches();
        page.inner_mut().resolve(0.0);
        if net.fetches() == before {
            break;
        }
    }
}

#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests {
    use super::*;

    /// フォントのファイル名。場所は `font_file` が決める
    const SANS: &str = "sans-regular.ttf";
    const SANS_BOLD: &str = "sans-bold.ttf";
    const JP: &str = "jp-regular.ttf";

    /// (ファイル名, family) の列から FontContext を組む。グローバルの `FONTS` は触らない
    /// (cargo test はスレッド並列なので、テストどうしで共有すると順序に依存する)
    fn ctx(fonts: &[(&str, &str)]) -> FontContext {
        let fonts: Vec<(Blob<u8>, String)> = fonts
            .iter()
            .map(|(name, family)| {
                let path = font_file(name);
                let bytes = std::fs::read(&path).unwrap_or_else(|e| panic!("{path}: {e}"));
                (Blob::new(Arc::new(bytes)), family.to_string())
            })
            .collect();
        build_font_ctx(&fonts).0
    }

    /// Latin と日本語の 2 family、Latin は regular + bold
    fn latin_jp() -> FontContext {
        ctx(&[(SANS, "sans"), (SANS_BOLD, "sans"), (JP, "jp")])
    }

    fn px(buf: &[u8], width: u32, x: u32, y: u32) -> [u8; 4] {
        let i = ((y * width + x) * 4) as usize;
        [buf[i], buf[i + 1], buf[i + 2], buf[i + 3]]
    }

    /// 白でも背景色でもない画素の数 (= 文字が描かれた量の目安)
    fn inked(buf: &[u8], w: u32, h: u32, bg: [u8; 4]) -> usize {
        (0..h)
            .flat_map(|y| (0..w).map(move |x| (x, y)))
            .filter(|&(x, y)| {
                let p = px(buf, w, x, y);
                p != bg && p != [255, 255, 255, 255]
            })
            .count()
    }

    #[test]
    fn renders_background_and_text() {
        let (w, h) = (200u32, 100u32);
        let html = r#"<html><body style="margin:0;background:#ff0000">
            <p style="margin:0;font-size:40px;color:#000">Hello</p></body></html>"#;
        let buf = render_with_ctx(html, "", latin_jp(), w, h);
        assert_eq!(buf.len(), (w * h * 4) as usize);

        // 右下は body の背景色 (赤) のまま
        assert_eq!(px(&buf, w, w - 1, h - 1), [255, 0, 0, 255]);

        // 文字が描かれていれば、上部の帯に赤でも白でもない画素がある
        let non_bg = inked(&buf[..(w * 50 * 4) as usize], w, 50, [255, 0, 0, 255]);
        assert!(non_bg > 50, "text should be rasterized, got {non_bg} non-bg pixels");

        // 目視用に RGBA をそのまま吐く (PNG 化は scripts 側)
        if let Ok(dir) = std::env::var("RENDER_DUMP_DIR") {
            std::fs::write(format!("{dir}/render_{w}x{h}.rgba"), &buf).unwrap();
        }
    }

    #[test]
    fn white_background_when_unspecified() {
        let buf = render_with_ctx("<p>x</p>", "", latin_jp(), 50, 50);
        assert_eq!(px(&buf, 50, 49, 49), [255, 255, 255, 255]);
    }

    /// フォントを 1 本も登録していなくても落ちない (文字は出ない)
    #[test]
    fn no_fonts_does_not_panic() {
        let buf = render_with_ctx("<p>Hello 日本語</p>", "", ctx(&[]), 100, 50);
        assert_eq!(buf.len(), 100 * 50 * 4);
    }

    const JA_HTML: &str = r#"<html><body style="margin:0;background:#fff">
        <p style="margin:0;font-size:40px;color:#000;font-family:sans-serif">日本語のテキスト</p>
        </body></html>"#;

    /// Latin だけだと日本語は描かれない (これが今回直したかった現象)
    #[test]
    fn japanese_is_blank_with_latin_only() {
        let (w, h) = (400u32, 60u32);
        let buf = render_with_ctx(JA_HTML, "", ctx(&[(SANS, "sans")]), w, h);
        let n = inked(&buf, w, h, [255, 255, 255, 255]);
        assert!(n < 20, "expected no glyphs without a JP font, got {n} inked pixels");
    }

    /// 日本語フォントを足すと描かれる
    #[test]
    fn japanese_renders_with_jp_font() {
        let (w, h) = (400u32, 60u32);
        let buf = render_with_ctx(JA_HTML, "", latin_jp(), w, h);
        let n = inked(&buf, w, h, [255, 255, 255, 255]);
        assert!(n > 500, "expected JP glyphs, got {n} inked pixels");
        if let Ok(dir) = std::env::var("RENDER_DUMP_DIR") {
            std::fs::write(format!("{dir}/japanese_{w}x{h}.rgba"), &buf).unwrap();
        }
    }

    /// Latin と日本語が 1 行に混ざっても両方出る。CSS が知らない family 名を指しても
    /// (script fallback に落ちても) 同じ
    #[test]
    fn mixed_latin_and_japanese() {
        let (w, h) = (600u32, 60u32);
        let html = r#"<p style="margin:0;font-size:40px;font-family:'No Such Font'">Rust と 日本語 abc</p>"#;
        let only_latin = inked(&render_with_ctx(html, "", ctx(&[(SANS, "sans")]), w, h), w, h, [255; 4]);
        let both = inked(&render_with_ctx(html, "", latin_jp(), w, h), w, h, [255; 4]);
        assert!(only_latin > 200, "latin part should render: {only_latin}");
        assert!(both > only_latin + 500, "adding JP should add glyphs: {only_latin} -> {both}");
    }

    /// bold を同じ family に登録すると、`<b>` が太くなる (塗られる画素が増える)
    #[test]
    fn bold_face_is_used_for_bold_text() {
        let (w, h) = (300u32, 60u32);
        let html = r#"<p style="margin:0;font-size:40px;font-family:sans-serif"><b>Hello World</b></p>"#;
        let regular_only = inked(&render_with_ctx(html, "", ctx(&[(SANS, "sans")]), w, h), w, h, [255; 4]);
        let with_bold = inked(&render_with_ctx(html, "", latin_jp(), w, h), w, h, [255; 4]);
        assert!(
            with_bold > regular_only + regular_only / 10,
            "bold face should ink more pixels: regular-only {regular_only}, with bold {with_bold}"
        );
    }

    /// script fallback の順序: Hani / Hira / Kana は jp が先、Latn は sans が先
    #[test]
    fn fallback_order_prefers_font_covering_the_script() {
        let mut fc = latin_jp();
        let sans = fc.collection.family_id("sans").unwrap();
        let jp = fc.collection.family_id("jp").unwrap();
        let order = |fc: &mut FontContext, s: &[u8; 4]| -> Vec<FamilyId> {
            fc.collection.fallback_families(Script::from_bytes(*s)).collect()
        };
        assert_eq!(order(&mut fc, b"Latn"), vec![sans, jp]);
        assert_eq!(order(&mut fc, b"Hani"), vec![jp, sans]);
        assert_eq!(order(&mut fc, b"Hira"), vec![jp, sans]);
        assert_eq!(order(&mut fc, b"Kana"), vec![jp, sans]);
        // 代表文字を決めていない script は登録順
        assert_eq!(order(&mut fc, b"Zyyy"), vec![sans, jp]);
        // generic family は登録順で、全部に両方が載っている
        for g in GENERIC_FAMILIES {
            let fams: Vec<FamilyId> = fc.collection.generic_families(g).collect();
            assert_eq!(fams, vec![sans, jp], "{g:?}");
        }
        // 同じ family 名で登録した regular と bold は 1 つの family に 2 face
        assert_eq!(fc.collection.family(sans).unwrap().fonts().len(), 2);
        assert_eq!(fc.collection.family(jp).unwrap().fonts().len(), 1);
    }

    /// wasm-bindgen 向けの入口 (グローバル登録) も一通り動く。
    /// フォントのグローバルを触るのはこのテストだけ。`render_png_rgba` は
    /// 資源の表と `missed_resources` も触るので、`net` 側のテストと直列にする
    #[test]
    fn global_registry_roundtrip() {
        let _guard = net::GLOBAL.lock().unwrap_or_else(|e| e.into_inner());
        clear_fonts();
        assert_eq!(add_font(std::fs::read(font_file(SANS)).unwrap(), "sans"), 1);
        assert_eq!(add_font(std::fs::read(font_file(SANS_BOLD)).unwrap(), "sans"), 1);
        assert_eq!(add_font(std::fs::read(font_file(JP)).unwrap(), "jp"), 1);
        // 読めないものは登録されず、family 名も残らない
        assert_eq!(add_font(b"not a font".to_vec(), "junk"), 0);
        assert_eq!(font_families(), vec!["sans", "jp"]);
        let buf = render_png_rgba(JA_HTML, "", 400, 60);
        assert!(inked(&buf, 400, 60, [255; 4]) > 500);
        clear_fonts();
        assert!(font_families().is_empty());
    }
}

#[cfg(all(test, not(target_arch = "wasm32")))]
mod fixture_tests {
    use super::*;

    fn fonts() -> FontContext {
        let load = |path: &str, family: &str| {
            (Blob::new(Arc::new(std::fs::read(path).unwrap())), family.to_string())
        };
        build_font_ctx(&[
            load(&font_file("sans-regular.ttf"), "sans"),
            load(&font_file("sans-bold.ttf"), "sans"),
            load(&font_file("jp-regular.ttf"), "jp"),
        ])
        .0
    }

    /// 相対 URL の stylesheet があっても落ちない (以前は blitz-dom の `resolve_url` で panic した)。
    /// base_url が空 (インライン HTML) でも同じ
    #[test]
    fn relative_stylesheet_does_not_panic() {
        let html = r#"<html><head>
            <link rel="stylesheet" href="/a.css">
            <link rel="stylesheet" href="a.css">
            <link rel="icon" href="/favicon.svg">
            <style>@import "b.css"; body { background: url(c.png) }</style>
            </head><body><img src="d.png"><p>x</p></body></html>"#;
        for base in ["", "https://example.com/post/", "not a url", "data:text/html,x"] {
            let buf = render_with_ctx(html, base, fonts(), 64, 64);
            assert_eq!(buf.len(), 64 * 64 * 4, "base_url = {base:?}");
        }
    }

    /// リポジトリに置いた実ページ (相対 stylesheet を持つもの) が全部通る
    #[test]
    fn bundled_fixtures_render() {
        for name in ["example", "todomvc", "aiji42", "mdn", "wikipedia", "kitesurf"] {
            let html = std::fs::read_to_string(format!("fixtures/{name}.html")).unwrap();
            let buf = render_with_ctx(&html, "https://example.com/", fonts(), 320, 240);
            assert_eq!(buf.len(), 320 * 240 * 4, "{name}");
        }
    }

    /// `FIXTURE=fixtures/kitesurf.html cargo test fixture -- --nocapture` で実ページを食わせる
    #[test]
    fn render_fixture() {
        let Ok(path) = std::env::var("FIXTURE") else { return };
        let html = std::fs::read_to_string(&path).unwrap();
        let base = std::env::var("FIXTURE_BASE").unwrap_or_else(|_| "https://example.com/".into());
        let t = std::time::Instant::now();
        let buf = render_with_ctx(&html, &base, fonts(), 800, 600);
        eprintln!("{path}: {} bytes html -> {} bytes rgba in {:?}", html.len(), buf.len(), t.elapsed());
        if let Ok(dir) = std::env::var("RENDER_DUMP_DIR") {
            std::fs::write(format!("{dir}/fixture.rgba"), &buf).unwrap();
        }
    }
}

#[cfg(all(test, not(target_arch = "wasm32")))]
mod script_tests {
    use super::*;

    /// 受け入れテストの HTML。`<b>` は赤、`<i>` は緑。JS が動けば赤が緑に置き換わる
    const ACCEPTANCE: &str = r#"<style>body{font:16px sans-serif;padding:20px}b{color:#c00}i{color:#080;font-style:normal}</style>
<p id="a">JS は <b>動いていない</b></p>
<p>2 + 2 = <span id="b">?</span></p>
<script>
  document.getElementById("a").innerHTML = 'JS は <i>動いた</i>';
  document.getElementById("b").textContent = 2 + 2;
</script>"#;

    fn fonts() -> FontContext {
        let load = |path: &str, family: &str| {
            (
                Blob::new(Arc::new(std::fs::read(path).unwrap())),
                family.to_string(),
            )
        };
        build_font_ctx(&[
            load(&font_file("sans-regular.ttf"), "sans"),
            load(&font_file("sans-bold.ttf"), "sans"),
            load(&font_file("jp-regular.ttf"), "jp"),
        ])
        .0
    }

    fn render(html: &str, js: bool, w: u32, h: u32) -> Vec<u8> {
        render_with_opts(
            html,
            "https://x.test/",
            fonts(),
            TableNetProvider::empty(),
            w,
            h,
            js,
        )
    }

    /// 条件に当たる画素の数。RGB は i32 で渡す (u8 のままだと足し算が回る)
    fn count(buf: &[u8], pred: impl Fn(i32, i32, i32) -> bool) -> usize {
        buf.chunks(4)
            .filter(|p| pred(p[0] as i32, p[1] as i32, p[2] as i32))
            .count()
    }

    /// 赤寄りの画素 (`#c00` の文字)
    fn reddish(buf: &[u8]) -> usize {
        count(buf, |r, g, b| r > 100 && r > g + 40 && r > b + 40)
    }

    /// 緑寄りの画素 (`#080` の文字)
    fn greenish(buf: &[u8]) -> usize {
        count(buf, |r, g, b| g > 60 && g > r + 30 && g > b + 30)
    }

    /// 受け入れテスト: JS を実行すると赤い「動いていない」が緑の「動いた」に変わり、
    /// `?` が `4` になる
    #[test]
    fn javascript_mutates_the_dom() {
        let _guard = net::GLOBAL.lock().unwrap_or_else(|e| e.into_inner());
        let (w, h) = (400u32, 120u32);

        // JS を切ると赤い文字があって緑は無い
        let off = render(ACCEPTANCE, false, w, h);
        assert!(reddish(&off) > 30, "JS off should keep the red text: {}", reddish(&off));
        assert!(greenish(&off) < 10, "JS off should have no green text: {}", greenish(&off));

        // JS を入れると赤が消えて緑になる
        let on = render(ACCEPTANCE, true, w, h);
        assert!(greenish(&on) > 30, "JS on should paint the green text: {}", greenish(&on));
        assert!(reddish(&on) < 10, "JS on should drop the red text: {}", reddish(&on));
        assert!(script::last_js_errors().is_empty(), "{:?}", script::last_js_errors());

        // 文字が増えている (`?` -> `4` は同じ幅なので、色で見た上のほうが確か)
        if let Ok(dir) = std::env::var("RENDER_DUMP_DIR") {
            std::fs::write(format!("{dir}/js_on_{w}x{h}.rgba"), &on).unwrap();
            std::fs::write(format!("{dir}/js_off_{w}x{h}.rgba"), &off).unwrap();
        }
    }

    /// `textContent` に数を入れると、その数が描かれる (`2 + 2` が JS として評価されている)
    #[test]
    fn text_content_from_arithmetic() {
        let _guard = net::GLOBAL.lock().unwrap_or_else(|e| e.into_inner());
        let html = r#"<p style="margin:0;font-size:40px">= <span id="n"></span></p>
            <script>document.getElementById("n").textContent = 2 + 2</script>"#;
        let (w, h) = (200u32, 60u32);
        let before = count(&render(html, false, w, h), |r, g, b| r < 200 && g < 200 && b < 200);
        let after = count(&render(html, true, w, h), |r, g, b| r < 200 && g < 200 && b < 200);
        assert!(after > before + 20, "the digit should be painted: {before} -> {after}");
        assert!(script::last_js_errors().is_empty(), "{:?}", script::last_js_errors());
    }

    /// 無限ループを書かれても帰ってくる。ループより前に JS が触った DOM はそのまま描く
    #[test]
    fn runaway_loop_is_stopped() {
        let _guard = net::GLOBAL.lock().unwrap_or_else(|e| e.into_inner());
        let html = r#"<p style="margin:0;font-size:40px;color:#080" id="a">x</p>
            <script>
              document.getElementById("a").textContent = "ok";
              while (true) {}
              document.getElementById("a").textContent = "never";
            </script>"#;
        let (w, h) = (200u32, 60u32);
        let t = std::time::Instant::now();
        let buf = render(html, true, w, h);
        let elapsed = t.elapsed();
        eprintln!("runaway loop: {elapsed:?}");
        // ループの上限に当たった例外が残る
        let errors = script::last_js_errors();
        assert!(
            errors.iter().any(|e| e.contains("RuntimeLimit") || e.contains("iteration")),
            "expected a loop limit error, got {errors:?}"
        );
        // ループより前の代入は絵に入っている (緑の文字がある)
        assert!(greenish(&buf) > 30, "the DOM before the loop should still paint");
        // 実時間で妥当な範囲に収まっている (native の目安。手元では 1 秒未満)
        assert!(elapsed.as_secs() < 20, "took too long: {elapsed:?}");
    }

    /// 深い再帰でも wasm のスタックを割る前に JS の例外になる
    #[test]
    fn deep_recursion_is_stopped() {
        let _guard = net::GLOBAL.lock().unwrap_or_else(|e| e.into_inner());
        let html = r#"<p id="a">x</p><script>
            function f(n) { return f(n + 1) }
            document.getElementById("a").textContent = "before";
            f(0);
            </script>"#;
        let buf = render(html, true, 100, 40);
        assert_eq!(buf.len(), 100 * 40 * 4);
        let errors = script::last_js_errors();
        assert!(!errors.is_empty(), "expected a recursion limit error");
    }

    /// タイマーは仮想時間で回る。`setTimeout(f, 3000)` を実時間で待たない
    #[test]
    fn timers_run_in_virtual_time() {
        let _guard = net::GLOBAL.lock().unwrap_or_else(|e| e.into_inner());
        let html = r#"<p style="margin:0;font-size:40px;color:#080" id="a"></p>
            <script>setTimeout(function () {
              document.getElementById("a").textContent = "late";
            }, 300)</script>"#;
        let t = std::time::Instant::now();
        let buf = render(html, true, 200, 60);
        assert!(t.elapsed().as_millis() < 3_000, "should not sleep: {:?}", t.elapsed());
        assert!(greenish(&buf) > 30, "the timer callback should have run");
    }

    /// `setInterval` を張られても回数で切る (帰ってくる)
    #[test]
    fn endless_interval_is_bounded() {
        let _guard = net::GLOBAL.lock().unwrap_or_else(|e| e.into_inner());
        let html = r#"<p id="a">x</p><script>
            var n = 0;
            setInterval(function () { n = n + 1; document.getElementById("a").textContent = String(n) }, 1);
            </script>"#;
        let t = std::time::Instant::now();
        let buf = render(html, true, 100, 40);
        eprintln!("endless interval: {:?}", t.elapsed());
        assert_eq!(buf.len(), 100 * 40 * 4);
        assert!(t.elapsed().as_secs() < 20, "took too long: {:?}", t.elapsed());
    }

    /// 外部スクリプトは資源の表から取る。表に無ければ取りこぼしに出る
    #[test]
    fn external_script_comes_from_the_table() {
        let _guard = net::GLOBAL.lock().unwrap_or_else(|e| e.into_inner());
        let html = r#"<p style="margin:0;font-size:40px;color:#080" id="a"></p>
            <script src="/app.js"></script>"#;

        // 表に無いとき: 実行されず、URL が取りこぼしに残る
        let net = TableNetProvider::empty();
        let buf = render_with_opts(html, "https://x.test/", fonts(), net.clone(), 200, 60, true);
        assert!(greenish(&buf) < 10, "nothing should have run");
        assert_eq!(net.misses(), vec!["https://x.test/app.js"]);

        // 表にあるとき: 実行される
        net::clear_resources();
        net::add_resource(
            "https://x.test/app.js",
            b"document.getElementById('a').textContent = 'from a file'".to_vec(),
        );
        let net = TableNetProvider::current();
        let buf = render_with_opts(html, "https://x.test/", fonts(), net.clone(), 200, 60, true);
        assert!(greenish(&buf) > 30, "the external script should have run");
        assert!(net.misses().is_empty(), "{:?}", net.misses());
        net::clear_resources();
    }

    /// 壊れた JS でも描画は続く
    #[test]
    fn broken_script_still_renders() {
        let _guard = net::GLOBAL.lock().unwrap_or_else(|e| e.into_inner());
        for code in [
            "this is not javascript ===",
            "null.foo.bar",
            "document.getElementById('nope').textContent = 'x'",
            "throw new Error('boom')",
            "window.location = 'https://elsewhere.test/'",
            "document.write('<p>x</p>')",
        ] {
            let html = format!(r#"<p style="margin:0;font-size:40px;color:#080">keep</p><script>{code}</script>"#);
            let buf = render(&html, true, 200, 60);
            assert!(greenish(&buf) > 30, "should still paint the page for {code:?}");
        }
    }

    /// `set_js_enabled(false)` と `render_png_rgba_no_js` で JS を切れる。
    /// グローバル (フォントと資源の表) を触るのでここだけ直列
    #[test]
    fn js_can_be_switched_off() {
        let _guard = net::GLOBAL.lock().unwrap_or_else(|e| e.into_inner());
        clear_fonts();
        add_font(std::fs::read(&font_file("sans-regular.ttf")).unwrap(), "sans");
        // 「動いた」は日本語なので JP フォントも要る
        add_font(std::fs::read(&font_file("jp-regular.ttf")).unwrap(), "jp");
        net::clear_resources();

        assert!(script::js_enabled(), "JS is on by default");
        let on = render_png_rgba(ACCEPTANCE, "", 400, 120);
        assert!(greenish(&on) > 30, "JS should run through render_png_rgba");

        let off = render_png_rgba_no_js(ACCEPTANCE, "", 400, 120);
        assert!(reddish(&off) > 30, "render_png_rgba_no_js should skip scripts");

        script::set_js_enabled(false);
        assert!(!script::js_enabled());
        let off = render_png_rgba(ACCEPTANCE, "", 400, 120);
        assert!(reddish(&off) > 30, "set_js_enabled(false) should skip scripts");
        script::set_js_enabled(true);

        clear_fonts();
    }
}
