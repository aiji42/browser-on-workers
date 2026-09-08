# 作りながら踏んだこと

Kitesurf が公開情報で挙げている構成を、そのまま Cloudflare Workers に載せる過程の記録。
うまくいったことと、詰まったことの両方を書く。

## 確かめた環境 (Workers の isolate の中)

自分で Worker を 1 つ立てて、中から確認した結果。

| 調べたこと | 結果 |
| --- | --- |
| `CompressionStream('deflate')` | ある。zlib 形式を吐くので PNG の IDAT にそのまま使える |
| `WebAssembly` | ある |
| `.ttf` を Data モジュールとして `import` | できる (`wrangler.jsonc` の `rules` に `type: "Data"` を書く) |
| `eval('1+1')` | **できない**。`Code generation from strings disallowed for this context` |
| `performance.memory` | **無い** (`undefined`) |
| システムフォント | **無い**。フォントは自分で持ち込むしかない |

`eval` が禁じられているのは、Kitesurf が Boa を Wasm で持ち込んでいる理由そのもの。
自分の Worker で同じエラーを踏んで、はじめて納得がいった。

## Stylo は wasm32-unknown-unknown に、何の対応もなしに載る

一番の懸念だった。Servo のスタイルシステムは並列トラバースに rayon を使うので、
スレッドの無い wasm では動かないと踏んでいた。

**そのままビルドできる。設定も要らなかった。**

最初は `StyleThreading::Sequential` を明示的に指定して「これが必要だった」と
書いたが、blitz-dom のこの enum は `#[default]` が `Sequential` で、
`DocumentConfig::default()` が最初からそうなっている。書いた 1 行は何もしていない。

```rust
pub enum StyleThreading {
    Parallel,
    #[default]
    Sequential,   // これが既定
}
```

つまり Blitz の作者が単一スレッド動作を想定済みの構成にしている。
CSS のパースとカスケードは OS に依存しない純粋な計算なので、載らない理由の方が無い。
「無理そうなものが通った」という話ではなかった。

`html5ever` / `blitz-dom` / `blitz-html` / `Stylo` / `Taffy` / `usvg` が
同じターゲットで通る。`doc.resolve(0.0)` (スタイル解決 + レイアウト) まで含めて
**434 KB、gzip 後 0.1 MB**。

## フォントは持ち込むしかない

Workers にはフォントが 1 つも無い。字を出すにはフォントファイルを持ち込む。

**woff2 は JS 側ではほどけない。** Brotli で圧縮されていて、Workers の
`DecompressionStream` は gzip と deflate しか扱えない。なので埋め込むフォントは
TrueType のまま置く。

ただし **Rust 側なら woff2 をほどける。** blitz-dom の `woff` feature が既定で入っていて、
`wuff` が Brotli を扱う。`@font-face { src: url(...woff2) }` を資源の表から返すと、
`add_font` を 1 本も呼んでいなくても文字が描かれた。つまりページ自身の web font を
使わせることもできる。埋め込みフォントが要るのは、web font を持たないページのため。

全部入れると重いので、`scripts/build-fonts.mjs` で Latin と記号だけに絞る。
リポジトリに既にある `subset-font` に `targetFormat: 'truetype'` を渡すと
woff2 から TTF を作れる。1 ウェイト 20 KB ほどに収まった。

日本語はひらがな・カタカナ・CJK 統合漢字を入れて 2.14 MiB。グリフ数にそのまま比例する。

### 置き場所は Static Assets

フォントは Wasm にも JS のバンドルにも埋め込まず、`public/fonts/` に置いて
Static Assets として配り、実行時に `env.ASSETS.fetch()` で読んでいる。Kitesurf も
PageRenderer が「Static Assets からフォントと画像を取る」と書いている。

スクリプトサイズの上限 (Free 3 MB / Paid 10 MB。2026-09-04 以降は非圧縮 64 MiB)
に効かなくなるのが理由。日本語 1 ウェイトで 2.2 MB あるので、フォントを埋め込むか
外に出すかで上限までの余裕がかなり変わる。

| | スクリプト (非圧縮) | gzip |
| --- | --- | --- |
| フォント同梱 | 17.14 MiB | 5.87 MiB |
| Static Assets | 14.99 MiB | 4.65 MiB |

(wrangler が出すのは KiB なので 1024 進法。`15351.96 KiB / 1024 = 14.99`)

代わりに cold start で読み込みが要る。`/health` を叩いて測ると、2.14 MiB の
日本語フォントが 9〜15 ms、Latin 2 本が 4〜17 ms。合計 20〜35 ms。

isolate ごとに 1 回のはずだが、**6 回連続で叩いたら 6 回とも boot が走った**
(`fetchMs` が毎回違う)。トラフィックの無い Worker では isolate が再利用されない。

```json
{"initMs":0,"fonts":[
  {"path":"/fonts/sans-regular.ttf","kb":20,"fetchMs":7,"addMs":0},
  {"path":"/fonts/sans-bold.ttf","kb":20,"fetchMs":4,"addMs":0},
  {"path":"/fonts/jp-regular.ttf","kb":2188,"fetchMs":10,"addMs":0}]}
```

`initMs` と `addMs` が 0 なのは速いからではなく、**Workers の `Date.now()` が I/O の
無い区間で進まない**ため。Wasm の instantiate と `add_font` は純粋な計算なので、
その間クロックが固定される。`fetchMs` だけが数字を持つのはそこに I/O があるから。
Kitesurf の中で `Date.now()` が 3 ms 刻みで止まって見えたのと同じ現象。

## PNG は自分で作る

Workers に画像を書き出す API が無いので、PNG エンコーダを書いた (`src/png.js`)。

やることは 3 つ。行ごとにフィルタ種別のバイトを挟む、`CompressionStream('deflate')`
に通す (これが zlib 形式なので PNG がそのまま受け取れる)、IHDR/IDAT/IEND に
CRC32 を付ける。100 行ほど。

## Worker からの取得は、ブラウザからの取得と同じではない

`fetch()` で実ページを取ると、通るサイトと通らないサイトがある。

| URL | 結果 |
| --- | --- |
| `https://example.com/` | 200 / 559 B / 12 ms |
| `https://blog.cloudflare.com/kitesurf/` | 200 / 569 KB / 34 ms |
| `https://news.ycombinator.com/` | **403** |

ブラウザらしい `accept` と `user-agent` を付けても 403 になる。
Worker の出口から出ていることが分かる形になっているため。

Kitesurf の SandboxOutbound も同じ問題を抱えていて、発表記事が
「real TLS fingerprints を伴う bot チャレンジには対応できない」と
限界を認めているのはこのあたり。

## 実ページで落ちたのは、相対 URL の stylesheet

`example.com` は描けるのに `blog.cloudflare.com/kitesurf/` (569 KB) は `unreachable` で落ちた。
サイズもメモリも無関係で、原因は `DocumentConfig.base_url` を渡していなかったこと。

blitz-dom の既定の base URL は `data:text/css;charset=utf-8;base64,` で、これは base になれない。
`<link rel="stylesheet" href="/_astro/Post.css">` のような相対参照を 1 つでも解決しようとすると
`resolve_url` が `panic!` する (`blitz-dom/src/document.rs:1086`)。`example.com` はインライン
`<style>` しか持たないので踏まなかった。

```
panicked at blitz-dom-0.3.0-beta.2/src/document.rs:1086:13:
to be able to resolve /_astro/Post.CLuFloBL.css with the base_url: Url { scheme: "data", cannot_be_a_base: true, ... }
```

native の `cargo test` に同じ HTML を食わせたら 1 回で出た。wasm で追うより先に native で再現するのが早い。
直しはページの URL を `base_url` に渡すだけ。URL が無いインライン HTML には `https://inline.invalid/` を敷く。

| ページ | HTML | wasm での描画 | wasm メモリ |
| --- | --- | --- | --- |
| example.com | 559 B | 52 ms | 4.8 MB |
| aiji42.dev | 16 KB | 77 ms | 6.6 MB |
| developer.mozilla.org | 118 KB | 90 ms | 8.5 MB |
| en.wikipedia.org | 246 KB | 110 ms | 12.2 MB |
| blog.cloudflare.com/kitesurf | 569 KB | 94 ms | 15.5 MB |

800x600、Node 上の wasm での実測。128 MB の上限にはまだ遠い。

## panic のメッセージは hook で控えて、トラップの後に取り出す

wasm32-unknown-unknown は target 自体が unwind 非対応で、`panic = "unwind"` にしても
`catch_unwind` は何も捕まえない。panic は `unreachable` でトラップして
JS には `RuntimeError: unreachable` しか届かない。

abort の前に走る panic hook で `console.error` に流し、static に控えるようにした。
`worker.js` は `RuntimeError` を受けたら `last_panic()` でそれを取り出して返す。
`error` に `panicked at <file>:<line>:<col>:\n<message>` がそのまま入る。

hook の中から `wasm_bindgen::throw_str` で JS の例外を投げると 1 回目はきれいに届くが、
hook から抜けないので std の「panic 処理中」フラグが残り、2 回目以降は hook を通らず
素の `unreachable` に戻ってしまう。wasm-bindgen の glue はインスタンスを 1 つしか持たず
(`init` を呼び直しても同じものが返る)、Workers の isolate はリクエストをまたいで生きるので、
この手は使えない。

## 日本語は、フォントを足すだけでは出ない

`ja.wikipedia.org` を描くと、リンクの下線と入力欄の枠だけが残って文字が全部消えた。
埋め込んでいた `fonts/sans-regular.ttf` が Latin だけのサブセットで、日本語のグリフが無いため。
Parley は「family にその文字が無い」と script 別の fallback を探しに行くが、fallback にも
同じフォントしか載っていないので 0 幅で終わる。エラーは出ない。

そこで `render_png_rgba` からフォント引数を外し、先に `add_font(bytes, family)` を
フォントごとに呼んで wasm 側に登録しておく形にした。登録した family は generic family 13 個と
script fallback 14 個の全部に載せる。

```js
const load = async (path, family) => {
  const res = await env.ASSETS.fetch(new URL(path, request.url));
  add_font(new Uint8Array(await res.arrayBuffer()), family);
};
await load('/fonts/sans-regular.ttf', 'sans');
await load('/fonts/sans-bold.ttf',    'sans'); // 同じ family 名なら weight で解決される
await load('/fonts/jp-regular.ttf',   'jp');
const rgba = render_png_rgba(html, baseUrl, width, height);
```

### 詰まった点: 3 本とも中の名前が同じ

`sans-regular.ttf` / `sans-bold.ttf` / `jp-regular.ttf` は全部 Noto Sans JP から切り出したもので、
name テーブルの family 名が 3 本とも `Noto Sans JP Thin`。fontique の `register_fonts` に
そのまま渡すと **1 つの family に 3 face** として入る。

fontique は family の中から weight で 1 face を選び、Parley はその 1 face の cmap でだけ
文字の有無を見る。weight 400 の face が Latin 用と日本語用の 2 つあると、どちらか片方しか
選ばれず、もう片方の文字は消える。「フォントを 2 本渡したのに片方しか効かない」という
形で出るので、原因に気付きにくい。

`FontInfoOverride { family_name }` でファイルの中の名前を無視し、呼び出し側が付けた名前で
family を作るようにした。だから `add_font` は family 名を取る。**別の文字集合のフォントは
必ず別の family 名にする** (同じ名前にしていいのは regular と bold のような weight 違いだけ)。

### サブセットに入っていない文字がある

`Rust → wasm32` の矢印が消えた。`→` (U+2192) は **latin にも japanese にも入っていない**。
fontsource のサブセットは 1 文字ずつ 120 個ほどのファイルに散らばっていて、
`→` は `noto-sans-jp-89-400-normal.woff2` のような番号付きのファイルの中にいる。

```
$ node -e '... cmap を読む ...'
sans-regular   →× ←× ✓× ※× あ× 日× A○
jp-regular     →× ←× ✓× ※× あ○ 日○ A○
```

`subset-font` は 1 つのファイルからしか作れないので、拾うにはフォントの結合が要る。
**無い文字は 0 幅で黙って消える**ので、HTML 側でこれらを使わないことにした。

### 等幅だけ順序を変える

generic family には登録した family が全部、登録順で入る。`sans` を先頭にしないと
本文が等幅になるので `sans` -> `mono` -> `jp` の順で登録するが、そうすると
**`monospace` を指したページも sans で描かれる**。ページの `<code>` が本文と
同じ書体になってしまう。

`set_generic_lead(generic, families)` を足して、`monospace` と `ui-monospace`
だけ `mono` を先頭に寄せた。`mono` は Latin しか持たないので、後ろに `jp` を残す。

### fallback の順序

generic family (`sans-serif` など) は登録順。Parley は先頭の family から順に cmap を見て、
文字を持つ最初の family を使うので、Latin を先、日本語を後に登録すれば
両方に入っている文字 (`…` など) は Latin 側で出る。

script 別 fallback (CSS が知らない family 名を指したときに落ちてくる経路) は、その script の
代表文字 (`Latn` = `a`、`Hani` = `日`、`Hira` = `あ`、`Kana` = `ア` …) を持つ family を先頭に
寄せる。`Hani` / `Hira` / `Kana` は日本語フォントが先、`Latn` は Latin が先になる。

### 太字

同じ family 名で regular と bold を登録すると、fontique が weight で face を選ぶので `<b>` は
太字の face で出る。日本語は regular しか無いので、`<b>日本語</b>` は regular の face で描かれる。
Latin だけのときも bold face が無ければ regular のまま。**合成の太字 (embolden) は掛からない**。

### 測定 (800x600、Node 上の wasm)

| ページ | HTML | Latin 1 本 | Latin + bold + 日本語 | 差 |
| --- | --- | --- | --- | --- |
| example.com | 559 B | 19 ms / 4.8 MB | 19 ms / 6.9 MB | +2.1 MB |
| en.wikipedia.org | 240 KB | 105 ms / 12.1 MB | 106 ms / 14.3 MB | +2.2 MB |
| ja.wikipedia.org | 140 KB | 84 ms / 12.1 MB (文字なし) | 96 ms / 14.3 MB | +12 ms / +2.2 MB |

3 回ずつ走らせた中央値。

- メモリの増分は `jp-regular.ttf` (2.1 MB) がそのまま wasm のメモリに乗った分。`add_font` は
  Blob (Arc) で持つので、描画ごとに `FontContext` を clone してもフォント本体はコピーされない
- `add_font` 自体は 2.1 MB のフォントで 0.4 ms。fontique は登録時に name / OS/2 / cmap の
  位置を読むだけで、グリフは描くときに初めて触る
- フォントが増えても、日本語の無い en.wikipedia の描画時間は変わらない。ja.wikipedia が
  12 ms 伸びたのは、消えていた文字を実際にシェイピングして描くようになった分
- 1280x800 の ja.wikipedia は 163 ms / 13.8 MB
- wasm 本体のサイズは変わらない (10.2 MB、gzip 3.1 MB)。フォントは Data モジュールとして
  別に乗るので、Worker のバンドルは 2.1 MB 増える

## まだやっていないこと

- JavaScript の実行 (`<script>` は無視する)。ここに手を出すと Boa が要る
- 画像や外部 CSS などのサブリソースの取得
- 日本語以外の非 Latin 文字 (ハングル・ギリシャ・キリル・アラビア文字など)。フォントを
  `add_font` で足せば出る
