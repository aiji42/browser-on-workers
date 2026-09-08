// Rust 側の描画が出来上がる前に、JS 側の継ぎ目が Workers で通るかを確かめる。
//
//   1. TTF を Data モジュールとして import できるか
//   2. CompressionStream('deflate') があるか (PNG の IDAT に必要)
//   3. 自前の PNG エンコーダが workerd で動くか
//   4. fetch で実ページの HTML が取れるか
//
// 確認が済んだら消す。
import { encodePNG } from '../src/png.js';
import fontTtf from '../fonts/sans-regular.ttf';

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === '/env') {
      return Response.json({
        fontBytes: fontTtf?.byteLength ?? null,
        fontMagic: fontTtf ? [...new Uint8Array(fontTtf.slice(0, 4))].map((b) => b.toString(16)).join('') : null,
        CompressionStream: typeof CompressionStream,
        deflateOk: (() => { try { new CompressionStream('deflate'); return true; } catch (e) { return String(e.message); } })(),
        WebAssembly: typeof WebAssembly,
        // Workers に無いものの確認
        performanceMemory: typeof performance?.memory,
        evalAllowed: (() => { try { eval('1+1'); return true; } catch (e) { return String(e.message); } })(),
      });
    }

    if (url.pathname === '/png') {
      const w = 320, h = 200;
      const rgba = new Uint8Array(w * h * 4);
      // 目で見て分かる絵にする。横グラデ + 縦の帯
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4;
          rgba[i] = Math.round((x / w) * 255);
          rgba[i + 1] = Math.round((y / h) * 255);
          rgba[i + 2] = (Math.floor(x / 20) % 2) ? 200 : 60;
          rgba[i + 3] = 255;
        }
      }
      const t = Date.now();
      const png = await encodePNG(rgba, w, h);
      return new Response(png, {
        headers: {
          'content-type': 'image/png',
          'x-encode-ms': String(Date.now() - t),
          'x-png-bytes': String(png.length),
        },
      });
    }

    if (url.pathname === '/fetch') {
      const target = url.searchParams.get('url') ?? 'https://example.com/';
      const t = Date.now();
      const res = await fetch(target, {
        headers: {
          accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) browser-on-workers/0.1',
        },
        redirect: 'follow',
      });
      const html = await res.text();
      return Response.json({
        status: res.status,
        contentType: res.headers.get('content-type'),
        bytes: html.length,
        ms: Date.now() - t,
        head: html.slice(0, 160),
      });
    }

    return new Response('/env /png /fetch?url=', { status: 404 });
  },
};
