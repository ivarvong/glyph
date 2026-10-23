import { WorkerEntrypoint } from 'cloudflare:workers';
import { loadFont, renderText, flattenCache } from 'glyph';
import { memo, Policy, layered, origin, memory, singleflight, store, r2Store, workersCache, serveCached, pngJob } from 'glyph/cache';
import inter from './inter-latin-400.woff2'; // wrangler rule: { type: "Data" }

// wrangler.jsonc:
//   "exports": { "default": { "type": "worker", "cache": { "enabled": false } },
//                "Renders": { "type": "worker", "cache": { "enabled": true } } },
//   "r2_buckets": [{ "binding": "RENDERS", "bucket_name": "glyph-renders" }]

let font: any;
// Budgets: the isolate's 128 MB is shared by every request it serves at once. Caches take
// 8 + 16 MiB; a banded render peaks at 4–6 MiB (@1x) to 13–22 MiB (@3x) on the posters,
// which leaves room for several concurrent renders.
const outlines = flattenCache({ maxBytes: 8 << 20 });            // L0: flattened glyphs, per isolate
const l1 = memory(memo(Policy.Sieve, { maxBytes: 16 << 20 }));   // L1: PNGs, per isolate
const herd = singleflight();                                     // one render per key per isolate
let below: any;                                                  // L3 + render, built on first use

async function job(url: URL, defer?: (p: Promise<unknown>) => void) {
  font ??= (await loadFont(inter)).value;
  const text = url.searchParams.get('t') ?? 'Hello, edge';
  const size = Math.min(512, Number(url.searchParams.get('s') ?? 96));
  const r = await renderText([{ font, fontKey: 'inter', text, size }], { targets: [] });
  return { ...pngJob(r.value.scene, { outlines, meta: { query: url.search } }), defer };
}

// L2 lives here: Workers Cache in front of this entrypoint, keyed by cf.cacheKey (the content key).
// On a miss: singleflight → R2 → render. Writes to R2 go through this request's waitUntil.
export class Renders extends WorkerEntrypoint<Env> {
  fetch(req: Request) {
    below ??= layered(herd, store(r2Store(this.env.RENDERS, { contentType: 'image/png' })))(origin);
    return serveCached(below, (r) => job(new URL(r.url), (p) => this.ctx.waitUntil(p)), { tags: () => ['glyph'] })(req);
  }
}

export default {
  async fetch(req, env, ctx) {
    const load = layered(l1, workersCache(ctx.exports.Renders, { url: (j) => `https://renders/${j.meta.query}` }))(origin);
    const j = await job(new URL(req.url));
    const r = await load(j);
    if (r.tag === 'Err') return new Response(r.error, { status: 502, headers: { 'cache-control': 'no-store' } });
    return new Response(r.value, { headers: { 'content-type': 'image/png', etag: `"${j.key}"` } });
  },
} satisfies ExportedHandler<Env>;
