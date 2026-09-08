# browser-on-workers

URL を渡すとスクリーンショットが返る、**Cloudflare Workers の isolate の中だけで動く**小さなブラウザ。Chromium は使わない。

```
GET /shot?url=https://example.com  ->  image/png
```

## なぜ作ったか

Cloudflare が 2026 年 8 月に [Kitesurf](https://blog.cloudflare.com/kitesurf/) を発表した。Chromium のバイナリを一切使わず、Rust で書いたブラウザエンジンを Wasm にして Workers の V8 isolate の上で動かす、という代物。発表記事には「Chromium より CPU が 3.1 倍、メモリが 7.0 倍少ない」という比較表が載っている。

その CPU とメモリを外から測ろうとしたら、測る手段が無かった。Browser Run のダッシュボードにもレスポンスヘッダにも出てこない。`performance.memory` は Kitesurf 側に存在せず、CDP の `Memory.*` は呼べるが空のオブジェクトを返す。

測れないなら、同じ構成で作ってみればいい。それがこのリポジトリ。

## 構成

発表記事が名前を挙げている部品を、そのまま使っている。

| 役割 | 使っているもの |
| --- | --- |
| HTML のパース | [html5ever](https://github.com/servo/html5ever) (blitz-html 経由) |
| DOM | [blitz-dom](https://github.com/DioxusLabs/blitz) |
| CSS | [Stylo](https://github.com/servo/stylo) — Firefox の CSS エンジン |
| レイアウト | [Taffy](https://github.com/DioxusLabs/taffy) |
| テキスト整形 | [Parley](https://github.com/linebender/parley) |
| 描画 | [blitz-paint](https://github.com/DioxusLabs/blitz) |
| PNG 化 | 自前 (`src/png.js`)。Workers に画像の API が無いので |
| 外向きの取得 | Worker の `fetch()` 1 箇所だけ |

Rust 側は wasm32-unknown-unknown 向けにビルドして wasm-bindgen で JS から呼ぶ。

## 動かす

```bash
npm install
npm run fonts     # Latin だけに絞った TTF を fonts/ に作る
npm run build     # Rust を wasm32 にビルドする
npm run dev       # ローカルで起動
```

Rust のツールチェーンが必要。

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
rustup target add wasm32-unknown-unknown
```

## 分かったこと・詰まったこと

作りながら踏んだところを `NOTES.md` に書いている。要点だけ:

- **Stylo は wasm32-unknown-unknown に載る。** ただし `StyleThreading::Sequential` を指定する必要がある。既定の並列トラバースは rayon のスレッドプールを使うので、スレッドの無い wasm では動かない
- **フォントはシステムから取れない。** Workers にフォントが 1 つも無いので、TTF を自分で埋め込んで Parley に登録するしかない。woff2 は Brotli で圧縮されていて Workers 側でほどけないので、TrueType のまま置く
- `eval` は使えない。ページの中の `<script>` を実行しようとすると、そこで詰まる。Kitesurf が Boa (Rust 製の JS エンジン) を Wasm で持ち込んでいるのは、この壁を越えるため

## できないこと

スクリーンショットを撮るところまでを目標にしているので、実用のブラウザではない。

- JavaScript を実行しない (`<script>` は無視する)
- 画像や外部 CSS などのサブリソースを取りに行かない
- Latin のみ。日本語を出すにはフォントを足す必要がある

## ライセンス

MIT
