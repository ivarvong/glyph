// Replay workloads against every eviction policy at several byte budgets.
//   node bench/replay.js
// A. Glyph level, real work: lines of real prose and code from this repo, popularity Zipf(1.0),
//    3 fonts, sizes from a Zipf over common px sizes. Each request runs the real scenePolygons
//    with a long-lived flatten cache; we report object hit ratio and measured flatten ms.
// B. Render level, simulated: Zipf(0.9) over 20k distinct requests mixed with 25% one-off
//    unique requests (the OG-image-per-URL pattern). Values sized like real PNGs (lognormal
//    around 40 KiB). Reports hit ratio and byte hit ratio. Synthetic: real traffic logs would
//    replace the generator, not the harness.
import { readFileSync } from 'node:fs';
import { loadFont, renderText } from '../index.js';
import { scenePolygons, flattenCache } from '../render/src/raster.js';
import { memo, Policy } from '../cache/src/policy.js';
import { NOOP_SPAN } from '../otel-compact/src/trace.js';

let seed = 42;
const rnd = () => ((seed = (Math.imul(seed ^ (seed >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0) / 2 ** 32);
/** Zipf sampler over n ranks with exponent s (inverse CDF on a precomputed table). */
const zipf = (n, s) => {
  const cdf = new Float64Array(n); let acc = 0;
  for (let i = 0; i < n; i++) { acc += 1 / (i + 1) ** s; cdf[i] = acc; }
  return () => { const u = rnd() * acc; let lo = 0, hi = n - 1; while (lo < hi) { const m = (lo + hi) >> 1; if (cdf[m] < u) lo = m + 1; else hi = m; } return lo; };
};
const POLICIES = [['fifo', Policy.Fifo], ['lru', Policy.Lru], ['sieve', Policy.Sieve], ['s3fifo', Policy.S3Fifo(0.1)]];
const pct = (x) => `${(100 * x).toFixed(1)}%`.padStart(7);

// ---------------------------------------------------------------- A. glyph level
const load = async (f) => (await loadFont(readFileSync(new URL(`../third_party/fonts/${f}`, import.meta.url)))).value;
const faces = [['inter', await load('inter-latin-400.woff2')], ['serif', await load('source-serif-4-regular.otf.woff2')], ['mono', await load('jetbrains-mono-latin-400.woff2')]];
const corpus = [readFileSync(new URL('../README.md', import.meta.url), 'utf8'), readFileSync(new URL('../render/src/raster.js', import.meta.url), 'utf8')]
  .join('\n').split('\n').map((l) => l.trim().replace(/[^\x20-\x7e]/g, '')).filter((l) => l.length > 12).map((l) => l.slice(0, 90));
const SIZES = [16, 14, 13, 12, 18, 20, 24, 32, 11, 48, 64, 96, 40, 28, 22];
const pickLine = zipf(corpus.length, 1.0), pickSize = zipf(SIZES.length, 1.1), pickFace = zipf(faces.length, 0.8);
const N = Number(process.env.N ?? 1500);
const requests = [];
for (let i = 0; i < N; i++) {
  const [key, font] = faces[pickFace()];
  requests.push({ font, fontKey: key, text: corpus[pickLine()], size: SIZES[pickSize()] * (rnd() < 0.3 ? 2 : 1) });
}
const scenes = [];
for (const r of requests) scenes.push((await renderText([r], { targets: [] })).value.scene);
const uniqueBytes = (() => { const c = flattenCache({ maxBytes: 1 << 30 }); for (const s of scenes) scenePolygons(s, NOOP_SPAN, c); return c.stats.bytes; })();
console.log(`A. glyph level: ${N} requests, ${corpus.length} lines, ${scenes.reduce((n, s) => n + s.items.length, 0)} glyph placements, working set ${(uniqueBytes / 2 ** 20).toFixed(1)} MiB of outlines`);
console.log('   budget      ' + POLICIES.map(([n]) => `${n.padStart(8)} hit   ms`).join('   '));
for (const frac of [0.02, 0.05, 0.1, 0.25, 0.5]) {
  const cells = [];
  for (const [, policy] of POLICIES) {
    const c = flattenCache({ policy, maxBytes: Math.floor(uniqueBytes * frac) });
    const t = performance.now();
    for (const s of scenes) scenePolygons(s, NOOP_SPAN, c);
    const ms = performance.now() - t;
    cells.push(`${pct(c.stats.hits / (c.stats.hits + c.stats.misses))} ${ms.toFixed(0).padStart(5)}`);
  }
  console.log(`   ${pct(frac)} WS  ${cells.join('   ')}`);
}
{
  const t = performance.now();
  for (const s of scenes) scenePolygons(s); // per-render cache only
  console.log(`   no cross-render cache: ${(performance.now() - t).toFixed(0)} ms`);
}

// ---------------------------------------------------------------- B. render level (simulated)
const DISTINCT = 20000, OPS = 300000;
const pickReq = zipf(DISTINCT, 0.9);
const sizeOf = (id) => Math.round(40960 * Math.exp(((id * 2654435761) % 1000) / 1000 * 1.6 - 0.8)); // ~18–90 KiB, fixed per id
let unique = 0;
const ops = Array.from({ length: OPS }, () => (rnd() < 0.25 ? `u${unique++}` : `r${pickReq()}`));
const bytesOf = (k) => (k[0] === 'u' ? 40960 : sizeOf(Number(k.slice(1))));
const wsBytes = (() => { const seen = new Set(); let b = 0; for (const k of ops) if (!seen.has(k)) { seen.add(k); b += bytesOf(k); } return b; })();
console.log(`\nB. render level (simulated): ${OPS} requests, ${DISTINCT} popular + ${unique} one-off, working set ${(wsBytes / 2 ** 30).toFixed(2)} GiB`);
console.log('   budget      ' + POLICIES.map(([n]) => `${n.padStart(8)} hit  byte`).join('   '));
for (const frac of [0.005, 0.01, 0.02, 0.05, 0.1]) {
  const cells = [];
  for (const [, policy] of POLICIES) {
    const m = memo(policy, { maxBytes: Math.floor(wsBytes * frac) });
    let hitB = 0, allB = 0;
    for (const k of ops) {
      const b = bytesOf(k); allB += b;
      if (m.get(k).tag === 'Some') hitB += b; else m.set(k, 1, b);
    }
    cells.push(`${pct(m.stats.hits / OPS)}${pct(hitB / allB)}`);
  }
  console.log(`   ${pct(frac)} WS  ${cells.join('   ')}`);
}

// ---------------------------------------------------------------- C. policy overhead
const keys = Array.from({ length: 1 << 16 }, (_, i) => `k${i}`);
const pick = zipf(keys.length, 1.0);
const trace = Int32Array.from({ length: 1 << 20 }, pick);
console.log('\nC. per-operation cost (get, set on miss), 1M ops, Zipf(1.0) over 65k keys, 8k-entry cache');
for (const [name, policy] of POLICIES) {
  const m = memo(policy, { maxBytes: 8192 });
  const t = performance.now();
  for (let i = 0; i < trace.length; i++) { const k = keys[trace[i]]; if (m.get(k).tag === 'None') m.set(k, 1); }
  console.log(`   ${name.padEnd(7)} ${((performance.now() - t) * 1e6 / trace.length).toFixed(0).padStart(4)} ns/op   hit ${pct(m.stats.hits / trace.length)}`);
}
