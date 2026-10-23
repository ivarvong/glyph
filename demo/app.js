// Glyph playground: the real library, running in the browser. No server, no canvas text API:
// every pixel comes from glyph's own WOFF2 → shape → flatten → scan → deflate pipeline.
import {
  loadFont, runFallback, place, onCircle, alongPath, arcLength, sine, offsetCurve, gradient, hex, translate,
  toSvg, scanline, accumulate, flattenCache, channelsFor, fastZlib, balancedZlib, maxZlib, storedZlib, nativeZlib, pngStream, ok,
} from '../index.js';
import { memo, Policy, layered, origin, memory, sceneKey } from '../cache/index.js';
import { tracer, Config, memorySink } from '../otel-compact/src/trace.js';
import { parse } from '../otel-compact/src/read.js';

const $ = (id) => document.getElementById(id);
// Fonts come straight from their pinned upstream releases on a CORS-enabled CDN (the site serves
// none); `integrity` makes the browser refuse any bytes but these (sha256, as in scripts/manifest.js).
const FACES = [
  ['inter', 'Inter', 'https://cdn.jsdelivr.net/npm/@fontsource/inter@5.3.0/files/inter-latin-400-normal.woff2', 'sha256-iQmQSrbIcuuZQJNIKoiijsos2VkS17b+zXIQOw3Aftw='],
  ['serif', 'Source Serif 4', 'https://cdn.jsdelivr.net/gh/adobe-fonts/source-serif@2823e993c53fca27c5c8749f529b56a5a7c77b6b/WOFF2/OTF/SourceSerif4-Regular.otf.woff2', 'sha256-QqoBDbuC2Qdkoo9sx9gJqTlZmbc5DrOyEgKMaXXpdAI='],
  ['mono', 'JetBrains Mono', 'https://cdn.jsdelivr.net/npm/@fontsource/jetbrains-mono@5.1.0/files/jetbrains-mono-latin-400-normal.woff2', 'sha256-fFM4b1XIZsG0yTCcS8907aEIlqqzoXgLCvXMSXbieic='],
];
const RASTERIZERS = { scanline, accumulate };
const ZLIBS = { fast: fastZlib, balanced: balancedZlib, max: maxZlib, stored: storedZlib, native: nativeZlib };
const BACKGROUNDS = { ink: hex('#0B0B0E'), paper: hex('#FFFFFF'), transparent: [0, 0, 0, 0] };

/** Long-lived caches, as a Worker isolate would keep them. */
const outlines = flattenCache();
const l1 = memory(memo(Policy.Sieve, { maxBytes: 48 << 20 }));
const load = layered(l1)(origin);

const fonts = {};
let loadReport = '';

async function boot() {
  const parts = [];
  for (const [key, name, url, integrity] of FACES) {
    const t = performance.now();
    const res = await fetch(url, { integrity, mode: 'cors' });
    if (!res.ok) throw new Error(`${name}: HTTP ${res.status} from ${url}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const r = await loadFont(bytes);
    if (r.tag === 'Err') throw new Error(`${name}: ${JSON.stringify(r.error)}`);
    fonts[key] = { font: r.value, key, name };
    parts.push(`${name} ${(bytes.length / 1024).toFixed(0)} KiB WOFF2 → ${(performance.now() - t).toFixed(0)} ms`);
  }
  loadReport = parts.join(' · ');
  $('fontload').textContent = loadReport;
}

// ------------------------------------------------------------------ state
const read = () => ({
  text: $('text').value,
  face: $('face').value,
  size: Number($('size').value),
  layout: document.querySelector('input[name=layout]:checked').value,
  amp: Number($('amp').value),
  wavelength: Number($('wavelength').value),
  color: $('color').value,
  color2: $('color2').value,
  grad: $('grad').checked,
  bg: $('bg').value,
  rasterizer: $('rasterizer').value,
  zlib: $('zlib').value,
  dpr: Math.min(3, Math.max(1, Math.round(window.devicePixelRatio || 1))),
});

// ------------------------------------------------------------------ scene
function buildScene(st) {
  const D = st.dpr, px = st.size * D, pad = 28 * D;
  const order = [fonts[st.face], ...Object.values(fonts).filter((f) => f.key !== st.face)];
  const c1 = hex(st.color), c2 = hex(st.color2);
  const paint = (s) => (st.grad ? gradient([c1, c2], s) : c1);
  const shape = (t) => { const r = runFallback(order, t, px); if (r.tag === 'Err') throw new Error(JSON.stringify(r.error)); return r.value; };
  const lines = st.text.split('\n').map((l) => l.replace(/\s+$/, '')).filter((l) => l.length);
  if (!lines.length) lines.push(' ');
  const items = [], runs = [];
  let width, height;
  if (st.layout === 'line') {
    let y = pad, w = 0;
    for (const t of lines) {
      const rn = shape(t); runs.push({ text: t, rn });
      y += rn.ascent;
      const n = Math.max(1, rn.glyphs.length - 1);
      items.push(...place(rn, translate(pad, y), (i) => paint(i / n)));
      y += rn.descent + px * 0.2; w = Math.max(w, rn.width);
    }
    width = Math.ceil(w + 2 * pad); height = Math.ceil(y - px * 0.2 + pad);
  } else {
    const t = st.layout === 'circle' ? `${lines.join(' · ')} · ` : lines.join(' · ');
    const rn = shape(t); runs.push({ text: t, rn });
    const n = Math.max(1, rn.glyphs.length - 1);
    const mid = px * 0.36; // x-height centre: space letters along it, not the baseline
    if (st.layout === 'circle') {
      const r = Math.max(rn.width / (2 * Math.PI), px * 1.5);
      const R = r + px * 1.15;
      width = height = Math.ceil(2 * (R + pad));
      items.push(...onCircle(rn, { cx: width / 2, cy: height / 2, r, fit: true }, (i) => paint(i / n)));
    } else if (st.layout === 'sine') {
      const amp = st.amp * px, wl = st.wavelength * px;
      // Choose the run of x whose curve length fits the text, by two refinements.
      let span = rn.width;
      for (let k = 0; k < 3; k++) {
        const c = offsetCurve(arcLength(sine({ x0: 0, x1: span, cy: 0, amp, wavelength: wl })), mid, 2048);
        span *= rn.width / c.length;
      }
      width = Math.ceil(span + 2 * pad + px); height = Math.ceil(2 * (amp + px * 1.25) + 2 * pad);
      const curve = arcLength(sine({ x0: pad + px / 2, x1: pad + px / 2 + span, cy: height / 2, amp, wavelength: wl }), 8192);
      const centre = offsetCurve(curve, mid, 8192);
      items.push(...alongPath(rn, centre, (_, __, s) => paint(s), { spacing: centre.length / rn.width, rise: -mid }));
    } else {
      // Archimedean spiral, clockwise and outward, with one line-height between turns,
      // solved for the number of turns that holds the text: π·sp·T² + 2π·r0·T − L = 0.
      const r0 = px * 1.4, sp = px * 1.3, L = rn.width;
      const turns = (-2 * Math.PI * r0 + Math.sqrt((2 * Math.PI * r0) ** 2 + 4 * Math.PI * sp * L)) / (2 * Math.PI * sp);
      const r1 = r0 + sp * turns, R = r1 + px * 1.2;
      width = height = Math.ceil(2 * (R + pad));
      const cx = width / 2, cy = height / 2;
      const curve = arcLength((u) => { const a = -Math.PI / 2 + 2 * Math.PI * turns * u, r = r0 + sp * turns * u; return [cx + r * Math.cos(a), cy + r * Math.sin(a)]; }, 8192);
      items.push(...alongPath(rn, curve, (_, __, s) => paint(s), { spacing: curve.length / rn.width }));
    }
  }
  return { scene: { width, height, background: BACKGROUNDS[st.bg], items }, runs, order };
}

// ------------------------------------------------------------------ render
let seq = 0, lastPng = null, lastSvg = null;
async function render() {
  const my = ++seq;
  const st = read();
  $('stage').setAttribute('aria-busy', 'true');
  const sink = memorySink();
  const tr = tracer(Config.Record(sink, { defer: 1 << 22 }));
  const T0 = performance.now();
  let out;
  try {
    out = await tr.span('render', async (s) => {
      const built = s.span('shape+layout', () => buildScene(st));
      const { scene } = built;
      const cfg = { format: 'png', rasterizer: st.rasterizer, zlib: st.zlib };
      const key = s.span('cache.key', () => sceneKey(scene, cfg));
      let firstIdat = null;
      const before = { ...l1.stats };
      const loaded = await load({
        key, span: s,
        make: () => s.span('png.stream', async (ps) => {
          const rd = pngStream(scene, RASTERIZERS[st.rasterizer], ZLIBS[st.zlib], { cache: outlines, span: ps }).getReader();
          const parts = []; let n = 0;
          for (;;) {
            const { done, value } = await rd.read();
            if (done) break;
            parts.push(value); n += value.length;
            if (parts.length === 2) firstIdat = performance.now() - T0;
          }
          const b = new Uint8Array(n); let o = 0;
          for (const p of parts) { b.set(p, o); o += p.length; }
          return ok(b);
        }),
      });
      if (loaded.tag === 'Err') throw new Error(loaded.error); // UI edge: shown in the error banner
      const png = loaded.value;
      const hit = l1.stats.hits > before.hits;
      const svg = s.span('svg', () => toSvg(scene, { title: st.text.split('\n')[0] }));
      return { ...built, png, svg, key, hit, firstIdat };
    });
  } catch (e) {
    $('error').textContent = String(e.message ?? e); $('error').hidden = false;
    $('stage').setAttribute('aria-busy', 'false');
    return;
  }
  const total = performance.now() - T0;
  tr.flush();
  if (my !== seq) return; // a newer render started
  $('error').hidden = true;
  show(st, out, total, parse(sink.lines.join('\n')).spans);
  $('stage').setAttribute('aria-busy', 'false');
}

const fmtB = (n) => (n < 1024 ? `${n} B` : n < 1 << 20 ? `${(n / 1024).toFixed(1)} KiB` : `${(n / 2 ** 20).toFixed(2)} MiB`);

function show(st, out, total, spans) {
  const { scene, png, svg, key, hit, firstIdat, runs } = out;
  if (lastPng) URL.revokeObjectURL(lastPng);
  if (lastSvg) URL.revokeObjectURL(lastSvg);
  lastPng = URL.createObjectURL(new Blob([png], { type: 'image/png' }));
  lastSvg = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  const cssW = scene.width / st.dpr, cssH = scene.height / st.dpr;
  for (const [id, url] of [['png', lastPng], ['svg', lastSvg]]) {
    const img = $(id);
    img.src = url; img.width = Math.round(cssW); img.height = Math.round(cssH);
  }
  $('loupe').style.backgroundImage = `url("${lastPng}")`;
  $('stage').dataset.bg = st.bg;
  const channels = { 1: 'gray', 3: 'RGB', 4: 'RGBA' }[channelsFor(scene)];
  const unique = new Set(scene.items.map((i) => i.key)).size;
  const stats = [
    ['canvas', `${scene.width}×${scene.height} px @${st.dpr}×`],
    ['format', channels],
    ['PNG', fmtB(png.length)],
    ['SVG', fmtB(new TextEncoder().encode(svg).length)],
    ['glyphs', `${scene.items.length} placed · ${unique} unique`],
    ['total', `${total.toFixed(1)} ms`],
    ['first IDAT', hit ? 'cache hit' : firstIdat ? `${firstIdat.toFixed(1)} ms` : '—'],
    ['key', `${key.slice(0, 16)}…`],
    ['L1 (SIEVE)', `${hit ? 'HIT' : 'miss'} · ${l1.stats.hits} hits / ${l1.stats.misses} misses`],
    ['outlines', `${outlines.stats.entries} cached · ${fmtB(outlines.stats.bytes)}`],
  ];
  $('stats').replaceChildren(...stats.map(([k, v]) => {
    const d = document.createElement('div');
    const dt = document.createElement('dt'); dt.textContent = k;
    const dd = document.createElement('dd'); dd.textContent = v;
    if (k === 'L1 (SIEVE)' && hit) dd.className = 'hit';
    d.append(dt, dd); return d;
  }));
  showShaping(runs);
  showTrace(spans, total);
}

// ------------------------------------------------------------------ shaping inspector
function showShaping(runs) {
  const host = $('shaping');
  host.replaceChildren();
  let shown = 0;
  for (const { text, rn } of runs) {
    const chars = [...text];
    const row = document.createElement('div'); row.className = 'glyphrow';
    rn.glyphs.forEach((g, i) => {
      if (shown++ > 600) return;
      let end = chars.length;
      for (let j = i + 1; j < rn.glyphs.length; j++) if (rn.glyphs[j].cluster > g.cluster) { end = rn.glyphs[j].cluster; break; }
      const src = chars.slice(g.cluster, Math.max(end, g.cluster + 1)).join('');
      const face = fonts[g.fontKey ?? rn.fontKey];
      const s = g.s ?? rn.s;
      const kern = g.ax - face.font.advance(g.gid) * s;
      const chip = document.createElement('div');
      chip.className = 'chip';
      if ([...src].length > 1 && src.trim()) chip.classList.add('lig');
      if (face.key !== $('face').value) chip.classList.add('fallback');
      if (Math.abs(kern) > 0.05) chip.classList.add('kern');
      chip.title = `${face.name} · gid ${g.gid} · advance ${(g.ax / read().dpr).toFixed(2)} css px`;
      const a = document.createElement('b'); a.textContent = src === ' ' ? '␠' : src;
      const b = document.createElement('span'); b.textContent = `#${g.gid}`;
      chip.append(a, b);
      if (Math.abs(kern) > 0.05) { const k = document.createElement('i'); k.textContent = `${kern > 0 ? '+' : ''}${(kern / read().dpr).toFixed(1)}`; chip.append(k); }
      if (g.gid === 0) chip.classList.add('missing');
      row.append(chip);
    });
    host.append(row);
  }
}

// ------------------------------------------------------------------ trace
function showTrace(spans, total) {
  const by = new Map();
  for (const s of spans) {
    const e = by.get(s.name) ?? { ms: 0, n: 0 };
    e.ms += s.dur / 1000; e.n++; by.set(s.name, e);
  }
  const rows = [...by.entries()].filter(([n]) => n !== 'render').sort((a, b) => b[1].ms - a[1].ms).slice(0, 18);
  const max = Math.max(...rows.map(([, e]) => e.ms), 0.001);
  $('trace').replaceChildren(...rows.map(([name, e]) => {
    const r = document.createElement('div'); r.className = 'trow';
    const l = document.createElement('span'); l.className = 'tname'; l.textContent = name;
    const bar = document.createElement('span'); bar.className = 'tbar';
    const fill = document.createElement('span'); fill.style.width = `${(100 * e.ms / max).toFixed(1)}%`; bar.append(fill);
    const v = document.createElement('span'); v.className = 'tval'; v.textContent = `${e.ms.toFixed(2)} ms${e.n > 1 ? ` ×${e.n}` : ''}`;
    r.append(l, bar, v); return r;
  }));
  const hit = spans.some((s) => s.name.startsWith('cache.memory') && s.attrs?.hit === true);
  $('tracenote').textContent = `${spans.length} spans recorded by otel-compact in this render (total ${total.toFixed(1)} ms; spans nest, so rows overlap).` +
    (hit ? ' This render was an L1 cache hit, so no raster or deflate spans: change the text or size to watch the full pipeline.' : '');
}

// ------------------------------------------------------------------ UI wiring
let timer = 0;
const schedule = () => { clearTimeout(timer); timer = setTimeout(render, 90); };
function syncLayout() {
  const l = document.querySelector('input[name=layout]:checked').value;
  $('wave').hidden = l !== 'sine';
}
document.querySelectorAll('input, select, textarea').forEach((el) => el.addEventListener('input', () => { syncLayout(); $('sizeval').textContent = `${$('size').value} px`; schedule(); }));
document.querySelectorAll('[data-preset]').forEach((b) => b.addEventListener('click', () => {
  const p = PRESETS[b.dataset.preset];
  for (const [k, v] of Object.entries(p)) {
    if (k === 'layout') document.querySelector(`input[name=layout][value=${v}]`).checked = true;
    else if (typeof v === 'boolean') $(k).checked = v; else $(k).value = v;
  }
  syncLayout(); $('sizeval').textContent = `${$('size').value} px`; render();
}));
document.querySelectorAll('[role=tab]').forEach((t) => t.addEventListener('click', () => {
  document.querySelectorAll('[role=tab]').forEach((x) => x.setAttribute('aria-selected', String(x === t)));
  document.querySelectorAll('[role=tabpanel]').forEach((p) => { p.hidden = p.id !== t.getAttribute('aria-controls'); });
}));

const PRESETS = {
  cloudflare: { text: 'Cloudflare', face: 'inter', size: 96, layout: 'line', color: '#F38020', color2: '#FBAD41', grad: true, bg: 'ink' },
  ligatures: { text: 'office affine fjord\nWaffle ﬁ ﬂ — Type AV To', face: 'serif', size: 56, layout: 'line', color: '#111111', grad: false, bg: 'paper' },
  code: { text: 'x => y != z === w -> www <= >= ?? ||', face: 'mono', size: 40, layout: 'sine', amp: 0.6, wavelength: 7, color: '#FBAD41', color2: '#F38020', grad: true, bg: 'ink' },
  ring: { text: 'CLOUDFLARE WORKERS · PURE-JS WOFF2', face: 'inter', size: 34, layout: 'circle', color: '#F38020', color2: '#FBAD41', grad: true, bg: 'ink' },
  spiral: { text: 'shaped, flattened, scanned, composited, deflated and streamed from the edge, glyph by glyph, in plain JavaScript', face: 'serif', size: 26, layout: 'spiral', color: '#ECEBE7', color2: '#F38020', grad: true, bg: 'ink' },
  fallback: { text: 'y = A·sin(2πx/λ + φ)', face: 'mono', size: 48, layout: 'line', color: '#ECEBE7', grad: false, bg: 'ink' },
};

boot().then(() => { syncLayout(); render(); }).catch((e) => { $('error').textContent = `Could not load fonts: ${e.message}`; $('error').hidden = false; });

// Pixel loupe over the PNG.
const plate = $('pngplate'), loupe = $('loupe'), img = $('png'), ZOOM = 4;
img.addEventListener('pointermove', (e) => {
  if (!img.naturalWidth) return;
  const r = img.getBoundingClientRect(), pr = plate.getBoundingClientRect();
  const fx = (e.clientX - r.left) / r.width, fy = (e.clientY - r.top) / r.height;
  const W = img.naturalWidth * ZOOM / read().dpr, H = img.naturalHeight * ZOOM / read().dpr, half = 90;
  loupe.hidden = false;
  loupe.style.backgroundSize = `${W}px ${H}px`;
  loupe.style.backgroundPosition = `${half - fx * W}px ${half - fy * H}px`;
  loupe.style.left = `${e.clientX - pr.left + plate.scrollLeft - half}px`;
  loupe.style.top = `${e.clientY - pr.top + plate.scrollTop - half}px`;
});
img.addEventListener('pointerleave', () => { loupe.hidden = true; });
