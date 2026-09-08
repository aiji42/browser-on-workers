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
