// ページのスクリプトより先に読ませる shim。
//
// engine (blitz-vibey-script + Boa) には DOM の主要な口はだいたい揃っているが、
// ホスト側の Web API がいくつか無い。実測で足りなかったのは 9 個:
//
//   matchMedia / URLSearchParams / fetch / localStorage / sessionStorage /
//   MutationObserver / IntersectionObserver / ResizeObserver / performance.now /
//   navigator / screen
//
// 本来は Rust 側に実装するもの (Kitesurf はそうしているはず) だが、
// 「あと何が足りないのか」を測るには JS で埋めるのがいちばん早い。
// スクリーンショットを撮るだけなら、多くは「呼べて、もっともらしい値を返す」だけで足りる。
//
// Boa 向けなので ES5 の書き方に寄せてある。
export const POLYFILL = `(function () {
  var w = typeof window !== 'undefined' ? window : this;
  var d = w.document;

  // navigator: react.dev は navigator.platform.includes('Mac') で
  // 表示するキーボードショートカットを変えている。無いと例外で止まる。
  // Windows と答えるのは、Mac だと \u2318 のグリフを持っていないので豆腐になるから
  try {
    if (!w.navigator) { w.navigator = {}; }
    var nav = w.navigator;
    if (!nav.platform) { nav.platform = 'Win32'; }
    if (!nav.userAgent) {
      nav.userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        + ' (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36 browser-on-workers/0.1';
    }
    if (!nav.vendor) { nav.vendor = ''; }
    if (!nav.language) { nav.language = 'ja'; }
    if (!nav.languages) { nav.languages = ['ja', 'en']; }
    if (nav.onLine === undefined) { nav.onLine = true; }
    if (nav.maxTouchPoints === undefined) { nav.maxTouchPoints = 0; }
    if (nav.hardwareConcurrency === undefined) { nav.hardwareConcurrency = 1; }
    if (!nav.clipboard) { nav.clipboard = { writeText: function () { return Promise.resolve(); } }; }
    if (typeof nav.sendBeacon !== 'function') { nav.sendBeacon = function () { return false; }; }
  } catch (e) { /* navigator に代入できない実装なら諦める */ }

  // screen: 幅を見て分岐するコードのために、viewport と同じ値を返す
  try {
    if (!w.screen) {
      w.screen = {
        get width() { return (w.innerWidth || 1280); },
        get height() { return (w.innerHeight || 800); },
        get availWidth() { return (w.innerWidth || 1280); },
        get availHeight() { return (w.innerHeight || 800); },
        colorDepth: 24, pixelDepth: 24
      };
    }
  } catch (e) { /* 同上 */ }

  // performance.now: 単調に増える値を返す。実時間ではない
  // (Workers は I/O の無い区間で時計が進まないので、実時間は取れない)
  if (!w.performance) { w.performance = {}; }
  if (typeof w.performance.now !== 'function') {
    var tick = 0;
    w.performance.now = function () { tick += 0.1; return tick; };
  }

  // DOM の口の穴を塞ぐ。
  //
  // 両経路の DOM を総当たりで比べたら、Boa 側 (blitz-vibey-script) と
  // V8 側 (自分で書いた shim) で欠けているものが違った。React DOM は
  // ハイドレーションの途中でこれらを呼ぶので、無いと「呼べない」で
  // 例外になり、React は不一致と判断して SSR の HTML を捨てる。
  //
  // prototype に足せるかどうかは engine 側の作りに依るので、
  // 足したうえで効いているかを別途測る (probes の api.html)
  var protos = [];
  ['Element', 'HTMLElement', 'Node'].forEach(function (name) {
    var c = w[name];
    if (c && c.prototype) protos.push(c.prototype);
  });
  var addMethod = function (name, fn) {
    for (var i = 0; i < protos.length; i++) {
      var pr = protos[i];
      try { if (typeof pr[name] !== 'function') pr[name] = fn; } catch (e) { /* 読み取り専用なら諦める */ }
    }
  };

  // 名前空間つきの属性。SVG の xlink などで React が使う。
  // 名前空間は無視して普通の属性として扱う
  addMethod('getAttributeNS', function (ns, n) { return this.getAttribute(n); });
  addMethod('setAttributeNS', function (ns, n, v) { return this.setAttribute(n, v); });
  addMethod('removeAttributeNS', function (ns, n) { return this.removeAttribute(n); });

  addMethod('hasChildNodes', function () {
    var c = this.childNodes;
    return !!(c && c.length);
  });
  addMethod('normalize', function () { /* テキストノードの結合。絵には出ない */ });
  addMethod('getClientRects', function () {
    var r = this.getBoundingClientRect ? this.getBoundingClientRect() : null;
    return r ? [r] : [];
  });
  addMethod('setSelectionRange', function () { /* 入力欄の選択。1 枚の絵には出ない */ });

  // isEqualNode。Next.js の head 管理が <meta> や <link> を突き合わせるのに使う。
  // 無いと updateHead が毎回落ちる。outerHTML の比較で足りる
  addMethod('isEqualNode', function (other) {
    if (!other) return false;
    if (other === this) return true;
    try {
      if (this.outerHTML != null && other.outerHTML != null) {
        return String(this.outerHTML) === String(other.outerHTML);
      }
      return String(this.nodeName) === String(other.nodeName)
        && String(this.textContent) === String(other.textContent);
    } catch (e) { return false; }
  });
  addMethod('isSameNode', function (other) { return other === this; });

  // element.attributes。
  //
  // **これが無いと React のハイドレーションが必ず失敗する。**
  // diffHydratedProperties が属性を列挙して突き合わせるので、undefined だと
  // 「cannot convert 'null' or 'undefined' to object」で落ち、React は
  // 不一致と判断して SSR の HTML を捨てる (Error #418)。
  //
  // engine 側に属性名を列挙する口が無いので、outerHTML の開きタグを読んで組む。
  // 正規表現はこのファイルが template literal なのでエスケープが潰れる。
  // 手で走査する
  var WS = ' ' + String.fromCharCode(9) + String.fromCharCode(10) + String.fromCharCode(13);
  var isWs = function (c) { return WS.indexOf(c) >= 0; };
  var parseAttrs = function (html) {
    var list = [];
    if (!html || html.charAt(0) !== '<') return list;
    var gt = html.indexOf('>');
    var tag = html.slice(1, gt < 0 ? html.length : gt);
    var i = 0;
    while (i < tag.length && !isWs(tag.charAt(i))) i++;   // タグ名を飛ばす
    while (i < tag.length) {
      while (i < tag.length && isWs(tag.charAt(i))) i++;
      if (i >= tag.length || tag.charAt(i) === '/') break;
      var ns = i;
      while (i < tag.length && !isWs(tag.charAt(i)) && tag.charAt(i) !== '=') i++;
      var name = tag.slice(ns, i);
      var value = '';
      var j = i;
      while (j < tag.length && isWs(tag.charAt(j))) j++;
      if (tag.charAt(j) === '=') {
        j++;
        while (j < tag.length && isWs(tag.charAt(j))) j++;
        var q = tag.charAt(j);
        if (q === '"' || q === "'") {
          var close = tag.indexOf(q, j + 1);
          if (close < 0) close = tag.length;
          value = tag.slice(j + 1, close);
          i = close + 1;
        } else {
          var vs = j;
          while (j < tag.length && !isWs(tag.charAt(j))) j++;
          value = tag.slice(vs, j);
          i = j;
        }
      } else {
        i = j;
      }
      if (name) list.push({ name: name, localName: name, value: value, specified: true, nodeName: name, nodeValue: value });
    }
    return list;
  };
  // select.options。React DOM の <select> の初期化が node.options を
  // そのまま for で回すので、無いと落ちる (react.dev には言語の select がある)
  protos.forEach(function (pr) {
    try {
      if (pr.options !== undefined) return;
      Object.defineProperty(pr, 'options', {
        configurable: true,
        get: function () {
          if (String(this.tagName).toLowerCase() !== 'select') return undefined;
          var found = this.querySelectorAll ? this.querySelectorAll('option') : [];
          var list = [];
          for (var i = 0; i < found.length; i++) list.push(found[i]);
          list.item = function (n) { return this[n] || null; };
          return list;
        }
      });
    } catch (e) { /* 定義できない engine では諦める */ }
  });

  protos.forEach(function (pr) {
    try {
      if (pr.attributes !== undefined) return;
      Object.defineProperty(pr, 'attributes', {
        configurable: true,
        get: function () {
          var list = parseAttrs(String(this.outerHTML == null ? '' : this.outerHTML));
          list.item = function (n) { return this[n] || null; };
          list.getNamedItem = function (n) {
            for (var k = 0; k < this.length; k++) if (this[k].name === n) return this[k];
            return null;
          };
          return list;
        }
      });
    } catch (e) { /* 定義できない engine では諦める */ }
  });
  addMethod('getRootNode', function () {
    var n = this;
    while (n && n.parentNode) n = n.parentNode;
    return n;
  });
  addMethod('remove', function () {
    if (this.parentNode && typeof this.parentNode.removeChild === 'function') {
      this.parentNode.removeChild(this);
    }
  });
  addMethod('replaceWith', function (node) {
    if (this.parentNode && typeof this.parentNode.replaceChild === 'function') {
      this.parentNode.replaceChild(node, this);
    }
  });

  // compareDocumentPosition。React は containsNode でこれを使う。
  // 返すのは DOCUMENT_POSITION_CONTAINED_BY (16) と _CONTAINS (8) だけ
  addMethod('compareDocumentPosition', function (other) {
    if (!other || other === this) return 0;
    var up = other.parentNode;
    while (up) { if (up === this) return 20; up = up.parentNode; }
    up = this.parentNode;
    while (up) { if (up === other) return 10; up = up.parentNode; }
    return 1;
  });

  // イベントを投げる口。listener の台帳は engine 側が持っているので、
  // ここでは「投げられる」ことだけ保証する (何も起きなくても止まらない)
  addMethod('dispatchEvent', function () { return true; });
  addMethod('click', function () {
    if (typeof this.dispatchEvent === 'function') {
      this.dispatchEvent({ type: 'click', target: this, bubbles: true });
    }
    return undefined;
  });
  if (typeof w.dispatchEvent !== 'function') w.dispatchEvent = function () { return true; };

  if (d && typeof d.createEvent !== 'function') {
    d.createEvent = function (kind) {
      return {
        type: '', bubbles: false, cancelable: false, target: null, kind: kind,
        initEvent: function (t, b, c) { this.type = t; this.bubbles = !!b; this.cancelable = !!c; },
        preventDefault: function () {}, stopPropagation: function () {}
      };
    };
  }

  if (typeof w.getComputedStyle !== 'function') {
    w.getComputedStyle = function (el) {
      var st = el && el.style ? el.style : {};
      if (typeof st.getPropertyValue !== 'function') {
        st.getPropertyValue = function (n) { return this[n] == null ? '' : String(this[n]); };
      }
      return st;
    };
  }
  if (typeof w.scrollTo !== 'function') w.scrollTo = function () {};

  // document.location。Next.js のルータが document.location.hostname を読む。
  // 無いと unhandled promise rejection になって遷移の初期化が止まる
  if (d && d.location == null && w.location) {
    try { d.location = w.location; } catch (e) {
      try { Object.defineProperty(d, 'location', { configurable: true, get: function () { return w.location; } }); }
      catch (e2) { /* 諦める */ }
    }
  }

  // document.title。engine 側が読み取り専用で持っていることがある。
  // Next.js は毎回代入するので、代入できないと head の更新が全部止まる
  if (d) {
    var titleOk = false;
    try { d.title = String(d.title == null ? '' : d.title); titleOk = true; } catch (e) { titleOk = false; }
    if (!titleOk) {
      try {
        var kept = '';
        try { kept = String(d.title == null ? '' : d.title); } catch (e3) { kept = ''; }
        Object.defineProperty(d, 'title', {
          configurable: true,
          get: function () { return kept; },
          set: function (v) {
            kept = String(v == null ? '' : v);
            // <title> 要素があれば中身も合わせる (絵には出ないが、読む側のため)
            try {
              var el = d.querySelector ? d.querySelector('title') : null;
              if (el) el.textContent = kept;
            } catch (e4) { /* 無ければそのまま */ }
          }
        });
      } catch (e5) { /* 定義もできないなら諦める */ }
    }
  }

  // console.error / console.warn を控えておく。
  //
  // React はハイドレーションの不一致を **例外ではなく console.error** で知らせる
  // (onRecoverableError の既定がこれ)。production ビルドだと文言は縮められて
  // いるが、エラー番号の URL が付くので何が起きたかは特定できる。
  // 絵にも JS のエラー一覧にも出ないので、ここで溜めて後から読めるようにする
  w.__consoleErrors = [];
  (function () {
    var base = w.console || {};
    var keep = function (level, orig) {
      return function () {
        try {
          var parts = [];
          for (var i = 0; i < arguments.length; i++) {
            var a = arguments[i];
            if (typeof a === 'string') { parts.push(a); continue; }
            if (a && a.message) {
              // 呼べなかったのが何なのかは stack にしか出ない
              parts.push(String(a.name) + ': ' + String(a.message));
              if (a.stack) {
                // ここは template literal の中。バックスラッシュを書くと
                // 文字列になる前に潰れるので、エスケープを使わない形にする
                var NL = String.fromCharCode(10);
                parts.push('@ ' + String(a.stack).split(NL).slice(0, 4).map(function (l) {
                  return l.trim();
                }).join(' < '));
              }
              continue;
            }
            parts.push(String(a));
          }
          if (w.__consoleErrors.length < 32) w.__consoleErrors.push(level + ': ' + parts.join(' '));
        } catch (e) { /* 控えるだけなので落とさない */ }
        if (typeof orig === 'function') { try { orig.apply(base, arguments); } catch (e) {} }
      };
    };
    if (!base.error || !base.error.__kept) {
      var e2 = keep('error', base.error);
      e2.__kept = true;
      base.error = e2;
    }
    if (!base.warn || !base.warn.__kept) {
      var w2 = keep('warn', base.warn);
      w2.__kept = true;
      base.warn = w2;
    }
    w.console = base;
  })();

  // setImmediate / MessageChannel。
  //
  // React 18 のスケジューラは、仕事をマクロタスクに逃がすときに
  // setImmediate -> MessageChannel -> setTimeout の順で使えるものを探す。
  // vibey-script はこの 2 つを持っていないので setTimeout に落ちるが、
  // V8 経路 (動的 Worker) では両方を塞いである。**同じ顔を与えないと
  // 比べたときに engine の差なのか shim の穴なのか分からない** ので、
  // ここでも setTimeout に寄せて揃える
  if (typeof w.setImmediate !== 'function') {
    w.setImmediate = function (fn) {
      var rest = Array.prototype.slice.call(arguments, 1);
      return w.setTimeout(function () { fn.apply(null, rest); }, 0);
    };
    w.clearImmediate = function (id) { return w.clearTimeout(id); };
  }
  if (typeof w.MessageChannel !== 'function') {
    w.MessageChannel = function MessageChannel() {
      var mk = function () {
        return {
          onmessage: null, start: function () {}, close: function () {},
          addEventListener: function (t, fn) { if (t === 'message') this.onmessage = fn; },
          removeEventListener: function () {}
        };
      };
      var p1 = mk();
      var p2 = mk();
      var send = function (to, data) {
        w.setTimeout(function () {
          if (typeof to.onmessage === 'function') to.onmessage({ data: data, target: to });
        }, 0);
      };
      p1.postMessage = function (d) { send(p2, d); };
      p2.postMessage = function (d) { send(p1, d); };
      return { port1: p1, port2: p2 };
    };
  }

  // localStorage / sessionStorage: メモリの中だけ。描画のあいだしか生きない
  function makeStorage() {
    var map = {};
    return {
      getItem: function (k) { return Object.prototype.hasOwnProperty.call(map, String(k)) ? map[String(k)] : null; },
      setItem: function (k, v) { map[String(k)] = String(v); },
      removeItem: function (k) { delete map[String(k)]; },
      clear: function () { map = {}; },
      key: function (i) { var ks = Object.keys(map); return i < ks.length ? ks[i] : null; },
      get length() { return Object.keys(map).length; }
    };
  }
  if (!w.localStorage) { w.localStorage = makeStorage(); }
  if (!w.sessionStorage) { w.sessionStorage = makeStorage(); }

  // URLSearchParams
  if (typeof w.URLSearchParams !== 'function') {
    var decode = function (s) {
      try { return decodeURIComponent(String(s).replace(/\\+/g, ' ')); } catch (e) { return String(s); }
    };
    var encode = function (s) { return encodeURIComponent(String(s)).replace(/%20/g, '+'); };
    var USP = function (init) {
      this._p = [];
      if (init == null) { return; }
      if (typeof init === 'string') {
        var q = init.charAt(0) === '?' ? init.slice(1) : init;
        if (q) {
          var parts = q.split('&');
          for (var i = 0; i < parts.length; i++) {
            if (!parts[i]) { continue; }
            var eq = parts[i].indexOf('=');
            if (eq < 0) { this._p.push([decode(parts[i]), '']); }
            else { this._p.push([decode(parts[i].slice(0, eq)), decode(parts[i].slice(eq + 1))]); }
          }
        }
      } else if (init instanceof USP) {
        for (var j = 0; j < init._p.length; j++) { this._p.push([init._p[j][0], init._p[j][1]]); }
      } else if (typeof init === 'object') {
        var keys = Object.keys(init);
        for (var k = 0; k < keys.length; k++) { this._p.push([keys[k], String(init[keys[k]])]); }
      }
    };
    USP.prototype.append = function (k, v) { this._p.push([String(k), String(v)]); };
    USP.prototype.get = function (k) {
      k = String(k);
      for (var i = 0; i < this._p.length; i++) { if (this._p[i][0] === k) { return this._p[i][1]; } }
      return null;
    };
    USP.prototype.getAll = function (k) {
      k = String(k); var out = [];
      for (var i = 0; i < this._p.length; i++) { if (this._p[i][0] === k) { out.push(this._p[i][1]); } }
      return out;
    };
    USP.prototype.has = function (k) { return this.get(k) !== null; };
    USP.prototype.set = function (k, v) {
      k = String(k); v = String(v);
      var found = false; var out = [];
      for (var i = 0; i < this._p.length; i++) {
        if (this._p[i][0] !== k) { out.push(this._p[i]); }
        else if (!found) { out.push([k, v]); found = true; }
      }
      if (!found) { out.push([k, v]); }
      this._p = out;
    };
    USP.prototype['delete'] = function (k) {
      k = String(k); var out = [];
      for (var i = 0; i < this._p.length; i++) { if (this._p[i][0] !== k) { out.push(this._p[i]); } }
      this._p = out;
    };
    USP.prototype.forEach = function (fn, thisArg) {
      for (var i = 0; i < this._p.length; i++) { fn.call(thisArg, this._p[i][1], this._p[i][0], this); }
    };
    USP.prototype.keys = function () { return this._p.map(function (e) { return e[0]; })[Symbol.iterator](); };
    USP.prototype.values = function () { return this._p.map(function (e) { return e[1]; })[Symbol.iterator](); };
    USP.prototype.entries = function () { return this._p.map(function (e) { return [e[0], e[1]]; })[Symbol.iterator](); };
    USP.prototype[Symbol.iterator] = USP.prototype.entries;
    USP.prototype.toString = function () {
      var out = [];
      for (var i = 0; i < this._p.length; i++) { out.push(encode(this._p[i][0]) + '=' + encode(this._p[i][1])); }
      return out.join('&');
    };
    USP.prototype.sort = function () { this._p.sort(function (a, b) { return a[0] < b[0] ? -1 : (a[0] > b[0] ? 1 : 0); }); };
    w.URLSearchParams = USP;
  }

  // matchMedia: 幅の条件だけは viewport から答える。それ以外は false。
  // Stylo は同じクエリを CSS 側で正しく解いているので、ここは JS から
  // 問い合わせたときの答えだけの話
  if (typeof w.matchMedia !== 'function') {
    var viewportWidth = function () {
      if (typeof w.innerWidth === 'number' && w.innerWidth > 0) { return w.innerWidth; }
      if (d && d.documentElement && d.documentElement.clientWidth) { return d.documentElement.clientWidth; }
      return 1280;
    };
    w.matchMedia = function (query) {
      var q = String(query);
      var matches = false;
      var min = q.match(/min-width\\s*:\\s*(\\d+(?:\\.\\d+)?)px/);
      var max = q.match(/max-width\\s*:\\s*(\\d+(?:\\.\\d+)?)px/);
      if (min || max) {
        matches = true;
        if (min && viewportWidth() < parseFloat(min[1])) { matches = false; }
        if (max && viewportWidth() > parseFloat(max[1])) { matches = false; }
      } else if (/prefers-color-scheme\\s*:\\s*light/.test(q)) {
        matches = true;   // 描くのは常にライト
      } else if (/prefers-reduced-motion\\s*:\\s*reduce/.test(q)) {
        matches = true;   // アニメーションは描かないので
      } else if (/^\\s*(all|screen)\\s*$/.test(q)) {
        matches = true;
      }
      return {
        matches: matches, media: q, onchange: null,
        addEventListener: function () {}, removeEventListener: function () {},
        addListener: function () {}, removeListener: function () {},
        dispatchEvent: function () { return false; }
      };
    };
  }

  // 3 つの Observer: 呼べるだけ。1 枚の絵を描くのに変化の通知は要らない
  function makeObserver(extra) {
    var O = function (cb) { this._cb = cb; };
    O.prototype.observe = function () {};
    O.prototype.unobserve = function () {};
    O.prototype.disconnect = function () {};
    O.prototype.takeRecords = function () { return []; };
    if (extra) { extra(O); }
    return O;
  }
  if (typeof w.MutationObserver !== 'function') { w.MutationObserver = makeObserver(); }
  if (typeof w.ResizeObserver !== 'function') { w.ResizeObserver = makeObserver(); }
  if (typeof w.IntersectionObserver !== 'function') {
    w.IntersectionObserver = makeObserver(function (O) {
      // 「画面の中に入っているか」を見るコードは、入っている前提で動かす方が絵になる
      O.prototype.root = null; O.prototype.rootMargin = '0px'; O.prototype.thresholds = [0];
    });
  }

  // fetch: engine はページからの取得を持っていない。
  // 呼べるようにはしておくが、必ず失敗する。ページ側の catch に落ちてほしいので
  if (typeof w.fetch !== 'function') {
    w.fetch = function () {
      return Promise.reject(new TypeError('fetch is not available in this renderer'));
    };
  }
})();`;

/**
 * ページの HTML の先頭に shim を差し込む。
 *
 * `<head>` の直後に入れる。無ければ `<html>` の直後、それも無ければ先頭。
 * ページ自身の `<script>` より前に来ることが条件
 */
export function injectPolyfill(html) {
  const tag = `<script>${POLYFILL}</script>`;
  const head = /<head[^>]*>/i.exec(html);
  if (head) return html.slice(0, head.index + head[0].length) + tag + html.slice(head.index + head[0].length);
  const htmlTag = /<html[^>]*>/i.exec(html);
  if (htmlTag) return html.slice(0, htmlTag.index + htmlTag[0].length) + tag + html.slice(htmlTag.index + htmlTag[0].length);
  return tag + html;
}
