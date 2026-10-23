// Workers Cache stand-in, in front of the main worker's Renders entrypoint (binding ORIGIN).
// Models the documented behaviour we depend on: read-through keyed by cf.cacheKey (else URL),
// honours Cache-Control max-age / immutable / no-store and Cache-Tag, answers with
// cf-cache-status HIT | MISS, and purges by tag. It is a model, not production: one colo, no
// tiering, no eviction under pressure, no request collapsing (singleflight lives in the app).
import { WorkerEntrypoint } from 'cloudflare:workers';
const entries = new Map(); // key -> { body, status, headers, expires, tags }
const stats = { hits: 0, misses: 0, stored: 0, uncacheable: 0, purged: 0 };
export class Cache extends WorkerEntrypoint {
  async fetch(req) {
    const key = (req.cf && req.cf.cacheKey) || new URL(req.url).pathname + new URL(req.url).search;
    const e = entries.get(key);
    if (e && e.expires > Date.now()) {
      stats.hits++;
      const h = new Headers(e.headers); h.set('cf-cache-status', 'HIT');
      return new Response(e.body, { status: e.status, headers: h });
    }
    stats.misses++;
    const res = await this.env.ORIGIN.fetch(req);
    const body = new Uint8Array(await res.arrayBuffer());
    const cc = res.headers.get('cache-control') || '';
    const m = /max-age=(\d+)/.exec(cc);
    const maxAge = m ? Number(m[1]) : 0;
    if (res.ok && maxAge > 0 && !/no-store|private/.test(cc)) {
      entries.set(key, { body, status: res.status, headers: [...res.headers], expires: Date.now() + maxAge * 1000,
        tags: (res.headers.get('cache-tag') || '').split(',').filter(Boolean) });
      stats.stored++;
    } else stats.uncacheable++;
    const h = new Headers(res.headers); h.set('cf-cache-status', 'MISS');
    return new Response(body, { status: res.status, headers: h });
  }
  purge(tags) { let n = 0; for (const [k, e] of entries) if (e.tags.some((t) => tags.includes(t))) { entries.delete(k); n++; } stats.purged += n; return n; }
  stats() { return { ...stats, entries: entries.size }; }
}
export default { fetch: () => new Response('wcache sim') };
