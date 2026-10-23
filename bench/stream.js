// Whole-image vs banded PNG: time (interleaved medians) and peak ArrayBuffer memory.
//   node --expose-gc bench/stream.js
// Peak memory: per variant in a fresh process (see CHILD below).
import { readFileSync } from 'node:fs';
import { autoBrotli } from '../woff2/src/brotli.js';
import { loadFont, renderText } from '../render/src/text.js';
import { rasterize, scanline, flattenCache } from '../render/src/raster.js';
import { encodePng, fastZlib } from '../render/src/png.js';
import { encodePngBanded } from '../render/src/stream.js';
import { NOOP_SPAN } from '../otel-compact/src/trace.js';

const gc = /** @type {any} */ (globalThis).gc ?? (() => {});
const load = async (f) => (await loadFont(new Uint8Array(readFileSync(new URL(`../third_party/fonts/${f}`, import.meta.url))), { brotli: autoBrotli })).value;
const inter = await load('inter-latin-400.woff2'), serif = await load('source-serif-4-regular.otf.woff2');
const PROSE = 'Cloudflare Workers provides a serverless execution environment that allows you to create new applications';
const SCENES = {
  'Cloudflare @384': [{ font: inter, fontKey: 'i', text: 'Cloudflare', size: 384 }],
  'prose 24 lines @48': Array.from({ length: 24 }, (_, i) => ({ font: i % 2 ? serif : inter, fontKey: i % 2 ? 's' : 'i', text: PROSE, size: 48 })),
};

const med = (/** @type {number[]} */ a) => a.sort((x, y) => x - y)[a.length >> 1];
const VARIANTS = ['whole', ...[8, 16, 32, 64, 128].map((r) => `banded ${r}`)];

/** @param {any} scene @param {string} k @param {any} cache @param {any} [span] */
const run = (scene, k, cache, span) => (k === 'whole'
  ? encodePng(rasterize(scene, scanline, span, { cache }), fastZlib, span)
  : encodePngBanded(scene, scanline, fastZlib, { rows: Number(k.split(' ')[1]), cache, span }));

const scene = async (/** @type {string} */ name) => (await renderText(SCENES[name], { padding: 24, gap: 8, targets: [] })).value.scene;

if (process.env.CHILD) {
  // Fresh process, one render: peak ArrayBuffer bytes above a post-GC baseline, sampled by a
  // probe span at every span boundary. (OS maxRSS was tried and rejected: scene building
  // and JIT set the process peak before the render starts, so it read +0 for large scenes.)
  const [name, k] = JSON.parse(process.env.CHILD);
  const sc = await scene(name), cache = flattenCache();
  const { scenePolygons } = await import('../render/src/raster.js');
  scenePolygons(sc, NOOP_SPAN, cache); // outlines cached in both variants: measure the pixel pipeline
  let peak = 0, base = 0;
  const sample = () => { const m = process.memoryUsage().arrayBuffers - base; if (m > peak) peak = m; };
  /** @type {any} */
  const probe = { recording: false, set() {}, span(/** @type {string} */ _n, /** @type {any} */ a, /** @type {any} */ f) { const fn = typeof a === 'function' ? a : f; sample(); const r = fn(probe); if (r && typeof r.then === 'function') return r.then((/** @type {any} */ v) => (sample(), v)); sample(); return r; } };
  gc(); base = process.memoryUsage().arrayBuffers;
  await run(sc, k, cache, probe);
  process.stdout.write(String(peak));
} else {
  const { execFileSync } = await import('node:child_process');
  const { pngStream } = await import('../render/src/stream.js');
  for (const name of Object.keys(SCENES)) {
    const sc = await scene(name), cache = flattenCache();
    /** @type {Record<string, number[]>} */
    const T = {};
    for (let rep = 0; rep < 25; rep++) for (const k of VARIANTS) { const t = performance.now(); await run(sc, k, cache); if (rep >= 5) (T[k] ??= []).push(performance.now() - t); }
    // Time to first IDAT through the ReadableStream (what a client sees as first image bytes).
    const ttfb = [];
    for (let rep = 0; rep < 15; rep++) {
      const t = performance.now(), rd = pngStream(sc, scanline, fastZlib, { rows: 32, cache }).getReader();
      await rd.read(); await rd.read(); ttfb.push(performance.now() - t); await rd.cancel();
    }
    console.log(`\n${name}: ${sc.width}×${sc.height}, ${sc.items.length} glyphs   first IDAT via stream (rows=32): ${med(ttfb).toFixed(2)} ms`);
    for (const k of VARIANTS) {
      const rss = [0, 1, 2].map(() => Number(execFileSync(process.execPath, ['--expose-gc', new URL(import.meta.url).pathname], { env: { ...process.env, CHILD: JSON.stringify([name, k]) } }).toString()));
      console.log(`  ${k.padEnd(11)} p50 ${med(T[k]).toFixed(2).padStart(7)} ms   peak buffers ${(med(rss) / 2 ** 20).toFixed(2).padStart(6)} MiB`);
    }
  }
}
