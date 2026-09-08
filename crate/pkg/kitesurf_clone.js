/**
 * フォントを 1 本登録する。`render_png_rgba` より先に、フォントごとに 1 回ずつ呼ぶ。
 *
 * - `bytes` は TTF / OTF / TTC の中身
 * - `family` はこのフォントを入れる family の名前。**フォントファイルの中の名前は使わない**。
 *   同じ `family` で regular と bold を登録すると、1 つの family の中で weight が解決される。
 *   別の文字集合のフォント (Latin と日本語など) は必ず別の `family` にする。同じ family に
 *   入れると、weight の一致で 1 本だけが選ばれて、もう 1 本の文字が消える
 * - 登録した順が優先順位になる。CSS の `sans-serif` などは、先に登録した family から順に
 *   文字を探す。Latin を先、日本語を後に登録すればよい (どちらも持っている文字は Latin で出る)
 * - 戻り値は登録できた face の数。0 ならフォントとして読めなかった (何も登録されない)
 *
 * 登録は wasm インスタンスに残る。Workers では isolate が生きている間は有効なので、
 * 初期化のときに 1 度だけ呼ぶ (2 度呼ぶと同じ face が 2 つ入る)
 * @param {Uint8Array} bytes
 * @param {string} family
 * @returns {number}
 */
export function add_font(bytes, family) {
    const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_export);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(family, wasm.__wbindgen_export, wasm.__wbindgen_export2);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.add_font(ptr0, len0, ptr1, len1);
    return ret >>> 0;
}

/**
 * サブリソースを 1 つ登録する。`render_png_rgba` より先に、資源ごとに 1 回呼ぶ。
 *
 * - `url` は**絶対 URL**。HTML の中の `src` / `href` を `new URL(href, baseUrl)` で
 *   解決したものを渡す。相対 URL を渡しても、Blitz が組む URL とは一致しない
 * - `bytes` は取得した中身をそのまま。画像は PNG / JPEG / GIF / WebP / SVG、
 *   CSS と web font もこの表から返る
 * - 戻り値は実際に鍵にした文字列。JS 側で URL の正規化がずれていないかの確認に使える
 * - 同じ URL を 2 度渡すと後のほうが残る
 *
 * `data:` URL は表に入れなくてよい。Rust 側で解く
 * @param {string} url
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function add_resource(url, bytes) {
    let deferred3_0;
    let deferred3_1;
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        const ptr0 = passStringToWasm0(url, wasm.__wbindgen_export, wasm.__wbindgen_export2);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArray8ToWasm0(bytes, wasm.__wbindgen_export);
        const len1 = WASM_VECTOR_LEN;
        wasm.add_resource(retptr, ptr0, len0, ptr1, len1);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        deferred3_0 = r0;
        deferred3_1 = r1;
        return getStringFromWasm0(r0, r1);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
        wasm.__wbindgen_export4(deferred3_0, deferred3_1, 1);
    }
}

/**
 * 登録したフォントを全部消す
 */
export function clear_fonts() {
    wasm.clear_fonts();
}

/**
 * 登録した資源を全部捨てる。ページごとに呼ぶ
 * (Workers の isolate はリクエストをまたいで生きるので、呼ばないと前のページの画像が残る)。
 * `missed_resources` の記録も一緒に捨てる
 */
export function clear_resources() {
    wasm.clear_resources();
}

/**
 * `parent.appendChild(child)`。
 *
 * 先に今の親から外す。「同じ親の末尾へ動かす」も正しく動くようになる
 * @param {number} doc
 * @param {number} parent
 * @param {number} child
 */
export function dom_append_child(doc, parent, child) {
    wasm.dom_append_child(doc, parent, child);
}

/**
 * 付いている属性の名前を並び順で返す
 * @param {number} doc
 * @param {number} node
 * @returns {string[]}
 */
export function dom_attribute_names(doc, node) {
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        wasm.dom_attribute_names(retptr, doc, node);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        var v1 = getArrayJsValueFromWasm0(r0, r1);
        wasm.__wbindgen_export4(r0, r1 * 4, 4);
        return v1;
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
    }
}

/**
 * `document.body`
 * @param {number} doc
 * @returns {number}
 */
export function dom_body(doc) {
    const ret = wasm.dom_body(doc);
    return ret >>> 0;
}

/**
 * `element.getBoundingClientRect()` を `[x, y, width, height]` で返す。
 *
 * 読む前に `resolve` を回す。JS が DOM をいじった直後に `dom_settle` を
 * 呼ばずにこれを読んでも、古い数が返らないようにする
 * @param {number} doc
 * @param {number} node
 * @returns {Float64Array}
 */
export function dom_bounding_rect(doc, node) {
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        wasm.dom_bounding_rect(retptr, doc, node);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        var v1 = getArrayF64FromWasm0(r0, r1).slice();
        wasm.__wbindgen_export4(r0, r1 * 8, 8);
        return v1;
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
    }
}

/**
 * `node.childNodes` (テキストとコメントも入る)
 * @param {number} doc
 * @param {number} node
 * @returns {Uint32Array}
 */
export function dom_child_nodes(doc, node) {
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        wasm.dom_child_nodes(retptr, doc, node);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        var v1 = getArrayU32FromWasm0(r0, r1).slice();
        wasm.__wbindgen_export4(r0, r1 * 4, 4);
        return v1;
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
    }
}

/**
 * `element.children` (要素だけ)
 * @param {number} doc
 * @param {number} node
 * @returns {Uint32Array}
 */
export function dom_children(doc, node) {
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        wasm.dom_children(retptr, doc, node);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        var v1 = getArrayU32FromWasm0(r0, r1).slice();
        wasm.__wbindgen_export4(r0, r1 * 4, 4);
        return v1;
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
    }
}

/**
 * `element.clientHeight`
 * @param {number} doc
 * @param {number} node
 * @returns {number}
 */
export function dom_client_height(doc, node) {
    const ret = wasm.dom_client_height(doc, node);
    return ret;
}

/**
 * `element.clientWidth`
 * @param {number} doc
 * @param {number} node
 * @returns {number}
 */
export function dom_client_width(doc, node) {
    const ret = wasm.dom_client_width(doc, node);
    return ret;
}

/**
 * document を捨てる。handle はもう使えない (使っても panic はしない)
 * @param {number} doc
 */
export function dom_close(doc) {
    wasm.dom_close(doc);
}

/**
 * `element.closest`
 * @param {number} doc
 * @param {number} node
 * @param {string} sel
 * @returns {number}
 */
export function dom_closest(doc, node, sel) {
    const ptr0 = passStringToWasm0(sel, wasm.__wbindgen_export, wasm.__wbindgen_export2);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.dom_closest(doc, node, ptr0, len0);
    return ret >>> 0;
}

/**
 * `getComputedStyle(node).getPropertyValue(property)`。
 *
 * レイアウトに依る値 (`width` など) は使用値になるので、読む前に `resolve` を回す
 * @param {number} doc
 * @param {number} node
 * @param {string} property
 * @returns {string}
 */
export function dom_computed_style(doc, node, property) {
    let deferred2_0;
    let deferred2_1;
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        const ptr0 = passStringToWasm0(property, wasm.__wbindgen_export, wasm.__wbindgen_export2);
        const len0 = WASM_VECTOR_LEN;
        wasm.dom_computed_style(retptr, doc, node, ptr0, len0);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        deferred2_0 = r0;
        deferred2_1 = r1;
        return getStringFromWasm0(r0, r1);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
        wasm.__wbindgen_export4(deferred2_0, deferred2_1, 1);
    }
}

/**
 * `document.createComment`
 * @param {number} doc
 * @param {string} text
 * @returns {number}
 */
export function dom_create_comment(doc, text) {
    const ptr0 = passStringToWasm0(text, wasm.__wbindgen_export, wasm.__wbindgen_export2);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.dom_create_comment(doc, ptr0, len0);
    return ret >>> 0;
}

/**
 * `document.createElement`。作った要素はまだ木に付いていない
 * @param {number} doc
 * @param {string} tag
 * @returns {number}
 */
export function dom_create_element(doc, tag) {
    const ptr0 = passStringToWasm0(tag, wasm.__wbindgen_export, wasm.__wbindgen_export2);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.dom_create_element(doc, ptr0, len0);
    return ret >>> 0;
}

/**
 * `document.createTextNode`
 * @param {number} doc
 * @param {string} text
 * @returns {number}
 */
export function dom_create_text_node(doc, text) {
    const ptr0 = passStringToWasm0(text, wasm.__wbindgen_export, wasm.__wbindgen_export2);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.dom_create_text_node(doc, ptr0, len0);
    return ret >>> 0;
}

/**
 * `document.documentElement` (`<html>`)
 * @param {number} doc
 * @returns {number}
 */
export function dom_document_element(doc) {
    const ret = wasm.dom_document_element(doc);
    return ret >>> 0;
}

/**
 * `node.firstChild`
 * @param {number} doc
 * @param {number} node
 * @returns {number}
 */
export function dom_first_child(doc, node) {
    const ret = wasm.dom_first_child(doc, node);
    return ret >>> 0;
}

/**
 * `element.getAttribute`。無ければ `undefined`
 * @param {number} doc
 * @param {number} node
 * @param {string} name
 * @returns {string | undefined}
 */
export function dom_get_attribute(doc, node, name) {
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        const ptr0 = passStringToWasm0(name, wasm.__wbindgen_export, wasm.__wbindgen_export2);
        const len0 = WASM_VECTOR_LEN;
        wasm.dom_get_attribute(retptr, doc, node, ptr0, len0);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        let v2;
        if (r0 !== 0) {
            v2 = getStringFromWasm0(r0, r1);
            wasm.__wbindgen_export4(r0, r1 * 1, 1);
        }
        return v2;
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
    }
}

/**
 * `document.getElementById`
 * @param {number} doc
 * @param {string} id
 * @returns {number}
 */
export function dom_get_element_by_id(doc, id) {
    const ptr0 = passStringToWasm0(id, wasm.__wbindgen_export, wasm.__wbindgen_export2);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.dom_get_element_by_id(doc, ptr0, len0);
    return ret >>> 0;
}

/**
 * `element.hasAttribute`
 * @param {number} doc
 * @param {number} node
 * @param {string} name
 * @returns {boolean}
 */
export function dom_has_attribute(doc, node, name) {
    const ptr0 = passStringToWasm0(name, wasm.__wbindgen_export, wasm.__wbindgen_export2);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.dom_has_attribute(doc, node, ptr0, len0);
    return ret !== 0;
}

/**
 * `document.head`
 * @param {number} doc
 * @returns {number}
 */
export function dom_head(doc) {
    const ret = wasm.dom_head(doc);
    return ret >>> 0;
}

/**
 * `element.innerHTML` (子の outerHTML を並べたもの)
 * @param {number} doc
 * @param {number} node
 * @returns {string}
 */
export function dom_inner_html(doc, node) {
    let deferred1_0;
    let deferred1_1;
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        wasm.dom_inner_html(retptr, doc, node);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        deferred1_0 = r0;
        deferred1_1 = r1;
        return getStringFromWasm0(r0, r1);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
        wasm.__wbindgen_export4(deferred1_0, deferred1_1, 1);
    }
}

/**
 * `parent.insertBefore(child, ref_node)`。`ref_node` が 0 なら末尾に足す
 * @param {number} doc
 * @param {number} parent
 * @param {number} child
 * @param {number} ref_node
 */
export function dom_insert_before(doc, parent, child, ref_node) {
    wasm.dom_insert_before(doc, parent, child, ref_node);
}

/**
 * `node.lastChild`
 * @param {number} doc
 * @param {number} node
 * @returns {number}
 */
export function dom_last_child(doc, node) {
    const ret = wasm.dom_last_child(doc, node);
    return ret >>> 0;
}

/**
 * `element.matches`
 * @param {number} doc
 * @param {number} node
 * @param {string} sel
 * @returns {boolean}
 */
export function dom_matches(doc, node, sel) {
    const ptr0 = passStringToWasm0(sel, wasm.__wbindgen_export, wasm.__wbindgen_export2);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.dom_matches(doc, node, ptr0, len0);
    return ret !== 0;
}

/**
 * `node.nextSibling`
 * @param {number} doc
 * @param {number} node
 * @returns {number}
 */
export function dom_next_sibling(doc, node) {
    const ret = wasm.dom_next_sibling(doc, node);
    return ret >>> 0;
}

/**
 * `node.nodeType`。DOM の番号 (1 要素 / 3 テキスト / 8 コメント / 9 document /
 * 11 fragment)。ノードが無ければ 0。
 *
 * blitz-dom は fragment を「`#document-fragment` という名前の、親のいない要素」で
 * 表す。匿名ブロック (`AnonymousBlock`) はレイアウトのために blitz-dom が挟む
 * 箱で、DOM としては要素と同じに見せる
 * @param {number} doc
 * @param {number} node
 * @returns {number}
 */
export function dom_node_type(doc, node) {
    const ret = wasm.dom_node_type(doc, node);
    return ret >>> 0;
}

/**
 * `element.offsetHeight`
 * @param {number} doc
 * @param {number} node
 * @returns {number}
 */
export function dom_offset_height(doc, node) {
    const ret = wasm.dom_offset_height(doc, node);
    return ret;
}

/**
 * `element.offsetLeft` (offsetParent の padding 辺からの位置)
 * @param {number} doc
 * @param {number} node
 * @returns {number}
 */
export function dom_offset_left(doc, node) {
    const ret = wasm.dom_offset_left(doc, node);
    return ret;
}

/**
 * `element.offsetTop`
 * @param {number} doc
 * @param {number} node
 * @returns {number}
 */
export function dom_offset_top(doc, node) {
    const ret = wasm.dom_offset_top(doc, node);
    return ret;
}

/**
 * `element.offsetWidth`
 * @param {number} doc
 * @param {number} node
 * @returns {number}
 */
export function dom_offset_width(doc, node) {
    const ret = wasm.dom_offset_width(doc, node);
    return ret;
}

/**
 * HTML をパースして document を開く。**`<script>` は実行しない**。
 *
 * 開いた時点で 1 度 `settle` (スタイル + レイアウト) を回すので、`dom_offset_width`
 * のようなレイアウトの読み出しがすぐ使える。返り値は 0 でない document handle。
 * 失敗したら 0 で、理由は `last_panic()` から取れる。
 *
 * フォントは `add_font`、サブリソースは `add_resource` で**先に**渡しておく
 * (`render_png_rgba` と同じ)。取りこぼした URL は `missed_resources()` に出る
 * @param {string} html
 * @param {string} base_url
 * @param {number} width
 * @param {number} height
 * @returns {number}
 */
export function dom_open(html, base_url, width, height) {
    const ptr0 = passStringToWasm0(html, wasm.__wbindgen_export, wasm.__wbindgen_export2);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(base_url, wasm.__wbindgen_export, wasm.__wbindgen_export2);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.dom_open(ptr0, len0, ptr1, len1, width, height);
    return ret >>> 0;
}

/**
 * 開いている document の数 (取りこぼしの確認用)
 * @returns {number}
 */
export function dom_open_count() {
    const ret = wasm.dom_open_count();
    return ret >>> 0;
}

/**
 * `element.outerHTML`
 * @param {number} doc
 * @param {number} node
 * @returns {string}
 */
export function dom_outer_html(doc, node) {
    let deferred1_0;
    let deferred1_1;
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        wasm.dom_outer_html(retptr, doc, node);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        deferred1_0 = r0;
        deferred1_1 = r1;
        return getStringFromWasm0(r0, r1);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
        wasm.__wbindgen_export4(deferred1_0, deferred1_1, 1);
    }
}

/**
 * いまの DOM を RGBA8 に描く。返り値は `width * height * 4` バイト。
 *
 * 中身は `render_png_rgba` の末尾と同じ (先に白で敷いてから `paint_scene`)。
 * handle が無ければ空の `Vec`
 * @param {number} doc
 * @returns {Uint8Array}
 */
export function dom_paint(doc) {
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        wasm.dom_paint(retptr, doc);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        var v1 = getArrayU8FromWasm0(r0, r1).slice();
        wasm.__wbindgen_export4(r0, r1 * 1, 1);
        return v1;
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
    }
}

/**
 * `node.parentNode`
 * @param {number} doc
 * @param {number} node
 * @returns {number}
 */
export function dom_parent(doc, node) {
    const ret = wasm.dom_parent(doc, node);
    return ret >>> 0;
}

/**
 * `node.previousSibling`
 * @param {number} doc
 * @param {number} node
 * @returns {number}
 */
export function dom_previous_sibling(doc, node) {
    const ret = wasm.dom_previous_sibling(doc, node);
    return ret >>> 0;
}

/**
 * `document.querySelector`。セレクタが壊れていたら 0
 * @param {number} doc
 * @param {string} sel
 * @returns {number}
 */
export function dom_query_selector(doc, sel) {
    const ptr0 = passStringToWasm0(sel, wasm.__wbindgen_export, wasm.__wbindgen_export2);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.dom_query_selector(doc, ptr0, len0);
    return ret >>> 0;
}

/**
 * `document.querySelectorAll`。セレクタが壊れていたら空
 * @param {number} doc
 * @param {string} sel
 * @returns {Uint32Array}
 */
export function dom_query_selector_all(doc, sel) {
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        const ptr0 = passStringToWasm0(sel, wasm.__wbindgen_export, wasm.__wbindgen_export2);
        const len0 = WASM_VECTOR_LEN;
        wasm.dom_query_selector_all(retptr, doc, ptr0, len0);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        var v2 = getArrayU32FromWasm0(r0, r1).slice();
        wasm.__wbindgen_export4(r0, r1 * 4, 4);
        return v2;
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
    }
}

/**
 * `element.querySelectorAll`
 * @param {number} doc
 * @param {number} node
 * @param {string} sel
 * @returns {Uint32Array}
 */
export function dom_query_selector_all_within(doc, node, sel) {
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        const ptr0 = passStringToWasm0(sel, wasm.__wbindgen_export, wasm.__wbindgen_export2);
        const len0 = WASM_VECTOR_LEN;
        wasm.dom_query_selector_all_within(retptr, doc, node, ptr0, len0);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        var v2 = getArrayU32FromWasm0(r0, r1).slice();
        wasm.__wbindgen_export4(r0, r1 * 4, 4);
        return v2;
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
    }
}

/**
 * `element.querySelector` (node の子孫の中から探す)
 * @param {number} doc
 * @param {number} node
 * @param {string} sel
 * @returns {number}
 */
export function dom_query_selector_within(doc, node, sel) {
    const ptr0 = passStringToWasm0(sel, wasm.__wbindgen_export, wasm.__wbindgen_export2);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.dom_query_selector_within(doc, node, ptr0, len0);
    return ret >>> 0;
}

/**
 * `node.remove()`
 * @param {number} doc
 * @param {number} node
 */
export function dom_remove(doc, node) {
    wasm.dom_remove(doc, node);
}

/**
 * `element.removeAttribute`
 * @param {number} doc
 * @param {number} node
 * @param {string} name
 */
export function dom_remove_attribute(doc, node, name) {
    const ptr0 = passStringToWasm0(name, wasm.__wbindgen_export, wasm.__wbindgen_export2);
    const len0 = WASM_VECTOR_LEN;
    wasm.dom_remove_attribute(doc, node, ptr0, len0);
}

/**
 * `parent.removeChild(child)`。捨てずに外すだけ
 * @param {number} doc
 * @param {number} parent
 * @param {number} child
 */
export function dom_remove_child(doc, parent, child) {
    wasm.dom_remove_child(doc, parent, child);
}

/**
 * `node.style.removeProperty(property)`
 * @param {number} doc
 * @param {number} node
 * @param {string} property
 */
export function dom_remove_style_property(doc, node, property) {
    const ptr0 = passStringToWasm0(property, wasm.__wbindgen_export, wasm.__wbindgen_export2);
    const len0 = WASM_VECTOR_LEN;
    wasm.dom_remove_style_property(doc, node, ptr0, len0);
}

/**
 * `parent.replaceChild(new_child, old_child)`
 * @param {number} doc
 * @param {number} parent
 * @param {number} new_child
 * @param {number} old_child
 */
export function dom_replace_child(doc, parent, new_child, old_child) {
    wasm.dom_replace_child(doc, parent, new_child, old_child);
}

/**
 * `document` そのもの (nodeType 9 のノード)
 * @param {number} doc
 * @returns {number}
 */
export function dom_root_node(doc) {
    const ret = wasm.dom_root_node(doc);
    return ret >>> 0;
}

/**
 * `element.scrollHeight`
 * @param {number} doc
 * @param {number} node
 * @returns {number}
 */
export function dom_scroll_height(doc, node) {
    const ret = wasm.dom_scroll_height(doc, node);
    return ret;
}

/**
 * `element.scrollWidth`
 * @param {number} doc
 * @param {number} node
 * @returns {number}
 */
export function dom_scroll_width(doc, node) {
    const ret = wasm.dom_scroll_width(doc, node);
    return ret;
}

/**
 * `element.setAttribute`。
 *
 * 書き換えは `doc.mutate()` を通す。返ってくる `DocumentMutator` は
 * **drop のときに `flush` する** ので、`<style>` の取り込みや再描画の要求は
 * この関数を抜けるところで済んでいる。呼び出し側で無効化を足す必要は無い
 * @param {number} doc
 * @param {number} node
 * @param {string} name
 * @param {string} value
 */
export function dom_set_attribute(doc, node, name, value) {
    const ptr0 = passStringToWasm0(name, wasm.__wbindgen_export, wasm.__wbindgen_export2);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(value, wasm.__wbindgen_export, wasm.__wbindgen_export2);
    const len1 = WASM_VECTOR_LEN;
    wasm.dom_set_attribute(doc, node, ptr0, len0, ptr1, len1);
}

/**
 * `element.innerHTML = html`。
 *
 * 断片は blitz-html (html5ever) が組む。`dom_open` で
 * `html_parser_provider` を渡してあるので、ここで本物の要素になる。
 *
 * 元の子は先に detach する。`set_inner_html` は残っている子を
 * **捨てる** (`remove_and_drop_all_children`) ので、外しておかないと
 * JS が持っている handle が死ぬ
 * @param {number} doc
 * @param {number} node
 * @param {string} html
 */
export function dom_set_inner_html(doc, node, html) {
    const ptr0 = passStringToWasm0(html, wasm.__wbindgen_export, wasm.__wbindgen_export2);
    const len0 = WASM_VECTOR_LEN;
    wasm.dom_set_inner_html(doc, node, ptr0, len0);
}

/**
 * `node.style.setProperty(property, value)`。
 *
 * blitz-dom は inline style を `style` 属性の文字列としてしか持たないので、
 * 読んで書き換えて書き戻す (vendor の `blitz-vibey-script` と同じやり方)。
 * 宣言として不正なら何もしない (CSSOM の決まり)
 * @param {number} doc
 * @param {number} node
 * @param {string} property
 * @param {string} value
 */
export function dom_set_style_property(doc, node, property, value) {
    const ptr0 = passStringToWasm0(property, wasm.__wbindgen_export, wasm.__wbindgen_export2);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(value, wasm.__wbindgen_export, wasm.__wbindgen_export2);
    const len1 = WASM_VECTOR_LEN;
    wasm.dom_set_style_property(doc, node, ptr0, len0, ptr1, len1);
}

/**
 * `node.textContent = text`。
 *
 * テキストノードとコメントは中身を差し替え、要素は子を捨ててテキスト 1 つにする。
 * 子は **detach で外すだけで捨てない** (JS 側がまだ handle を持っているかもしれない
 * ので、id が死なないほうがよい)
 * @param {number} doc
 * @param {number} node
 * @param {string} text
 */
export function dom_set_text_content(doc, node, text) {
    const ptr0 = passStringToWasm0(text, wasm.__wbindgen_export, wasm.__wbindgen_export2);
    const len0 = WASM_VECTOR_LEN;
    wasm.dom_set_text_content(doc, node, ptr0, len0);
}

/**
 * スタイルとレイアウトを取り直す。JS が DOM をいじったあとに呼ぶ。
 *
 * 中身は `render_png_rgba` が使っているのと同じ待ち方 (取得が増えなくなるまで
 * `resolve` を回す)。取りこぼした URL は `missed_resources()` に置き直す
 * @param {number} doc
 */
export function dom_settle(doc) {
    wasm.dom_settle(doc);
}

/**
 * `node.style.getPropertyValue(property)` (inline style だけを見る)
 * @param {number} doc
 * @param {number} node
 * @param {string} property
 * @returns {string}
 */
export function dom_style_property(doc, node, property) {
    let deferred2_0;
    let deferred2_1;
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        const ptr0 = passStringToWasm0(property, wasm.__wbindgen_export, wasm.__wbindgen_export2);
        const len0 = WASM_VECTOR_LEN;
        wasm.dom_style_property(retptr, doc, node, ptr0, len0);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        deferred2_0 = r0;
        deferred2_1 = r1;
        return getStringFromWasm0(r0, r1);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
        wasm.__wbindgen_export4(deferred2_0, deferred2_1, 1);
    }
}

/**
 * `element.tagName` (大文字)。要素でなければ空文字
 * @param {number} doc
 * @param {number} node
 * @returns {string}
 */
export function dom_tag_name(doc, node) {
    let deferred1_0;
    let deferred1_1;
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        wasm.dom_tag_name(retptr, doc, node);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        deferred1_0 = r0;
        deferred1_1 = r1;
        return getStringFromWasm0(r0, r1);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
        wasm.__wbindgen_export4(deferred1_0, deferred1_1, 1);
    }
}

/**
 * `node.textContent`
 * @param {number} doc
 * @param {number} node
 * @returns {string}
 */
export function dom_text_content(doc, node) {
    let deferred1_0;
    let deferred1_1;
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        wasm.dom_text_content(retptr, doc, node);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        deferred1_0 = r0;
        deferred1_1 = r1;
        return getStringFromWasm0(r0, r1);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
        wasm.__wbindgen_export4(deferred1_0, deferred1_1, 1);
    }
}

/**
 * `<title>` の文字列
 * @param {number} doc
 * @returns {string}
 */
export function dom_title(doc) {
    let deferred1_0;
    let deferred1_1;
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        wasm.dom_title(retptr, doc);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        deferred1_0 = r0;
        deferred1_1 = r1;
        return getStringFromWasm0(r0, r1);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
        wasm.__wbindgen_export4(deferred1_0, deferred1_1, 1);
    }
}

/**
 * 登録済みの family 名を登録順に返す (確認用)
 * @returns {string[]}
 */
export function font_families() {
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        wasm.font_families(retptr);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        var v1 = getArrayJsValueFromWasm0(r0, r1);
        wasm.__wbindgen_export4(r0, r1 * 4, 4);
        return v1;
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
    }
}

/**
 * wasm-bindgen の init 時に呼ばれる。panic のメッセージを外に残す。
 *
 * wasm32-unknown-unknown は unwind できない (target 自体が abort 固定で、
 * `panic = "unwind"` にしても `catch_unwind` は何も捕まえない)。panic は最終的に
 * `unreachable` 命令でトラップし、JS 側には `RuntimeError: unreachable` しか届かない。
 * そこで abort の前に走る panic hook で
 *   1. `console.error` にメッセージ (発生箇所の file:line 入り) を流し、
 *   2. `LAST_PANIC` に控える。
 * 呼び出し側は `RuntimeError` を受けたら `last_panic()` で中身を取り出せる。
 *
 * hook の中から `wasm_bindgen::throw_str` で JS の例外を投げる手もあるが、hook から
 * 抜けないと std の「panic 処理中」フラグが立ったままになり、同じインスタンスでの
 * 2 度目の panic は hook を通らず即 abort になる。wasm-bindgen の glue は
 * インスタンスを 1 つしか持たず (`init` を呼び直しても同じものが返る) Workers の
 * isolate はリクエストをまたいで生きるので、hook は素直に return して abort に任せる。
 *
 * トラップの後も wasm のメモリは残っている。abort は hook の処理が終わってから
 * 呼ばれるので、`last_panic()` で `LAST_PANIC` を読むのは安全。ただし panic を
 * 起こした描画の途中状態 (借用中の RefCell 等) は捨てられずに残るので、
 * 次の描画が連鎖して panic する可能性はある。それも同じ経路でメッセージが出る
 */
export function init() {
    wasm.init();
}

/**
 * いま JS を実行する設定になっているか
 * @returns {boolean}
 */
export function js_enabled() {
    const ret = wasm.js_enabled();
    return ret !== 0;
}

/**
 * 直前の描画で JS が投げた、拾われなかった例外のメッセージ。
 *
 * 実行そのものは失敗しても描画は続く (そこまでの DOM が絵になる) ので、
 * 「絵は出たが JS が途中で死んだ」を知るにはこれを見る。
 * ループの上限に当たったときも `RuntimeLimitError` としてここに出る。
 * 描画のたびに置き換わる
 * @returns {string[]}
 */
export function last_js_errors() {
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        wasm.last_js_errors(retptr);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        var v1 = getArrayJsValueFromWasm0(r0, r1);
        wasm.__wbindgen_export4(r0, r1 * 4, 4);
        return v1;
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
    }
}

/**
 * 直前の panic のメッセージを取り出す (取り出すと消える)。無ければ `None` (JS では `undefined`)。
 * `render_png_rgba` が `RuntimeError: unreachable` で落ちた直後に呼ぶ
 * @returns {string | undefined}
 */
export function last_panic() {
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        wasm.last_panic(retptr);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        let v1;
        if (r0 !== 0) {
            v1 = getStringFromWasm0(r0, r1);
            wasm.__wbindgen_export4(r0, r1 * 1, 1);
        }
        return v1;
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
    }
}

/**
 * **直前の `render_png_rgba` が要求したのに表に無かった** URL。
 *
 * これを fetch して `add_resource` で足し、もう 1 度描くと、CSS の中から
 * 参照される画像 (`background-image`) や `@import` した CSS、`@font-face` の
 * web font まで絵に入る。HTML を走査するだけでは集まらないもの。
 *
 * - `fetch` にそのまま渡せる絶対 URL (http / https)。要求された順、重複なし
 * - `data:` は Rust 側で解くので入らない
 * - 描画のたびに置き換わる。空になったら足すものは無い
 * - `render_png_rgba` を通らない描画 (native のテスト) では更新されない
 * @returns {string[]}
 */
export function missed_resources() {
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        wasm.missed_resources(retptr);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        var v1 = getArrayJsValueFromWasm0(r0, r1);
        wasm.__wbindgen_export4(r0, r1 * 4, 4);
        return v1;
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
    }
}

/**
 * HTML を `width` x `height` のビューポートに描き、RGBA8 のピクセル列を返す。
 *
 * - 戻り値は `width * height * 4` バイト。左上から行優先、1 ピクセル = R, G, B, A
 * - 背景は白で塗ってから描くので全ピクセルの A は 255。vello_cpu の出力は
 *   premultiplied RGBA だが、A = 255 なら straight と一致するので JS 側で
 *   そのまま PNG にできる
 * - `base_url` はページの URL。`<link href>` や `<img src>` の相対参照を解決する起点に
 *   なる。取得はしないが、解決できないと blitz-dom が panic するので必ず絶対 URL を渡す。
 *   インライン HTML のように URL が無いときは空文字でよい (内部で仮の URL を敷く)
 * - フォントは先に `add_font` で登録しておく。CSS の font-family が何を指していても、
 *   登録したフォントの中から文字を持つものに落ちる。何も登録していないと文字は描かれない
 * - vello_cpu の描画面は u16 なので、辺の長さは 65535 まで
 * - サブリソース (画像・外部 CSS・web font) は**先に `add_resource` で渡した表からだけ**
 *   届く。Rust 側から通信はしない。表に無いものは無かったものとして描く
 *   (画像はその場所が空き、CSS は当たらない)
 * - 表に無かった URL は `missed_resources` に残る。JS はそれを取ってきて
 *   `add_resource` で足し、もう 1 度これを呼ぶ (CSS の中から参照される画像は
 *   この 2 パスでしか拾えない)
 * - ページの `<script>` は Boa で実行する。`set_js_enabled(false)` で切れる。
 *   外部スクリプト (`<script src>`) も資源の表から引く (表に無ければ
 *   `missed_resources` に出るので、2 パス目で当たる)。
 *   拾われなかった例外は `last_js_errors` に出る
 * @param {string} html
 * @param {string} base_url
 * @param {number} width
 * @param {number} height
 * @returns {Uint8Array}
 */
export function render_png_rgba(html, base_url, width, height) {
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        const ptr0 = passStringToWasm0(html, wasm.__wbindgen_export, wasm.__wbindgen_export2);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(base_url, wasm.__wbindgen_export, wasm.__wbindgen_export2);
        const len1 = WASM_VECTOR_LEN;
        wasm.render_png_rgba(retptr, ptr0, len0, ptr1, len1, width, height);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        var v3 = getArrayU8FromWasm0(r0, r1).slice();
        wasm.__wbindgen_export4(r0, r1 * 1, 1);
        return v3;
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
    }
}

/**
 * `render_png_rgba` と同じだが、ページの `<script>` を実行しない。
 *
 * 実ページの崩れが JS のせいなのかを 1 回だけ切り分けたいときに使う
 * (`set_js_enabled` と違って設定を残さない)
 * @param {string} html
 * @param {string} base_url
 * @param {number} width
 * @param {number} height
 * @returns {Uint8Array}
 */
export function render_png_rgba_no_js(html, base_url, width, height) {
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        const ptr0 = passStringToWasm0(html, wasm.__wbindgen_export, wasm.__wbindgen_export2);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(base_url, wasm.__wbindgen_export, wasm.__wbindgen_export2);
        const len1 = WASM_VECTOR_LEN;
        wasm.render_png_rgba_no_js(retptr, ptr0, len0, ptr1, len1, width, height);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        var v3 = getArrayU8FromWasm0(r0, r1).slice();
        wasm.__wbindgen_export4(r0, r1 * 1, 1);
        return v3;
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
    }
}

/**
 * 登録済みの URL (確認用。順序は決まらない)
 * @returns {string[]}
 */
export function resource_urls() {
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        wasm.resource_urls(retptr);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        var v1 = getArrayJsValueFromWasm0(r0, r1);
        wasm.__wbindgen_export4(r0, r1 * 4, 4);
        return v1;
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
    }
}

/**
 * document を捨てる。handle はもう使えない (使っても panic はしない)
 * @param {number} doc
 */
export function sess_close(doc) {
    wasm.sess_close(doc);
}

/**
 * この document の JS context で文字列を評価する。JS context が無ければ `false`。
 *
 * `sess_run_scripts` のあとの document でも動く (同じ context がそのまま
 * 残っている)。CDP の `Runtime.evaluate` の下敷き。
 *
 * 返すのは「評価できる document だったか」だけ。値は返らないので、結果は
 * DOM に書き出して読むか、`sess_paint` で見る。例外は `sess_js_errors` に出る
 * @param {number} doc
 * @param {string} code
 * @returns {boolean}
 */
export function sess_eval(doc, code) {
    const ptr0 = passStringToWasm0(code, wasm.__wbindgen_export, wasm.__wbindgen_export2);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.sess_eval(doc, ptr0, len0);
    return ret !== 0;
}

/**
 * 待っている URL 1 つに「取れなかった」と答える (空のバイト列で答える)。
 *
 * 取れなかったからといって黙って捨ててはいけない。`<head>` の
 * `<link rel="stylesheet">` は `pending_critical_resources` に残り、
 * `doc.resolve` が「まだ描いてはいけない」と判断して**永久に何も描かなくなる**
 * (`net.rs` の頭に書いたのと同じ話)。
 *
 * 空の CSS は中身の無い stylesheet として読まれ、画像はデコードに失敗して
 * 「読めなかった画像」になり、フォントは形式不明として捨てられる。
 * どれも描画は続く
 * @param {number} doc
 * @param {string} url
 * @returns {boolean}
 */
export function sess_fail(doc, url) {
    const ptr0 = passStringToWasm0(url, wasm.__wbindgen_export, wasm.__wbindgen_export2);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.sess_fail(doc, ptr0, len0);
    return ret !== 0;
}

/**
 * この document で拾われなかった JS の例外。
 *
 * グローバルの `last_js_errors` は描画のたびに置き換わるが、session は
 * 1 つの document を何ターンも生かすので、こちらは document ごとに
 * **溜める** (`sess_run_scripts` / `sess_eval` / `sess_run_timers` のぶんが
 * 順に並ぶ)。読んでも消えない。上限は 256 で、古いものから落ちる
 * @param {number} doc
 * @returns {string[]}
 */
export function sess_js_errors(doc) {
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        wasm.sess_js_errors(retptr, doc);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        var v1 = getArrayJsValueFromWasm0(r0, r1);
        wasm.__wbindgen_export4(r0, r1 * 4, 4);
        return v1;
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
    }
}

/**
 * document を開く。**`<script>` は実行しない** ([`sess_run_scripts`] が実行する)。
 *
 * サブリソースは表から引かずに**応答を待たせる**。開いた直後に
 * `sess_pending` を読むと、`<head>` の stylesheet や `<img>` のように
 * パースの時点で要求された URL が並んでいる。
 *
 * - 返り値は 0 でない document handle。失敗したら 0 で、理由は `last_panic()`
 * - `run_js` を真にすると Boa の context 付きで組む。`<script>` の実行は
 *   `sess_run_scripts` まで待つ。`<script src>` の中身は資源のループが
 *   1 周してからでないと手元に無いので、ここで走らせると外部スクリプトが
 *   丸ごと飛ばされる (`execute_scripts` は 2 度目を走らせない)
 * - フォントは `add_font` で先に渡しておく。サブリソースは `add_resource` で
 *   先に渡してもよい (渡してあるものは待たせずに返す)
 * @param {string} html
 * @param {string} base_url
 * @param {number} width
 * @param {number} height
 * @param {boolean} run_js
 * @returns {number}
 */
export function sess_open(html, base_url, width, height, run_js) {
    const ptr0 = passStringToWasm0(html, wasm.__wbindgen_export, wasm.__wbindgen_export2);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(base_url, wasm.__wbindgen_export, wasm.__wbindgen_export2);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.sess_open(ptr0, len0, ptr1, len1, width, height, run_js);
    return ret >>> 0;
}

/**
 * 開いている session の数 (取りこぼしの確認用)
 * @returns {number}
 */
export function sess_open_count() {
    const ret = wasm.sess_open_count();
    return ret >>> 0;
}

/**
 * いまの DOM を RGBA8 に描く。返り値は `width * height * 4` バイト
 * (`dom_paint` と同じ中身)。handle が無ければ空の `Vec`。
 *
 * 待っている `<head>` の stylesheet が 1 つでもあると、blitz-dom は
 * レイアウトを付けないので**白い絵**になる。描く前に `sess_pending` を
 * 空にすること
 * @param {number} doc
 * @returns {Uint8Array}
 */
export function sess_paint(doc) {
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        wasm.sess_paint(retptr, doc);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        var v1 = getArrayU8FromWasm0(r0, r1).slice();
        wasm.__wbindgen_export4(r0, r1 * 1, 1);
        return v1;
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
    }
}

/**
 * まだ応答を待っている URL。要求された順、重複なし。
 *
 * - fragment を落とした絶対 URL (`fetch` にそのまま渡せる http / https)
 * - `data:` は Rust 側で解くので入らない
 * - SVG sprite の `icons.svg#a` と `icons.svg#b` は 1 本にまとまる
 * - `<script src>` の URL も入る (blitz-dom は script を取りに行かないので、
 *   `sess_open` が並べておく)
 *
 * JS はこれを取ってきて `sess_provide` か `sess_fail` で全部答える。
 * **1 つでも答えないまま置くと、`<head>` の stylesheet を待っている
 * document は永久に描かれない**
 * @param {number} doc
 * @returns {string[]}
 */
export function sess_pending(doc) {
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        wasm.sess_pending(retptr, doc);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        var v1 = getArrayJsValueFromWasm0(r0, r1);
        wasm.__wbindgen_export4(r0, r1 * 4, 4);
        return v1;
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
    }
}

/**
 * 待っている URL 1 つに中身を渡す。handler を持っていた (= blitz-dom が
 * 実際に待っていた) なら `true`。
 *
 * - `url` は `sess_pending` が返した文字列をそのまま渡す
 * - 同じ URL を待っている handler は全部答える
 * - 待っていない URL でも中身は覚える。あとで要求されたときに待たせずに返す
 * - `<script src>` の待ちには handler が無いので `false` が返る
 *   (中身は覚えているので `sess_run_scripts` から引ける)
 *
 * 渡した中身が絵に入るのは次の `sess_settle` から
 * @param {number} doc
 * @param {string} url
 * @param {Uint8Array} bytes
 * @returns {boolean}
 */
export function sess_provide(doc, url, bytes) {
    const ptr0 = passStringToWasm0(url, wasm.__wbindgen_export, wasm.__wbindgen_export2);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray8ToWasm0(bytes, wasm.__wbindgen_export);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.sess_provide(doc, ptr0, len0, ptr1, len1);
    return ret !== 0;
}

/**
 * ページの `<script>` を Boa で実行する。JS 無しで開いた document では `false`。
 *
 * 2 度呼んでも 2 度は走らない (`execute_scripts` 自身も同じ約束を持っている)。
 * 走らせる前に**実時間の予算を貼り直す**。`sess_open` から実際の実行までに
 * JS が資源を取りに行っている (実時間で数秒) ので、組んだ時点の予算のままだと
 * 1 本も実行されずに「out of script budget」だけが残る。
 *
 * `<script src>` の中身は `sess_provide` で渡してあること。手元に無い
 * スクリプトは飛ばされ、`sess_js_errors` にその旨が残る
 * @param {number} doc
 * @returns {boolean}
 */
export function sess_run_scripts(doc) {
    const ret = wasm.sess_run_scripts(doc);
    return ret !== 0;
}

/**
 * 溜まっているタイマー (setTimeout / setInterval / requestAnimationFrame) を
 * 仮想時間で進める。最大 `limit` ターン回して、実際に何か走ったターンの数を返す。
 *
 * 時間は実時間では待たない。次のタイマーの時刻へ飛ぶだけ。進める先は
 * **呼ぶたびに** 「いまの仮想時計 + 1 秒」で引き直すが、時計はタイマーが
 * 走ったときにしか進まない。つまり `setTimeout(f, 5000)` のように 1 秒より
 * 先に置かれたタイマーは、その間に走るタイマーが無ければ何度呼んでも走らない
 * (スクリーンショットは「読み込み直後の絵」なので、そこは切ってある)。
 *
 * `sess_run_scripts` も最後にタイマーを 1 度回すので、`<script>` を走らせた
 * 直後に溜まっているぶんはそこで消えている。ここで回るのは、そのときの
 * 地平の外にあったタイマーと、走ったタイマーが新しく張ったタイマー。
 *
 * `<script>` を走らせる前に呼んでも何も起きない (タイマーを張るのは JS なので、
 * 実行前に溜まっているタイマーは 1 つも無い)
 * @param {number} doc
 * @param {number} limit
 * @returns {number}
 */
export function sess_run_timers(doc, limit) {
    const ret = wasm.sess_run_timers(doc, limit);
    return ret >>> 0;
}

/**
 * スタイルとレイアウトを取り直して、**まだ待っている URL の数**を返す。
 *
 * `sess_provide` で渡した中身はここで document に入る。入った結果として
 * 新しい URL が要求されることがある (外部 CSS の中の `@import` や
 * `background-image`、`@font-face` の web font は、その CSS が届いて初めて
 * 読める)。なので JS は 0 になるまで `sess_pending` → `sess_provide` →
 * `sess_settle` を回す
 * @param {number} doc
 * @returns {number}
 */
export function sess_settle(doc) {
    const ret = wasm.sess_settle(doc);
    return ret >>> 0;
}

/**
 * この generic family では、この family を先に探す、と決める。
 *
 * `set_generic_lead("monospace", vec!["mono", "jp"])` のように呼ぶと、CSS が
 * `monospace` を指したときに `mono` -> `jp` -> (残りは登録順) の順で文字を探す。
 * `add_font` を全部呼び終わったあとに呼ぶ (呼ぶたびに `FontContext` を組み直す)。
 *
 * 戻り値は generic family 名を解釈できたかどうか
 * @param {string} generic
 * @param {string[]} families
 * @returns {boolean}
 */
export function set_generic_lead(generic, families) {
    const ptr0 = passStringToWasm0(generic, wasm.__wbindgen_export, wasm.__wbindgen_export2);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArrayJsValueToWasm0(families, wasm.__wbindgen_export);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.set_generic_lead(ptr0, len0, ptr1, len1);
    return ret !== 0;
}

/**
 * ページの `<script>` を実行するかどうかを切り替える。既定は実行する。
 *
 * 実ページの崩れが JS のせいなのかを切り分けたいときに `false` にする。
 * wasm インスタンスに残るので、Workers では isolate が生きている間は有効
 * @param {boolean} enabled
 */
export function set_js_enabled(enabled) {
    wasm.set_js_enabled(enabled);
}
function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbg___wbindgen_is_undefined_8c687d0b90d5b524: function(arg0) {
            const ret = getObject(arg0) === undefined;
            return ret;
        },
        __wbg___wbindgen_string_get_92ab86bb19cbc12f: function(arg0, arg1) {
            const obj = getObject(arg1);
            const ret = typeof(obj) === 'string' ? obj : undefined;
            var ptr1 = isLikeNone(ret) ? 0 : passStringToWasm0(ret, wasm.__wbindgen_export, wasm.__wbindgen_export2);
            var len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbg___wbindgen_throw_5d9e815e6fdf150f: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
        },
        __wbg_error_51dc455fc840bcbc: function(arg0, arg1) {
            console.error(getStringFromWasm0(arg0, arg1));
        },
        __wbg_getRandomValues_436a51d0629d84e1: function() { return handleError(function (arg0, arg1) {
            globalThis.crypto.getRandomValues(getArrayU8FromWasm0(arg0, arg1));
        }, arguments); },
        __wbg_getTime_65922ba0b59d55a7: function(arg0) {
            const ret = getObject(arg0).getTime();
            return ret;
        },
        __wbg_getTimezoneOffset_6e4850ad528ac37d: function(arg0) {
            const ret = getObject(arg0).getTimezoneOffset();
            return ret;
        },
        __wbg_new_0_35540e542ba689d2: function() {
            const ret = new Date();
            return addHeapObject(ret);
        },
        __wbg_new_180f1022bb6ee517: function(arg0) {
            const ret = new Date(getObject(arg0));
            return addHeapObject(ret);
        },
        __wbg_now_d1fb6650485d7f3e: function() {
            const ret = Date.now();
            return ret;
        },
        __wbg_now_e7c6795a7f81e10f: function(arg0) {
            const ret = getObject(arg0).now();
            return ret;
        },
        __wbg_performance_3fcf6e32a7e1ed0a: function(arg0) {
            const ret = getObject(arg0).performance;
            return addHeapObject(ret);
        },
        __wbg_static_accessor_GLOBAL_8eb4cd83130a11a0: function() {
            const ret = typeof global === 'undefined' ? null : global;
            return isLikeNone(ret) ? 0 : addHeapObject(ret);
        },
        __wbg_static_accessor_GLOBAL_THIS_1e7044f654e934db: function() {
            const ret = typeof globalThis === 'undefined' ? null : globalThis;
            return isLikeNone(ret) ? 0 : addHeapObject(ret);
        },
        __wbg_static_accessor_SELF_d8b50611246a6d92: function() {
            const ret = typeof self === 'undefined' ? null : self;
            return isLikeNone(ret) ? 0 : addHeapObject(ret);
        },
        __wbg_static_accessor_WINDOW_fd0bc376bf0f8b42: function() {
            const ret = typeof window === 'undefined' ? null : window;
            return isLikeNone(ret) ? 0 : addHeapObject(ret);
        },
        __wbindgen_generic_0000000000000001: function(arg0) {
            // Cast intrinsic for `F64 -> Externref`.
            const ret = arg0;
            return addHeapObject(ret);
        },
        __wbindgen_generic_0000000000000002: function(arg0, arg1) {
            // Cast intrinsic for `Ref(String) -> Externref`.
            const ret = getStringFromWasm0(arg0, arg1);
            return addHeapObject(ret);
        },
        __wbindgen_object_clone_ref: function(arg0) {
            const ret = getObject(arg0);
            return addHeapObject(ret);
        },
        __wbindgen_object_drop_ref: function(arg0) {
            takeObject(arg0);
        },
    };
    return {
        __proto__: null,
        "./kitesurf_clone_bg.js": import0,
    };
}

function addHeapObject(obj) {
    if (heap_next === heap.length) heap.push(heap.length + 1);
    const idx = heap_next;
    heap_next = heap[idx];

    heap[idx] = obj;
    return idx;
}

function dropObject(idx) {
    if (idx < 1028) return;
    heap[idx] = heap_next;
    heap_next = idx;
}

function getArrayF64FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getFloat64ArrayMemory0().subarray(ptr / 8, ptr / 8 + len);
}

function getArrayJsValueFromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    const mem = getDataViewMemory0();
    const result = [];
    for (let i = ptr; i < ptr + 4 * len; i += 4) {
        result.push(takeObject(mem.getUint32(i, true)));
    }
    return result;
}

function getArrayU32FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}

function getArrayU8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

let cachedDataViewMemory0 = null;
function getDataViewMemory0() {
    if (cachedDataViewMemory0 === null || cachedDataViewMemory0.buffer.detached === true || (cachedDataViewMemory0.buffer.detached === undefined && cachedDataViewMemory0.buffer !== wasm.memory.buffer)) {
        cachedDataViewMemory0 = new DataView(wasm.memory.buffer);
    }
    return cachedDataViewMemory0;
}

let cachedFloat64ArrayMemory0 = null;
function getFloat64ArrayMemory0() {
    if (cachedFloat64ArrayMemory0 === null || cachedFloat64ArrayMemory0.byteLength === 0) {
        cachedFloat64ArrayMemory0 = new Float64Array(wasm.memory.buffer);
    }
    return cachedFloat64ArrayMemory0;
}

function getStringFromWasm0(ptr, len) {
    return decodeText(ptr >>> 0, len);
}

let cachedUint32ArrayMemory0 = null;
function getUint32ArrayMemory0() {
    if (cachedUint32ArrayMemory0 === null || cachedUint32ArrayMemory0.byteLength === 0) {
        cachedUint32ArrayMemory0 = new Uint32Array(wasm.memory.buffer);
    }
    return cachedUint32ArrayMemory0;
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function getObject(idx) { return heap[idx]; }

function handleError(f, args) {
    try {
        return f.apply(this, args);
    } catch (e) {
        wasm.__wbindgen_export3(addHeapObject(e));
    }
}

let heap = new Array(1024).fill(undefined);
heap.push(undefined, null, true, false);

let heap_next = heap.length;

function isLikeNone(x) {
    return x === undefined || x === null;
}

function passArray8ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 1, 1) >>> 0;
    getUint8ArrayMemory0().set(arg, ptr / 1);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passArrayJsValueToWasm0(array, malloc) {
    const ptr = malloc(array.length * 4, 4) >>> 0;
    const mem = getDataViewMemory0();
    for (let i = 0; i < array.length; i++) {
        mem.setUint32(ptr + 4 * i, addHeapObject(array[i]), true);
    }
    WASM_VECTOR_LEN = array.length;
    return ptr;
}

function passStringToWasm0(arg, malloc, realloc) {
    if (realloc === undefined) {
        const buf = cachedTextEncoder.encode(arg);
        const ptr = malloc(buf.length, 1) >>> 0;
        getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;

    const mem = getUint8ArrayMemory0();

    let offset = 0;

    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7F) break;
        mem[ptr + offset] = code;
    }
    if (offset !== len) {
        if (offset !== 0) {
            arg = arg.slice(offset);
        }
        ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
        const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
        const ret = cachedTextEncoder.encodeInto(arg, view);

        offset += ret.written;
        ptr = realloc(ptr, len, offset, 1) >>> 0;
    }

    WASM_VECTOR_LEN = offset;
    return ptr;
}

function takeObject(idx) {
    const ret = getObject(idx);
    dropObject(idx);
    return ret;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
    numBytesDecoded += len;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
        cachedTextDecoder.decode();
        numBytesDecoded = len;
    }
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

const cachedTextEncoder = new TextEncoder();

if (!('encodeInto' in cachedTextEncoder)) {
    cachedTextEncoder.encodeInto = function (arg, view) {
        const buf = cachedTextEncoder.encode(arg);
        view.set(buf);
        return {
            read: arg.length,
            written: buf.length
        };
    };
}

let WASM_VECTOR_LEN = 0;

let wasmModule, wasmInstance, wasm;
function __wbg_finalize_init(instance, module) {
    wasmInstance = instance;
    wasm = instance.exports;
    wasmModule = module;
    cachedDataViewMemory0 = null;
    cachedFloat64ArrayMemory0 = null;
    cachedUint32ArrayMemory0 = null;
    cachedUint8ArrayMemory0 = null;
    wasm.__wbindgen_start();
    return wasm;
}

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (!module.ok) {
            throw new Error(`failed to fetch Wasm: ${module.status} ${module.statusText} fetching '${module.url}'`);
        }

        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);
            } catch (e) {
                const validResponse = expectedResponseType(module.type);

                if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else { throw e; }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);
    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };
        } else {
            return instance;
        }
    }

    function expectedResponseType(type) {
        switch (type) {
            case 'basic': case 'cors': case 'default': return true;
        }
        return false;
    }
}

function initSync(module) {
    if (wasm !== undefined) return wasm;


    if (module !== undefined) {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports();
    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }
    const instance = new WebAssembly.Instance(module, imports);
    return __wbg_finalize_init(instance, module);
}

async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;


    if (module_or_path !== undefined) {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (module_or_path === undefined) {
        module_or_path = new URL('kitesurf_clone_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync, __wbg_init as default };
