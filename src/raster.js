// ラスタライザ。RGBA のバッファに矩形と多角形を塗る。
//
// アンチエイリアスは、1 ピクセルを縦 4 本のサブスキャンラインに割って、
// 各本で「内側になった区間」を求め、横方向は端の小数分だけ部分的に足す方式。
// フォントの輪郭は nonzero で塗る (TrueType がその規則)。

const SUB = 4; // 1 ピクセルあたりのサブスキャンライン数

export class Canvas {
  constructor(width, height, bg = [255, 255, 255, 255]) {
    this.width = width;
    this.height = height;
    this.data = new Uint8Array(width * height * 4);
    this.fillRect(0, 0, width, height, bg);
  }

  /** 1 ピクセルに色を alpha (0..1) で乗せる */
  blend(x, y, [r, g, b, a], cov) {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const alpha = (a / 255) * cov;
    if (alpha <= 0) return;
    const i = (y * this.width + x) * 4;
    const d = this.data;
    d[i] = d[i] + (r - d[i]) * alpha;
    d[i + 1] = d[i + 1] + (g - d[i + 1]) * alpha;
    d[i + 2] = d[i + 2] + (b - d[i + 2]) * alpha;
    d[i + 3] = Math.max(d[i + 3], Math.round(alpha * 255));
  }

  fillRect(x, y, w, h, color) {
    const x0 = Math.max(0, Math.floor(x));
    const y0 = Math.max(0, Math.floor(y));
    const x1 = Math.min(this.width, Math.ceil(x + w));
    const y1 = Math.min(this.height, Math.ceil(y + h));
    for (let py = y0; py < y1; py++) {
      for (let px = x0; px < x1; px++) {
        // 端のピクセルは矩形との重なりぶんだけ塗る
        const cx = Math.min(x + w, px + 1) - Math.max(x, px);
        const cy = Math.min(y + h, py + 1) - Math.max(y, py);
        this.blend(px, py, color, Math.max(0, Math.min(1, cx)) * Math.max(0, Math.min(1, cy)));
      }
    }
  }

  /**
   * 多角形の集まりを塗る。contours は [[{x,y}, ...], ...]。
   * 曲線は呼び出し側で折れ線に落としてから渡す。
   */
  fillPath(contours, color) {
    // 辺を集める。水平な辺は交差判定に使えないので捨てる
    const edges = [];
    let minY = Infinity, maxY = -Infinity, minX = Infinity, maxX = -Infinity;
    for (const c of contours) {
      for (let i = 0; i < c.length; i++) {
        const a = c[i], b = c[(i + 1) % c.length];
        if (a.y === b.y) continue;
        edges.push({ x0: a.x, y0: a.y, x1: b.x, y1: b.y, dir: b.y > a.y ? 1 : -1 });
        minY = Math.min(minY, a.y, b.y); maxY = Math.max(maxY, a.y, b.y);
        minX = Math.min(minX, a.x, b.x); maxX = Math.max(maxX, a.x, b.x);
      }
    }
    if (!edges.length) return;

    const yStart = Math.max(0, Math.floor(minY));
    const yEnd = Math.min(this.height, Math.ceil(maxY));
    const xStart = Math.max(0, Math.floor(minX));
    const xEnd = Math.min(this.width, Math.ceil(maxX));
    if (xEnd <= xStart) return;

    const cov = new Float32Array(xEnd - xStart);
    const xs = [];

    for (let py = yStart; py < yEnd; py++) {
      cov.fill(0);
      for (let s = 0; s < SUB; s++) {
        const sy = py + (s + 0.5) / SUB;
        xs.length = 0;
        for (const e of edges) {
          const lo = Math.min(e.y0, e.y1), hi = Math.max(e.y0, e.y1);
          if (sy < lo || sy >= hi) continue;
          const t = (sy - e.y0) / (e.y1 - e.y0);
          xs.push({ x: e.x0 + t * (e.x1 - e.x0), dir: e.dir });
        }
        if (xs.length < 2) continue;
        xs.sort((a, b) => a.x - b.x);
        // nonzero: 巻き数が 0 でない区間が内側
        let wind = 0;
        for (let i = 0; i < xs.length - 1; i++) {
          wind += xs[i].dir;
          if (wind === 0) continue;
          const spanA = xs[i].x, spanB = xs[i + 1].x;
          const pa = Math.max(xStart, Math.floor(spanA));
          const pb = Math.min(xEnd, Math.ceil(spanB));
          for (let px = pa; px < pb; px++) {
            const overlap = Math.min(spanB, px + 1) - Math.max(spanA, px);
            if (overlap > 0) cov[px - xStart] += overlap / SUB;
          }
        }
      }
      for (let i = 0; i < cov.length; i++) {
        if (cov[i] > 0.002) this.blend(xStart + i, py, color, Math.min(1, cov[i]));
      }
    }
  }
}
