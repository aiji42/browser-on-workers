// 土台の確認: フォントを読んで、字を描いて、PNG にする。
// HTML の処理を足す前にここが通らないと先に進めない。
// 実行: node test/glyphs.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { Canvas } from '../src/raster.js';
import { Font, glyphToPolylines } from '../src/ttf.js';
import { encodePNG } from '../src/png.js';

const load = (n) => {
  const b = readFileSync(new URL(`../fonts/${n}.ttf`, import.meta.url));
  return new Font(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
};
const sans = load('sans-regular');
const bold = load('sans-bold');
const mono = load('mono-regular');

console.log('unitsPerEm', sans.unitsPerEm, 'glyphs', sans.numGlyphs, 'cmap entries', sans.cmap.size);
console.log('ascender', sans.ascender, 'descender', sans.descender);

const canvas = new Canvas(640, 260, [255, 255, 255, 255]);

/** 1 行描く。戻り値は右端の x */
function drawText(font, text, x, baseline, sizePx, color) {
  const scale = sizePx / font.unitsPerEm;
  let cx = x;
  for (const ch of text) {
    const gid = font.glyphIndex(ch.codePointAt(0));
    const contours = font.glyphContours(gid);
    if (contours.length) {
      canvas.fillPath(glyphToPolylines(contours, scale, cx, baseline), color);
    }
    cx += font.advance(gid) * scale;
  }
  return cx;
}

const ink = [17, 17, 17, 255];
const accent = [11, 92, 214, 255];

canvas.fillRect(0, 0, 640, 52, [11, 92, 214, 255]);
drawText(bold, 'browser-on-workers', 20, 34, 24, [255, 255, 255, 255]);

drawText(sans, 'The quick brown fox jumps over the lazy dog.', 20, 92, 18, ink);
drawText(sans, 'Sizes: 10 12 14 18 24 32', 20, 120, 14, ink);
drawText(bold, 'Bold weight, same pipeline', 20, 150, 18, accent);
drawText(mono, 'mono: const a = eval("1+1");', 20, 182, 15, ink);

// 小さい字が潰れないかの確認
let y = 210;
for (const size of [9, 11, 13, 16]) {
  drawText(sans, `${size}px sans — AVWjgq0O@#`, 20, y, size, ink);
  y += size + 8;
}

canvas.fillRect(20, 236, 600, 2, [11, 92, 214, 90]);

const png = await encodePNG(canvas.data, canvas.width, canvas.height);
writeFileSync(new URL('../test-glyphs.png', import.meta.url), png);
console.log('wrote test-glyphs.png', png.length, 'bytes');
