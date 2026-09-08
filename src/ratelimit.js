// 送信元ごとのリクエスト数を数える Durable Object。
//
// Workers 組み込みの Rate Limiting binding (`unsafe.bindings` の `ratelimit`) を
// 先に試したが、20 発通しても `{ success: true }` しか返らず、まったく効かなかった。
// KV は結果が遅れて伝わるので数えるのに向かない。強い一貫性が要るのでこれにした。
//
// IP ごとに 1 つのインスタンスを作る (`idFromName(ip)`)。数はメモリに置くだけで、
// storage には書かない。インスタンスが落ちたら数え直しになるが、悪用を止めるには足りる。
//
// Date.now() は I/O のない区間で進まないが、リクエストの到着そのものが I/O なので、
// ハンドラに入った時点の値は更新されている。

export class RateLimiter {
  constructor() {
    /** @type {number[]} 通したリクエストの時刻 */
    this.hits = [];
  }

  /**
   * 窓は呼び出し側が `?w=<秒>,<回数>` で渡す。インスタンスは
   * 「バケット + IP」ごとに 1 つなので、同じインスタンスには同じ窓しか来ない
   */
  async fetch(request) {
    const windows = new URL(request.url).searchParams
      .getAll('w')
      .map((v) => v.split(',').map(Number))
      .map(([sec, limit]) => [sec * 1000, limit]);
    if (!windows.length) return Response.json({ ok: true, used: 0 });

    const now = Date.now();
    // いちばん長い窓から外れたものは捨てる
    const longest = Math.max(...windows.map(([ms]) => ms));
    this.hits = this.hits.filter((t) => now - t < longest);

    for (const [ms, limit] of windows) {
      const inWindow = this.hits.reduce((n, t) => n + (now - t < ms ? 1 : 0), 0);
      if (inWindow >= limit) {
        return Response.json({ ok: false, retryAfter: Math.ceil(ms / 1000), limit, window: ms });
      }
    }
    this.hits.push(now);
    return Response.json({ ok: true, used: this.hits.length });
  }
}
