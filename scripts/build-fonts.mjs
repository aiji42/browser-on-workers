/**
 * Worker が使うフォントを作る。出力先は public/fonts/ で、Static Assets として
 * 配られる。Worker は起動時に ASSETS binding から読んで Parley に登録する。
 *
 * Workers にはシステムフォントが無いので、字を出すにはフォントファイルを
 * 自分で持ち込むしかない。woff2 は Brotli で圧縮されていて Workers 側で
 * ほどけないので、TrueType のまま置く。
 *
 * グリフ数にそのまま比例して大きくなるので、Latin は記号まで、日本語は
 * ひらがな・カタカナ・常用漢字あたりに絞る。
 *
 * 実行: node scripts/build-fonts.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import subsetFont from 'subset-font';

const CHARS = [
  'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  'abcdefghijklmnopqrstuvwxyz',
  '0123456789',
  ' .,:;!?\'"`^~-_/\\|()[]{}<>@#$%&*+=',
  '…—–‘’“”•·©®™°±×÷',
].join('');

// 日本語。個別に列挙できないので範囲で作る。
// 常用漢字は CJK 統合漢字に散らばっているので、そのブロックを丸ごと入れている
const range = (from, to) => {
  let out = '';
  for (let c = from; c <= to; c++) out += String.fromCodePoint(c);
  return out;
};
const JP_CHARS = [
  range(0x3000, 0x303f),  // 句読点・括弧
  range(0x3041, 0x309f),  // ひらがな
  range(0x30a0, 0x30ff),  // カタカナ
  range(0x4e00, 0x9fff),  // CJK 統合漢字
  range(0xff01, 0xff60),  // 全角の英数字と記号
  range(0xffe0, 0xffe6),  // 全角の通貨記号
].join('');

const SOURCES = {
  'sans-regular': ['noto-sans-jp/files/noto-sans-jp-latin-400-normal.woff2', CHARS],
  'sans-bold': ['noto-sans-jp/files/noto-sans-jp-latin-700-normal.woff2', CHARS],
  'mono-regular': ['ibm-plex-mono/files/ibm-plex-mono-latin-400-normal.woff2', CHARS],
  'jp-regular': ['noto-sans-jp/files/noto-sans-jp-japanese-400-normal.woff2', CHARS + JP_CHARS],
};

mkdirSync(new URL('../public/fonts/', import.meta.url), { recursive: true });

for (const [name, [src, chars]] of Object.entries(SOURCES)) {
  const buf = readFileSync(new URL(`../node_modules/@fontsource/${src}`, import.meta.url));
  const ttf = await subsetFont(buf, chars, { targetFormat: 'truetype' });
  const out = new URL(`../public/fonts/${name}.ttf`, import.meta.url);
  writeFileSync(out, ttf);
  console.log(`${name}.ttf  ${(ttf.length / 1024).toFixed(1)} KB`);
}
