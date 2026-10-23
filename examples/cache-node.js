// The same cache tiers with no Workers anywhere: memory (SIEVE) → singleflight → files → render.
//   node examples/cache-node.js        run it twice: the second run is served from out/cache
import { readFileSync } from 'node:fs';
import { loadFont, renderText, flattenCache } from 'glyph';
import { memo, Policy, layered, origin, memory, singleflight, store, pngJob } from 'glyph/cache';
import { fsStore } from 'glyph/cache/node';

const font = (await loadFont(readFileSync(new URL('../third_party/fonts/inter-latin-400.woff2', import.meta.url)))).value;
const outlines = flattenCache();                                  // L0: flattened glyphs
const l1 = memory(memo(Policy.Sieve, { maxBytes: 16 << 20 }));    // L1: rendered PNGs in memory
const files = store(fsStore(new URL('../out/cache/', import.meta.url).pathname)); // L2: disk
const load = layered(l1, singleflight(), files)(origin);

const requests = ['Cloudflare', 'Workers', 'Cloudflare', 'Edge', 'Workers', 'Cloudflare'];
for (const text of requests) {
  const t = performance.now();
  const r = await renderText([{ font, fontKey: 'inter', text, size: 96 }], { targets: [] });
  const job = pngJob(r.value.scene, { outlines });
  const r2 = await load(job);
  if (r2.tag === 'Err') { console.error(text, r2.error); continue; }
  const png = r2.value;
  console.log(`${text.padEnd(11)} ${job.key.slice(0, 12)}…  ${String(png.length).padStart(6)} B  ${(performance.now() - t).toFixed(2).padStart(6)} ms`);
}
console.log('memory', l1.stats, ' files', files.stats);
