# browser-on-workers

URL を渡すとスクリーンショットが返る、**Cloudflare Workers の isolate の中だけで動く**小さなブラウザ。Chromium は使わない。

```
GET /shot?url=https://example.com  ->  image/png
```

- `GET /` — デモ。このブラウザが描いた絵を並べている
- `GET /js` — ページの JavaScript が動くことを見せるページ。`/js.png` がその自画像
- `GET /shot?url=...&js=0` — ページの `<script>` を実行せずに描く
- `GET /health` — Wasm とフォントが読めているか

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
| JavaScript | [Boa](https://boajs.dev) ([blitz-vibey-script](https://github.com/DioxusLabs/blitz) 経由。crates.io に無いので vendor した) |
| 画像のデコード | [image](https://github.com/image-rs/image) (blitz-dom 経由) |
| PNG 化 | 自前 (`src/png.js`)。Workers に画像の API が無いので |
| 外向きの取得 | Worker の `fetch()` 1 箇所だけ (`src/outbound.js`) |
| フォントの置き場 | Static Assets (`public/fonts/`)。実行時に `env.ASSETS` から読む |

Rust 側は wasm32-unknown-unknown 向けにビルドして wasm-bindgen で JS から呼ぶ。

## 描けるもの

`ja.wikipedia.org` のメインページ。日本語、2 カラム、写真、アイコンが出る。

![ja.wikipedia.org](docs/ja-wikipedia-images.png)

外部 CSS と画像は Worker が取ってきて engine に渡している。Blitz 自身は
サブリソースを取りに行かないので、ネットワークは Worker 側の 1 箇所に閉じている
(Kitesurf が SandboxOutbound に閉じ込めているのと同じ形)。

| ページ | HTML | CSS | 画像 |
| --- | --- | --- | --- |
| `ja.wikipedia.org` | 140 KB | 3 枚 231 KB | 24 枚 452 KB |
| `en.wikipedia.org` | 246 KB | 2 枚 210 KB | — |
| `developer.mozilla.org` | 118 KB | 20 枚 55 KB | — |
| `blog.cloudflare.com/kitesurf` | 569 KB | — | — |

## 動かす

```bash
npm install
npm run fonts     # 文字を絞った TTF (Latin / 日本語) を public/fonts/ に作る
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

- **Stylo は wasm32-unknown-unknown に、何の対応もなしに載る。** 並列トラバースが rayon を要求するので無理だろうと踏んでいたが、blitz-dom の `StyleThreading` は既定が `Sequential` で、単一スレッド動作が想定済みの構成だった。CSS のパースとカスケードは OS に依存しない純粋な計算なので、載らない理由の方が無い
- **フォントはシステムから取れない。** Workers にフォントが 1 つも無いので、TTF を自分で持ち込んで Parley に登録するしかない。woff2 は Brotli で圧縮されていて Workers 側でほどけないので、TrueType のまま置く。バンドルには埋め込まず Static Assets から読む (Kitesurf の PageRenderer と同じ)。日本語 1 ウェイトで 2.14 MiB あるので、スクリプトサイズの上限に効かせない方が楽で、代わりに cold start で 20〜35 ms かかる
- **フォントを足すだけでは文字は出ない。** fontique は wasm32 ではシステムフォントのバックエンドが空になる。Parley は「family に無い文字」を script 単位の fallback で探すので、そこが空だと**文字が幅 0 で消える。エラーは出ない**。13 個の generic family と 14 の script に、登録したフォントを手で結び付ける必要がある
- **同じ family に別の文字集合を入れると、片方が黙って消える。** fontsource のサブセットは name テーブルの family 名が全部同じ (`Noto Sans JP Thin`) なので、Latin と日本語をそのまま渡すと 1 つの family に入る。fontique は weight で 1 face だけを選び、Parley はその face の cmap しか見ないので、weight 400 の face が 2 つあると片方の文字が出ない。`FontInfoOverride` でファイル内の名前を捨てて回避した
- **Workers の `eval` 禁止は、Boa には効かない。** Worker のコードが `eval` を呼ぶと `EvalError: Code generation from strings disallowed for this context` になるが、**ページの中の `eval` は動く**。文字列をコードにするのが V8 ではなく Wasm の中の Boa だから。結果として V8 と Boa が同じ isolate に同居する (Kitesurf も同じ構造)
- **Boa には実行を中断する仕組みが無い。** `Context` にループ回数と再帰の上限を積み、`<script>` とタイマーごとに実時間の予算を見る二段構えにした。`while (true)` は 27 ms で JS の例外になり、**止まるまでに触った DOM はそのまま描かれる**

## できないこと

スクリーンショットを撮るところまでを目標にしているので、実用のブラウザではない。

- **JavaScript には実行上限がある。** `while (true)` は 27 ms で止まる。
  巨大な文字列や配列を作られると `boa_string` の中で panic して Worker が 500 を返す
  (RangeError を投げるべきところで panic している upstream のバグ)。`?js=0` で戻る
- **レイアウトが返ってこないページがある。** `ja.wikipedia.org/wiki/コーヒー` は
  taffy のブロックレイアウトの深い再帰から 300 秒経っても帰らない。JS を切っても再現する
- フォントに入れた文字しか出ない。いまは Latin と、ひらがな・カタカナ・
  常用漢字あたり。他の言語を出すにはフォントを足す
- 動くもの (アニメーション、動画、WebGL) は扱わない

## ライセンス

MIT
