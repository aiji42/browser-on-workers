// デモのページ。
//
// このブラウザは自分自身を描ける (Worker は自分の workers.dev を fetch できないので、
// HTML を直接エンジンに渡す経路を使う)。ページの JavaScript も Boa で実行するので、
// Chrome で見たときと、このブラウザで描いたときの絵が一致する。

const CSS = `
:root{
  --ink:#111; --muted:#666; --line:#e5e5e5; --paper:#fafafa;
  --accent:#0b5cd6; --orange:#f38020;
}
*{box-sizing:border-box}
body{
  margin:0; padding:0 20px 80px;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;
  color:var(--ink); line-height:1.75; background:#fff;
}
.wrap{max-width:900px; margin:0 auto}
header{padding:56px 0 28px; border-bottom:1px solid var(--line)}
h1{margin:0 0 10px; font-size:30px; line-height:1.3; letter-spacing:-.01em}
h1 span{color:var(--accent)}
.lede{margin:0; font-size:16px; color:var(--muted)}
.tag{
  display:inline-block; margin-bottom:18px; padding:3px 9px;
  font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:11px;
  letter-spacing:.08em; color:#fff; background:var(--ink);
}
h2{margin:44px 0 12px; font-size:19px; letter-spacing:-.01em}
p{margin:0 0 14px}
code{
  font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:.88em;
  background:#eef3fb; color:#0a4aa8; padding:.1em .35em;
}
figure{margin:0 0 8px; border:1px solid var(--line); background:var(--paper); padding:10px}
figure img{display:block; width:100%; height:auto; border:1px solid var(--line); background:#fff}
figcaption{
  margin-top:8px; font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
  font-size:11px; color:var(--muted); letter-spacing:.03em;
}
.grid{display:flex; flex-wrap:wrap; gap:14px}
.grid figure{flex:1 1 400px; margin:0}
table{border-collapse:collapse; width:100%; font-size:14px; margin:0 0 14px}
th,td{text-align:left; padding:9px 12px; border-bottom:1px solid var(--line); vertical-align:top}
thead th{
  background:var(--ink); color:#fff; border-bottom:none;
  font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:11px; letter-spacing:.08em;
}
td:first-child{white-space:nowrap; color:var(--muted)}
form{
  display:flex; flex-wrap:wrap; gap:8px; align-items:center;
  border:1px solid var(--line); background:var(--paper); padding:14px;
}
input[type=url]{
  flex:1 1 380px; padding:9px 11px; font-size:14px;
  border:1px solid #ccc; background:#fff; color:var(--ink);
}
input[type=number]{width:82px; padding:9px 11px; font-size:14px; border:1px solid #ccc}
button{
  padding:9px 20px; font-size:14px; font-weight:700; color:#fff;
  background:var(--accent); border:0; cursor:pointer;
}
.note{
  border-left:3px solid var(--orange); padding:2px 0 2px 14px;
  color:var(--muted); font-size:14px; margin:0 0 14px;
}
ul{margin:0 0 14px; padding-left:22px}
li{margin:0 0 5px}
a{color:var(--accent)}
footer{margin-top:56px; padding-top:18px; border-top:1px solid var(--line); font-size:13px; color:var(--muted)}
`;

/** X などに貼ったときの見せ札。外部資源を持たないので単体で描ける */
export function cardHtml() {
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>browser-on-workers</title>
<style>
body{margin:0;width:1200px;height:630px;display:flex;background:#fff;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif}
.left{flex:1;padding:64px 56px;display:flex;flex-direction:column;justify-content:center}
.badge{display:inline-block;align-self:flex-start;padding:5px 12px;background:#111;color:#fff;
  font-family:ui-monospace,Menlo,monospace;font-size:14px;letter-spacing:.1em;margin-bottom:26px}
h1{margin:0 0 18px;font-size:52px;line-height:1.15;letter-spacing:-.02em;color:#111}
h1 em{font-style:normal;color:#0b5cd6}
p{margin:0;font-size:21px;line-height:1.6;color:#555}
.right{width:330px;background:#fafafa;border-left:1px solid #e5e5e5;padding:48px 34px;
  display:flex;flex-direction:column;justify-content:center}
.right div{font-size:17px;color:#333;padding:9px 0;border-bottom:1px solid #ebebeb}
.right div:last-child{border-bottom:0}
.right b{color:#0b5cd6}
</style></head><body>
<div class="left">
  <span class="badge">CLOUDFLARE WORKERS</span>
  <h1>Chromium なしで<br><em>スクリーンショット</em>を撮る</h1>
  <p>HTML のパースから JavaScript の実行まで、<br>すべて Worker の isolate の中。</p>
</div>
<div class="right">
  <div>HTML <b>html5ever</b></div>
  <div>CSS <b>Stylo</b></div>
  <div>Layout <b>Taffy</b></div>
  <div>Text <b>Parley</b></div>
  <div>Paint <b>blitz-paint</b></div>
  <div>JS <b>Boa</b></div>
  <div>Target <b>wasm32</b></div>
</div>
</body></html>`;
}

/**
 * JavaScript が動いていることを見せるページ。
 *
 * 枠が緑になっているところは、すべてページの `<script>` が書いたもの。
 * Chrome で開いたときと、このブラウザが描いた絵 (/js.png) で、書き換わった
 * 中身が一致する (書体は違う。こちらは持ち込んだ Noto Sans JP と IBM Plex Mono)。
 */
export function jsDemoHtml() {
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8">
<title>JavaScript は動く — browser-on-workers</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
body{margin:0;padding:26px;background:#fff;color:#111;line-height:1.6;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif}
h1{margin:0 0 6px;font-size:24px;letter-spacing:-.01em}
.lede{margin:0 0 20px;font-size:14px;color:#666}
.box{padding:12px 14px;border:2px solid #d5d5d5;background:#f7f7f7;margin:0 0 9px;font-size:17px}
.box.ok{border-color:#0a7a2f;background:#eaf7ec}
.box b{color:#0b5cd6}
.box code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.85em;
  background:#e7eef9;color:#0a4aa8;padding:.1em .3em}
.lbl{display:inline-block;min-width:118px;font-family:ui-monospace,Menlo,monospace;
  font-size:11px;letter-spacing:.06em;color:#666;vertical-align:1px}
.foot{margin:14px 0 0;font-size:13px;color:#666;line-height:1.65}
.foot code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.9em;
  background:#f0f0f0;padding:.1em .3em}
</style></head><body>
<h1>JavaScript は動く</h1>
<p class="lede">緑になっている枠は、すべてこのページの <code>&lt;script&gt;</code> が書き換えたものです。</p>

<div class="box" id="dom"><span class="lbl">DOM</span>書き換え前</div>
<div class="box" id="calc"><span class="lbl">計算</span>実行前</div>
<div class="box" id="ev"><span class="lbl">eval</span>実行前</div>
<div class="box" id="timer"><span class="lbl">setTimeout</span>実行前</div>
<div class="box" id="layout"><span class="lbl">レイアウト参照</span>実行前</div>
<div class="box" id="guard"><span class="lbl">暴走の停止</span>この枠だけ緑になりません</div>
<p class="foot">最後に <code>while (true) {}</code> を回しています。実行上限に当たると
JavaScript がそこで止まるので、この枠は書き換わりません。上の 5 つは、止まる前に
書かれたものです。</p>

<script>
  function fill(id, html) {
    var e = document.getElementById(id);
    e.innerHTML = '<span class="lbl">' + e.querySelector('.lbl').textContent + '</span>' + html;
    e.className = 'box ok';
  }
  fill('dom', 'この文は <b>Boa</b> が書きました');
  fill('calc', '2 + 2 = <b>' + (2 + 2) + '</b>');
  // Workers は eval を禁じているが、Boa が自分でコンパイルするので通る
  fill('ev', '<code>eval("6*7")</code> = <b>' + eval('6*7') + '</b>');
  setTimeout(function () { fill('timer', 'タイマーも走りました'); }, 10);
  // レイアウトが付いた状態でスクリプトを走らせているので、寸法が読める
  fill('layout', 'body の幅は <b>' + document.body.offsetWidth + '</b> px');
  // 無限ループは実行上限で止まる。Boa の RuntimeLimitError はページ側の
  // catch には来ないので、スクリプトはここで終わる。
  // 止まるまでに触った DOM はそのまま描かれる (上の 5 つが緑のまま残る)
  var n = 0;
  while (true) { n++; }
  // ここには来ない
</script>
</body></html>`;
}

/** デモのトップページ。origin は自分の URL (自己参照の画像に使う) */
export function demoHtml(origin) {
  const shot = (url, w, h) =>
    `${origin}/shot?w=${w}&h=${h}&url=${encodeURIComponent(url)}`;

  return `<!doctype html><html lang="ja"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>browser-on-workers — Chromium なしでスクリーンショットを撮る</title>
<meta name="description" content="HTML のパースから JavaScript の実行まで、すべて Cloudflare Workers の isolate の中で動く小さなブラウザ。">
<meta property="og:title" content="Chromium なしでスクリーンショットを撮る">
<meta property="og:description" content="HTML のパースから JavaScript の実行まで、すべて Cloudflare Workers の isolate の中。Stylo・Parley・blitz-paint・Boa を wasm32 に載せた。">
<meta property="og:image" content="${origin}/card.png">
<meta name="twitter:card" content="summary_large_image">
<style>${CSS}</style>
</head><body><div class="wrap">

<header>
  <span class="tag">CLOUDFLARE WORKERS</span>
  <h1>Chromium なしで、<span>スクリーンショット</span>を撮る</h1>
  <p class="lede">HTML のパースから JavaScript の実行まで、すべて Worker の isolate の中で動いています。</p>
</header>

<h2>このブラウザが描いた絵</h2>
<p>下の画像は、いまこのページを配信している Worker が、その中の Wasm で描いたものです。Chromium のバイナリはどこにもありません。</p>

<figure>
  <img src="${origin}/card.png" width="1200" height="630"
       alt="browser-on-workers の見せ札を、このブラウザ自身が描いた画像">
  <figcaption>この PNG は、このページを配信している Worker が Wasm で描いたもの</figcaption>
</figure>

<h2>JavaScript も動く</h2>
<p>ページの <code>&lt;script&gt;</code> を <a href="https://boajs.dev">Boa</a> (Rust で書かれた JavaScript エンジン) で実行しています。Workers は <code>eval</code> と <code>new Function</code> を禁じていますが、Boa が自分でコンパイルするので、<strong>ページの中の <code>eval</code> は通ります</strong>。</p>

<figure>
  <img src="${origin}/js.png" width="760" height="560"
       alt="JavaScript が DOM を書き換えたことを示すページを、このブラウザ自身が描いた画像">
  <figcaption>緑の枠はページの JavaScript が書いたもの。<a href="/js">同じページを自分のブラウザで開く</a>と、書き換わった中身が一致します (書体は違います)</figcaption>
</figure>

<p class="note">V8 と Boa が同じ isolate に同居する形になります。Worker のコードは V8 で動き、ページのコードは Wasm の中の Boa で動く。Kitesurf も同じ構造です。</p>

<h2>実際のサイトを描く</h2>
<div class="grid">
  <figure>
    <img src="${shot('https://ja.wikipedia.org/wiki/メインページ', 900, 700)}" width="900" height="700"
         alt="日本語版 Wikipedia のメインページを描いた画像">
    <figcaption>ja.wikipedia.org — 日本語、2 カラム、写真</figcaption>
  </figure>
  <figure>
    <img src="${shot('https://developer.mozilla.org/en-US/', 900, 700)}" width="900" height="700"
         alt="MDN のトップページを描いた画像">
    <figcaption>developer.mozilla.org — CSS 20 枚</figcaption>
  </figure>
</div>

<h2>自分で試す</h2>
<form action="/shot" method="get">
  <input type="url" name="url" value="https://example.com/" placeholder="https://..." required>
  <input type="number" name="w" value="1000" min="64" max="2000" aria-label="幅">
  <input type="number" name="h" value="800" min="64" max="4000" aria-label="高さ">
  <button type="submit">撮る</button>
</form>
<p class="note">外部 CSS と画像は Worker が取ってきてエンジンに渡します。取得に数秒かかることがあります。</p>

<h2>中身</h2>
<table>
  <thead><tr><th>役割</th><th>使っているもの</th></tr></thead>
  <tbody>
    <tr><td>HTML のパース</td><td>html5ever</td></tr>
    <tr><td>DOM</td><td>blitz-dom</td></tr>
    <tr><td>CSS</td><td>Stylo — Firefox の CSS エンジン</td></tr>
    <tr><td>レイアウト</td><td>Taffy</td></tr>
    <tr><td>テキスト整形</td><td>Parley</td></tr>
    <tr><td>描画</td><td>blitz-paint + vello_cpu</td></tr>
    <tr><td>JavaScript</td><td>Boa (blitz-vibey-script 経由)</td></tr>
    <tr><td>PNG 化</td><td>自前。Workers に画像の API が無いので</td></tr>
    <tr><td>外向きの取得</td><td>Worker の <code>fetch()</code> 1 箇所だけ</td></tr>
  </tbody>
</table>
<p>Rust を <code>wasm32-unknown-unknown</code> にビルドして Worker から呼んでいます。Wasm は 15 MB ほど。フォントは Static Assets に置いて、起動時に読んでいます。</p>

<h2>できないこと</h2>
<p>スクリーンショットを撮るところまでを目標にしているので、実用のブラウザではありません。</p>
<ul>
  <li>フォントに入れた文字しか出ません。いまは Latin と、ひらがな・カタカナ・漢字</li>
  <li>動くもの (アニメーション、動画、WebGL) は扱いません</li>
  <li>ページの JavaScript には実行上限があります。<code>while (true)</code> は 27 ms ほどで止まります (止まるまでに書き換えた DOM はそのまま描かれます)</li>
  <li>レイアウトが返ってこないページがまだあります</li>
</ul>

<footer>
  Rust で書いたブラウザエンジンを Wasm にして Cloudflare Workers の V8 isolate で動かす、という Cloudflare の Kitesurf を見て、同じ構成を公開情報だけから組んでみたものです。
</footer>

</div></body></html>`;
}
