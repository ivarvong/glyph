// Deflate A/B on real PNG row data: every zlib we ship, plus node:zlib levels as a yardstick.
//   node bench/deflate.js            (row data = unfiltered rows of each poster, as encodePng feeds it)
import { deflateSync } from 'node:zlib';
import { rasterize, scanline, flattenCache } from '../render/src/raster.js';
import { unfilteredRows, zlibOf } from '../render/src/png.js';
import { Lz, Entropy } from '../render/src/deflate.js';
import { ZLIBS } from '../render/src/targets.js';
import { NOOP_SPAN } from '../otel-compact/src/trace.js';

process.env.ONLY = 'none'; // load poster scene builders without rendering them
const { SCENES } = await import('../examples/posters.js');
const med = (a) => a.sort((x, y) => x - y)[a.length >> 1];
const rows = {};
for (const [name, build] of Object.entries(SCENES)) {
  const img = rasterize(build(), scanline, NOOP_SPAN, { cache: flattenCache() });
  rows[name] = unfilteredRows(img.data, img.width, img.height, img.channels);
}
const CANDIDATES = process.env.SWEEP ? [
  zlibOf({ name: 'greedy·dyn', lz: Lz.Greedy, entropy: Entropy.Dynamic }),
  ...[[4, 4, 16, 4], [8, 8, 32, 4], [16, 16, 64, 8], [32, 32, 128, 8], [128, 128, 258, 32]].map(([c, l, n, g]) =>
    zlibOf({ name: `chain${c}·dyn`, lz: Lz.Chain(c, l, n, g), entropy: Entropy.Dynamic })),
] : [];
const coders = [
  ...[...ZLIBS, ...CANDIDATES].map((z) => ({ name: z.name, run: (b) => z.deflate(b) })),
  ...[1, 6, 9].map((level) => ({ name: `node -${level}`, run: async (b) => deflateSync(b, { level }) })),
];
console.log('input'.padEnd(10) + coders.map((c) => c.name.padStart(16)).join(''));
const total = Object.fromEntries(coders.map((c) => [c.name, [0, 0]]));
for (const [name, raw] of Object.entries(rows)) {
  const cells = [];
  for (const c of coders) {
    let out; const ts = [];
    for (let i = 0; i < 5; i++) { const t = performance.now(); out = await c.run(raw); ts.push(performance.now() - t); }
    const ms = med(ts.slice(1));
    total[c.name][0] += out.length; total[c.name][1] += ms;
    cells.push(`${(out.length / 1024).toFixed(0)}K ${ms.toFixed(0).padStart(4)}ms`.padStart(16));
  }
  console.log(`${name.padEnd(10)}${cells.join('')}   (${(raw.length / 2 ** 20).toFixed(1)} MiB raw)`);
}
console.log('total'.padEnd(10) + coders.map((c) => `${(total[c.name][0] / 1024).toFixed(0)}K ${total[c.name][1].toFixed(0).padStart(4)}ms`.padStart(16)).join(''));
