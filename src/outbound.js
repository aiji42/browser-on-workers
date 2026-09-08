// 外に出る取得をここ 1 箇所にまとめる。
// Kitesurf が SandboxOutbound という 1 コンポーネントにネットワークを閉じ込めて
// いるのと同じ考え方。呼び出し側からは「URL を渡すと描ける HTML が返る」だけに見える。
//
// Rust 側 (Blitz) はサブリソースを取りに行かないので、外部 CSS は Worker が取ってきて
// インラインの <style> として本文に差し込む。これをやらないと、実ページはどれも
// スタイルの当たっていない素の文書として描かれてしまう。

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
function decodeEntities(s) {
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
export async function fetchStylesheets(html, baseUrl) {
  const hrefs = findStylesheetHrefs(html).slice(0, MAX_STYLESHEETS);
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
export async function fetchImages(html, baseUrl) {
  const urls = findImageUrls(html, baseUrl);
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
  let skipped = 0;
  for (const g of got) {
    if (!g) { skipped++; continue; }
    if (bytes + g.bytes.length > MAX_IMAGE_BYTES) { skipped++; continue; }
    bytes += g.bytes.length;
    images.push(g);
  }
  return { images, skipped, bytes };
}
