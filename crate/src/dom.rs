//! 描画を段に割って、DOM を JS から触れるようにする。
//!
//! `render_png_rgba` は 1 回の wasm 呼び出しの中で「組む → JS を走らせる →
//! 落ち着かせる → 描く」を全部やる。JS は Boa で、V8 の 200 分の 1 の速さしか出ない。
//!
//! ページの `<script>` を Dynamic Worker の V8 で走らせるなら、DOM はこちら (wasm)
//! に置いたまま、組むところと描くところを別々に呼べる必要がある。この module は
//! それを 4 つの入口に分ける (`dom_open` / `dom_settle` / `dom_paint` / `dom_close`)。
//! 間に JS から DOM を読み書きする口を並べてある。
//!
//! 既存の `render_png_rgba` は触っていない。今の Worker はそちらを呼んでいる。
//!
//! # ノードの指し方
//!
//! blitz-dom の `NodeId` は **u64** で、下 32bit が slot の番号、上 32bit が世代。
//! ノードを捨てた slot を使い回すときに世代が上がるので、古い id は
//! 「解決できない id」になる (別のノードを指してしまわない)。つまり u32 に
//! 詰めると世代が落ちて、まさにその安全性が消える。
//!
//! なので `NodeId` をそのまま渡すのではなく、**document ごとに u32 の handle を振る**。
//! 同じ `NodeId` には必ず同じ handle を返す (JS 側が handle を鍵に
//! `Element` オブジェクトを 1 つに保つため。`document.body === document.body` が
//! これで成り立つ)。handle は 1 から振るので、`0` が「無い」になる。
//!
//! # なぜ `Mutex` ではなく `thread_local`
//!
//! `BaseDocument` は `Send` ではない (Stylo と Parley が `Rc` を持っている)。
//! wasm32 はそもそも単一スレッドなので、`Mutex` に入れる理由が無く、入れられない。
//! `thread_local!` + `RefCell` にする。native のテストはスレッド並列で走るが、
//! slot の表がスレッドごとに分かれるだけなので、テストどうしは干渉しない。

use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::Arc;

use anyrender::{ImageRenderer, PaintScene};
use anyrender_vello_cpu::VelloCpuImageRenderer;
use blitz_dom::node::NodeData;
use blitz_dom::{
    BaseDocument, DocumentConfig, FontContext, LocalName, Namespace, NodeId, QualName,
    StyleThreading, local_name,
};
use blitz_traits::shell::{ColorScheme, Viewport};
use kurbo::{Affine, Rect};
use peniko::{Color, Fill};
use wasm_bindgen::prelude::*;

use crate::net::TableNetProvider;

/// vello_cpu の描画面は u16。辺の長さはここまで
/// (`session` の `sess_open` も同じ範囲で弾く)
pub(crate) const MAX_SIDE: u32 = 65535;

/// HTML の要素の名前空間。`markup5ever` の `ns!(html)` は `namespace_url!` を
/// 展開するマクロで、両方を `use` しないと通らない。文字列から作っても
/// 同じ静的 atom に落ちるので、こちらで書く
const HTML_NS: &str = "http://www.w3.org/1999/xhtml";

/// 開いている document 1 つ。
///
/// JS を走らせないので `ScriptDocument` ではなく `BaseDocument` をそのまま持つ。
/// `blitz_paint::paint_scene` が要求するのもこれ
struct Page {
    doc: BaseDocument,
    /// この document が資源を引く表。取りこぼしを数えるので描画をまたいで持つ
    net: Arc<TableNetProvider>,
    width: u32,
    height: u32,
    /// handle (1 起点) から `NodeId`。添字は `handle - 1`
    handles: Vec<NodeId>,
    /// `NodeId` から handle。同じノードに同じ handle を返すための逆引き
    by_id: HashMap<NodeId, u32>,
}

impl Page {
    /// `NodeId` に handle を振る (すでに振ってあればそれを返す)
    fn handle(&mut self, id: NodeId) -> u32 {
        if let Some(&h) = self.by_id.get(&id) {
            return h;
        }
        self.handles.push(id);
        let h = self.handles.len() as u32;
        self.by_id.insert(id, h);
        h
    }

    fn handle_opt(&mut self, id: Option<NodeId>) -> u32 {
        id.map_or(0, |id| self.handle(id))
    }

    /// blitz-dom の返り値は `Vec` と `SmallVec` が混ざるので、iterator で受ける
    fn handles_of(&mut self, ids: impl IntoIterator<Item = NodeId>) -> Vec<u32> {
        ids.into_iter().map(|id| self.handle(id)).collect()
    }

    /// handle を **いま生きている** `NodeId` に直す。
    ///
    /// `DocumentMutator` の口 (`append_children`、`remove_node`、`child_ids` など) は
    /// `doc.nodes[id]` で直に引くので、死んだ id を渡すと slotmap が panic する。
    /// wasm では panic = インスタンスごと abort なので、**必ずここを通してから**
    /// mutator に渡す。`get_node` だけが `Option` を返す安全な口
    fn live(&self, handle: u32) -> Option<NodeId> {
        let index = handle.checked_sub(1)? as usize;
        let id = *self.handles.get(index)?;
        self.doc.get_node(id).map(|_| id)
    }
}

/// 開いている document の表と、次に振る document handle。
///
/// document handle も 1 起点。`0` は `dom_open` の失敗を表すので使わない
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

/// document を借りて何かする。handle が無ければ `R` の既定値を返す。
///
/// 死んだ handle でも panic しないのがここの役目。`dom_close` した handle を
/// JS が使い続けても、「無い」が返るだけになる
fn with<R: Default>(doc: u32, f: impl FnOnce(&mut Page) -> R) -> R {
    SLOTS.with(|slots| {
        let mut slots = slots.borrow_mut();
        match slots.pages.get_mut(&doc) {
            Some(page) => f(page),
            None => R::default(),
        }
    })
}

/// document とノードの両方が生きているときだけ何かする
fn with_node<R: Default>(doc: u32, node: u32, f: impl FnOnce(&mut Page, NodeId) -> R) -> R {
    with(doc, |page| match page.live(node) {
        Some(id) => f(page, id),
        None => R::default(),
    })
}

/// 属性の `QualName` (名前空間なし)
fn attr_name(local: &str) -> QualName {
    QualName::new(None, Namespace::from(""), LocalName::from(local))
}

/// HTML 要素の `QualName`
fn element_name(local: &str) -> QualName {
    QualName::new(None, Namespace::from(HTML_NS), LocalName::from(local))
}

// === ライフサイクル ===

/// HTML をパースして document を開く。**`<script>` は実行しない**。
///
/// 開いた時点で 1 度 `settle` (スタイル + レイアウト) を回すので、`dom_offset_width`
/// のようなレイアウトの読み出しがすぐ使える。返り値は 0 でない document handle。
/// 失敗したら 0 で、理由は `last_panic()` から取れる。
///
/// フォントは `add_font`、サブリソースは `add_resource` で**先に**渡しておく
/// (`render_png_rgba` と同じ)。取りこぼした URL は `missed_resources()` に出る
#[wasm_bindgen]
pub fn dom_open(html: &str, base_url: &str, width: u32, height: u32) -> u32 {
    if width == 0 || height == 0 || width > MAX_SIDE || height > MAX_SIDE {
        // 描画面が作れない大きさ。panic させずに 0 で返し、理由だけ残す
        if let Ok(mut slot) = crate::LAST_PANIC.lock() {
            *slot = Some(format!(
                "dom_open: viewport {width}x{height} is out of range (1..={MAX_SIDE})"
            ));
        }
        return 0;
    }
    let net = TableNetProvider::current();
    let doc = open_with(html, base_url, crate::current_font_ctx(), net.clone(), width, height);
    // 何を取りこぼしたかを JS から読めるところに置く。JS はこれを取ってきて
    // `add_resource` で足し、もう 1 度 `dom_open` する (画像や CSS の 2 パス)
    crate::net::publish_misses(&net);
    doc
}

/// `dom_open` の本体。`FontContext` とサブリソースの表を外から渡す
/// (テストがグローバルを触らずに開くための口)
fn open_with(
    html: &str,
    base_url: &str,
    font_ctx: FontContext,
    net: Arc<TableNetProvider>,
    width: u32,
    height: u32,
) -> u32 {
    let config = DocumentConfig {
        viewport: Some(Viewport::new(width, height, 1.0, ColorScheme::Light)),
        base_url: Some(crate::base_url_or_fallback(base_url)),
        font_ctx: Some(font_ctx),
        net_provider: Some(net.clone()),
        // wasm32 には rayon のスレッドプールが無いので並列トラバースは使えない
        style_threading: StyleThreading::Sequential,
        // `dom_set_inner_html` が断片を組むのに使う parser。既定は
        // `DummyHtmlParserProvider` で、**黙って何もしない** ので、
        // これを渡さないと innerHTML への代入が無反応になる
        html_parser_provider: Some(Arc::new(blitz_html::HtmlProvider)),
        ..Default::default()
    };

    let mut page = Page {
        doc: BaseDocument::from(blitz_html::HtmlDocument::from_html(html, config)),
        net,
        width,
        height,
        handles: Vec::new(),
        by_id: HashMap::new(),
    };
    // レイアウトを読む口が最初から使えるように、ここで 1 度落ち着かせる
    crate::settle(&mut page.doc, &page.net);

    SLOTS.with(|slots| {
        let mut slots = slots.borrow_mut();
        let doc = slots.next;
        slots.next += 1;
        slots.pages.insert(doc, page);
        doc
    })
}

/// スタイルとレイアウトを取り直す。JS が DOM をいじったあとに呼ぶ。
///
/// 中身は `render_png_rgba` が使っているのと同じ待ち方 (取得が増えなくなるまで
/// `resolve` を回す)。取りこぼした URL は `missed_resources()` に置き直す
#[wasm_bindgen]
pub fn dom_settle(doc: u32) {
    with(doc, |page| {
        crate::settle(&mut page.doc, &page.net);
        crate::net::publish_misses(&page.net);
    })
}

/// いまの DOM を RGBA8 に描く。返り値は `width * height * 4` バイト。
///
/// 中身は `render_png_rgba` の末尾と同じ (先に白で敷いてから `paint_scene`)。
/// handle が無ければ空の `Vec`
#[wasm_bindgen]
pub fn dom_paint(doc: u32) -> Vec<u8> {
    with(doc, |page| {
        let (width, height) = (page.width, page.height);
        let mut renderer = VelloCpuImageRenderer::new(width, height);
        let mut buf = Vec::new();
        renderer.render_to_vec(
            |scene| {
                // blitz-paint は html / body に background があるときだけページ背景を
                // 塗る。無指定だと透明のままなので、先に白で敷く
                scene.fill(
                    Fill::NonZero,
                    Affine::IDENTITY,
                    Color::WHITE,
                    None,
                    &Rect::new(0.0, 0.0, width as f64, height as f64),
                );
                blitz_paint::paint_scene(scene, &mut page.doc, 1.0, width, height, 0, 0);
            },
            &mut buf,
        );
        buf
    })
}

/// document を捨てる。handle はもう使えない (使っても panic はしない)
#[wasm_bindgen]
pub fn dom_close(doc: u32) {
    SLOTS.with(|slots| {
        slots.borrow_mut().pages.remove(&doc);
    })
}

/// 開いている document の数 (取りこぼしの確認用)
#[wasm_bindgen]
pub fn dom_open_count() -> u32 {
    SLOTS.with(|slots| slots.borrow().pages.len() as u32)
}

// === ノードを探す ===

/// `document.documentElement` (`<html>`)
#[wasm_bindgen]
pub fn dom_document_element(doc: u32) -> u32 {
    with(doc, |page| {
        let id = page.doc.try_root_element().map(|root| root.id);
        page.handle_opt(id)
    })
}

/// `document.body`
#[wasm_bindgen]
pub fn dom_body(doc: u32) -> u32 {
    with(doc, |page| {
        let id = page.doc.find_body_node().map(|node| node.id);
        page.handle_opt(id)
    })
}

/// `document.head`
#[wasm_bindgen]
pub fn dom_head(doc: u32) -> u32 {
    with(doc, |page| {
        let id = page.doc.find_head_node().map(|node| node.id);
        page.handle_opt(id)
    })
}

/// `document` そのもの (nodeType 9 のノード)
#[wasm_bindgen]
pub fn dom_root_node(doc: u32) -> u32 {
    with(doc, |page| {
        let id = page.doc.root_node().id;
        page.handle(id)
    })
}

/// `<title>` の文字列
#[wasm_bindgen]
pub fn dom_title(doc: u32) -> String {
    with(doc, |page| {
        page.doc
            .find_title_node()
            .map(|node| node.text_content())
            .unwrap_or_default()
    })
}

/// `document.getElementById`
#[wasm_bindgen]
pub fn dom_get_element_by_id(doc: u32, id: &str) -> u32 {
    with(doc, |page| {
        let found = page.doc.get_element_by_id(id);
        page.handle_opt(found)
    })
}

/// `document.querySelector`。セレクタが壊れていたら 0
#[wasm_bindgen]
pub fn dom_query_selector(doc: u32, sel: &str) -> u32 {
    with(doc, |page| {
        let found = page.doc.query_selector(sel).ok().flatten();
        page.handle_opt(found)
    })
}

/// `document.querySelectorAll`。セレクタが壊れていたら空
#[wasm_bindgen]
pub fn dom_query_selector_all(doc: u32, sel: &str) -> Vec<u32> {
    with(doc, |page| {
        let found = page.doc.query_selector_all(sel).unwrap_or_default();
        page.handles_of(found)
    })
}

/// `element.querySelector` (node の子孫の中から探す)
#[wasm_bindgen]
pub fn dom_query_selector_within(doc: u32, node: u32, sel: &str) -> u32 {
    with_node(doc, node, |page, id| {
        let found = page.doc.query_selector_in(id, sel).ok().flatten();
        page.handle_opt(found)
    })
}

/// `element.querySelectorAll`
#[wasm_bindgen]
pub fn dom_query_selector_all_within(doc: u32, node: u32, sel: &str) -> Vec<u32> {
    with_node(doc, node, |page, id| {
        let found = page.doc.query_selector_all_in(id, sel).unwrap_or_default();
        page.handles_of(found)
    })
}

/// `element.matches`
#[wasm_bindgen]
pub fn dom_matches(doc: u32, node: u32, sel: &str) -> bool {
    with_node(doc, node, |page, id| {
        page.doc.matches_selector(id, sel).unwrap_or(false)
    })
}

/// `element.closest`
#[wasm_bindgen]
pub fn dom_closest(doc: u32, node: u32, sel: &str) -> u32 {
    with_node(doc, node, |page, id| {
        let found = page.doc.closest(id, sel).ok().flatten();
        page.handle_opt(found)
    })
}

// === ノードを読む ===

/// `element.tagName` (大文字)。要素でなければ空文字
#[wasm_bindgen]
pub fn dom_tag_name(doc: u32, node: u32) -> String {
    with_node(doc, node, |page, id| {
        page.doc
            .get_node(id)
            .and_then(|node| node.element_data())
            .map(|element| element.name.local.to_uppercase())
            .unwrap_or_default()
    })
}

/// `node.nodeType`。DOM の番号 (1 要素 / 3 テキスト / 8 コメント / 9 document /
/// 11 fragment)。ノードが無ければ 0。
///
/// blitz-dom は fragment を「`#document-fragment` という名前の、親のいない要素」で
/// 表す。匿名ブロック (`AnonymousBlock`) はレイアウトのために blitz-dom が挟む
/// 箱で、DOM としては要素と同じに見せる
#[wasm_bindgen]
pub fn dom_node_type(doc: u32, node: u32) -> u32 {
    with_node(doc, node, |page, id| {
        let is_fragment = page
            .doc
            .get_node(id)
            .and_then(|node| node.element_data())
            .is_some_and(|element| &*element.name.local == "#document-fragment");
        match page.doc.get_node(id).map(|node| &node.data) {
            Some(NodeData::Document(_)) => 9,
            Some(NodeData::Element(_)) if is_fragment => 11,
            Some(NodeData::Element(_)) | Some(NodeData::AnonymousBlock(_)) => 1,
            Some(NodeData::Text(_)) => 3,
            Some(NodeData::Comment { .. }) => 8,
            None => 0,
        }
    })
}

/// `node.textContent`
#[wasm_bindgen]
pub fn dom_text_content(doc: u32, node: u32) -> String {
    with_node(doc, node, |page, id| {
        page.doc
            .get_node(id)
            .map(|node| node.text_content())
            .unwrap_or_default()
    })
}

/// `element.innerHTML` (子の outerHTML を並べたもの)
#[wasm_bindgen]
pub fn dom_inner_html(doc: u32, node: u32) -> String {
    with_node(doc, node, |page, id| {
        let mut html = String::new();
        if let Some(parent) = page.doc.get_node(id) {
            for child_id in &parent.children {
                if let Some(child) = page.doc.get_node(*child_id) {
                    child.write_outer_html(&mut html);
                }
            }
        }
        html
    })
}

/// `element.outerHTML`
#[wasm_bindgen]
pub fn dom_outer_html(doc: u32, node: u32) -> String {
    with_node(doc, node, |page, id| {
        page.doc
            .get_node(id)
            .map(|node| node.outer_html())
            .unwrap_or_default()
    })
}

// === 属性 ===

/// 属性を 1 つ読む (名前は小文字に直して引く)
fn read_attr(doc: &BaseDocument, id: NodeId, name: &str) -> Option<String> {
    let element = doc.get_node(id)?.element_data()?;
    element
        .attrs()
        .iter()
        .find(|attr| &*attr.name.local == name)
        .map(|attr| attr.value.clone())
}

/// `element.getAttribute`。無ければ `undefined`
#[wasm_bindgen]
pub fn dom_get_attribute(doc: u32, node: u32, name: &str) -> Option<String> {
    let name = name.to_ascii_lowercase();
    with_node(doc, node, |page, id| read_attr(&page.doc, id, &name))
}

/// `element.hasAttribute`
#[wasm_bindgen]
pub fn dom_has_attribute(doc: u32, node: u32, name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    with_node(doc, node, |page, id| {
        read_attr(&page.doc, id, &name).is_some()
    })
}

/// `element.setAttribute`。
///
/// 書き換えは `doc.mutate()` を通す。返ってくる `DocumentMutator` は
/// **drop のときに `flush` する** ので、`<style>` の取り込みや再描画の要求は
/// この関数を抜けるところで済んでいる。呼び出し側で無効化を足す必要は無い
#[wasm_bindgen]
pub fn dom_set_attribute(doc: u32, node: u32, name: &str, value: &str) {
    let name = name.to_ascii_lowercase();
    with_node(doc, node, |page, id| {
        page.doc.mutate().set_attribute(id, attr_name(&name), value);
    })
}

/// `element.removeAttribute`
#[wasm_bindgen]
pub fn dom_remove_attribute(doc: u32, node: u32, name: &str) {
    let name = name.to_ascii_lowercase();
    with_node(doc, node, |page, id| {
        page.doc.mutate().clear_attribute(id, attr_name(&name));
    })
}

/// 付いている属性の名前を並び順で返す
#[wasm_bindgen]
pub fn dom_attribute_names(doc: u32, node: u32) -> Vec<String> {
    with_node(doc, node, |page, id| {
        page.doc
            .get_node(id)
            .and_then(|node| node.element_data())
            .map(|element| {
                element
                    .attrs()
                    .iter()
                    .map(|attr| attr.name.local.to_string())
                    .collect()
            })
            .unwrap_or_default()
    })
}

// === ノードを作る ===

/// `document.createElement`。作った要素はまだ木に付いていない
#[wasm_bindgen]
pub fn dom_create_element(doc: u32, tag: &str) -> u32 {
    let tag = tag.to_ascii_lowercase();
    with(doc, |page| {
        let id = page
            .doc
            .mutate()
            .create_element(element_name(&tag), Vec::new());
        page.handle(id)
    })
}

/// `document.createTextNode`
#[wasm_bindgen]
pub fn dom_create_text_node(doc: u32, text: &str) -> u32 {
    with(doc, |page| {
        let id = page.doc.mutate().create_text_node(text);
        page.handle(id)
    })
}

/// `document.createComment`
#[wasm_bindgen]
pub fn dom_create_comment(doc: u32, text: &str) -> u32 {
    with(doc, |page| {
        let id = page.doc.mutate().create_comment_node(text);
        page.handle(id)
    })
}

// === 木を書き換える ===

/// `node.textContent = text`。
///
/// テキストノードとコメントは中身を差し替え、要素は子を捨ててテキスト 1 つにする。
/// 子は **detach で外すだけで捨てない** (JS 側がまだ handle を持っているかもしれない
/// ので、id が死なないほうがよい)
#[wasm_bindgen]
pub fn dom_set_text_content(doc: u32, node: u32, text: &str) {
    with_node(doc, node, |page, id| {
        let is_text_like = matches!(
            page.doc.get_node(id).map(|node| &node.data),
            Some(NodeData::Text(_)) | Some(NodeData::Comment { .. })
        );
        let mut mutr = page.doc.mutate();
        if is_text_like {
            mutr.set_node_text(id, text);
        } else {
            for child_id in mutr.child_ids(id) {
                mutr.remove_node(child_id);
            }
            if !text.is_empty() {
                let text_id = mutr.create_text_node(text);
                mutr.append_children(id, &[text_id]);
            }
        }
    })
}

/// `element.innerHTML = html`。
///
/// 断片は blitz-html (html5ever) が組む。`dom_open` で
/// `html_parser_provider` を渡してあるので、ここで本物の要素になる。
///
/// 元の子は先に detach する。`set_inner_html` は残っている子を
/// **捨てる** (`remove_and_drop_all_children`) ので、外しておかないと
/// JS が持っている handle が死ぬ
#[wasm_bindgen]
pub fn dom_set_inner_html(doc: u32, node: u32, html: &str) {
    with_node(doc, node, |page, id| {
        let mut mutr = page.doc.mutate();
        for child_id in mutr.child_ids(id) {
            mutr.remove_node(child_id);
        }
        mutr.set_inner_html(id, html);
    })
}

/// `parent.appendChild(child)`。
///
/// 先に今の親から外す。「同じ親の末尾へ動かす」も正しく動くようになる
#[wasm_bindgen]
pub fn dom_append_child(doc: u32, parent: u32, child: u32) {
    with(doc, |page| {
        let (Some(parent_id), Some(child_id)) = (page.live(parent), page.live(child)) else {
            return;
        };
        let mut mutr = page.doc.mutate();
        if mutr.node_has_parent(child_id) {
            mutr.remove_node(child_id);
        }
        mutr.append_children(parent_id, &[child_id]);
    })
}

/// `parent.insertBefore(child, ref_node)`。`ref_node` が 0 なら末尾に足す
#[wasm_bindgen]
pub fn dom_insert_before(doc: u32, parent: u32, child: u32, ref_node: u32) {
    with(doc, |page| {
        let (Some(parent_id), Some(child_id)) = (page.live(parent), page.live(child)) else {
            return;
        };
        let ref_id = page.live(ref_node);
        // 自分の前に自分を入れるのは何もしないのと同じ
        if ref_id == Some(child_id) {
            return;
        }
        let mut mutr = page.doc.mutate();
        if mutr.node_has_parent(child_id) {
            mutr.remove_node(child_id);
        }
        match ref_id {
            Some(ref_id) if mutr.node_has_parent(ref_id) => {
                mutr.insert_nodes_before(ref_id, &[child_id]);
            }
            _ => mutr.append_children(parent_id, &[child_id]),
        }
    })
}

/// `parent.removeChild(child)`。捨てずに外すだけ
#[wasm_bindgen]
pub fn dom_remove_child(doc: u32, parent: u32, child: u32) {
    with(doc, |page| {
        let (Some(_), Some(child_id)) = (page.live(parent), page.live(child)) else {
            return;
        };
        page.doc.mutate().remove_node(child_id);
    })
}

/// `node.remove()`
#[wasm_bindgen]
pub fn dom_remove(doc: u32, node: u32) {
    with_node(doc, node, |page, id| {
        let mut mutr = page.doc.mutate();
        if mutr.node_has_parent(id) {
            mutr.remove_node(id);
        }
    })
}

/// `parent.replaceChild(new_child, old_child)`
#[wasm_bindgen]
pub fn dom_replace_child(doc: u32, parent: u32, new_child: u32, old_child: u32) {
    with(doc, |page| {
        let (Some(parent_id), Some(new_id), Some(old_id)) =
            (page.live(parent), page.live(new_child), page.live(old_child))
        else {
            return;
        };
        if new_id == old_id {
            return;
        }
        // old_child が本当に parent の子でなければ何もしない
        if page.doc.get_node(old_id).and_then(|node| node.parent) != Some(parent_id) {
            return;
        }
        let mut mutr = page.doc.mutate();
        if mutr.node_has_parent(new_id) {
            mutr.remove_node(new_id);
        }
        mutr.insert_nodes_before(old_id, &[new_id]);
        mutr.remove_node(old_id);
    })
}

// === 木を歩く ===

/// `node.parentNode`
#[wasm_bindgen]
pub fn dom_parent(doc: u32, node: u32) -> u32 {
    with_node(doc, node, |page, id| {
        let parent = page.doc.get_node(id).and_then(|node| node.parent);
        page.handle_opt(parent)
    })
}

/// `node.childNodes` (テキストとコメントも入る)
#[wasm_bindgen]
pub fn dom_child_nodes(doc: u32, node: u32) -> Vec<u32> {
    with_node(doc, node, |page, id| {
        let children: Vec<NodeId> = page
            .doc
            .get_node(id)
            .map(|node| node.children.to_vec())
            .unwrap_or_default();
        page.handles_of(children)
    })
}

/// `element.children` (要素だけ)
#[wasm_bindgen]
pub fn dom_children(doc: u32, node: u32) -> Vec<u32> {
    with_node(doc, node, |page, id| {
        let children: Vec<NodeId> = page
            .doc
            .get_node(id)
            .map(|node| {
                node.children
                    .iter()
                    .copied()
                    .filter(|child_id| {
                        page.doc
                            .get_node(*child_id)
                            .is_some_and(|child| child.is_element())
                    })
                    .collect()
            })
            .unwrap_or_default();
        page.handles_of(children)
    })
}

/// `node.firstChild`
#[wasm_bindgen]
pub fn dom_first_child(doc: u32, node: u32) -> u32 {
    with_node(doc, node, |page, id| {
        let child = page
            .doc
            .get_node(id)
            .and_then(|node| node.children.first().copied());
        page.handle_opt(child)
    })
}

/// `node.lastChild`
#[wasm_bindgen]
pub fn dom_last_child(doc: u32, node: u32) -> u32 {
    with_node(doc, node, |page, id| {
        let child = page
            .doc
            .get_node(id)
            .and_then(|node| node.children.last().copied());
        page.handle_opt(child)
    })
}

/// 親の子の並びを `offset` だけずれた位置のノード (+1 で次、-1 で前)
fn sibling(doc: &BaseDocument, id: NodeId, offset: isize) -> Option<NodeId> {
    let node = doc.get_node(id)?;
    let parent = doc.get_node(node.parent?)?;
    let index = parent.index_of_child(id)?;
    parent.children.get(index.checked_add_signed(offset)?).copied()
}

/// `node.nextSibling`
#[wasm_bindgen]
pub fn dom_next_sibling(doc: u32, node: u32) -> u32 {
    with_node(doc, node, |page, id| {
        let found = sibling(&page.doc, id, 1);
        page.handle_opt(found)
    })
}

/// `node.previousSibling`
#[wasm_bindgen]
pub fn dom_previous_sibling(doc: u32, node: u32) -> u32 {
    with_node(doc, node, |page, id| {
        let found = sibling(&page.doc, id, -1);
        page.handle_opt(found)
    })
}

// === レイアウトを読む ===

/// `element.getBoundingClientRect()` を `[x, y, width, height]` で返す。
///
/// 読む前に `resolve` を回す。JS が DOM をいじった直後に `dom_settle` を
/// 呼ばずにこれを読んでも、古い数が返らないようにする
#[wasm_bindgen]
pub fn dom_bounding_rect(doc: u32, node: u32) -> Vec<f64> {
    with_node(doc, node, |page, id| {
        page.doc.resolve(0.0);
        match page.doc.get_client_bounding_rect(id) {
            Some(rect) => vec![rect.x, rect.y, rect.width, rect.height],
            None => vec![0.0; 4],
        }
    })
}

/// レイアウトを読む前に `resolve` を回してから、ノードから 1 つの数を取る
fn layout_value(doc: u32, node: u32, f: impl FnOnce(&blitz_dom::Node) -> f32) -> f64 {
    with_node(doc, node, |page, id| {
        page.doc.resolve(0.0);
        page.doc.get_node(id).map(f).unwrap_or(0.0) as f64
    })
}

/// `element.offsetWidth`
#[wasm_bindgen]
pub fn dom_offset_width(doc: u32, node: u32) -> f64 {
    layout_value(doc, node, |node| node.final_layout().size.width.round())
}

/// `element.offsetHeight`
#[wasm_bindgen]
pub fn dom_offset_height(doc: u32, node: u32) -> f64 {
    layout_value(doc, node, |node| node.final_layout().size.height.round())
}

/// `element.offsetLeft` (offsetParent の padding 辺からの位置)
#[wasm_bindgen]
pub fn dom_offset_left(doc: u32, node: u32) -> f64 {
    layout_value(doc, node, |node| node.offset_top_left().x.round())
}

/// `element.offsetTop`
#[wasm_bindgen]
pub fn dom_offset_top(doc: u32, node: u32) -> f64 {
    layout_value(doc, node, |node| node.offset_top_left().y.round())
}

/// `element.clientWidth`
#[wasm_bindgen]
pub fn dom_client_width(doc: u32, node: u32) -> f64 {
    layout_value(doc, node, |node| node.client_width().round())
}

/// `element.clientHeight`
#[wasm_bindgen]
pub fn dom_client_height(doc: u32, node: u32) -> f64 {
    layout_value(doc, node, |node| node.client_height().round())
}

/// `element.scrollWidth`
#[wasm_bindgen]
pub fn dom_scroll_width(doc: u32, node: u32) -> f64 {
    layout_value(doc, node, |node| node.scroll_width().round())
}

/// `element.scrollHeight`
#[wasm_bindgen]
pub fn dom_scroll_height(doc: u32, node: u32) -> f64 {
    layout_value(doc, node, |node| node.scroll_height().round())
}

// === スタイル ===

/// `getComputedStyle(node).getPropertyValue(property)`。
///
/// レイアウトに依る値 (`width` など) は使用値になるので、読む前に `resolve` を回す
#[wasm_bindgen]
pub fn dom_computed_style(doc: u32, node: u32, property: &str) -> String {
    let property = property.trim().to_ascii_lowercase();
    with_node(doc, node, |page, id| {
        page.doc.resolve(0.0);
        page.doc.resolved_style_value(id, &property)
    })
}

/// `node.style.setProperty(property, value)`。
///
/// blitz-dom は inline style を `style` 属性の文字列としてしか持たないので、
/// 読んで書き換えて書き戻す (vendor の `blitz-vibey-script` と同じやり方)。
/// 宣言として不正なら何もしない (CSSOM の決まり)
#[wasm_bindgen]
pub fn dom_set_style_property(doc: u32, node: u32, property: &str, value: &str) {
    with_node(doc, node, |page, id| {
        let current = read_style_attr(&page.doc, id);
        let Some(next) = page
            .doc
            .style_attr_set_property(&current, property, value, false)
        else {
            return;
        };
        page.doc
            .mutate()
            .set_attribute(id, attr_name("style"), &next);
    })
}

/// `node.style.removeProperty(property)`
#[wasm_bindgen]
pub fn dom_remove_style_property(doc: u32, node: u32, property: &str) {
    with_node(doc, node, |page, id| {
        let current = read_style_attr(&page.doc, id);
        let Some((next, _removed)) = page.doc.style_attr_remove_property(&current, property) else {
            return;
        };
        page.doc
            .mutate()
            .set_attribute(id, attr_name("style"), &next);
    })
}

/// `node.style.getPropertyValue(property)` (inline style だけを見る)
#[wasm_bindgen]
pub fn dom_style_property(doc: u32, node: u32, property: &str) -> String {
    with_node(doc, node, |page, id| {
        let current = read_style_attr(&page.doc, id);
        page.doc.style_attr_get_property(&current, property)
    })
}

/// `style` 属性の中身 (無ければ空文字)
fn read_style_attr(doc: &BaseDocument, id: NodeId) -> String {
    doc.get_node(id)
        .and_then(|node| node.attr(local_name!("style")))
        .unwrap_or_default()
        .to_string()
}

#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests {
    use super::*;
    use parley::fontique::Blob;

    /// テスト用の `FontContext`。グローバルの `FONTS` は触らない
    fn fonts() -> FontContext {
        let load = |name: &str, family: &str| {
            let path = crate::font_file(name);
            let bytes = std::fs::read(&path).unwrap_or_else(|e| panic!("{path}: {e}"));
            (Blob::new(Arc::new(bytes)), family.to_string())
        };
        crate::build_font_ctx(&[
            load("sans-regular.ttf", "sans"),
            load("sans-bold.ttf", "sans"),
            load("jp-regular.ttf", "jp"),
        ])
        .0
    }

    /// フォントも資源の表もテスト専用のもので document を開く
    fn open(html: &str, width: u32, height: u32) -> u32 {
        open_with(
            html,
            "https://x.test/",
            fonts(),
            TableNetProvider::empty(),
            width,
            height,
        )
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

    /// 受け入れテスト: accessor を通した書き換えが**絵に出る**。
    /// 同じ document を、書き換える前と後で描いて比べる
    #[test]
    fn mutation_shows_up_in_the_pixels() {
        let html = r#"<p id="a" style="margin:0;font-size:40px;color:#000">i</p>"#;
        let doc = open(html, 300, 60);
        assert_ne!(doc, 0);

        let before = dom_paint(doc);
        assert_eq!(before.len(), 300 * 60 * 4);

        let node = dom_get_element_by_id(doc, "a");
        assert_ne!(node, 0, "getElementById should find #a");
        assert_eq!(dom_tag_name(doc, node), "P");
        assert_eq!(dom_text_content(doc, node), "i");

        dom_set_text_content(doc, node, "WWWWW");
        assert_eq!(dom_text_content(doc, node), "WWWWW");
        dom_settle(doc);
        let after = dom_paint(doc);

        assert_ne!(before, after, "the mutation should change the pixels");
        assert!(
            inked(&after) > inked(&before) + 200,
            "wider text should ink more pixels: {} -> {}",
            inked(&before),
            inked(&after)
        );
        dom_close(doc);
    }

    /// `dom_set_inner_html` は本物の子要素を作る (parser が繋がっている)
    #[test]
    fn inner_html_creates_real_children() {
        let doc = open("<div id=\"d\">old</div>", 200, 60);
        let node = dom_get_element_by_id(doc, "d");
        dom_set_inner_html(doc, node, "a <b>c</b>");

        // テキスト "a " と <b> の 2 つ
        assert_eq!(dom_child_nodes(doc, node).len(), 2);
        let children = dom_children(doc, node);
        assert_eq!(children.len(), 1, "only <b> is an element");
        assert_eq!(dom_tag_name(doc, children[0]), "B");
        assert_eq!(dom_node_type(doc, children[0]), 1);
        assert_eq!(dom_text_content(doc, children[0]), "c");
        assert_eq!(dom_text_content(doc, node), "a c");
        assert_eq!(dom_inner_html(doc, node), "a <b>c</b>");

        // テキストノードは nodeType 3
        let first = dom_first_child(doc, node);
        assert_eq!(dom_node_type(doc, first), 3);
        assert_eq!(dom_next_sibling(doc, first), children[0]);
        assert_eq!(dom_parent(doc, children[0]), node);
        dom_close(doc);
    }

    /// `dom_create_element` + `dom_append_child` で見える箱が増える
    #[test]
    fn created_element_is_painted() {
        let doc = open("<body style=\"margin:0\"></body>", 100, 100);
        let before = dom_paint(doc);
        assert_eq!(reddish(&before), 0);

        let body = dom_body(doc);
        assert_ne!(body, 0);
        let div = dom_create_element(doc, "div");
        assert_ne!(div, 0);
        assert_eq!(dom_tag_name(doc, div), "DIV");
        // まだ木に付いていないので親はいない
        assert_eq!(dom_parent(doc, div), 0);

        dom_set_style_property(doc, div, "width", "40px");
        dom_set_style_property(doc, div, "height", "40px");
        dom_set_style_property(doc, div, "background", "#ff0000");
        assert_eq!(dom_style_property(doc, div, "width"), "40px");

        dom_append_child(doc, body, div);
        assert_eq!(dom_parent(doc, div), body);
        assert_eq!(dom_children(doc, body), vec![div]);

        dom_settle(doc);
        let after = dom_paint(doc);
        assert!(
            reddish(&after) > 1_200,
            "the 40x40 red box should be painted: {}",
            reddish(&after)
        );
        assert_eq!(dom_offset_width(doc, div), 40.0);
        assert_eq!(dom_offset_height(doc, div), 40.0);
        dom_close(doc);
    }

    /// レイアウトの読み出しがまともな数を返す。
    /// body の既定の margin は 8px なので、1000px のビューポートで 984px になる
    #[test]
    fn layout_reads_are_sane() {
        let doc = open("<div id=\"d\">x</div>", 1000, 200);
        let node = dom_get_element_by_id(doc, "d");
        let width = dom_offset_width(doc, node);
        assert!(width > 900.0, "block should fill the viewport: {width}");
        assert!(width <= 1000.0, "and not exceed it: {width}");

        let rect = dom_bounding_rect(doc, node);
        assert_eq!(rect.len(), 4);
        assert!(rect[2] > 900.0, "rect width: {:?}", rect);
        assert!(rect[3] > 0.0, "rect height: {:?}", rect);
        // body の margin のぶん右下にずれている
        assert!(rect[0] >= 8.0 && rect[1] >= 8.0, "rect origin: {:?}", rect);
        assert!(dom_offset_height(doc, node) > 0.0);
        dom_close(doc);
    }

    /// `dom_query_selector_all` が数を当てる。`_within` は子孫だけを見る
    #[test]
    fn selector_queries() {
        let html = r#"<ul id="l"><li class="x">a</li><li class="x">b</li></ul>
            <p class="x">outside</p>"#;
        let doc = open(html, 200, 200);

        assert_eq!(dom_query_selector_all(doc, ".x").len(), 3);
        assert_eq!(dom_query_selector_all(doc, "li").len(), 2);
        assert_eq!(dom_query_selector_all(doc, "nope").len(), 0);
        // 壊れたセレクタは空 (例外にしない。JS 側で投げ分ける)
        assert_eq!(dom_query_selector_all(doc, "!!!").len(), 0);
        assert_eq!(dom_query_selector(doc, "!!!"), 0);

        let first = dom_query_selector(doc, ".x");
        assert_eq!(dom_tag_name(doc, first), "LI");

        let list = dom_get_element_by_id(doc, "l");
        assert_eq!(dom_query_selector_all_within(doc, list, ".x").len(), 2);
        assert_eq!(
            dom_query_selector_within(doc, list, "li"),
            dom_children(doc, list)[0]
        );
        assert!(dom_matches(doc, first, "li.x"));
        assert!(!dom_matches(doc, first, "p"));
        assert_eq!(dom_closest(doc, first, "ul"), list);
        dom_close(doc);
    }

    /// 属性の読み書き
    #[test]
    fn attributes_round_trip() {
        let doc = open(r#"<div id="d" class="a b" data-x="1"></div>"#, 100, 100);
        let node = dom_get_element_by_id(doc, "d");

        assert_eq!(dom_get_attribute(doc, node, "class").as_deref(), Some("a b"));
        // 名前は大文字でも引ける
        assert_eq!(dom_get_attribute(doc, node, "DATA-X").as_deref(), Some("1"));
        assert_eq!(dom_get_attribute(doc, node, "nope"), None);
        assert!(dom_has_attribute(doc, node, "id"));
        assert!(!dom_has_attribute(doc, node, "nope"));
        let mut names = dom_attribute_names(doc, node);
        names.sort();
        assert_eq!(names, vec!["class", "data-x", "id"]);

        dom_set_attribute(doc, node, "class", "c");
        assert_eq!(dom_get_attribute(doc, node, "class").as_deref(), Some("c"));
        dom_remove_attribute(doc, node, "class");
        assert!(!dom_has_attribute(doc, node, "class"));
        dom_close(doc);
    }

    /// 木から外す・入れ替える
    #[test]
    fn tree_mutations() {
        let doc = open("<div id=\"d\"><i>1</i><b>2</b></div>", 100, 100);
        let node = dom_get_element_by_id(doc, "d");
        let kids = dom_children(doc, node);
        assert_eq!(kids.len(), 2);

        // insertBefore で先頭に入れる
        let span = dom_create_element(doc, "span");
        dom_insert_before(doc, node, span, kids[0]);
        assert_eq!(dom_children(doc, node), vec![span, kids[0], kids[1]]);
        assert_eq!(dom_first_child(doc, node), span);
        assert_eq!(dom_previous_sibling(doc, kids[0]), span);

        // ref_node が 0 なら末尾
        let em = dom_create_element(doc, "em");
        dom_insert_before(doc, node, em, 0);
        assert_eq!(dom_last_child(doc, node), em);

        // removeChild は外すだけ (id は生きたまま)
        dom_remove_child(doc, node, span);
        assert_eq!(dom_children(doc, node), vec![kids[0], kids[1], em]);
        assert_eq!(dom_tag_name(doc, span), "SPAN");
        assert_eq!(dom_parent(doc, span), 0);

        // replaceChild
        dom_replace_child(doc, node, span, kids[0]);
        assert_eq!(dom_children(doc, node), vec![span, kids[1], em]);

        // remove()
        dom_remove(doc, em);
        assert_eq!(dom_children(doc, node), vec![span, kids[1]]);
        dom_close(doc);
    }

    /// 木の入口。`documentElement` / `body` / `head` / `nodeType`
    #[test]
    fn document_entry_points() {
        let doc = open("<html><head><title>t</title></head><body><p>x</p></body></html>", 100, 100);
        let root = dom_document_element(doc);
        let body = dom_body(doc);
        let head = dom_head(doc);
        assert_ne!(root, 0);
        assert_eq!(dom_tag_name(doc, root), "HTML");
        assert_eq!(dom_tag_name(doc, body), "BODY");
        assert_eq!(dom_tag_name(doc, head), "HEAD");
        assert_eq!(dom_parent(doc, body), root);
        assert_eq!(dom_node_type(doc, root), 1);
        assert_eq!(dom_node_type(doc, dom_root_node(doc)), 9);
        assert_eq!(dom_title(doc), "t");

        // 同じノードには同じ handle が返る (JS 側の wrapper の同一性がこれに乗る)
        assert_eq!(dom_body(doc), body);
        assert_eq!(dom_query_selector(doc, "body"), body);
        dom_close(doc);
    }

    /// 計算後のスタイルが読める
    #[test]
    fn computed_style_reads_the_cascade() {
        let html = r#"<style>#d { color: rgb(255, 0, 0) }</style><div id="d">x</div>"#;
        let doc = open(html, 200, 100);
        let node = dom_get_element_by_id(doc, "d");
        assert_eq!(dom_computed_style(doc, node, "color"), "rgb(255, 0, 0)");
        assert_eq!(dom_computed_style(doc, node, "display"), "block");

        // inline style を足すとそちらが勝つ
        dom_set_style_property(doc, node, "color", "rgb(0, 128, 0)");
        assert_eq!(dom_computed_style(doc, node, "color"), "rgb(0, 128, 0)");
        dom_remove_style_property(doc, node, "color");
        assert_eq!(dom_computed_style(doc, node, "color"), "rgb(255, 0, 0)");
        dom_close(doc);
    }

    /// 捨てた handle を使っても panic しない (「無い」が返るだけ)
    #[test]
    fn stale_handles_are_harmless() {
        let doc = open("<div id=\"d\"><b>x</b></div>", 100, 100);
        let node = dom_get_element_by_id(doc, "d");
        let child = dom_children(doc, node)[0];

        // innerHTML の入れ替えで子は木から外れるが、id は生きている
        dom_set_inner_html(doc, node, "<i>y</i>");
        assert_eq!(dom_parent(doc, child), 0);

        dom_close(doc);
        // document ごと消えたので、どの口も「無い」を返す
        assert_eq!(dom_get_element_by_id(doc, "d"), 0);
        assert_eq!(dom_document_element(doc), 0);
        assert_eq!(dom_body(doc), 0);
        assert_eq!(dom_tag_name(doc, node), "");
        assert_eq!(dom_text_content(doc, node), "");
        assert_eq!(dom_inner_html(doc, node), "");
        assert_eq!(dom_node_type(doc, node), 0);
        assert_eq!(dom_children(doc, node), Vec::<u32>::new());
        assert_eq!(dom_child_nodes(doc, node), Vec::<u32>::new());
        assert_eq!(dom_query_selector_all(doc, "div"), Vec::<u32>::new());
        assert_eq!(dom_get_attribute(doc, node, "id"), None);
        assert_eq!(dom_offset_width(doc, node), 0.0);
        assert_eq!(dom_bounding_rect(doc, node), Vec::<f64>::new());
        assert_eq!(dom_computed_style(doc, node, "color"), "");
        assert!(dom_paint(doc).is_empty());
        // 書き換えの口も黙って何もしない
        dom_set_text_content(doc, node, "x");
        dom_set_inner_html(doc, node, "<p>x</p>");
        dom_append_child(doc, node, child);
        dom_remove(doc, node);
        dom_settle(doc);
        dom_close(doc);

        // 存在しない handle も同じ
        assert_eq!(dom_body(999_999), 0);
        assert_eq!(dom_create_element(999_999, "div"), 0);
    }

    /// 大きさが取れないビューポートは 0 で返し、理由を残す
    #[test]
    fn bad_viewport_is_reported() {
        let _guard = crate::net::GLOBAL.lock().unwrap_or_else(|e| e.into_inner());
        crate::last_panic();
        assert_eq!(dom_open("<p>x</p>", "", 0, 100), 0);
        let why = crate::last_panic().unwrap_or_default();
        assert!(why.contains("out of range"), "{why}");
        assert_eq!(dom_open("<p>x</p>", "", 100, 70_000), 0);
        assert!(crate::last_panic().is_some());
    }

    /// `dom_open` から `dom_close` までで slot が残らない
    #[test]
    fn handles_do_not_leak() {
        let before = dom_open_count();
        let a = open("<p>a</p>", 50, 50);
        let b = open("<p>b</p>", 50, 50);
        assert_ne!(a, b);
        assert_eq!(dom_open_count(), before + 2);
        dom_close(a);
        dom_close(b);
        assert_eq!(dom_open_count(), before);
    }
}
