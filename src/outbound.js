// 外に出る取得をここ 1 箇所にまとめる。
// Kitesurf が SandboxOutbound という 1 コンポーネントにネットワークを閉じ込めて
// いるのと同じ考え方。呼び出し側からは「URL を渡すと描ける HTML が返る」だけに見える。
//
// Rust 側 (Blitz) はサブリソースを取りに行かないので、Worker が取ってきて
// 「URL -> バイト列」の表に入れる。これをやらないと、実ページはどれも
// スタイルの当たっていない素の文書として描かれてしまう。
//
// deny を渡すと、その URL は取りに行かない。自分の /shot を指す <img> を
// 描こうとして再帰するのを防ぐために使う。

const BROWSER_HEADERS = {
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'accept-language': 'en-US,en;q=0.9',
  'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) browser-on-workers/0.1',
};

// 1 ページあたりの取得数と量に上限を置く。
// ブラウザなら際限なく取りに行くが、Worker には CPU と時間の制限がある。
// 枚数の上限は低くしすぎると崩れる。MDN のトップは 20 枚あり、12 枚で切ると
// navigation / logo / menu / footer の CSS が落ちてナビが崩れた。
// 実際の歯止めは合計バイト数のほうに置く
const MAX_STYLESHEETS = 40;
const MAX_CSS_BYTES = 2 * 1024 * 1024;
const CSS_TIMEOUT_MS = 5000;

export async function fetchHtml(url) {
  const res = await fetch(url, { headers: BROWSER_HEADERS, redirect: 'follow' });
  if (!res.ok) throw new Error(`origin returned ${res.status}`);
  const type = res.headers.get('content-type') ?? '';
  if (!/html|xml|text\/plain/.test(type)) throw new Error(`unsupported content-type: ${type}`);
  // リダイレクト後の URL を base にしたいので、実際に届いた URL を返す
  return { html: await res.text(), finalUrl: res.url || url };
}

// HTML の属性値は実体参照でエスケープされている。
// 特に URL の中の & は &amp; になっているので、これを戻さないと
// クエリ文字列が壊れる。Wikipedia の /w/load.php?lang=en&amp;modules=... が
// まさにこれで、戻さないと中身のほぼ無い CSS が返ってくる。
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };
export function decodeEntities(s) {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[body.toLowerCase()] ?? m;
  });
}

/** <link rel="stylesheet"> の href を、種類を問わず拾う */
function findStylesheetHrefs(html) {
  const out = [];
  // link タグを 1 つずつ見る。rel と href の順序は決まっていないので個別に読む
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    const rel = tag.match(/\brel\s*=\s*["']?([^"'>\s]+)/i)?.[1]?.toLowerCase();
    if (rel !== 'stylesheet') continue;
    // media が print だけのものは画面の描画に関係しない
    const media = tag.match(/\bmedia\s*=\s*["']([^"']*)["']/i)?.[1]?.toLowerCase();
    if (media && /\bprint\b/.test(media) && !/screen|all/.test(media)) continue;
    const raw = tag.match(/\bhref\s*=\s*["']([^"']+)["']/i)?.[1]
      ?? tag.match(/\bhref\s*=\s*([^"'>\s]+)/i)?.[1];
    if (raw) out.push(decodeEntities(raw));
  }
  return out;
}

/**
 * 外部 CSS を取ってきて、URL とバイト列の組で返す。
 *
 * HTML に `<style>` として差し込む方式はやめた。差し込むと CSS の中の相対 `url()` が
 * ページの URL を基準に解決されてしまう。本来はスタイルシート自身の URL が基準なので、
 * `../img/x.png` のような参照がずれる。
 * 表に入れて Blitz に `<link>` から要求させれば、基準は正しくなる。
 */
export async function fetchStylesheets(html, baseUrl, deny = () => false) {
  const hrefs = findStylesheetHrefs(html).filter((h) => {
    try { return !deny(new URL(h, baseUrl).toString()); } catch { return true; }
  }).slice(0, MAX_STYLESHEETS);
  if (!hrefs.length) return { sheets: [], skipped: 0, bytes: 0 };

  const got = await Promise.all(hrefs.map(async (href) => {
    let abs;
    try {
      abs = new URL(href, baseUrl).toString();
    } catch {
      return null;
    }
    if (!/^https?:/.test(abs)) return null; // data: は Rust 側が解く
    try {
      const res = await fetch(abs, {
        headers: { ...BROWSER_HEADERS, accept: 'text/css,*/*;q=0.1', referer: baseUrl },
        redirect: 'follow',
        signal: AbortSignal.timeout(CSS_TIMEOUT_MS),
      });
      if (!res.ok) return null;
      return { url: abs, bytes: new Uint8Array(await res.arrayBuffer()) };
    } catch {
      return null;
    }
  }));

  const sheets = [];
  let bytes = 0;
  let skipped = 0;
  for (const g of got) {
    if (!g) { skipped++; continue; }
    if (bytes + g.bytes.length > MAX_CSS_BYTES) { skipped++; continue; }
    bytes += g.bytes.length;
    sheets.push(g);
  }
  return { sheets, skipped, bytes };
}



// ── 画像 ─────────────────────────────────────────────────────────
//
// Blitz は画像のデコードは自分でやるが、バイト列の入手は NetProvider に任せている。
// なので Worker が全部取ってきて「URL -> バイト列」の表にして渡す。
// ネットワークは Worker 側の 1 箇所に閉じたままになる。

const MAX_IMAGES = 24;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
// 展開後の画素の大きさで断るための上限。
// 1 枚が大きすぎると wasm のメモリ確保に失敗して panic するので、
// 1 枚ごと (画素数) と全部の合計 (バイト数) の 2 つで見る
const MAX_IMAGE_PIXELS = 8_000_000;               // 8 メガピクセル = 32 MB
const MAX_DECODED_BYTES = 48 * 1024 * 1024;
const IMAGE_TIMEOUT_MS = 5000;

/** <img> の src と srcset、<source> の srcset から URL を集める */
function findImageUrls(html, baseUrl) {
  const urls = new Set();
  const push = (raw) => {
    if (!raw) return;
    const href = decodeEntities(raw.trim());
    if (!href || href.startsWith('data:')) return; // data: は Blitz が持っていれば読める
    try {
      const abs = new URL(href, baseUrl).toString();
      if (/^https?:/.test(abs)) urls.add(abs);
    } catch { /* 解決できない src は捨てる */ }
  };

  // src だけを見る。blitz-dom は srcset を読まないので、拾っても要求されず
  // 取得の枠を無駄に使うだけになる
  for (const tag of html.match(/<img\b[^>]*>/gi) ?? []) {
    push(tag.match(/\bsrc\s*=\s*["']([^"']+)["']/i)?.[1]);
  }
  return [...urls].slice(0, MAX_IMAGES);
}

/**
 * ページの画像を取ってきて、URL とバイト列の組で返す。
 * 取れなかったものは黙って飛ばす。
 */
export async function fetchImages(html, baseUrl, deny = () => false) {
  const urls = findImageUrls(html, baseUrl).filter((u) => !deny(u));
  if (!urls.length) return { images: [], skipped: 0, bytes: 0 };

  const got = await Promise.all(urls.map(async (url) => {
    try {
      const res = await fetch(url, {
        headers: { ...BROWSER_HEADERS, // AVIF は外す。image クレートの AVIF 復号は libdav1d (C) 依存で wasm32 では作れず、
        // 受け取っても 0 画素になる
        accept: 'image/webp,image/png,image/jpeg,image/gif,image/svg+xml,image/*;q=0.8', referer: baseUrl },
        redirect: 'follow',
        signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS),
      });
      if (!res.ok) return null;
      const type = res.headers.get('content-type') ?? '';
      // SVG は usvg 側で扱うので、ここではラスタ画像だけ持ち込む
      if (!/^image\//.test(type)) return null;
      return { url, bytes: new Uint8Array(await res.arrayBuffer()), type };
    } catch {
      return null;
    }
  }));

  const images = [];
  let bytes = 0;
  let decoded = 0;
  let skipped = 0;
  let tooBig = 0;
  for (const g of got) {
    if (!g) { skipped++; continue; }
    if (bytes + g.bytes.length > MAX_IMAGE_BYTES) { skipped++; continue; }
    // 展開後の大きさで断る。ここを通すと wasm 側で panic する
    const size = imageSize(g.bytes);
    if (size) {
      const px = size.width * size.height;
      if (px > MAX_IMAGE_PIXELS || decoded + px * 4 > MAX_DECODED_BYTES) { tooBig++; continue; }
      decoded += px * 4;
    }
    bytes += g.bytes.length;
    images.push(g);
  }
  return { images, skipped, tooBig, bytes, decodedBytes: decoded };
}


// ── 取りこぼしの回収 ─────────────────────────────────────────────
//
// エンジンが要求したのに表に無かった URL を、まとめて取ってくる。
// CSS の中の url() や @font-face は、その CSS を表に入れて初めて読めるので、
// 「描く → 取りこぼしを取る → 描き直す」を何周か回すことになる。

const MAX_MISS_BYTES = 8 * 1024 * 1024;
const MAX_MISS_COUNT = 96;
const MISS_TIMEOUT_MS = 5000;

/** 任意の URL をまとめて取得する。種類 (CSS / 画像 / フォント) は問わない */
export async function fetchResources(urls, baseUrl, deny = () => false, decodedBudget = MAX_DECODED_BYTES) {
  // 上限に当たったときにどれを捨てるかが効く。react.dev は 66 本要求してきて、
  // 上限 64 で落ちた 2 本が Next.js の manifest だった。それが無いと起動の
  // スクリプトが例外を投げ、ページが白くなる。
  // 絵が 1 枚欠けるより、スクリプトやスタイルが欠けるほうが壊れるので先に取る
  const rank = (u) => {
    const path = u.split('?')[0].toLowerCase();
    if (/\.(js|mjs|css)$/.test(path)) return 0;
    if (/\.(woff2?|ttf|otf)$/.test(path)) return 1;
    if (/\.(png|jpe?g|gif|webp|svg|avif|ico)$/.test(path)) return 3;
    return 2;   // 拡張子から分からないもの (API や動的な JS)
  };
  const targets = urls
    .filter((u) => /^https?:/.test(u))
    .filter((u) => !u.startsWith('https://inline.invalid/')) // base が無いときの見せかけの URL
    .filter((u) => !deny(u))
    .sort((a, b) => rank(a) - rank(b))
    .slice(0, MAX_MISS_COUNT);
  if (!targets.length) return { got: [], skipped: 0, bytes: 0 };

  const results = await Promise.all(targets.map(async (url) => {
    try {
      const res = await fetch(url, {
        headers: { ...BROWSER_HEADERS, accept: '*/*', referer: baseUrl },
        redirect: 'follow',
        signal: AbortSignal.timeout(MISS_TIMEOUT_MS),
      });
      if (!res.ok) return null;
      return { url, bytes: new Uint8Array(await res.arrayBuffer()) };
    } catch {
      return null;
    }
  }));

  const got = [];
  let bytes = 0;
  let decoded = 0;
  let skipped = 0;
  let tooBig = 0;
  for (const r of results) {
    if (!r) { skipped++; continue; }
    if (bytes + r.bytes.length > MAX_MISS_BYTES) { skipped++; continue; }
    // CSS の url() から来る画像もここを通る。1 枚で 87 MB に展開されるものがあるので、
    // <img> と同じ基準で断る (通すと wasm のメモリ確保が失敗して panic する)
    const size = imageSize(r.bytes);
    if (size) {
      const px = size.width * size.height;
      if (px > MAX_IMAGE_PIXELS || decoded + px * 4 > decodedBudget) { tooBig++; continue; }
      decoded += px * 4;
    }
    bytes += r.bytes.length;
    got.push(r);
  }
  return { got, skipped, tooBig, bytes, decodedBytes: decoded };
}

/**
 * 画像の先頭から幅と高さを読む。分からなければ null。
 *
 * デコード後の画素は幅 × 高さ × 4 バイトになるので、圧縮されたファイルの
 * 大きさでは足りない。5263 KB の JPEG が 24 枚あっても平気だが、その中の
 * 1 枚が 87 MB に展開されると wasm のメモリ確保が失敗して panic する
 * (image クレートの `TryReserveError`)。だから展開後の大きさで先に断る。
 */
export function imageSize(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u8 = bytes;
  const at = (i) => u8[i];

  // PNG: 8 バイトの署名のあと IHDR (幅と高さが 4 バイトずつ)
  if (u8.length > 24 && at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) {
    return { width: dv.getUint32(16), height: dv.getUint32(20) };
  }

  // GIF: "GIF8" のあと 2 バイトずつ (little endian)
  if (u8.length > 10 && at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46) {
    return { width: dv.getUint16(6, true), height: dv.getUint16(8, true) };
  }

  // WebP: RIFF....WEBP のあと VP8 / VP8L / VP8X で持ち方が違う
  if (u8.length > 30 && at(0) === 0x52 && at(8) === 0x57 && at(9) === 0x45 && at(10) === 0x42) {
    const fourcc = String.fromCharCode(at(12), at(13), at(14), at(15));
    if (fourcc === 'VP8 ') {
      return { width: dv.getUint16(26, true) & 0x3fff, height: dv.getUint16(28, true) & 0x3fff };
    }
    if (fourcc === 'VP8L') {
      const b = dv.getUint32(21, true);
      return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
    }
    if (fourcc === 'VP8X') {
      const w = at(24) | (at(25) << 8) | (at(26) << 16);
      const h = at(27) | (at(28) << 8) | (at(29) << 16);
      return { width: w + 1, height: h + 1 };
    }
    return null;
  }

  // JPEG: SOI のあとマーカーを辿って SOF を探す
  if (u8.length > 4 && at(0) === 0xff && at(1) === 0xd8) {
    let i = 2;
    while (i + 9 < u8.length) {
      if (at(i) !== 0xff) { i++; continue; }
      const marker = at(i + 1);
      // スタンドアロンのマーカー (長さを持たない)
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      const len = dv.getUint16(i + 2);
      // SOF0..SOF3 / SOF5..SOF7 / SOF9..SOF11 / SOF13..SOF15
      const isSof = marker >= 0xc0 && marker <= 0xcf
        && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSof) return { width: dv.getUint16(i + 7), height: dv.getUint16(i + 5) };
      if (marker === 0xda) break;   // 画素の始まり。ここまでに無ければ諦める
      i += 2 + len;
    }
    return null;
  }

  return null;   // SVG など。展開後の大きさが分からないものは通す
}
