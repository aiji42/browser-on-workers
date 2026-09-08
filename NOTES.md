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

## eval が使える場所と、I/O が使える場所は排他

ここが今回いちばん大きい発見。

**ページの `<script>` を V8 で動かす方法はある。** Workers は文字列からコードを
作れないが、**動的 Worker (Dynamic Workers) のモジュールとして渡せば V8 が
普通にコンパイルする。** Kitesurf の PageScript はこの形で、発表記事も
「Dynamic Workers を使ってページごとの PageScript isolate を立ち上げ、
clean な globalThis と DOM document object を用意する」と書いている。

`worker_loaders` binding は open beta で、**Paid ユーザー全員が使える**。

```jsonc
"worker_loaders": [{ "binding": "LOADER" }]
```

動的 Worker の中でエンジンの指紋を測ると、全部 V8 だった。

```
hasCaptureStackTrace: "function"    (Boa なら undefined)
hasStack:             "string"      (Boa なら undefined)
typedArray:           "undefined"   (Boa なら function)
nullError: "Cannot read properties of null"   (Boa は小文字の c)
callError: "1 is not a function"              (Boa は not a callable function)
```

### そして eval も通る。ただし場所が限られる

同じ 7 項目を、モジュールの評価中 (グローバルスコープ) と handler の中で
1 つずつ試した結果。

| | グローバルスコープ | handler の中 |
| --- | --- | --- |
| `eval('1+1')` | **ok: 2** | `EvalError: Code generation from strings disallowed` |
| `new Function` | **ok: 2** | 同じ `EvalError` |
| `setTimeout` | **Disallowed operation called within global scope** | ok |
| `fetch` (await する) | **同じ Disallowed** | ok |
| `crypto.getRandomValues` | **同じ Disallowed** | ok |
| `Math.random` | ok | ok |
| `Date.now()` | **0** | 実時刻 |

**排他になっている。** グローバルスコープでは eval が通るが I/O とタイマーが
使えない。handler では I/O とタイマーが使えるが eval が通らない。

### これは動的 Worker の性質ではなく、Workers 全般の性質

最初は「動的 Worker だと eval が通る」と書いていたが、間違いだった。
**本体の Worker のモジュールスコープでも通る。**

`src/worker.js` のトップレベル (モジュールの評価中) と handler の中で、
同じ 2 行を試した結果 (`/eval-here`)。

| | handler の中 | モジュールの評価中 |
| --- | --- | --- |
| 本体の Worker | `EvalError: Code generation from strings disallowed for this context` | **ok: 2** |
| 動的 Worker | 同じ `EvalError` | **ok: 2** |

つまり境目は「動的 Worker かどうか」ではなく、**「モジュールの評価中かどうか」**。
動的 Worker が効くのは別の理由で、**ページごとに新しいモジュールの評価を
起こせる**こと。本体の Worker の評価中は 1 度きりなので、そこでページの
スクリプトを走らせることはできない。

ブラウザはページの資源を取りに行き、タイマーを回さなければならない。
つまり **handler で走らせるしかなく、handler では eval が使えない。**
だから別の JS エンジンを持ち込むことになる。

「Workers が eval を禁じているから Boa が要る」ではなく、
**「eval が使える場所と、ブラウザが必要とする場所が重ならないから Boa が要る」**
というのが正確なところ。

おまけ: グローバルスコープの `Date.now()` は **0** を返す。起動時は時計が
文字どおりゼロから始まる。

### 選ばされる: eval か、解釈中の資源取得か

`globalOutbound` を渡しても渡さなくても、**グローバルスコープでは fetch が
「Disallowed operation」**。handler では通る。eval は逆。

| | `eval` | `fetch` (await) | `setTimeout` |
| --- | --- | --- | --- |
| グローバルスコープ | **通る** | Disallowed | Disallowed |
| handler の中 | `EvalError` | 通る | 通る |

つまり **どちらかしか選べない。**

- **解釈の途中で資源を取りに行く**なら handler で走らせるしかない。そこでは
  eval が使えないので、JS エンジンを持ち込むことになる (Kitesurf の Boa)
- **資源を先に全部取ってから渡す**ならグローバルスコープで完結できる。
  eval が使えて V8 の速度が出る。代償は「解釈の前には何が必要か分からない」
  ので描き直しが要ること (このリポジトリの多パス)

Kitesurf は live なブラウザセッション (CDP、ナビゲーション、イベント) なので、
スクリプトの実行はいずれ handler の中で起きる。だから Boa が要る、というのが
**この排他から導ける説明** (推定。Cloudflare の実装は見ていない)。

もう 1 つの説明も否定できない: **Kitesurf を作った時期には、動的 Worker でも
eval が使えなかった**のかもしれない。発表は 2026-08-06。

### 実測: 同じページを Boa と V8 で描く

200,000 回のループを含むページ (400x160、外部資源なし)。

| 経路 | cpuTime |
| --- | --- |
| Boa (本体の Worker の中) | 609 / 1023 ms (中央値 816) |
| **V8 (動的 Worker、グローバルスコープ)** | **7 / 11 / 15 ms (中央値 11)** |

**約 74 倍少ない。** ページ側から見た値も V8 だった。

```json
{"loop":599994,"hasStack":"string","callErr":"1 is not a function",
 "evalOk":42,"globals":91}
```

`hasStack` が `string` (Boa は `undefined`)、`callErr` が V8 の文言、
そして **`eval` が 42 を返している。**

### 15 MB の engine は動的 Worker に持ち込める

`modules` に `{ wasm: ... }` で渡す。**コンパイル済みの `WebAssembly.Module` を
そのまま渡せる**ので、ページごとに再コンパイルしなくてよい。

| 渡し方 | 所要 |
| --- | --- |
| `WebAssembly.Module` をそのまま | **170 ms** |
| Static Assets から 15 MB を読んで ArrayBuffer | 1567 ms |

どちらも動的 Worker の中で `WebAssembly.Module` として届き、export は 24 個。

### 起動時の CPU にも上限がある。ただし 10 秒近い

グローバルスコープで全部やるということは、**ページの JS も、レイアウトも、
描画も、全部「起動時」に入る**ということ。ここには専用の上限がある。

ループの回数を上げていって、`/v8shot?html=...&fresh=1` で測った。

| ループ | 結果 | pageScriptMs |
| --- | --- | --- |
| 2 億回 | ok | 1483 ms |
| 5 億回 | ok | 2494 ms |
| 8.5 億回 | ok | 8603 ms |
| 10 億回 | ok / **失敗** | 9042 ms / — |

10 億回は 1 度通って 1 度落ちた。落ちたときのメッセージは

```
Script startup exceeded CPU time limit.
```

境目は 9〜11 秒あたりで揺れる。**400 ms ではない。** 1 枚の絵を描くには
足りるが、上限が存在すること自体は設計に効く。live なセッションを
グローバルスコープに載せることはできない。

### top-level await を使うと、兄弟モジュールの順が決まらない

最初は `setup.js` で `await glue.default(wasm)` としていた。それだけで
`setup.js` が async モジュールになり、**それを import している側の
兄弟モジュールが、setup の終わる前に評価された。**

```
Cannot read properties of undefined (reading 'report')
```

`entry.js` が `setup.js` と `finish.js` を並べて import していて、
finish が先に走っていた。

直し方は 2 つある。

1. 依存関係を作る (`finish.js` が `setup.js` から import する)
2. **top-level await をやめる**

2 が本筋だった。wasm-bindgen は `initSync` を出しているので、
**15 MB でも同期で instantiate できる。**

```js
glue.initSync({ module: wasm });
```

これで setup が同期モジュールになり、静的 import の順がそのまま評価の順に
なる。`<script type="module">` を文書順に走らせるのにも、この性質が要る。

### Kitesurf は eval を Boa 実装に差し替えている (推定)

`plain` が V8 で `viaEval` が Boa なのに、両方 1 つの isolate で動いている。
グローバル `eval` を Boa 呼び出しに差し替えていると考えるのが自然
(だから eval の中のコードは呼び出し元のローカルスコープを見られない)。

`stack` の中身が `/__ks_user_classic_regular.js` を指すので、ページの
スクリプトはファイルとして isolate に持ち込まれている。

### 再現 (2026-09-08)

`probes/11-two-engines.mjs` を今日もう一度回した。100 万回のループで、
Kitesurf の `plain` が 3 ms、`viaNewFunction` が 546 ms (**182 倍遅い**)。
自作の側で Boa と V8 を比べた 194 倍、記事に書いた 226 倍と同じ桁。

## 3 つの構成を同じ 4 ページで測る

「Boa を引き剥がすと速くなるのか」を確かめるため、同じ 4 ページを 2 つの
構成に通した。Kitesurf と Chromium は Browser Run で同時に撮っている
(`probes/19-three-configs.mjs`)。

| | ページの JS | 資源の取得 | eval |
| --- | --- | --- | --- |
| **C** (`/shot`) | Boa (本体の Worker) | 先に取って多パス | Boa |
| **B** (`/v8shot`) | V8 (動的 Worker、グローバルスコープ) | 先に取って多パス | V8 |
| A (未着手) | Boa (動的 Worker、handler) | 解釈の途中で取りに行く | Boa |

### 壁時計 (手元から観測、TLS の確立を引いた値。3 本の中央値)

| ページ | C: Boa | B: V8 | Kitesurf | Chromium |
| --- | --- | --- | --- | --- |
| ja.wikipedia「ウェブブラウザ」 | **1856 ms** | 2815 ms | 8300 ms | 2359 ms |
| MDN `font-family` | **1912 ms** | 2614 ms | 5960 ms | 2134 ms |
| TodoMVC (React、CSR) | 2551 ms | 3592 ms | **1824 ms** | 1729 ms |
| react.dev (React、SSR) | 15109 ms | **7477 ms** | 4144 ms | 2095 ms |

Kitesurf と Chromium は同じ手元のマシンから同じ Browser Run API で撮った
ので、往復の時間は同じ条件で乗っている。

**Kitesurf は Chromium より 3〜5 倍遅い** (billed の中央値で
7491 / 5315 / 1535 / 3763 ms 対 1559 / 1614 / 1225 / 1072 ms)。
Chromium を置き換えるためのものではなく、Chromium を置けない場所に
置くためのもの、という位置づけが数字にも出ている。

おまけ: **Kitesurf は MDN の `font-family` を描けなかった。** 3 本のうち
1 本が失敗し、成功した 2 本も 307 バイトしか返ってこない。こちらは
両経路とも 58 KB の絵になる。

### CPU 時間 (`wrangler tail`、3 本の中央値)

| ページ | C: Boa | B: V8 (**親の分だけ**) |
| --- | --- | --- |
| ja.wikipedia | 1149 ms | 898 ms |
| MDN | 1657 ms | 843 ms |
| TodoMVC | 2141 ms | 1269 ms |
| react.dev | **12664 ms** | 3656 ms |

### 動的 Worker の中の実行は、tail に出てこない

B の cpuTime は **本体の Worker の分だけ**。`https://page.invalid/` への
呼び出しに対応する行が 1 つも出ない。

決め手になった実測。2 億回のループを含むページを `?discover=0` (探索の
描き直しなし) で通すと、

| | cpuTime | wallTime |
| --- | --- | --- |
| 子 Worker で 2 億回 | **24 ms** | 1334 ms |

親は 24 ms しか使っていないのに、壁時計は 1.3 秒。**子の CPU は親の
cpuTime に入らず、tail にも出ない。** だから B と C の CPU を並べた表は
「Boa の分」対「探索の描き直しと PNG の分」を比べているだけで、
**引き算で B の総 CPU を出すことはできない。**

### 答え: 引き剥がすと速くなるのは、ページの JS が重いときだけ

- **軽いページでは遅くなる** (wikipedia 1856 -> 2815 ms、MDN 1912 -> 2614 ms)。
  グローバルスコープでは fetch できないので、**何が必要かを知るために
  先に捨てる描画をする**。wikipedia は 2 パス、MDN は 2 パスで 31 件を
  拾い直している。この探索の分がそのまま乗る
- **重いページでは速くなる** (react.dev 15109 -> 7477 ms、CPU で
  12664 -> 3656 ms)。Boa は react.dev の JS を走らせると本文を消すので、
  **JS ありで描いてから JS なしで描き直している** (`blankWithJs: true`,
  `usedNoJs: true`)。V8 は 1 回で済む

つまり **Boa は「要らない」のではなく、「別のものを払っている」**。
V8 を使うには資源を先に全部揃える必要があり、それには捨てる描画が要る。

## 構成 A: 動的 Worker の handler で Boa に走らせる

公式の Kitesurf にいちばん近い形。`/ashot`。

- ページの JS は **Boa** (handler では eval が使えないが、Boa は Wasm の中の
  インタプリタなので関係ない)
- 資源は **解釈の途中で取りに行く**。`NetProvider::fetch` が受け取った
  `Box<dyn NetHandler>` を溜めておき、JS が fetch してから `sess_provide` で答える
- ネットワークは `globalOutbound` で親の専用 entrypoint に通す (SandboxOutbound)

### 捨てるための描画が要らない

構成 B は「何が必要か」を知るために親で 1〜3 回描き捨てる。
構成 A は document を開いたまま資源が後から届くので、それが要らない。

実測 (1000x800、`fresh=1`)。

| ページ | settle の周回 | 取得 | 残った pending | 結果 |
| --- | --- | --- | --- | --- |
| ja.wikipedia「ウェブブラウザ」 | 2 (19 + 6) | 25 本 423 KB | 0 | 92 KB の PNG |
| MDN `font-family` | 2 (22 + 31) | 53 本 1.05 MB | 0 | 56 KB の PNG、JS エラー 0 |
| TodoMVC | 1 (3) | 3 本 248 KB | 0 | 20 KB の PNG |
| react.dev | 2 (47 + 44) | 91 本 3.3 MB | 0 | **白紙 (5 KB)** |

**2 周で収束する。** 1 周目が HTML に書かれているもの、2 周目がその CSS の中から
参照されるもの (`background-image`、`@font-face`)。

### 引っかかったところ

`<script src>` は **blitz-dom の `NetProvider` を通らない。** vibey-script の
`ScriptFetcher` が `execute_scripts` の最中に**同期で**引く。しかも
`execute_scripts` は 2 度走らない。だからそのとき手元に無いスクリプトは
**永久に飛ばされる。** `sess_open` が `<script src>` を「handler の無い保留」として
先に積んでおき、JS 側は **pending を 0 にしてから `sess_run_scripts` を呼ぶ**。

もう 1 つ、blitz-dom 側の穴。**後から届いた `@import` は黙って効かない。**
要求はされる (保留に出る) が、親のシートは既に stylist に入っていて、
入れ子の応答が `Resource::None` として捨てられる。カスケードの組み直しが無い。
JS 側からは成功と区別が付かない。回避は `sess_open` より前に
`add_resource` で渡しておくことだけ。

## Boa の RuntimeLimitError は、ページの try/catch では捕まらない

暴走を止めるために `RECURSION_LIMIT = 160` を置いている。超えると

```
Uncaught JS error in <inline script>:
RuntimeLimitError: reached the maximum number of recursive calls on this execution
```

**呼び出しを 1 つずつ `try/catch` で包んでも捕まらない。** 包んだ中で
上限に当たると、その `catch` も走らず、**そのスクリプトの残り全部が飛ぶ。**

深さを 1 段ずつ上げて、DOM に書きながら測った結果。

| 深さ | Boa 経路 | V8 経路 |
| --- | --- | --- |
| 50 / 100 / 140 / 150 / 155 | 通る | 通る |
| **160** | **ここでスクリプトが終わる** | 通る |
| 170 / 200 / 300 / 500 / 1000 | (到達しない) | 通る (`done` まで) |

ただし **react.dev はこの上限には当たっていない。** 構成 A で react.dev を
描くと `jsErrors` は 0 件で、それでも白紙になる。上限に当たっていれば
上のエラーが出るはずなので、白紙の原因は別。候補は `LOOP_ITERATION_LIMIT`
(500,000、フレームごとの通算でループを抜けても戻らない。こちらは catch できる
例外なので、React が自分で捕まえてクライアント描画にやり直す形になりうる) と
`SCRIPT_BUDGET` (1.5 秒、スクリプトの切れ目でしか見ない)。

## SandboxOutbound は、専用の entrypoint にしないと再帰する

`globalOutbound` に Fetcher を渡すと、**子 Worker の `fetch` が全部そこへ届く。**
URL はページが要求したものそのまま。子のコードにネットワークの権限は無く、
方針を親の 1 箇所に置ける。Kitesurf の SandboxOutbound がこの位置。

```jsonc
"services": [
  { "binding": "OUTBOUND", "service": "browser-on-workers", "entrypoint": "Outbound" }
]
```

```js
globalOutbound: env.OUTBOUND,
```

最初は自分自身 (既定の `fetch`) に向けた。**それだと再帰する。**
中継の依頼と外から来たリクエストが同じ handler に届くので、区別が付かない。
ページが `https://not-kitesurf.aiji42.dev/shot?url=...` を要求すると、
自分のルーティングに落ちて自分を呼ぶ。

`WorkerEntrypoint` を 1 つ増やして、そこに向けたら分かれた。

| 子から取りに行った先 | 既定の fetch に向けたとき | 専用の entrypoint に向けたとき |
| --- | --- | --- |
| `https://ja.wikipedia.org/wiki/Main_Page` | 200 (143 KB) | 200 (143 KB) |
| `https://not-kitesurf.aiji42.dev/health` | **200 (通ってしまう)** | **403** |

## React のハイドレーションは V8 側では通った

Boa 経路では通らないと書いていたが、**V8 経路では通る。**

| | ページの JS | 結果 |
| --- | --- | --- |
| Boa (`/shot`) | 走る | `blankWithJs: true` -> **JS を切って描き直し** |
| V8 (`/v8shot`) | 走る | **14 本すべてエラー無し**、`__reactContainer` が付く |

絵だけでは SSR の HTML と区別が付かないので、**React が container と
その子に直接付ける `__reactContainer` / `_reactListening` というキー**の
有無で判定した (`report.reactKeys`)。

### engine の差だと言い切るまでにやったこと

最初に V8 側で動かしたときは `location is not defined` で止まった。
Boa 側 (blitz-vibey-script) の顔を数えたら、**向こうのほうが揃っていた。**

`/shot?html=<script>...typeof...</script>` で数えた結果。

```
持っている: location history HTMLIFrameElement Node Element HTMLElement
            Text queueMicrotask fetch navigator getComputedStyle
            MutationObserver Event CustomEvent requestAnimationFrame
            document.defaultView
無い:       setImmediate MessageChannel XMLHttpRequest
```

そこで **両側の顔を揃えた。**

- V8 側に足した: `location` / `history` / `document.defaultView` /
  `instanceof` の右辺になる DOM のコンストラクタ (`HTMLIFrameElement` など) /
  `setImmediate` / `MessageChannel`
- Boa 側 (`POLYFILL`) に足した: `setImmediate` / `MessageChannel`

**揃えたうえで、react.dev は Boa 側ではやはり白紙になる。**
だから「Boa だから通らない」は shim の穴ではない。

### V8 側で React を通すのに要ったもの

- **`location` と `history`。** 無いと react.dev の最初の 1 本が
  `location.search` で落ちて、そこで 14 本が全滅する
- **`instanceof` の右辺。** React DOM は `t instanceof e.HTMLIFrameElement` と
  window から辿ったコンストラクタで narrowing する。無いと
  「Right-hand side of 'instanceof' is not an object」で止まる。
  BlitzNode と**別の**クラスにしないと、全ノードが iframe として真になる
- **`setImmediate` と `MessageChannel`。** React 18 のスケジューラは
  この順でマクロタスクの手段を探す。workerd は `setImmediate` を持っている
  ので、塞がないと仕事がそこへ消える
- **タイマーを何周も流すこと。** React は「起きて、少し進めて、また積む」を
  繰り返す。1 回流して終わりにはできないので、`await Promise.resolve()` を
  挟みながら 12 周まで回す (await は I/O ではないのでグローバルスコープでも通る)
- **実行済みの `<script>` を DOM から消さないこと。** 消すと
  `document.getElementsByTagName('script')[0]` が undefined になり、
  Google Analytics の定番のスニペットが `.parentNode` で落ちる。
  ブラウザでは実行後も要素は残るので、`type` を潰して残す
- **`defer` と `type="module"` を後ろに回すこと。** TodoMVC は
  `app.bundle.js` が defer、`base.js` が非 defer なので、文書順に走らせると
  逆になる

### `<script type="module">` は本物のモジュールとして渡せる

間接 eval に流すと `export` の行で SyntaxError になる。動的 Worker の
モジュールとして置けば V8 がそのままコンパイルする。

ただし **指定子が 1 本でも解決できないと Worker がまるごと起動しない。**

```
No such module "runtime.3b0471a04a45c8e9.js".
  imported from "m1wfru51.js"
```

MDN はこれを踏む。webpack の runtime チャンクは `<script src>` として
HTML に出てこないので、資源の表に無い。だから

1. import の網を全部たどって、揃っているときだけ昇格させる
2. 書き換え漏れが 1 本も無いことを、書き換えたあとにもう一度走査して確かめる
3. それでも起動に失敗したら、昇格を切って描き直す

の 3 段にした。MDN は 6 本のうち 2 本が昇格して、2 本が eval に落ちる。

## 「JS が動く」と「React が動く」の間の距離

`react.dev` を手がかりに、engine に何が足りないのかを測った。

### 足りない Web API は 11 個だった

44 個の API の有無を 1 枚の絵に出させて数えた (`?html=` に検査ページを渡す)。
**DOM の主要な口はだいたい揃っている** — `querySelector` / `createElement` /
`classList` / `addEventListener` / `getBoundingClientRect` / `insertBefore` /
`cloneNode` / `DocumentFragment` / `DOMParser` / `customElements` /
`getComputedStyle` / `requestAnimationFrame` / `history.pushState` /
`Proxy` / `Reflect` / `structuredClone` / `queueMicrotask` は全部ある。

無かったのはホスト側の 11 個。

```
matchMedia / URLSearchParams / fetch / localStorage / sessionStorage /
MutationObserver / IntersectionObserver / ResizeObserver /
performance.now / navigator / screen
```

本来は Rust 側に実装するもの (Kitesurf はそうしているはず) だが、
**何が足りないかを測るには JS で埋めるのが早い**。`src/polyfill.js` に
200 行ほどの shim を書いて、ページのスクリプトより先に差し込んだ
(`?polyfill=0` で外せる)。

埋めた順に `react.dev` のエラーが減った。

| shim | 残ったエラー |
| --- | --- |
| なし | `TypeError: not a callable function` (`window.matchMedia`) |
| matchMedia など 9 個 | `TypeError: cannot convert 'null' or 'undefined' to object` (`navigator.platform.includes`) |
| navigator / screen も | **0 件** |

`navigator.platform` は `Win32` と答えることにした。`MacIntel` と答えると
react.dev が \u2318 を出そうとして、持っていないグリフなので豆腐になる。

### それでもページは白い。原因は React 側

エラーが 0 件になっても、`react.dev` は白いまま。**外部スクリプトだけ落とすと
(`?scripts=inline`) 正しく描ける。** 941 バイトの `<script src>` を消しただけで
本文が出る。つまりインラインは全部通っていて、**React のバンドルが本文を消している**。

`__NEXT_DATA__` を見ると `"content":"[]"` で、**このページの本文はサーバが吐いた
HTML の中にしか無い**。だから React が最初から描き直す判断をした時点で、本文は
どこからも復元できない。

Kitesurf は同じページを正しく描く (`billed 3758ms`、本文 8303 文字)。
つまり残っているのは「足りない API を足す」作業ではなく、**React の
ハイドレーションが諦めないくらい DOM を忠実にする**作業。API の一覧のような
チェックリストが無い側の仕事で、ここが本当に高い。

## ページの JavaScript を動かすと、動かさないより悪くなることがある

`react.dev` が真っ白になった。**`?js=0` を付けると正しく描ける。**
React のハイドレーションが Boa の上で途中で失敗し、本文が消えたまま終わる。

原因を追うと 2 つ重なっていた。

**1. 取りこぼしの回収に上限があった。** `react.dev` は 2 周目で 66 本を要求してくるが、
`fetchResources` の上限を 64 本にしていた。落ちた 2 本が Next.js の
`_buildManifest.js` と `_ssgManifest.js` で、それが無いと起動のスクリプトが
`TypeError: not a callable function` を投げる。

上限に当たったときに**どれを捨てるか**が効く。絵が 1 枚欠けるより、スクリプトや
スタイルが欠けるほうが壊れるので、拡張子で並べ替えて JS / CSS を先に取るようにした
(上限も 96 本に上げた)。66 本すべて取れて、JS のエラーは 3 件から 1 件に減った。

**2. それでも白くなる。** 残った 1 件で React が本文を消す。ここは Boa の側に
足りない Web API があるので、すぐには直らない (`URLSearchParams is not defined`
なども出る)。

そこで**白い絵が出たら JS を切って描き直す**ようにした。1 色だけの画像かどうかを
間引いて数えて判定し、`x-timing` に `blankWithJs` と `usedNoJs` を出す。
「JS を動かしたほうが悪くなる」ページがあるという事実は、ヘッダに残す。

## 組み込みの Rate Limiting binding は効かなかった

公開したままにするには数を絞る必要がある (1 枚 0.1〜2 秒の CPU を使うので)。
Workers には Rate Limiting binding があるので、まずそれを使った。

```jsonc
"unsafe": { "bindings": [{ "name": "SHOT_LIMIT", "type": "ratelimit",
  "namespace_id": "1001", "simple": { "limit": 4, "period": 10 } }] }
```

binding は生きていて `limit({ key })` も例外を投げないのに、**20 発通しても
`{ success: true }` しか返らない**。10 秒に 4 回の設定で、並列 15 + 直列 5 を
同じ IP から投げて全部 200。数えていない。

Durable Object に置き換えた (`src/ratelimit.js`)。IP ごとにインスタンスを 1 つ作り、
通した時刻をメモリに積んで窓ごとに数える。storage には書かない (インスタンスが
落ちたら数え直しになるが、悪用を止めるには足りる)。4 発通って 5 発目から 429。

バケットは 2 つに分けた。トップページは自分で 4 枚の絵を貼っているので、
訪問者が URL を指定する経路と同じ枠で数えると、ページを開いた瞬間に自分で
制限に当たる。**`demo=1` を付けるだけで緩くすると、その口から好きな URL を
撮られる**ので、貼っている URL と大きさに一致するときだけ緩い方を使う。

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
