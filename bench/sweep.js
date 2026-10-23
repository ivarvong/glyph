// Parametric sweeps on the production path: banded PNG (pngChunks) with the `balanced` deflate.
//   node --expose-gc bench/sweep.js          exit 1 if any axis scales past its limit
//
// Each axis varies one thing and fits log(cost) = k·log(driver) + c by least squares, per span
// name. k ≈ 1 is linear in the driver; each axis declares the k it must stay under:
//   A  text length, one line        driver glyphs   (pixels ∝ glyphs: width only)       k ≤ 1.2
//   B  font size                    driver pixels   (width and height together)         k ≤ 1.2
//   C  line count                   driver pixels   (height only, fixed width)          k ≤ 1.2
//   D  fill colours, fixed scene    driver colours  (should not matter)                 k ≤ 0.3
//   E  text on a circle             driver glyphs   (every glyph its own angle: cache   k ≤ 1.2
//                                                    misses on every one)
//   M  peak ArrayBuffer memory      vs pixels (B) and vs colours (D), fresh process     k ≤ 1.1 / 0.3
//   N  concurrent renders           peak memory vs N in one process; reports how many
//                                    fit in a 128 MB isolate next to the default caches
// Renders use a fresh outline cache each time, so flattening is counted, not memoised away.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tracer, Config, memorySink } from '../otel-compact/src/trace.js';
import { parse, forest } from '../otel-compact/src/read.js';
import { loadFont, renderText, runFallback, place, onCircle, translate } from '../index.js';
import { scanline, flattenCache } from '../render/src/raster.js';
import { balancedZlib } from '../render/src/png.js';
import { pngChunks } from '../render/src/stream.js';

const font = (await loadFont(readFileSync(new URL('../third_party/fonts/inter-latin-400.woff2', import.meta.url)))).value;
const PANGRAM = 'The quick brown fox jumps over the lazy dog. Cloudflare Workers run JavaScript at the edge! ';
const text = (n) => PANGRAM.repeat(Math.ceil(n / PANGRAM.length)).slice(0, n);
const shape = (t, px) => runFallback([{ font, key: 'inter' }], t, px).value;

/** Encode a scene through the production path, draining the stream. */
async function encode(scene, span) {
  let n = 0;
  for await (const c of pngChunks(scene, scanline, balancedZlib, { cache: flattenCache(), span })) n += c.length;
  return n;
}

// ---- scene builders: each returns (span) => Promise<{ scene, glyphs, fills }> ----------------
const lineScene = (t, size) => async (span) => {
  const r = await renderText([{ font, fontKey: 'inter', text: t, size }], { targets: [], span });
  return { scene: r.value.scene, glyphs: r.value.scene.items.length, fills: 1 };
};
const linesScene = (count) => async (span) => {
  const lines = Array.from({ length: count }, () => ({ font, fontKey: 'inter', text: text(60), size: 20 }));
  const r = await renderText(lines, { targets: [], span, gap: 6 });
  return { scene: r.value.scene, glyphs: r.value.scene.items.length, fills: 1 };
};
const fillsScene = (k) => async () => {
  const rns = Array.from({ length: 24 }, () => shape(text(120), 22));
  let gi = 0;
  const items = rns.flatMap((rn, li) => place(rn, translate(20, 30 + li * 30), () => { const c = gi++ % k; return [c & 255, (c >> 8) & 255, 128, 255]; }));
  return { scene: { width: Math.ceil(rns[0].width + 40), height: 24 * 30 + 40, background: [255, 255, 255, 255], items }, glyphs: items.length, fills: k };
};
const circleScene = (n) => async () => {
  const rn = shape(text(n), 24), r = rn.width / (2 * Math.PI), S = Math.ceil(2 * (r + 60));
  const items = onCircle(rn, { cx: S / 2, cy: S / 2, r, fit: true }, [0, 0, 0, 255]);
  return { scene: { width: S, height: S, background: [255, 255, 255, 255], items }, glyphs: items.length, fills: 1 };
};

// ---- timing ---------------------------------------------------------------------------------
/** Median per-span-name ms over warm repetitions; plus the driver facts of the scene. */
async function measure(point, { reps = 7, warm = 2 } = {}) {
  const sink = memorySink();
  const t = tracer(Config.Record(sink, { defer: 1 << 22 }));
  let facts;
  for (let i = 0; i < warm + reps; i++) {
    await t.span('render', async (s) => {
      const f = await point(s);
      facts = { ...f, pixels: f.scene.width * f.scene.height };
      await encode(f.scene, s);
    });
  }
  t.flush();
  const roots = forest(parse(sink.lines.join('\n')).spans).roots.slice(warm);
  /** @type {Record<string, number[]>} */
  const per = {};
  for (const root of roots) {
    const acc = {};
    const walk = (n) => { acc[n.span.name] = (acc[n.span.name] ?? 0) + n.span.dur; n.children.forEach(walk); };
    walk(root);
    for (const k in acc) (per[k] ??= []).push(acc[k] / 1000);
  }
  const med = Object.fromEntries(Object.entries(per).map(([k, v]) => [k, v.sort((a, b) => a - b)[v.length >> 1]]));
  return { med, ...facts };
}

const slope = (xs, ys) => {
  const lx = xs.map(Math.log), ly = ys.map(Math.log);
  const mx = lx.reduce((a, b) => a + b) / lx.length, my = ly.reduce((a, b) => a + b) / ly.length;
  let num = 0, den = 0;
  for (let i = 0; i < lx.length; i++) { num += (lx[i] - mx) * (ly[i] - my); den += (lx[i] - mx) ** 2; }
  return num / den;
};

const STAGES = ['render', 'shape', 'layout', 'raster.flatten', 'scan.sort', 'scan.rows', 'band', 'raster.clear', 'raster.composite', 'png.filter', 'png.deflate', 'png.chunks'];
/** Stages that are a fixed cost per render: report, never fail on them. */
const NOISE_FLOOR_MS = 0.05;
const failures = [];

/**
 * `driverOf` gives the axis's driver; `alt` an optional second natural driver. A stage is
 * super-linear only if it is over the limit against every driver: on a circle the canvas area
 * grows with glyphs², so a per-pixel stage is ~2 against glyphs and ~1 against pixels.
 */
async function axis(id, label, points, driverOf, limit, alt) {
  const rows = [];
  for (const p of points) rows.push(await measure(p));
  const drivers = rows.map(driverOf), alts = alt ? rows.map(alt.of) : null;
  console.log(`\n${id}. ${label}   (limit k ≤ ${limit}${alt ? `, against ${alt.name} as well` : ''})`);
  console.log('driver'.padEnd(18) + drivers.map((d) => String(Math.round(d)).padStart(9)).join('') + `   exponent${alt ? ` (vs ${alt.name})` : ''}`);
  for (const st of STAGES) {
    const ys = rows.map((r) => r.med[st]);
    if (ys.some((y) => !(y > 0))) continue;
    const k = slope(drivers, ys), k2 = alts ? slope(alts, ys) : k;
    const big = Math.max(...ys) > NOISE_FLOOR_MS * 20;
    const bad = Math.min(k, k2) > limit && big;
    if (bad) failures.push(`${id} ${st}: k=${k.toFixed(2)}${alts ? ` (vs ${alt.name} ${k2.toFixed(2)})` : ''} > ${limit}`);
    console.log(st.padEnd(18) + ys.map((y) => y.toFixed(2).padStart(9)).join('') + `   ${k.toFixed(2)}${alts ? ` (${k2.toFixed(2)})` : ''}${bad ? '  ◀ over limit' : ''}`);
  }
}

// ---- memory, in fresh processes ----------------------------------------------------------------
const AXES = {
  size: (v) => lineScene('Cloudflare', v),
  fills: (v) => fillsScene(v),
};
if (process.env.SWEEP_CHILD) {
  // One render, peak ArrayBuffer bytes above a post-GC baseline, sampled at every span boundary.
  const { axis: ax, value } = JSON.parse(process.env.SWEEP_CHILD);
  const f = await AXES[ax](Number(value))();
  let peak = 0, base = 0;
  const sample = () => { const m = process.memoryUsage().arrayBuffers - base; if (m > peak) peak = m; };
  const probe = { recording: false, set() {}, span(_n, a, b) { const fn = typeof a === 'function' ? a : b; sample(); const r = fn(probe); if (r && typeof r.then === 'function') return r.then((v) => (sample(), v)); sample(); return r; } };
  globalThis.gc(); base = process.memoryUsage().arrayBuffers;
  await encode(f.scene, probe);
  process.stdout.write(JSON.stringify({ peak, pixels: f.scene.width * f.scene.height, fills: f.fills }));
  process.exit(0);
}
const child = (ax, value) => JSON.parse(execFileSync(process.execPath, ['--expose-gc', new URL(import.meta.url).pathname], { env: { ...process.env, SWEEP_CHILD: JSON.stringify({ axis: ax, value }) } }).toString());

async function memoryAxis(id, label, ax, values, driver, limit) {
  const rows = values.map((v) => child(ax, v));
  const xs = rows.map((r) => r[driver]), ys = rows.map((r) => r.peak / 2 ** 20);
  const k = slope(xs, ys);
  if (k > limit) failures.push(`${id}: peak memory k=${k.toFixed(2)} > ${limit}`);
  console.log(`\n${id}. ${label}   (limit k ≤ ${limit})`);
  console.log('driver'.padEnd(18) + xs.map((d) => String(Math.round(d)).padStart(9)).join('') + '   exponent');
  console.log('peak MiB'.padEnd(18) + ys.map((y) => y.toFixed(2).padStart(9)).join('') + `   ${k.toFixed(2)}${k > limit ? '  ◀ over limit' : ''}`);
}

// ---- concurrency -------------------------------------------------------------------------------
async function concurrency() {
  const isolate = 128, caches = 8 + 16; // MiB: outline cache + rendered-PNG cache, as in examples/worker-cached.ts
  const point = lineScene(text(200), 48);
  const { scene } = await point();
  console.log(`\nN. concurrent renders in one process: ${scene.width}×${scene.height} line of 200 glyphs @48px, interleaved at band boundaries`);
  for (const n of [1, 2, 4, 8, 16, 32]) {
    globalThis.gc?.();
    const base = process.memoryUsage().arrayBuffers;
    let peak = 0;
    const tick = setInterval(() => { peak = Math.max(peak, process.memoryUsage().arrayBuffers - base); }, 1);
    const sample = () => { peak = Math.max(peak, process.memoryUsage().arrayBuffers - base); };
    const probe = { recording: false, set() {}, span(_n, a, b) { const fn = typeof a === 'function' ? a : b; sample(); const r = fn(probe); if (r && typeof r.then === 'function') return r.then((v) => (sample(), v)); sample(); return r; } };
    const t = performance.now();
    await Promise.all(Array.from({ length: n }, () => encode(scene, probe)));
    clearInterval(tick);
    const mib = peak / 2 ** 20;
    console.log(`  N=${String(n).padStart(2)}  peak ${mib.toFixed(1).padStart(6)} MiB  (${(mib / n).toFixed(1)} per render)  wall ${(performance.now() - t).toFixed(0)} ms`);
    if (n === 4) console.log(`        at this rate a 128 MB isolate with ${caches} MiB of caches holds ≈ ${Math.floor((isolate - caches) / (mib / n))} such renders in flight`);
  }
}

// ---- run ----------------------------------------------------------------------------------------
await axis('A', 'text length, one line at 24px (width grows, height fixed)', [12, 24, 48, 96, 192, 384, 768].map((n) => lineScene(text(n), 24)), (r) => r.glyphs, 1.2);
await axis('B', 'font size, "Cloudflare" (width and height grow)', [12, 24, 48, 96, 192, 384].map((s) => lineScene('Cloudflare', s)), (r) => r.pixels, 1.2);
await axis('C', 'line count, 60 glyphs per line at 20px (height grows, width fixed)', [1, 2, 4, 8, 16, 32, 64].map(linesScene), (r) => r.pixels, 1.2);
await axis('D', 'fill colours, fixed 24-line scene (2,880 glyphs)', [1, 4, 16, 64, 256, 1024, 2880].map(fillsScene), (r) => r.fills, 0.3);
await axis('E', 'text on a circle at 24px (every glyph at its own angle)', [24, 48, 96, 192, 384, 768].map(circleScene), (r) => r.glyphs, 1.2, { name: 'pixels', of: (r) => r.pixels });
await memoryAxis('M1', 'peak memory vs pixels (font size 24…384)', 'size', [24, 48, 96, 192, 384], 'pixels', 1.1);
await memoryAxis('M2', 'peak memory vs fill colours (fixed scene)', 'fills', [1, 16, 256, 2880], 'fills', 0.3);
await concurrency();

if (failures.length) { console.log(`\nOVER LIMIT:\n  ${failures.join('\n  ')}`); process.exitCode = 1; }
else console.log('\nall axes within their limits');
