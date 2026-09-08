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

## まだやっていないこと

- JavaScript の実行 (`<script>` は無視する)。ここに手を出すと Boa が要る
- 画像や外部 CSS などのサブリソースの取得
- Latin 以外の文字
