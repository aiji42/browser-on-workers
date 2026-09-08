/**
 * Worker に埋め込むフォントを作る。
 *
 * Workers にはシステムフォントが無いので、字を出すにはフォントファイルを
 * 自分で持ち込むしかない。woff2 は Brotli で圧縮されていて Workers 側で
 * ほどけないので、TrueType のまま置く。
 *
 * 全部入れると重いので、Latin と記号だけに絞る。日本語を出すなら
 * CHARS に足せば入るが、グリフ数に比例して大きくなる。
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

const SOURCES = {
  'sans-regular': 'node_modules/@fontsource/noto-sans-jp/files/noto-sans-jp-latin-400-normal.woff2',
  'sans-bold': 'node_modules/@fontsource/noto-sans-jp/files/noto-sans-jp-latin-700-normal.woff2',
  'mono-regular': 'node_modules/@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-400-normal.woff2',
};

mkdirSync(new URL('../fonts/', import.meta.url), { recursive: true });

for (const [name, src] of Object.entries(SOURCES)) {
  const buf = readFileSync(new URL('../' + src, import.meta.url));
  const ttf = await subsetFont(buf, CHARS, { targetFormat: 'truetype' });
  const out = new URL(`../fonts/${name}.ttf`, import.meta.url);
  writeFileSync(out, ttf);
  console.log(`${name}.ttf  ${(ttf.length / 1024).toFixed(1)} KB`);
}
