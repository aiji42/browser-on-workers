// 実ページを 1 枚まるごと落として、Rust 側のテストが食える形で置く。
//
//   node scripts/fetch-page.mjs https://en.wikipedia.org/wiki/Main_Page /tmp/enwiki
//   cd crate && PAGE_DIR=/tmp/enwiki RENDER_DUMP_DIR=/tmp cargo test page_with_images -- --nocapture
//
// 出力は 4 つ。
//   page.html    … 外部 CSS を <style> に差し込んだ HTML (Worker が Rust に渡すのと同じもの)
//   base.txt     … リダイレクト後のページ URL (相対参照を解決する起点)
//   manifest.tsv … 「絶対 URL \t ファイル名」の行。Rust 側が add_resource に渡す
//   files/       … 画像の中身
//
// 取得は src/outbound.js をそのまま使う。Worker と同じ経路で集めたものを見たいので、
// ここに別の取得処理は書かない。

import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fetchHtml, inlineStylesheets, fetchImages } from '../src/outbound.js';

const [url, outDir] = process.argv.slice(2);
if (!url || !outDir) {
  console.error('usage: node scripts/fetch-page.mjs <url> <out-dir>');
  process.exit(1);
}

await rm(outDir, { recursive: true, force: true });
await mkdir(join(outDir, 'files'), { recursive: true });

const { html, finalUrl } = await fetchHtml(url);
const css = await inlineStylesheets(html, finalUrl);
const { images, skipped, bytes } = await fetchImages(css.html, finalUrl);

const manifest = [];
for (const [i, img] of images.entries()) {
  // ファイル名は連番。URL は manifest 側に持たせる (URL をファイル名に潰さない)
  const name = `files/${String(i).padStart(3, '0')}`;
  await writeFile(join(outDir, name), img.bytes);
  manifest.push(`${img.url}\t${name}`);
}

await writeFile(join(outDir, 'page.html'), css.html);
await writeFile(join(outDir, 'base.txt'), finalUrl);
await writeFile(join(outDir, 'manifest.tsv'), manifest.join('\n'));

console.log(
  `${finalUrl}\n  html ${css.html.length} bytes (css ${css.fetched} 枚 / ${css.cssBytes} bytes, 飛ばした ${css.skipped})\n` +
    `  images ${images.length} 枚 / ${bytes} bytes, 飛ばした ${skipped}`,
);
for (const img of images) console.log(`  ${img.type.padEnd(12)} ${img.url}`);
