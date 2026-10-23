import { fetchFont, allowHosts, describeFetchError, renderText, flattenCache } from 'glyph';
import { memo, Policy, layered, origin, memory, store, r2Store, pngJob, serveCached } from 'glyph/cache';

// GET /?font=<url>&t=<text>&s=<px>: render text in a user-supplied font.
// wrangler.jsonc: "r2_buckets": [{ "binding": "FONTS", "bucket_name": "glyph-fonts" }]
//
// Untrusted input on two axes: the URL (policy: allowlisted https hosts only, re-checked on every
// redirect, 10 s deadline, 16 MiB cap) and the bytes (the fuzzed parser, plus a canvas cap so a
// hostile font's metrics cannot make a 20 Mpx render).
const policy = allowHosts(['fonts.gstatic.com', '*.jsdelivr.net']);
const fonts = memo(Policy.Lru, { maxBytes: 24 << 20, sizeOf: (e) => e.bytes.length * 4 }); // parsed, by content hash
const fontBytes = memory(memo(Policy.Sieve, { maxBytes: 8 << 20, sizeOf: (b) => b.length })); // raw, by URL
const outlines = flattenCache({ maxBytes: 8 << 20 });
let via: any; // memory → R2 → network, built on first use (needs env)

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

export default {
  async fetch(req, env, ctx) {
    const u = new URL(req.url);
    via ??= layered(fontBytes, store(r2Store(env.FONTS, { contentType: 'font/woff2' })))(origin);
    const f = await fetchFont(u.searchParams.get('font') ?? '', { policy, fonts, via, defer: (p) => ctx.waitUntil(p) });
    if (f.tag === 'Err') {
      if (f.error.tag === 'Load') return json(422, { error: 'not a usable font', detail: f.error.error.tag });
      // Whose fault: the request (bad or refused URL, too large, the origin says 4xx) is 422 and
      // final; the upstream (network, timeout, 5xx) is 502/504 and worth retrying. Through a cache
      // stack (`via`) the error arrives as text, so classify that too.
      const e = f.error.error;
      const detail = typeof e === 'string' ? e : describeFetchError(e);
      const upstream = typeof e === 'string'
        ? /network error|took over|answered 5\d\d/.test(e)
        : e.tag === 'Network' || e.tag === 'Timeout' || (e.tag === 'Status' && e.status >= 500);
      const timeout = typeof e === 'string' ? /took over/.test(e) : e.tag === 'Timeout';
      return json(upstream ? (timeout ? 504 : 502) : 422, { error: 'font fetch', detail });
    }
    const text = (u.searchParams.get('t') ?? 'Hello').slice(0, 200);
    const size = Math.min(256, Math.max(8, Number(u.searchParams.get('s') ?? 96) || 96));
    const r = await renderText([{ font: f.value.font, fontKey: f.value.key, text, size }], { targets: [], maxPixels: 4 << 20 });
    if (r.tag === 'Err') return json(r.error.tag === 'CanvasTooLarge' ? 413 : 422, { error: 'render', detail: r.error });
    const job = pngJob(r.value.scene, { outlines });
    return serveCached(async () => job.make(), async () => job)(req);
  },
} satisfies ExportedHandler<Env>;
