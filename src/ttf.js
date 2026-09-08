// TrueType のフォントファイルから、文字の輪郭と字送り幅を取り出す。
//
// 使うテーブルは 6 つ:
//   head  unitsPerEm と loca の形式
//   maxp  グリフ数
//   cmap  文字コード -> グリフ番号 (format 4 と 12 だけ見る)
//   hhea  hmtx の件数
//   hmtx  字送り幅
//   loca  glyf の中の位置
//   glyf  輪郭そのもの
//
// 輪郭は 2 次ベジエで入っているので、折れ線に落として raster.js に渡す。

export class Font {
  constructor(buffer) {
    this.dv = new DataView(buffer);
    this.tables = {};
    const numTables = this.dv.getUint16(4);
    for (let i = 0; i < numTables; i++) {
      const o = 12 + i * 16;
      let tag = '';
      for (let j = 0; j < 4; j++) tag += String.fromCharCode(this.dv.getUint8(o + j));
      this.tables[tag.trim()] = { offset: this.dv.getUint32(o + 8), length: this.dv.getUint32(o + 12) };
    }
    const head = this.tables.head.offset;
    this.unitsPerEm = this.dv.getUint16(head + 18);
    this.indexToLocFormat = this.dv.getInt16(head + 50);
    this.numGlyphs = this.dv.getUint16(this.tables.maxp.offset + 4);
    this.numHMetrics = this.dv.getUint16(this.tables.hhea.offset + 34);
    this.ascender = this.dv.getInt16(this.tables.hhea.offset + 4);
    this.descender = this.dv.getInt16(this.tables.hhea.offset + 6);
    this.cmap = this.#readCmap();
    this.glyphCache = new Map();
  }

  #readCmap() {
    const base = this.tables.cmap.offset;
    const n = this.dv.getUint16(base + 2);
    let best = null;
    for (let i = 0; i < n; i++) {
      const rec = base + 4 + i * 8;
      const platform = this.dv.getUint16(rec);
      const encoding = this.dv.getUint16(rec + 2);
      const offset = this.dv.getUint32(rec + 4);
      // Unicode を引ける組み合わせだけ拾う
      const usable = (platform === 3 && (encoding === 1 || encoding === 10)) || platform === 0;
      if (usable) best = base + offset;
    }
    if (best == null) return new Map();

    const map = new Map();
    const format = this.dv.getUint16(best);
    if (format === 4) {
      const segX2 = this.dv.getUint16(best + 6);
      const seg = segX2 / 2;
      const ends = best + 14;
      const starts = ends + segX2 + 2;
      const deltas = starts + segX2;
      const ranges = deltas + segX2;
      for (let i = 0; i < seg; i++) {
        const end = this.dv.getUint16(ends + i * 2);
        const start = this.dv.getUint16(starts + i * 2);
        const delta = this.dv.getInt16(deltas + i * 2);
        const rangeOffset = this.dv.getUint16(ranges + i * 2);
        if (start === 0xffff) continue;
        for (let c = start; c <= end && c !== 0x10000; c++) {
          let g;
          if (rangeOffset === 0) {
            g = (c + delta) & 0xffff;
          } else {
            const addr = ranges + i * 2 + rangeOffset + (c - start) * 2;
            g = this.dv.getUint16(addr);
            if (g !== 0) g = (g + delta) & 0xffff;
          }
          if (g) map.set(c, g);
        }
      }
    } else if (format === 12) {
      const nGroups = this.dv.getUint32(best + 12);
      for (let i = 0; i < nGroups; i++) {
        const g = best + 16 + i * 12;
        const start = this.dv.getUint32(g);
        const end = this.dv.getUint32(g + 4);
        const startGlyph = this.dv.getUint32(g + 8);
        for (let c = start; c <= end; c++) map.set(c, startGlyph + (c - start));
      }
    }
    return map;
  }

  glyphIndex(codePoint) {
    return this.cmap.get(codePoint) ?? 0;
  }

  /** 字送り幅 (フォント単位) */
  advance(glyphId) {
    const hmtx = this.tables.hmtx.offset;
    const i = Math.min(glyphId, this.numHMetrics - 1);
    return this.dv.getUint16(hmtx + i * 4);
  }

  #locaRange(glyphId) {
    const loca = this.tables.loca.offset;
    if (this.indexToLocFormat === 0) {
      return [this.dv.getUint16(loca + glyphId * 2) * 2, this.dv.getUint16(loca + (glyphId + 1) * 2) * 2];
    }
    return [this.dv.getUint32(loca + glyphId * 4), this.dv.getUint32(loca + (glyphId + 1) * 4)];
  }

  /**
   * グリフの輪郭を取り出す。返すのはフォント単位の座標 (y は上向き)。
   * 合成グリフ (アクセント付きなど) は構成要素を平行移動して合わせる。
   */
  glyphContours(glyphId, depth = 0) {
    if (this.glyphCache.has(glyphId)) return this.glyphCache.get(glyphId);
    const [start, end] = this.#locaRange(glyphId);
    if (start >= end || depth > 4) return [];
    const g = this.tables.glyf.offset + start;
    const numContours = this.dv.getInt16(g);

    let result;
    if (numContours < 0) {
      result = this.#compositeContours(g, depth);
    } else {
      result = this.#simpleContours(g, numContours);
    }
    this.glyphCache.set(glyphId, result);
    return result;
  }

  #simpleContours(g, numContours) {
    const endPts = [];
    for (let i = 0; i < numContours; i++) endPts.push(this.dv.getUint16(g + 10 + i * 2));
    const numPts = numContours ? endPts[numContours - 1] + 1 : 0;
    const insLen = this.dv.getUint16(g + 10 + numContours * 2);
    let p = g + 10 + numContours * 2 + 2 + insLen;

    // フラグ (繰り返し圧縮あり)
    const flags = new Uint8Array(numPts);
    for (let i = 0; i < numPts;) {
      const f = this.dv.getUint8(p++);
      flags[i++] = f;
      if (f & 8) {
        let rep = this.dv.getUint8(p++);
        while (rep-- > 0 && i < numPts) flags[i++] = f;
      }
    }
    // x は差分。short/same のビットで長さと符号が変わる
    const xs = new Int16Array(numPts);
    let x = 0;
    for (let i = 0; i < numPts; i++) {
      const f = flags[i];
      if (f & 2) { const d = this.dv.getUint8(p++); x += (f & 16) ? d : -d; }
      else if (!(f & 16)) { x += this.dv.getInt16(p); p += 2; }
      xs[i] = x;
    }
    const ys = new Int16Array(numPts);
    let y = 0;
    for (let i = 0; i < numPts; i++) {
      const f = flags[i];
      if (f & 4) { const d = this.dv.getUint8(p++); y += (f & 32) ? d : -d; }
      else if (!(f & 32)) { y += this.dv.getInt16(p); p += 2; }
      ys[i] = y;
    }

    const contours = [];
    let s = 0;
    for (let c = 0; c < numContours; c++) {
      const e = endPts[c];
      const pts = [];
      for (let i = s; i <= e; i++) pts.push({ x: xs[i], y: ys[i], on: !!(flags[i] & 1) });
      if (pts.length) contours.push(pts);
      s = e + 1;
    }
    return contours;
  }

  #compositeContours(g, depth) {
    let p = g + 10;
    const out = [];
    for (;;) {
      const flags = this.dv.getUint16(p);
      const glyphIndex = this.dv.getUint16(p + 2);
      p += 4;
      let dx = 0, dy = 0;
      if (flags & 1) { dx = this.dv.getInt16(p); dy = this.dv.getInt16(p + 2); p += 4; }
      else { dx = this.dv.getInt8(p); dy = this.dv.getInt8(p + 1); p += 2; }
      // 拡大縮小や回転は扱わない (平行移動だけ合わせる)
      if (flags & 8) p += 2;
      else if (flags & 0x40) p += 4;
      else if (flags & 0x80) p += 8;

      for (const c of this.glyphContours(glyphIndex, depth + 1)) {
        out.push(c.map((pt) => ({ x: pt.x + dx, y: pt.y + dy, on: pt.on })));
      }
      if (!(flags & 0x20)) break;
    }
    return out;
  }
}

/**
 * グリフの輪郭を、描画用の折れ線に変換する。
 * TrueType の点列は「on 点と off 点 (制御点) が交互」ではなく、
 * off が連続したら中点に暗黙の on 点があるという規則なので、そこを補う。
 */
export function glyphToPolylines(contours, scale, originX, baselineY) {
  const px = (p) => ({ x: originX + p.x * scale, y: baselineY - p.y * scale });
  const out = [];

  for (const c of contours) {
    if (c.length < 2) continue;
    // 開始点は on 点にしたい。無ければ中点を作る
    let pts = c;
    const firstOn = pts.findIndex((p) => p.on);
    if (firstOn === -1) {
      const mid = { x: (pts[0].x + pts[pts.length - 1].x) / 2, y: (pts[0].y + pts[pts.length - 1].y) / 2, on: true };
      pts = [mid, ...pts];
    } else if (firstOn > 0) {
      pts = [...pts.slice(firstOn), ...pts.slice(0, firstOn)];
    }

    const line = [px(pts[0])];
    let i = 1;
    const n = pts.length;
    while (i <= n) {
      const cur = pts[i % n];
      if (cur.on) {
        line.push(px(cur));
        i++;
        continue;
      }
      // 制御点。次が off なら中点が暗黙の終点
      const next = pts[(i + 1) % n];
      const endPt = next.on ? next : { x: (cur.x + next.x) / 2, y: (cur.y + next.y) / 2 };
      const from = line[line.length - 1];
      const ctrl = px(cur);
      const to = px(endPt);
      // 2 次ベジエを折れ線にする。長さに応じて分割数を決める
      const dist = Math.abs(to.x - from.x) + Math.abs(to.y - from.y) + Math.abs(ctrl.x - from.x) + Math.abs(ctrl.y - from.y);
      const steps = Math.max(2, Math.min(24, Math.ceil(dist / 2)));
      for (let s = 1; s <= steps; s++) {
        const t = s / steps, u = 1 - t;
        line.push({
          x: u * u * from.x + 2 * u * t * ctrl.x + t * t * to.x,
          y: u * u * from.y + 2 * u * t * ctrl.y + t * t * to.y,
        });
      }
      i += next.on ? 2 : 1;
    }
    out.push(line);
  }
  return out;
}
