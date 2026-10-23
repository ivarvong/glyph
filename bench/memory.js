// Peak live memory of a render: the number a 128 MB isolate cares about.
//   node --expose-gc bench/memory.js <module.js> [export=poster]     (DPR from env, default 3; ONLY=none for posters.js)
// Builds the scene, then streams the PNG; after every chunk forces a GC and samples heapUsed, so
// the peak is live data (garbage the collector could free is not counted). Also reports the
// scene's own footprint and its path-segment count, and the render's CPU time without GCs.
import { createHash } from 'node:crypto';
import { draw } from '../index.js';

const [file, name = 'poster'] = process.argv.splice(2); // consumed: an imported script must not read them
const gc = globalThis.gc;
if (!gc) { console.error('run with --expose-gc'); process.exit(2); }
// A .json file is a scene spec, built by the same path a Worker uses (fonts from the local mirror).
let build;
if (file.endsWith('.json')) {
  const { readFileSync } = await import('node:fs');
  const { createHash: h } = await import('node:crypto');
  const { loadFont } = await import('../index.js');
  const { buildScene } = await import('../spec/src/spec.js');
  const ROOT = new URL('../', import.meta.url).pathname;
  const MIRROR = /^https:\/\/raw\.githubusercontent\.com\/google\/fonts\/[0-9a-f]{40}\/(.*)$/;
  const text = readFileSync(file, 'utf8');
  const fontsLoaded = new Map();
  const load = async (ref) => {
    if (fontsLoaded.has(ref.url)) return fontsLoaded.get(ref.url);
    const bytes = readFileSync(`${ROOT}conform/.ext/gfonts/${MIRROR.exec(ref.url)[1].split('/').map(decodeURIComponent).join('/')}`);
    const f = await loadFont(bytes);
    const r = { tag: 'Ok', value: { font: f.value, key: h('sha256').update(bytes).digest('hex').slice(0, 16) } };
    fontsLoaded.set(ref.url, r);
    return r;
  };
  // Fonts first (they are cached per isolate in a Worker), then the per-request work.
  const first = await buildScene(JSON.parse(text), { dpr: Number(process.env.DPR || 3), params: {}, loadFont: load });
  if (first.tag === 'Err') { console.error(JSON.stringify(first.error)); process.exit(1); }
  build = async () => {
    const r = await buildScene(JSON.parse(text), { dpr: Number(process.env.DPR || 3), params: {}, loadFont: load });
    return r.tag === 'Ok' ? r.value.scene : null;
  };
} else {
  const mod = await import(new URL(file, `file://${process.cwd()}/`).href);
  const fn = mod[name] ?? mod.SCENES?.[name]; // examples/posters.js exports its builders as SCENES
  build = async () => fn();
}
gc();
const base = process.memoryUsage().heapUsed;
const scene = await build();
gc();
const withScene = process.memoryUsage().heapUsed;
const paths = new Set();
let segs = 0;
for (const it of scene.items) if (!paths.has(it.path)) { paths.add(it.path); segs += Array.isArray(it.path) ? it.path.length : 0; }

// Pass 1: timing (no forced GCs). Pass 2: live-heap sampling.
const t0 = performance.now(), c0 = process.cpuUsage();
const bytes = new Uint8Array(await new Response(draw.png(scene)).arrayBuffer());
const cpu = process.cpuUsage(c0), ms = performance.now() - t0;
const reader = draw.png(scene).getReader();
let peak = withScene, chunks = 0;
for (;;) {
  const { done } = await reader.read();
  if (done) break;
  chunks++;
  gc();
  const h = process.memoryUsage().heapUsed;
  if (h > peak) peak = h;
}
const mb = (b) => `${(b / 1048576).toFixed(1)} MiB`;
console.log(JSON.stringify({
  file, items: scene.items.length, paths: paths.size, segs,
  heap: { fontsAndCode: mb(base), scene: mb(withScene - base), renderPeakLive: mb(peak), renderOverScene: mb(peak - withScene) },
  render: { ms: Math.round(ms), cpuMs: Math.round((cpu.user + cpu.system) / 1000), chunks },
  png: { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex').slice(0, 16) },
}));
