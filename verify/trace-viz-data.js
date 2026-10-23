// out/one.jsonl -> out/trace-viz.json: the data behind the flame-chart page.
import { readFileSync, writeFileSync } from 'node:fs';
import { parse, forest } from '../otel-compact/src/read.js';

const file = process.argv[2] ?? 'out/one.jsonl';
const { resource, spans } = parse(readFileSync(file, 'utf8'));
const gc = spans.filter((s) => s.name === 'v8.gc');
const roots = forest(spans.filter((s) => s.name !== 'v8.gc' && !s.name.startsWith('otel.'))).roots;
const renders = roots.filter((r) => r.span.name === 'render.one');
const imp = roots.find((r) => r.span.name === 'module.import');

// Stage of a span = the first matching rule on its own name, else inherited from its parent.
const STAGES = [
  ['brotli', /^(woff2\.brotli|brotli\.)/],
  ['glyf decode', /^(glyf\.|font\.outlines)/],
  ['font tables', /^(font\.|woff2\.)/],
  ['shaping', /^(shape|gsub|gpos|layout\.parse|layout\.(scripts|features|lookups))/],
  ['outlines', /^glyph\.path/],
  ['layout', /^layout$/],
  ['svg', /^(svg\.|render\.svg)/],
  ['flatten', /^(flatten\.|raster\.flatten)/],
  ['rasterize', /^(scan\.|acc\.|raster\.fill)/],
  ['composite', /^raster\.(clear|composite)|^raster$/],
  ['png filter', /^png\.filter/],
  ['deflate', /^(png\.deflate|deflate\.)/],
  ['png other', /^(png\.|render\.png)/],
  ['io', /^io\./],
  ['orchestration', /^render\.(one|text)/],
];
const stageOf = (name, inherited) => STAGES.find(([, re]) => re.test(name))?.[0] ?? inherited ?? 'other';

const gcIn = (a, b) => gc.reduce((t, s) => t + Math.max(0, Math.min(b, s.start + s.dur) - Math.max(a, s.start)), 0);

/** Flatten a root into rows for the flame chart; times in µs relative to the root start. */
function rows(root) {
  const out = [];
  const t0 = root.span.start;
  const walk = (n, depth, inherited) => {
    const stage = stageOf(n.span.name, inherited);
    const childGc = n.children.reduce((t, c) => t + gcIn(c.span.start, c.span.start + c.span.dur), 0);
    const selfGc = Math.max(0, gcIn(n.span.start, n.span.start + n.span.dur) - childGc);
    out.push({ n: n.span.name, s: +(n.span.start - t0).toFixed(1), d: n.span.dur, self: +n.self.toFixed(1), gc: +selfGc.toFixed(1), depth, stage,
      leaf: n.children.length === 0, atomic: n.span.attrs.atomic === true, a: Object.fromEntries(Object.entries(n.span.attrs).filter(([k]) => k !== 'atomic')) });
    n.children.forEach((c) => walk(c, depth + 1, stage));
  };
  walk(root, 0, undefined);
  return out;
}

/** Self time per stage; parent self time is "untraced", GC split out. */
function breakdown(root) {
  const b = {};
  for (const r of rows(root)) {
    const net = Math.max(0, r.self - r.gc);
    const key = r.leaf ? r.stage : 'untraced';
    b[key] = (b[key] ?? 0) + net;
    if (r.gc) b['GC'] = (b['GC'] ?? 0) + r.gc;
  }
  return Object.fromEntries(Object.entries(b).map(([k, v]) => [k, +(v / 1000).toFixed(3)]));
}

const warm = renders.slice(1);
const byDur = [...warm].sort((a, b) => a.span.dur - b.span.dur);
const median = byDur[Math.floor(byDur.length / 2)];
const gcFor = (root) => gc.filter((g) => g.start < root.span.start + root.span.dur && g.start + g.dur > root.span.start)
  .map((g) => ({ s: +(g.start - root.span.start).toFixed(1), d: g.dur, kind: g.attrs.kind }));

// Per span name: median self time across warm renders (what to optimise first).
const names = {};
for (const r of warm) for (const row of rows(r)) {
  if (!row.leaf) continue;
  ((names[row.n] ??= { stage: row.stage, per: [] }).per[warm.indexOf(r)] ??= 0);
  names[row.n].per[warm.indexOf(r)] += Math.max(0, row.self - row.gc);
}
const med = (xs) => { const s = xs.filter((x) => x !== undefined).sort((a, b) => a - b); return s[Math.floor(s.length / 2)] ?? 0; };
const hot = Object.entries(names).map(([n, v]) => ({ n, stage: v.stage, p50: +(med(v.per) / 1000).toFixed(3), max: +(Math.max(...v.per.filter((x) => x !== undefined)) / 1000).toFixed(3) }))
  .sort((a, b) => b.p50 - a.p50).slice(0, 16);

const out = {
  meta: { service: resource?.service, node: resource?.attrs?.node, font: 'inter-latin-400.woff2', text: 'Cloudflare', size: 96, iterations: renders.length,
    spansPerRender: rows(renders[0]).length, moduleImportMs: imp ? +(imp.span.dur / 1000).toFixed(2) : null },
  cold: { dur: renders[0].span.dur, rows: rows(renders[0]), gc: gcFor(renders[0]) },
  warm: { iter: renders.indexOf(median), dur: median.span.dur, rows: rows(median), gc: gcFor(median) },
  iterations: renders.map((r, i) => ({ i, ms: +(r.span.dur / 1000).toFixed(2), phase: i === 0 ? 'cold' : 'warm', b: breakdown(r) })),
  hot,
};
writeFileSync('out/trace-viz.json', JSON.stringify(out));
console.log(`cold ${(out.cold.dur / 1000).toFixed(1)}ms, warm median (iter ${out.warm.iter}) ${(out.warm.dur / 1000).toFixed(1)}ms, ${out.meta.spansPerRender} spans/render`);
console.log('cold breakdown', JSON.stringify(out.iterations[0].b));
console.log('warm breakdown', JSON.stringify(out.iterations[out.warm.iter].b));
console.log('hot (warm p50 ms):', out.hot.map((h) => `${h.n} ${h.p50}`).join(' | '));
console.log('size', JSON.stringify(out).length);
