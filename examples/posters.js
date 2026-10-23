// Posters: what the engine does beyond lines of text. Each scene is plain data built
// with render/src/compose.js, then written as PNG (banded stream) and SVG.
//   node examples/posters.js [outdir]     DPR=3 by default; ZLIB=balanced by default; CHECK=1 also diffs banded vs whole pixels
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { autoBrotli } from '../woff2/src/brotli.js';
import { loadFont } from '../render/src/text.js';
import { scanline, rasterize, channelsFor, flattenCache } from '../render/src/raster.js';
import { encodePng } from '../render/src/png.js';
import { ZLIBS } from '../render/src/targets.js';
import { pngStream } from '../render/src/stream.js';
import { toSvg } from '../render/src/svg.js';
import { run, runFallback, offsetCurve, must, place, onCircle, circle, ring, roundRect, gradient, hex, translate, chain, rotate, alongPath, arcLength, sine } from '../render/src/compose.js';
import { Seg } from '../outline/src/path.js';
import { NOOP_SPAN } from '../otel-compact/src/trace.js';

const dir = process.argv[2] ?? new URL('../out/posters/', import.meta.url).pathname;
mkdirSync(dir, { recursive: true });
const D = Number(process.env.DPR ?? 3);
/** Any zlib preset by name: fast | balanced | max | native | stored. */
const Z = ZLIBS.find((z) => z.name === (process.env.ZLIB ?? 'balanced')) ?? (() => { throw new Error(`unknown ZLIB ${process.env.ZLIB}`); })();
const load = async (f) => must(await loadFont(new Uint8Array(readFileSync(new URL(`../third_party/fonts/${f}`, import.meta.url))), { brotli: autoBrotli }));
const F = {
  sans: { font: await load('inter-latin-400.woff2'), key: 'inter' },
  serif: { font: await load('source-serif-4-regular.otf.woff2'), key: 'serif' },
  mono: { font: await load('jetbrains-mono-latin-400.woff2'), key: 'mono' },
};
/** Shape `text` in face `f` (falling back to the others per character) at `size` CSS px (× DPR). A character no face maps is an error, never a silent .notdef box. */
const R = (f, text, size, opts = {}) => {
  const rn = must(runFallback([f, ...Object.values(F).filter((x) => x !== f)], text, size * D, { tracking: (opts.tracking ?? 0) * D }));
  if (rn.missing) throw new Error(`no face maps ${rn.missing} character(s) of ${JSON.stringify(text)}`);
  return rn;
};

const ORANGE = hex('#F38020'), AMBER = hex('#FBAD41'), INK = hex('#0A0A0C');

// ---------------------------------------------------------------------------- hero
function hero() {
  const W = 1200 * D, H = 675 * D, x0 = 72 * D;
  const items = [];
  // A giant serif ampersand bleeding off the right edge, barely lifted from the background.
  const amp = R(F.serif, '&', 900);
  items.push(...place(amp, translate(W - amp.width * 0.78, H + 120 * D), hex('#16161B')));
  // Rings behind the title: nonzero holes, exact AA on thin strokes.
  for (let i = 0; i < 9; i++) items.push(ring(W - 150 * D, 120 * D, (50 + i * 24) * D, 1.2 * D, [243, 128, 32, Math.round(150 - i * 15)]));
  const label = R(F.mono, 'GLYPH / PURE-JS TEXT RENDERER', 15, { tracking: 3 });
  items.push(...place(label, translate(x0, 150 * D), hex('#8A8A93')));
  const title = R(F.sans, 'Cloudflare', 190, { tracking: -6 });
  items.push(...place(title, translate(x0 - 8 * D, 345 * D), (i) => gradient([ORANGE, AMBER], i / (title.glyphs.length - 1))));
  const sub = R(F.serif, 'WOFF2 in, pixels out. Shaped, flattened, scanned and deflated', 31);
  const sub2 = R(F.serif, 'in plain JavaScript, streaming from the edge.', 31);
  items.push(...place(sub, translate(x0, 430 * D), hex('#E9E7E2')), ...place(sub2, translate(x0, 472 * D), hex('#E9E7E2')));
  const stats = [['3', 'fonts'], ['2', 'rasterizers'], ['3', 'zlibs'], ['0', 'dependencies'], ['90/90', 'golden']];
  let x = x0;
  for (const [n, what] of stats) {
    const a = R(F.mono, n, 34), b = R(F.mono, what, 13, { tracking: 1.5 });
    items.push(...place(a, translate(x, 590 * D), hex('#F2F2F2')), ...place(b, translate(x, 618 * D), hex('#7C7C86')));
    x += Math.max(a.width, b.width) + 52 * D;
  }
  return { width: W, height: H, background: INK, items };
}

// ---------------------------------------------------------------------------- rings
function rings() {
  const S = 1000 * D, c = S / 2;
  const items = [];
  const bands = [
    { f: F.sans, text: 'CLOUDFLARE WORKERS · PURE-JS WOFF2 · ', size: 30, r: 430, tracking: 4, fill: (t) => gradient([ORANGE, AMBER, ORANGE], t) },
    { f: F.serif, text: 'shaped · flattened · scanned · composited · deflated · streamed · ', size: 34, r: 360, fill: () => hex('#EDEBE6') },
    { f: F.mono, text: '=> != === -> <= >= || && ?? ', size: 30, r: 292, fill: (t) => gradient([AMBER, ORANGE], t) },
    { f: F.sans, text: 'GSUB GPOS glyf CFF Brotli CRC-32 Adler-32 · ', size: 18, r: 238, tracking: 3, fill: () => hex('#9A9AA3') },
    { f: F.serif, text: 'ﬁ ﬂ ffi Tokyo AVA Wave Type · ', size: 30, r: 186, fill: () => hex('#EDEBE6') },
  ];
  bands.forEach((b, k) => {
    // Repeat the phrase to fill the circumference, then spread it to close the ring exactly.
    const one = R(b.f, b.text, b.size, b);
    const reps = Math.max(1, Math.floor((2 * Math.PI * b.r * D) / one.width));
    const rn = R(b.f, b.text.repeat(reps), b.size, b);
    const n = rn.glyphs.length;
    items.push(...onCircle(rn, { cx: c, cy: c, r: b.r * D, start: k * 0.7, fit: true }, (i) => b.fill(i / (n - 1))));
    items.push(ring(c, c, (b.r - b.size * 0.42) * D, 0.8 * D, [255, 255, 255, 28]));
  });
  items.push(circle(c, c, 132 * D, hex('#F38020')));
  const g = R(F.serif, 'g', 230);
  items.push(...place(g, translate(c - g.width / 2, c + 48 * D), INK));
  return { width: S, height: S, background: INK, items };
}

// ---------------------------------------------------------------------------- code card
// The card shows the exact file `npm run worker:check` executes.
const CODE = readFileSync(new URL('./worker.ts', import.meta.url), 'utf8').trimEnd();

const THEME = {
  plain: hex('#C9D1D9'), keyword: hex('#F38020'), string: hex('#A5D6FF'), comment: hex('#6E7681'),
  fn: hex('#D2A8FF'), number: hex('#79C0FF'), type: hex('#FBAD41'), punct: hex('#8B949E'),
};
const KEYWORDS = new Set(['import', 'from', 'export', 'default', 'async', 'await', 'const', 'let', 'return', 'new', 'satisfies', 'any']);

/** Token class per character (code point index), from a deliberately tiny lexer. */
function classify(line) {
  const cls = Array([...line].length).fill('plain');
  const re = /(\/\/.*$)|('[^']*')|(\b\d+\b)|([A-Za-z_$][\w$]*)(?=\s*\()|([A-Z][\w$]*)|([A-Za-z_$][\w$]*)|([{}()[\],.;:<>=!?&|]+)/g;
  for (const m of line.matchAll(re)) {
    const k = m[1] ? 'comment' : m[2] ? 'string' : m[3] ? 'number' : m[4] ? (KEYWORDS.has(m[4]) ? 'keyword' : 'fn') : m[5] ? 'type' : m[6] ? (KEYWORDS.has(m[6]) ? 'keyword' : 'plain') : 'punct';
    const start = [...line.slice(0, m.index)].length;
    for (let i = 0; i < [...m[0]].length; i++) cls[start + i] = k;
  }
  return cls;
}

function code() {
  const lines = CODE.split('\n');
  const size = 21, lh = 34 * D, padX = 44 * D, top = 100 * D;
  const shaped = lines.map((l) => R(F.mono, l || ' ', size));
  const cardW = Math.max(...shaped.map((r) => r.width)) + 2 * padX, cardH = top + lines.length * lh + 40 * D;
  const M = 64 * D, W = cardW + 2 * M, H = cardH + 2 * M;
  const items = [
    roundRect(M + 6 * D, M + 14 * D, cardW, cardH, 18 * D, [0, 0, 0, 90]), // soft offset shadow
    roundRect(M, M, cardW, cardH, 18 * D, hex('#151922')),
    ...['#FF5F57', '#FEBC2E', '#28C840'].map((h, i) => circle(M + (30 + i * 24) * D, M + 30 * D, 7 * D, hex(h))),
  ];
  const title = R(F.sans, 'worker.ts', 15);
  items.push(...place(title, translate(M + cardW / 2 - title.width / 2, M + 36 * D), hex('#7D8590')));
  shaped.forEach((rn, li) => {
    const cls = classify(lines[li]);
    // Colour by the source characters each glyph came from: ligatures keep their token colour.
    items.push(...place(rn, translate(M + padX, M + top + li * lh), (_, g) => THEME[cls[g.cluster] ?? 'plain']));
  });
  return { width: Math.ceil(W), height: Math.ceil(H), background: hex('#0B0D12'), items };
}

// ---------------------------------------------------------------------------- waterfall
function waterfall() {
  const W = 1200 * D, x0 = 150 * D;
  const items = [];
  let y = 70 * D;
  const sizes = [9, 11, 13, 16, 20, 26, 34, 46, 62, 84, 112];
  for (const px of sizes) {
    const rn = R(F.serif, px >= 100 ? 'Quixotic zephyrs' : px >= 80 ? 'Quixotic zephyrs ﬁnd' : 'Quixotic zephyrs ﬁnd hamburgefonts', px);
    y += rn.ascent + 8 * D;
    const label = R(F.mono, `${px}px`, 12);
    items.push(...place(label, translate(x0 - label.width - 28 * D, y), hex('#9B9B9B')));
    items.push(...place(rn, translate(x0, y), hex('#111111')));
    y += rn.descent;
  }
  const foot = R(F.sans, 'Source Serif 4 · unhinted, exact nonzero coverage, 16 sub-scanlines', 14);
  y += 40 * D;
  items.push(...place(foot, translate(x0, y), hex('#8A8A8A')));
  return { width: W, height: Math.ceil(y + 50 * D), background: hex('#FFFFFF'), items };
}

// ---------------------------------------------------------------------------- squiggle
/** A curve stroked as one closed polygon: the curve offset ±w/2 along its normal. */
function stroke(curve, w, fill, key) {
  const n = Math.ceil(curve.length / (2 * D)), left = [], right = [];
  for (let i = 0; i <= n; i++) {
    const { x, y, angle } = curve.at((i / n) * curve.length);
    const nx = -Math.sin(angle) * w / 2, ny = Math.cos(angle) * w / 2;
    left.push([x + nx, y + ny]); right.push([x - nx, y - ny]);
  }
  const pts = [...left, ...right.reverse()];
  return { key, fill, transform: [1, 0, 0, 1, 0, 0], path: [Seg.MoveTo(...pts[0]), ...pts.slice(1).map((p) => Seg.LineTo(...p)), Seg.Close] };
}

/** Repeat `text` until it covers `length` px, then spread it to land exactly on the end. */
function fill(f, text, size, length, opts = {}) {
  const one = R(f, text, size, opts);
  const rn = R(f, text.repeat(Math.max(1, Math.floor(length / one.width))), size, opts);
  return { rn, spacing: length / rn.width };
}

function squiggle() {
  const W = 1600 * D, H = 780 * D, x0 = -40 * D, x1 = W + 40 * D;
  const items = [];
  const waves = [
    { f: F.serif, text: 'shaped · flattened · scanned · composited · deflated · streamed · ', size: 30, cy: 170, amp: 46, wl: 520, ph: 2.2, color: () => hex('#E9E7E2') },
    { f: F.sans, text: 'Cloudflare Workers · pure JavaScript · zero dependencies · ', size: 66, cy: 385, amp: 92, wl: 820, ph: 0, color: (s) => gradient([ORANGE, AMBER, ORANGE, AMBER], s), tracking: -1 },
    { f: F.mono, text: '=> != === -> <= >= ?? || && :: ', size: 26, cy: 590, amp: 70, wl: 300, ph: 1, color: (s) => gradient([AMBER, ORANGE], s), env: (u) => Math.exp(-2.6 * u) },
  ];
  for (const wv of waves) {
    const curve = arcLength(sine({ x0: x0 * 1, x1, cy: wv.cy * D, amp: wv.amp * D, wavelength: wv.wl * D, phase: wv.ph, envelope: wv.env }), 8192);
    items.push(stroke(curve, 1.1 * D, [255, 255, 255, 30], `stroke:${wv.cy}`));
    // Space letters along the x-height centre line, not the baseline: even through crests and troughs.
    const rise = 6 * D, mid = rise + wv.size * D * 0.36;
    const centre = offsetCurve(curve, mid, 8192);
    const { rn, spacing } = fill(wv.f, wv.text, wv.size, centre.length, wv);
    items.push(...alongPath(rn, centre, (_, __, s) => wv.color(s), { spacing, rise: rise - mid })); // baseline back on curve + rise
  }
  const label = R(F.mono, 'y = A·sin(2πx/λ + φ) · e^(−2.6u)   — text set by arc length, rotated to the tangent', 14, { tracking: 0.5 });
  items.push(...place(label, translate(64 * D, H - 52 * D), hex('#7C7C86')));
  return { width: W, height: H, background: INK, items };
}

// ---------------------------------------------------------------------------- render
export const SCENES = { hero, rings, code, waterfall, squiggle };
for (const [name, build] of Object.entries(SCENES).filter(([n]) => !process.env.ONLY || n === process.env.ONLY)) {
  const scene = build();
  const cache = flattenCache();
  const ts = [];
  let png = new Uint8Array();
  for (let i = 0; i < 6; i++) {
    const t = performance.now();
    png = new Uint8Array(await new Response(pngStream(scene, scanline, Z, { cache })).arrayBuffer());
    ts.push(performance.now() - t);
  }
  if (process.env.CHECK) {
    const whole = await encodePng(rasterize(scene, scanline, NOOP_SPAN, { cache }), Z);
    const { decodePng, toRgba } = await import('../verify/pngdecode.js');
    if (Buffer.compare(Buffer.from(toRgba(decodePng(png))), Buffer.from(toRgba(decodePng(whole))))) throw new Error(`${name}: banded != whole`);
  }
  const svg = toSvg(scene, { title: name });
  writeFileSync(`${dir}/${name}@${D}x.png`, png);
  writeFileSync(`${dir}/${name}.svg`, svg);
  const fills = new Set(scene.items.map((i) => i.fill.join())).size;
  console.log(`${name.padEnd(10)} ${scene.width}×${scene.height}  ${{ 1: 'gray', 3: 'RGB', 4: 'RGBA' }[channelsFor(scene)].padEnd(4)} ${String(scene.items.length).padStart(5)} items ${String(fills).padStart(4)} fills  png ${(png.length / 1024).toFixed(0).padStart(5)} KiB  svg ${(svg.length / 1024).toFixed(0).padStart(4)} KiB  warm ${ts.slice(2).sort((a, b) => a - b)[1].toFixed(0)} ms`);
}
