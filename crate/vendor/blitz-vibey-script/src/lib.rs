//! # このディレクトリは upstream の写し
//!
//! `blitz-vibey-script` は crates.io に出ていない。Blitz の workspace
//! (`DioxusLabs/blitz`) の中にだけあるクレートなので、`packages/blitz-vibey-script`
//! を rev `4507cd7` (`script: fix panic in replaceChild ...`、これが最後に
//! このクレートを触ったコミット) からそのまま写してある。
//!
//! upstream との差は 4 つ。
//!
//! 1. `Cargo.toml` の `workspace = true` を具体的なバージョンに開いた
//! 2. [`ScriptDocument::with_runtime_limits`] を足した。Boa の実行上限
//!    (loop iteration / recursion) は `Context` にしか無く、このクレートは
//!    `Context` を外に出していない。Workers には CPU 時間の上限があるので、
//!    ページの `while (true) {}` を JS の例外に変える口が必要だった
//! 3. [`ScriptDocument::with_deadline`] を足した。上のループの上限は
//!    「1 つの呼び出しフレーム」ごとなので、関数や `<script>` の数だけ
//!    使い回せてしまう。実時間の予算はこのクレートに無かった
//! 4. `DefaultScriptFetcher` の `file:` の枝を wasm では消した
//!    (`Url::to_file_path` が wasm に無い)。wasm には読むファイルも無いし、
//!    こちらは自前の `ScriptFetcher` (資源の表) を差すので使わない
//!
//! `blitz-dom` などは crates.io の `0.3.0-beta.2` では足りない
//! (このクレートが `style_attr_*` や `css_supports_condition` を使う) ので、
//! 呼び出し側の `Cargo.toml` が `[patch.crates-io]` で同じ rev に寄せている。
//!
//! JavaScript execution on top of Blitz
//!
//! This crate implements a [`ScriptDocument`]: a wrapper around a [`BaseDocument`](blitz_dom::BaseDocument)
//! which can execute the JavaScript contained in (or referenced by) the document's `<script>` tags
//! using the [Boa](https://boajs.dev) JavaScript engine, and which exposes JavaScript DOM APIs
//! (`document`, elements, events, timers, etc) backed by `blitz-dom` to the scripts it runs.
//!
//! It is capable of running real-world JavaScript frameworks such as [Preact](https://preactjs.com/).
//!
//! ### Example
//!
//! ```rust
//! use blitz_vibey_script::ScriptDocument;
//! use blitz_dom::DocumentConfig;
//!
//! let mut doc = ScriptDocument::from_html(
//!     r#"
//!         <div id="root"></div>
//!         <script>
//!             const el = document.createElement("h1");
//!             el.textContent = "Hello from JS";
//!             document.getElementById("root").appendChild(el);
//!         </script>
//!     "#,
//!     DocumentConfig::default(),
//! );
//! doc.execute_scripts();
//! ```

#![allow(clippy::collapsible_if)]

mod clock;
mod document;
mod dom;
mod event_handler;
mod fetch;
mod runtime;
mod state;
mod timers;

pub use document::ScriptDocument;
pub use fetch::{DefaultScriptFetcher, FetchError, ScriptFetcher};
