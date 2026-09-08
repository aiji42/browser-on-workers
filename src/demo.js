// デモのページ。
//
// このブラウザは自分自身を描ける (Worker は自分の workers.dev を fetch できないので、
// HTML を直接エンジンに渡す経路を使う)。ページの JavaScript も Boa で実行するので、
// Chrome で見たときと、このブラウザで描いたときの絵が一致する。

const CSS = `
:root{
  --ink:#111; --muted:#666; --line:#e5e5e5; --paper:#fafafa;
  --accent:#0b5cd6; --orange:#f38020; --ok:#0a7a2f;
}
*{box-sizing:border-box}
body{
  margin:0; padding:0 20px 90px;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;
  color:var(--ink); line-height:1.75; background:#fff;
}
.wrap{max-width:940px; margin:0 auto}
header{padding:56px 0 26px}
h1{margin:0 0 12px; font-size:32px; line-height:1.28; letter-spacing:-.015em}
h1 span{color:var(--accent)}
.lede{margin:0; font-size:16px; color:#444; max-width:64ch}
.tag{
  display:inline-block; margin-bottom:20px; padding:4px 10px;
  font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:11px;
  letter-spacing:.1em; color:#fff; background:var(--ink);
}
h2{
  margin:54px 0 8px; font-size:19px; letter-spacing:-.01em; color:var(--ink);
  border-top:1px solid var(--line); padding-top:22px;
}
h2 + p{margin-top:10px}
p{margin:0 0 14px}
code{
  font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:.88em;
  background:#eef3fb; color:#0a4aa8; padding:.1em .35em;
}
a{color:var(--accent)}

/* 描いた画像の枠。ここが「疑似 Kitesurf の出力」だと一目で分かるようにする */
.shot{margin:0 0 26px; border:1px solid var(--ink)}
.shot .bar{
  display:flex; align-items:center; gap:9px; flex-wrap:wrap;
  background:var(--ink); color:#fff; padding:8px 12px;
  font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:11.5px; letter-spacing:.04em;
}
.shot .bar b{color:#7fb2ff; font-weight:400}
.shot .bar .sp{margin-left:auto; color:#9a9a9a}
.shot .dot{
  width:8px; height:8px; border-radius:50%; background:#33d17a; flex:none;
}
.shot .body{background:var(--paper); padding:10px}
.shot img{display:block; width:100%; height:auto; border:1px solid var(--line); background:#fff}
.shot figcaption{
  border-top:1px solid var(--line); padding:9px 12px; font-size:12.5px; color:var(--muted);
}
.shot figcaption b{color:var(--ink); font-weight:600}

/* 自分で試す欄 */
form{
  display:flex; flex-wrap:wrap; gap:8px; align-items:center;
  border:1px solid var(--line); background:var(--paper); padding:14px;
}
input[type=url]{
  flex:1 1 380px; padding:10px 11px; font-size:14px;
  border:1px solid #ccc; background:#fff; color:var(--ink);
}
input[type=number]{width:84px; padding:10px 11px; font-size:14px; border:1px solid #ccc}
button{
  padding:10px 22px; font-size:14px; font-weight:700; color:#fff;
  background:var(--accent); border:0; cursor:pointer;
}
button[disabled]{background:#9bb8e4; cursor:default}
.hint{font-size:12.5px; color:var(--muted); margin:8px 0 0}
#out{margin-top:18px}
#out .msg{
  font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12.5px;
  color:var(--muted); border-left:3px solid var(--orange); padding:4px 0 4px 12px;
}
table{border-collapse:collapse; width:100%; font-size:14px; margin:0 0 14px}
th,td{text-align:left; padding:9px 12px; border-bottom:1px solid var(--line); vertical-align:top}
thead th{
  background:var(--ink); color:#fff; border-bottom:none;
  font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:11px; letter-spacing:.08em;
}
td:first-child{white-space:nowrap; color:var(--muted)}
ul{margin:0 0 14px; padding-left:22px}
li{margin:0 0 5px}
footer{margin-top:60px; padding-top:18px; border-top:1px solid var(--line); font-size:13px; color:var(--muted)}
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

/**
 * トップページが貼っている、外のサイトの絵。
 *
 * この一覧に載っている URL と大きさだけが緩いレートリミットを使える。`demo=1` を
 * 付けるだけで緩くなると、その口から好きな URL を撮られてしまう。
 *
 * [URL, 幅, 高さ, 見出し, 説明]
 */
export const DEMO_SHOTS = [
  [
    'https://ja.wikipedia.org/wiki/メインページ', 1000, 780,
    'ja.wikipedia.org',
    '日本語の見出しと本文、2 カラム、写真 24 枚。CSS は 3 枚で 231 KB',
  ],
  [
    'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/map', 1000, 780,
    'developer.mozilla.org',
    'CSS 20 枚。本文中の <code>map()</code> が等幅で出ている。JS は 938 KB 実行してエラー 0 件',
  ],
  [
    'https://react.dev/', 1000, 780,
    'react.dev',
    'ページの JS を動かすと React のハイドレーションが本文を消すので、JS を切って描き直したもの',
  ],
];

/** デモのトップページ。origin は自分の URL (自己参照の画像に使う) */
export function demoHtml(origin) {
  const shotUrl = (url, w, h) =>
    `${origin}/shot?demo=1&w=${w}&h=${h}&url=${encodeURIComponent(url)}`;

  const shot = ([url, w, h, title, note]) => `<figure class="shot">
  <div class="bar"><span class="dot"></span>この画像は <b>Chromium を使わずに</b>描いています<span class="sp">${w}×${h}</span></div>
  <div class="body"><img src="${shotUrl(url, w, h)}" width="${w}" height="${h}" alt="${title} を描いた画像"></div>
  <figcaption><b>${title}</b> — ${note}<br><a href="${url}">${url}</a></figcaption>
</figure>`;

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
  <p class="lede">Rust で書いたブラウザエンジンを Wasm にして、Cloudflare Workers の isolate の中で動かしています。ブラウザのバイナリはどこにもありません。以下の画像は全部、この Worker が描いたものです。</p>
</header>

<h2>実際のサイトを描く</h2>
${DEMO_SHOTS.map(shot).join('\n')}

<h2>自分で試す</h2>
<p>好きな URL を入れてください。この場に画像が出ます。</p>
<form id="f">
  <input type="url" id="u" value="https://example.com/" placeholder="https://..." required>
  <input type="number" id="w" value="1000" min="64" max="2000" aria-label="幅">
  <input type="number" id="h" value="800" min="64" max="4000" aria-label="高さ">
  <button type="submit" id="go">撮る</button>
</form>
<p class="hint">外部 CSS と画像は Worker が取ってきてエンジンに渡します。重いページは 10 秒ほどかかります。10 秒で 4 枚までにしています。</p>
<div id="out"></div>

<h2>JavaScript も動く</h2>
<p>ページの <code>&lt;script&gt;</code> を <a href="https://boajs.dev">Boa</a> (Rust で書かれた JavaScript エンジン) で実行しています。Workers は <code>eval</code> と <code>new Function</code> を禁じていますが、Boa が自分でコンパイルするので、<strong>ページの中の <code>eval</code> は通ります</strong>。</p>

<figure class="shot">
  <div class="bar"><span class="dot"></span>この画像は <b>Chromium を使わずに</b>描いています<span class="sp">760×560</span></div>
  <div class="body"><img src="${origin}/js.png" width="760" height="560" alt="JavaScript が DOM を書き換えたことを示すページを描いた画像"></div>
  <figcaption><b>緑の枠はページの JavaScript が書いたもの</b> — 最後の枠だけは <code>while (true)</code> が実行上限に当たって書き換わりません。それより前に書いた 5 つは残ります<br><a href="/js">同じページを自分のブラウザで開く</a></figcaption>
</figure>

<p>V8 と Boa が同じ isolate に同居する形になります。Worker のコードは V8 で動き、ページのコードは Wasm の中の Boa で動く。Cloudflare の <a href="https://blog.cloudflare.com/kitesurf/">Kitesurf</a> も同じ構造です。</p>

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
    <tr><td>フォント</td><td>Static Assets に置いて起動時に読む</td></tr>
    <tr><td>外向きの取得</td><td>Worker の <code>fetch()</code> 1 箇所だけ</td></tr>
  </tbody>
</table>
<p>Rust を <code>wasm32-unknown-unknown</code> にビルドして Worker から呼んでいます。Wasm は 15 MB ほど。</p>

<h2>できないこと</h2>
<ul>
  <li>フォントに入れた文字しか出ません。いまは Latin と、ひらがな・カタカナ・漢字</li>
  <li>ページの JavaScript には実行上限があります。<code>while (true)</code> は 27 ms ほどで止まります</li>
  <li>展開すると大きすぎる画像は飛ばします。1 枚で 87 MB になる画像があり、isolate のメモリに載りません</li>
  <li>動くもの (アニメーション、動画、WebGL) は扱いません</li>
  <li>レイアウトが返ってこないページがまだあります</li>
</ul>

<footer>
  Rust で書いたブラウザエンジンを Wasm にして Cloudflare Workers の V8 isolate で動かす、という Cloudflare の Kitesurf を見て、同じ構成を公開情報だけから組んでみたものです。
</footer>

</div>
<script>
// 自分で試す欄。この場に画像を出す。
// このページを自分自身で描くこともあるので、失敗しても本文が壊れないようにしておく
try {
  var f = document.getElementById('f');
  var out = document.getElementById('out');
  var go = document.getElementById('go');
  f.addEventListener('submit', function (e) {
    e.preventDefault();
    var url = document.getElementById('u').value;
    var w = document.getElementById('w').value || 1000;
    var h = document.getElementById('h').value || 800;
    go.disabled = true;
    out.innerHTML = '<p class="msg">' + url + ' を描いています…</p>';
    var src = '/shot?w=' + w + '&h=' + h + '&url=' + encodeURIComponent(url) + '&cb=' + Date.now();
    var t0 = Date.now();
    fetch(src).then(function (res) {
      var ms = Date.now() - t0;
      if (!res.ok) {
        return res.text().then(function (body) {
          out.innerHTML = '<p class="msg">' + res.status + ' で描けませんでした。<br>'
            + body.slice(0, 400).replace(/[<&]/g, '') + '</p>';
        });
      }
      var timing = {};
      try { timing = JSON.parse(res.headers.get('x-timing') || '{}'); } catch (err) {}
      return res.blob().then(function (blob) {
        var img = URL.createObjectURL(blob);
        var meta = [
          'CSS ' + ((timing.css || {}).fetched || 0) + ' 枚',
          '画像 ' + ((timing.img || {}).fetched || 0) + ' 枚',
          (timing.passes || 1) + ' パス',
          Math.round(ms / 100) / 10 + ' 秒',
        ];
        if (timing.usedNoJs) meta.push('JS を切って描き直した');
        else if (timing.jsErrors) meta.push('JS のエラー ' + timing.jsErrors + ' 件');
        out.innerHTML = '<figure class="shot">'
          + '<div class="bar"><span class="dot"></span>この画像は <b>Chromium を使わずに</b>描いています'
          + '<span class="sp">' + w + '×' + h + '</span></div>'
          + '<div class="body"><img src="' + img + '" alt="' + url + ' を描いた画像"></div>'
          + '<figcaption><b>' + meta.join(' · ') + '</b><br>' + url.replace(/[<&]/g, '') + '</figcaption>'
          + '</figure>';
      });
    }).catch(function (err) {
      out.innerHTML = '<p class="msg">失敗しました: ' + String(err && err.message) + '</p>';
    }).then(function () { go.disabled = false; });
  });
} catch (err) { /* エンジン側に addEventListener が無くても本文は出る */ }
</script>
</body></html>`;
}
