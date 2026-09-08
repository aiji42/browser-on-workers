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

## Stylo は wasm32-unknown-unknown に載る

一番の懸念だった。Servo のスタイルシステムは並列トラバースに rayon を使うので、
スレッドの無い wasm では動かないと踏んでいた。

実際には**そのままビルドできる**。必要だったのは 1 行だけ。

```rust
blitz_html::HtmlDocument::from_html(html, DocumentConfig {
    // 既定は Parallel。rayon のスレッドプールを使うので wasm では動かない
    style_threading: StyleThreading::Sequential,
    ..Default::default()
})
```

`html5ever` / `blitz-dom` / `blitz-html` / `Stylo` / `Taffy` / `usvg` が
同じターゲットで通る。`doc.resolve(0.0)` (スタイル解決 + レイアウト) まで含めて
**434 KB、gzip 後 0.1 MB**。

## フォントは持ち込むしかない

Workers にはフォントが 1 つも無い。字を出すにはフォントファイルを埋め込む。

**woff2 は使えない。** Brotli で圧縮されていて、Workers 側でほどく手段が無い
(`DecompressionStream` は gzip と deflate だけ)。なので TrueType のまま置く。

全部入れると重いので、`scripts/build-fonts.mjs` で Latin と記号だけに絞る。
リポジトリに既にある `subset-font` に `targetFormat: 'truetype'` を渡すと
woff2 から TTF を作れる。1 ウェイト 20 KB ほどに収まった。

日本語を出すなら文字を足せば入るが、グリフ数に比例して大きくなる。

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

## まだやっていないこと

- JavaScript の実行 (`<script>` は無視する)。ここに手を出すと Boa が要る
- 画像や外部 CSS などのサブリソースの取得
- Latin 以外の文字
