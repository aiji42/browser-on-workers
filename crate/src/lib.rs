//! Kitesurf が公開情報で挙げている構成 (Blitz + Stylo + Parley) を、
//! そのまま wasm32-unknown-unknown に載せて HTML を絵にする。
//!
//! 第 1 段: blitz-html で HTML をパースし、Stylo にスタイルを解決させる (`parse_and_resolve`)。
//! 第 2 段: blitz-paint + vello_cpu で RGBA のピクセル列に描く (`render_png_rgba`)。

use std::sync::Arc;

use anyrender::{ImageRenderer, PaintScene};
use anyrender_vello_cpu::VelloCpuImageRenderer;
use blitz_dom::{BaseDocument, DocumentConfig, FontContext, StyleThreading};
use blitz_traits::shell::{ColorScheme, Viewport};
use kurbo::{Affine, Rect};
use parley::fontique::{
    Blob, Collection, CollectionOptions, FamilyId, GenericFamily, Script, SourceCache,
};
use peniko::{Color, Fill};
use wasm_bindgen::prelude::*;

/// HTML を渡してノード数を返す。ここが通れば
/// html5ever + Stylo + Taffy が wasm32 で動いていることになる。
pub fn parse_and_resolve(html: &str) -> usize {
    let mut doc: BaseDocument = blitz_html::HtmlDocument::from_html(
        html,
        DocumentConfig {
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

/// script ごとの fallback にも同じフォントを割り当てる。
/// Parley は「指定された family に無い文字」を script 単位の fallback で探すので、
/// ここが空だと日本語や記号が 0 幅になる
const FALLBACK_SCRIPTS: [[u8; 4]; 14] = [
    *b"Latn", *b"Cyrl", *b"Grek", *b"Hani", *b"Hira", *b"Kana", *b"Hang", *b"Arab",
    *b"Hebr", *b"Deva", *b"Thai", *b"Zyyy", *b"Zinh", *b"Zzzz",
];

/// 引数で受け取ったフォント 1 本だけで完結する `FontContext` を組む。
///
/// wasm32 には OS のフォントが無い。fontique は `system_fonts: true` でも
/// wasm32 ではダミーのバックエンドになるだけだが、generic family (sans-serif など) と
/// script fallback が空のままなので、渡されたフォントを全部に結び付ける必要がある。
fn build_font_ctx(font_ttf: &[u8]) -> FontContext {
    let mut collection = Collection::new(CollectionOptions {
        shared: false,
        system_fonts: false,
    });

    // 呼び出し側のフォントを登録する。TTF/OTF のほか TTC (複数 family) も入る
    let registered = collection.register_fonts(Blob::new(Arc::new(font_ttf.to_vec())), None);
    let family_ids: Vec<FamilyId> = registered.iter().map(|(id, _)| *id).collect();

    for generic in GENERIC_FAMILIES {
        collection.set_generic_families(generic, family_ids.iter().copied());
    }
    for script in FALLBACK_SCRIPTS {
        collection.set_fallbacks(Script::from_bytes(script), family_ids.iter().copied());
    }

    // blitz-dom は font_ctx を渡されなかったときだけ、リストの黒丸用フォントを自分で登録する。
    // 自前の font_ctx を渡すとその経路を通らないので、ここで登録しておく
    collection.register_fonts(Blob::new(Arc::new(blitz_dom::BULLET_FONT) as _), None);

    FontContext {
        collection,
        source_cache: SourceCache::default(),
    }
}

/// HTML を `width` x `height` のビューポートに描き、RGBA8 のピクセル列を返す。
///
/// - 戻り値は `width * height * 4` バイト。左上から行優先、1 ピクセル = R, G, B, A
/// - 背景は白で塗ってから描くので全ピクセルの A は 255。vello_cpu の出力は
///   premultiplied RGBA だが、A = 255 なら straight と一致するので JS 側で
///   そのまま PNG にできる
/// - `font_ttf` はページ全体に使うフォント (TTF / OTF / TTC)。CSS の font-family が
///   何を指していてもこのフォントに落ちる
/// - vello_cpu の描画面は u16 なので、辺の長さは 65535 まで
/// - サブリソース (画像・外部 CSS・web font) は取得しない。インライン `<style>` と
///   `style` 属性だけが効く
#[wasm_bindgen]
pub fn render_png_rgba(html: &str, font_ttf: &[u8], width: u32, height: u32) -> Vec<u8> {
    let mut doc: BaseDocument = blitz_html::HtmlDocument::from_html(
        html,
        DocumentConfig {
            viewport: Some(Viewport::new(width, height, 1.0, ColorScheme::Light)),
            font_ctx: Some(build_font_ctx(font_ttf)),
            // wasm32 には rayon のスレッドプールが無いので並列トラバースは使えない
            style_threading: StyleThreading::Sequential,
            ..Default::default()
        },
    )
    .into();
    doc.resolve(0.0);

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
            blitz_paint::paint_scene(scene, &mut doc, 1.0, width, height, 0, 0);
        },
        &mut buf,
    );
    buf
}

#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests {
    use super::*;

    const FONT_PATH: &str = "/System/Library/Fonts/Supplemental/Arial.ttf";

    fn px(buf: &[u8], width: u32, x: u32, y: u32) -> [u8; 4] {
        let i = ((y * width + x) * 4) as usize;
        [buf[i], buf[i + 1], buf[i + 2], buf[i + 3]]
    }

    #[test]
    fn renders_background_and_text() {
        let font = std::fs::read(FONT_PATH).expect("Arial.ttf");
        let (w, h) = (200u32, 100u32);
        let html = r#"<html><body style="margin:0;background:#ff0000">
            <p style="margin:0;font-size:40px;color:#000">Hello</p></body></html>"#;
        let buf = render_png_rgba(html, &font, w, h);
        assert_eq!(buf.len(), (w * h * 4) as usize);

        // 右下は body の背景色 (赤) のまま
        assert_eq!(px(&buf, w, w - 1, h - 1), [255, 0, 0, 255]);

        // 文字が描かれていれば、上部の帯に赤でも白でもない画素がある
        let non_bg = (0..h.min(50))
            .flat_map(|y| (0..w).map(move |x| (x, y)))
            .filter(|&(x, y)| {
                let p = px(&buf, w, x, y);
                p != [255, 0, 0, 255] && p != [255, 255, 255, 255]
            })
            .count();
        assert!(non_bg > 50, "text should be rasterized, got {non_bg} non-bg pixels");

        // 目視用に RGBA をそのまま吐く (PNG 化は scripts 側)
        if let Ok(dir) = std::env::var("RENDER_DUMP_DIR") {
            std::fs::write(format!("{dir}/render_{w}x{h}.rgba"), &buf).unwrap();
        }
    }

    #[test]
    fn white_background_when_unspecified() {
        let font = std::fs::read(FONT_PATH).expect("Arial.ttf");
        let buf = render_png_rgba("<p>x</p>", &font, 50, 50);
        assert_eq!(px(&buf, 50, 49, 49), [255, 255, 255, 255]);
    }
}
