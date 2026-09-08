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
// ブラウザなら際限なく取りに行くが、Worker には CPU と時間の制限がある
const MAX_STYLESHEETS = 12;
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
    const href = tag.match(/\bhref\s*=\s*["']([^"']+)["']/i)?.[1]
      ?? tag.match(/\bhref\s*=\s*([^"'>\s]+)/i)?.[1];
    if (href) out.push(href);
  }
  return out;
}

/**
 * 外部 CSS を取ってきて、HTML の中に <style> として差し込む。
 * 取れなかったものは黙って飛ばす (1 枚のスタイルシートで落としたくない)。
 */
export async function inlineStylesheets(html, baseUrl) {
  const hrefs = findStylesheetHrefs(html).slice(0, MAX_STYLESHEETS);
  if (!hrefs.length) return { html, fetched: 0, skipped: 0, cssBytes: 0 };

  const results = await Promise.all(hrefs.map(async (href) => {
    let abs;
    try {
      abs = new URL(href, baseUrl).toString();
    } catch {
      return null; // 解決できない href は捨てる
    }
    if (!/^https?:/.test(abs)) return null; // data: や blob: は今回扱わない
    try {
      const res = await fetch(abs, {
        headers: { ...BROWSER_HEADERS, accept: 'text/css,*/*;q=0.1', referer: baseUrl },
        redirect: 'follow',
        signal: AbortSignal.timeout(CSS_TIMEOUT_MS),
      });
      if (!res.ok) return null;
      const text = await res.text();
      // CSS の中の @import と url() の相対参照は、取得元を基準に直す必要がある。
      // ここでは @import だけ絶対 URL に書き換える (url() は画像なので今回は使わない)
      return rewriteImports(text, abs);
    } catch {
      return null;
    }
  }));

  const css = [];
  let bytes = 0;
  let skipped = 0;
  for (const text of results) {
    if (text == null) { skipped++; continue; }
    if (bytes + text.length > MAX_CSS_BYTES) { skipped++; continue; }
    bytes += text.length;
    css.push(text);
  }
  if (!css.length) return { html, fetched: 0, skipped, cssBytes: 0 };

  // </head> の直前に入れる。無ければ先頭に付ける。
  // 元の <link> より後ろに置くので、カスケードの順序は元と同じになる
  const block = `<style data-injected-by="browser-on-workers">\n${css.join('\n')}\n</style>`;
  const idx = html.search(/<\/head\s*>/i);
  const merged = idx >= 0
    ? html.slice(0, idx) + block + html.slice(idx)
    : block + html;

  return { html: merged, fetched: css.length, skipped, cssBytes: bytes };
}

/** CSS の中の @import を絶対 URL に直す。中身は取りに行かない */
function rewriteImports(css, cssUrl) {
  return css.replace(/@import\s+(?:url\(\s*)?["']?([^"')\s;]+)["']?\s*\)?/gi, (m, href) => {
    try {
      return m.replace(href, new URL(href, cssUrl).toString());
    } catch {
      return m;
    }
  });
}
