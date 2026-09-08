// 動的 Worker の中で、Rust 側の DOM に JS の顔を付ける。
//
// engine (blitz-dom) は Rust 側にあり、ノードは u32 の id で指す。
// ここはその id を包んで `document` / `Element` / `Node` に見せる層。
// ページのスクリプトは V8 で走るので、DOM を触るたびに wasm-bindgen の
// 境界を 1 回越える。Boa の中で DOM を触るときは境界が無いかわりに、
// JS の実行そのものが約 200 倍遅い。どちらを取るかという話になる。
//
// このファイルは wrangler の Text ルールで**文字列として**読み込み、
// 動的 Worker のモジュールとして渡す (だから `export` は使わず、
// グローバルに置く形で書いてある)。

/* eslint-disable no-undef */
(function () {
  // `installDom(api, doc)` で使う。api は glue の dom_* を集めたもの
  globalThis.installDom = function installDom(api, doc) {
    // 「無い」を表す値。Rust 側が 0 を使うか u32::MAX を使うかに依存しないよう両方見る
    const NONE = new Set([0, 4294967295, undefined, null]);
    const isNone = (id) => NONE.has(id);

    const need = (name) => {
      const fn = api[name];
      if (typeof fn !== 'function') {
        throw new Error(`engine に ${name} が無い (DOM の口が足りていない)`);
      }
      return fn;
    };
    const opt = (name) => (typeof api[name] === 'function' ? api[name] : null);

    // ノードの包みは id ごとに 1 つだけ作る。
    // そうしないと `a === b` が成り立たず、イベントの登録先も揃わない
    const wrappers = new Map();
    const wrap = (id) => {
      if (isNone(id)) return null;
      let w = wrappers.get(id);
      if (!w) { w = new BlitzNode(id); wrappers.set(id, w); }
      return w;
    };
    const idOf = (node) => {
      if (node == null) return 0;
      if (typeof node === 'number') return node;
      if (node.__id !== undefined) return node.__id;
      throw new TypeError('DOM のノードではないものが渡された');
    };

    // ---- style。blitz-dom は style 属性を持っているので、そこを読み書きする ----
    const CSS_NAME = (prop) => String(prop).replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());

    class Style {
      constructor(nodeId) { this.__node = nodeId; }
      setProperty(prop, value) {
        const set = opt('dom_set_style_property');
        if (set) { set(doc, this.__node, CSS_NAME(prop), String(value)); return; }
        // 無ければ style 属性を自分で組み立てる
        const cur = need('dom_get_attribute')(doc, this.__node, 'style') ?? '';
        const name = CSS_NAME(prop);
        const kept = cur.split(';').map((s) => s.trim()).filter(Boolean)
          .filter((s) => s.split(':')[0].trim().toLowerCase() !== name);
        kept.push(`${name}: ${value}`);
        need('dom_set_attribute')(doc, this.__node, 'style', kept.join('; '));
      }
      getPropertyValue(prop) {
        const cur = need('dom_get_attribute')(doc, this.__node, 'style') ?? '';
        const name = CSS_NAME(prop);
        for (const part of cur.split(';')) {
          const [k, ...rest] = part.split(':');
          if (k && k.trim().toLowerCase() === name) return rest.join(':').trim();
        }
        return '';
      }
      removeProperty(prop) { this.setProperty(prop, ''); }
      get cssText() { return need('dom_get_attribute')(doc, this.__node, 'style') ?? ''; }
      set cssText(v) { need('dom_set_attribute')(doc, this.__node, 'style', String(v)); }
    }

    // camelCase のプロパティ (el.style.backgroundColor = ...) を通す
    const styleProxy = (nodeId) => new Proxy(new Style(nodeId), {
      get(target, prop) {
        if (prop in target) return typeof target[prop] === 'function' ? target[prop].bind(target) : target[prop];
        if (typeof prop === 'string') return target.getPropertyValue(prop);
        return undefined;
      },
      set(target, prop, value) {
        if (prop in target) { target[prop] = value; return true; }
        if (typeof prop === 'string') { target.setProperty(prop, value); return true; }
        return false;
      },
    });

    // ---- classList ----
    class ClassList {
      constructor(nodeId) { this.__node = nodeId; }
      get __list() {
        return (need('dom_get_attribute')(doc, this.__node, 'class') ?? '').split(/\s+/).filter(Boolean);
      }
      __write(list) {
        need('dom_set_attribute')(doc, this.__node, 'class', list.join(' '));
      }
      add(...names) {
        const list = this.__list;
        for (const n of names) if (!list.includes(n)) list.push(n);
        this.__write(list);
      }
      remove(...names) { this.__write(this.__list.filter((n) => !names.includes(n))); }
      toggle(name, force) {
        const has = this.contains(name);
        const want = force === undefined ? !has : !!force;
        if (want) this.add(name); else this.remove(name);
        return want;
      }
      contains(name) { return this.__list.includes(name); }
      item(i) { return this.__list[i] ?? null; }
      get length() { return this.__list.length; }
      get value() { return this.__list.join(' '); }
      toString() { return this.value; }
      forEach(fn, thisArg) { this.__list.forEach(fn, thisArg); }
      [Symbol.iterator]() { return this.__list[Symbol.iterator](); }
    }

    // ---- ノード本体 ----
    class BlitzNode {
      constructor(id) {
        this.__id = id;
        this.__listeners = new Map();
      }

      // 種別
      get nodeType() { const f = opt('dom_node_type'); return f ? f(doc, this.__id) : 1; }
      get tagName() { const t = need('dom_tag_name')(doc, this.__id); return t ? t.toUpperCase() : ''; }
      get nodeName() { return this.nodeType === 3 ? '#text' : this.tagName; }
      get localName() { return (need('dom_tag_name')(doc, this.__id) ?? '').toLowerCase(); }
      get ownerDocument() { return documentObject; }
      get isConnected() { return !isNone(need('dom_parent')(doc, this.__id)) || this.__id === rootId; }

      // 中身
      get textContent() { return need('dom_text_content')(doc, this.__id); }
      set textContent(v) { need('dom_set_text_content')(doc, this.__id, v == null ? '' : String(v)); }
      get innerHTML() { return need('dom_inner_html')(doc, this.__id); }
      set innerHTML(v) {
        // 子は作り直されるので、その子孫の包みだけ捨てる。
        // 全部捨てると `document.body` の同一性まで壊れて、
        // 別のノードに付けたイベントの登録先も失われる
        const stale = [];
        const walk = (id) => {
          for (const child of need('dom_child_nodes')(doc, id)) {
            stale.push(child);
            walk(child);
          }
        };
        walk(this.__id);
        need('dom_set_inner_html')(doc, this.__id, v == null ? '' : String(v));
        for (const id of stale) wrappers.delete(id);
      }
      get outerHTML() { const f = opt('dom_outer_html'); return f ? f(doc, this.__id) : ''; }
      get innerText() { return this.textContent; }
      set innerText(v) { this.textContent = v; }
      get data() { return this.textContent; }
      set data(v) { this.textContent = v; }

      // 属性
      getAttribute(name) { const v = need('dom_get_attribute')(doc, this.__id, String(name)); return v === undefined ? null : v; }
      setAttribute(name, value) { need('dom_set_attribute')(doc, this.__id, String(name), value == null ? '' : String(value)); }
      removeAttribute(name) { need('dom_remove_attribute')(doc, this.__id, String(name)); }
      hasAttribute(name) { return need('dom_has_attribute')(doc, this.__id, String(name)); }
      getAttributeNames() { const f = opt('dom_attribute_names'); return f ? Array.from(f(doc, this.__id)) : []; }
      get attributes() {
        return this.getAttributeNames().map((name) => ({ name, value: this.getAttribute(name) }));
      }
      get id() { return this.getAttribute('id') ?? ''; }
      set id(v) { this.setAttribute('id', v); }
      get className() { return this.getAttribute('class') ?? ''; }
      set className(v) { this.setAttribute('class', v); }
      get classList() { return new ClassList(this.__id); }
      get style() { return styleProxy(this.__id); }
      get href() { return this.getAttribute('href') ?? ''; }
      set href(v) { this.setAttribute('href', v); }
      get src() { return this.getAttribute('src') ?? ''; }
      set src(v) { this.setAttribute('src', v); }
      get value() { return this.getAttribute('value') ?? ''; }
      set value(v) { this.setAttribute('value', v); }
      get dataset() {
        const el = this;
        return new Proxy({}, {
          get: (_t, k) => el.getAttribute('data-' + CSS_NAME(k)) ?? undefined,
          set: (_t, k, v) => { el.setAttribute('data-' + CSS_NAME(k), v); return true; },
          has: (_t, k) => el.hasAttribute('data-' + CSS_NAME(k)),
        });
      }

      // 木
      get parentNode() { return wrap(need('dom_parent')(doc, this.__id)); }
      get parentElement() { return this.parentNode; }
      get childNodes() { return Array.from(need('dom_child_nodes')(doc, this.__id)).map(wrap); }
      get children() { return Array.from(need('dom_children')(doc, this.__id)).map(wrap); }
      get firstChild() { return wrap(need('dom_first_child')(doc, this.__id)); }
      get firstElementChild() { return this.children[0] ?? null; }
      get lastChild() { const c = this.childNodes; return c[c.length - 1] ?? null; }
      get nextSibling() { return wrap(need('dom_next_sibling')(doc, this.__id)); }
      get nextElementSibling() {
        let n = this.nextSibling;
        while (n && n.nodeType !== 1) n = n.nextSibling;
        return n;
      }

      appendChild(child) { need('dom_append_child')(doc, this.__id, idOf(child)); return child; }
      insertBefore(child, ref) { need('dom_insert_before')(doc, this.__id, idOf(child), idOf(ref)); return child; }
      removeChild(child) { need('dom_remove_child')(doc, this.__id, idOf(child)); return child; }
      remove() { const f = opt('dom_remove'); if (f) f(doc, this.__id); else { const p = this.parentNode; if (p) p.removeChild(this); } }
      replaceChild(next, prev) { this.insertBefore(next, prev); this.removeChild(prev); return prev; }
      append(...nodes) { for (const n of nodes) this.appendChild(typeof n === 'string' ? documentObject.createTextNode(n) : n); }
      prepend(...nodes) { for (const n of nodes.reverse()) this.insertBefore(typeof n === 'string' ? documentObject.createTextNode(n) : n, this.firstChild); }
      cloneNode(deep) { const f = opt('dom_clone_node'); return f ? wrap(f(doc, this.__id, !!deep)) : null; }
      contains(other) {
        let n = other;
        while (n) { if (n === this) return true; n = n.parentNode; }
        return false;
      }

      // 検索
      querySelector(sel) { return wrap(need('dom_query_selector_within')(doc, this.__id, String(sel))); }
      querySelectorAll(sel) { return Array.from(need('dom_query_selector_all_within')(doc, this.__id, String(sel))).map(wrap); }
      getElementsByTagName(tag) { return this.querySelectorAll(String(tag)); }
      getElementsByClassName(cls) { return this.querySelectorAll('.' + String(cls).split(/\s+/).filter(Boolean).join('.')); }
      closest(sel) {
        let n = this;
        while (n && n.nodeType === 1) {
          if (n.matches && n.matches(sel)) return n;
          n = n.parentNode;
        }
        return null;
      }
      matches(sel) { const f = opt('dom_matches'); return f ? f(doc, this.__id, String(sel)) : false; }

      // レイアウト
      getBoundingClientRect() {
        const r = Array.from(need('dom_bounding_rect')(doc, this.__id));
        const [x = 0, y = 0, width = 0, height = 0] = r;
        return { x, y, width, height, top: y, left: x, right: x + width, bottom: y + height,
          toJSON() { return { x, y, width, height, top: y, left: x, right: x + width, bottom: y + height }; } };
      }
      get offsetWidth() { const f = opt('dom_offset_width'); return f ? f(doc, this.__id) : this.getBoundingClientRect().width; }
      get offsetHeight() { const f = opt('dom_offset_height'); return f ? f(doc, this.__id) : this.getBoundingClientRect().height; }
      get clientWidth() { return this.offsetWidth; }
      get clientHeight() { return this.offsetHeight; }
      get scrollWidth() { return this.offsetWidth; }
      get scrollHeight() { return this.offsetHeight; }
      get offsetTop() { return this.getBoundingClientRect().top; }
      get offsetLeft() { return this.getBoundingClientRect().left; }
      get offsetParent() { return this.parentElement; }

      // イベント。1 枚の絵を描くだけなので、登録は受けるが発火はしない
      addEventListener(type, fn) {
        if (typeof fn !== 'function') return;
        const list = this.__listeners.get(type) ?? [];
        list.push(fn);
        this.__listeners.set(type, list);
      }
      removeEventListener(type, fn) {
        const list = this.__listeners.get(type);
        if (list) this.__listeners.set(type, list.filter((f) => f !== fn));
      }
      dispatchEvent(ev) {
        const list = this.__listeners.get(ev && ev.type) ?? [];
        for (const fn of list) { try { fn.call(this, ev); } catch (e) { globalThis.__pageErrors.push(String(e && e.message)); } }
        return true;
      }
      // よく触られる no-op
      focus() {} blur() {} click() { this.dispatchEvent({ type: 'click', target: this }); }
      scrollIntoView() {} setAttributeNS() {} getAttributeNS() { return null; }
    }

    const rootId = need('dom_document_element')(doc);

    // ---- document ----
    const documentObject = {
      __id: 9,
      nodeType: 9,
      get documentElement() { return wrap(rootId); },
      get body() { return wrap(need('dom_body')(doc)); },
      get head() { return wrap(need('dom_query_selector')(doc, 'head')); },
      get title() { const t = wrap(need('dom_query_selector')(doc, 'title')); return t ? t.textContent : ''; },
      set title(v) { const t = wrap(need('dom_query_selector')(doc, 'title')); if (t) t.textContent = v; },
      readyState: 'loading',
      get characterSet() { return 'UTF-8'; },
      get compatMode() { return 'CSS1Compat'; },
      getElementById(id) { return wrap(need('dom_get_element_by_id')(doc, String(id))); },
      querySelector(sel) { return wrap(need('dom_query_selector')(doc, String(sel))); },
      querySelectorAll(sel) { return Array.from(need('dom_query_selector_all')(doc, String(sel))).map(wrap); },
      getElementsByTagName(tag) { return this.querySelectorAll(String(tag)); },
      getElementsByClassName(cls) { return this.querySelectorAll('.' + String(cls).split(/\s+/).filter(Boolean).join('.')); },
      getElementsByName(name) { return this.querySelectorAll(`[name="${String(name).replace(/"/g, '\\"')}"]`); },
      createElement(tag) { return wrap(need('dom_create_element')(doc, String(tag))); },
      createElementNS(_ns, tag) { return this.createElement(tag); },
      createTextNode(text) { return wrap(need('dom_create_text_node')(doc, text == null ? '' : String(text))); },
      createComment() { return wrap(need('dom_create_text_node')(doc, '')); },
      createDocumentFragment() { return wrap(need('dom_create_element')(doc, 'div')); },
      createEvent(type) { return { type, initEvent() {} }; },
      addEventListener(type, fn) { docListeners.set(type, [...(docListeners.get(type) ?? []), fn]); },
      removeEventListener() {},
      dispatchEvent(ev) {
        for (const fn of docListeners.get(ev && ev.type) ?? []) {
          try { fn.call(documentObject, ev); } catch (e) { globalThis.__pageErrors.push(String(e && e.message)); }
        }
        return true;
      },
      get cookie() { return ''; },
      set cookie(_v) {},
      write() {}, writeln() {}, open() {}, close() {},
      get activeElement() { return this.body; },
      // React はここから window を辿って、そこのコンストラクタを見る
      get defaultView() { return globalThis; },
      get scrollingElement() { return this.documentElement; },
    };
    const docListeners = new Map();

    globalThis.document = documentObject;
    globalThis.Node = BlitzNode;
    globalThis.Element = BlitzNode;
    globalThis.HTMLElement = BlitzNode;

    // instanceof の右辺になるものを置く。
    //
    // React DOM は `t instanceof e.HTMLIFrameElement` のように、
    // window から辿ったコンストラクタで narrowing する。無いと
    // 「Right-hand side of 'instanceof' is not an object」で止まる。
    //
    // ここは **BlitzNode と別のクラスにする**。同じにすると全ノードが
    // iframe や input として真になって、React が違う枝に入る
    for (const name of [
      'HTMLIFrameElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLSelectElement',
      'HTMLButtonElement', 'HTMLAnchorElement', 'HTMLImageElement', 'HTMLFormElement',
      'HTMLCanvasElement', 'HTMLScriptElement', 'HTMLStyleElement', 'HTMLLinkElement',
      'SVGElement', 'Text', 'Comment', 'DocumentFragment', 'Document', 'Window',
    ]) {
      if (!globalThis[name]) globalThis[name] = class {};
    }
    globalThis.__domReady = () => {
      documentObject.readyState = 'interactive';
      documentObject.dispatchEvent({ type: 'DOMContentLoaded', target: documentObject });
      documentObject.readyState = 'complete';
      documentObject.dispatchEvent({ type: 'readystatechange', target: documentObject });
      // window の load は globalThis 側に登録される
      for (const fn of (globalThis.__windowListeners?.get('load') ?? [])) {
        try { fn.call(globalThis, { type: 'load' }); } catch (e) { globalThis.__pageErrors.push(String(e && e.message)); }
      }
    };
    return documentObject;
  };
})();
