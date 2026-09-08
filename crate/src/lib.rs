//! Kitesurf が公開情報で挙げている構成を、そのまま wasm32 に載せられるか試す。
//! 第 1 段: blitz-html で HTML をパースし、Stylo にスタイルを解決させる。

use blitz_dom::{BaseDocument, DocumentConfig, StyleThreading};

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
