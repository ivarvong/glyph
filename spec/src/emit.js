// @ts-check
// Scene → spec: the authoring side. Any scene built with glyph's API becomes data a generic
// renderer can draw: glyphs become { glyph, font } references to font URLs (never outline bytes),
// deferred strokes keep their source and options, every other path becomes path data, and every
// number is written at full precision (the shortest decimal that round-trips), so nothing drifts.
import { isSolid } from '../../render/src/paint.js';
import { isDeferred } from '../../render/src/scene.js';

/** @typedef {import('../../outline/src/path.js').Path} Path */

/**
 * SVG path data. Coordinates are rounded to `digits` decimals (default 3: 1/1000 CSS px, under
 * 0.004 device px at DPR 4); Infinity digits writes each as the shortest decimal that parses back
 * to the same double.
 * @param {Path} path @param {number} [digits]
 */
export function exactPathData(path, digits = Infinity) {
  const k = 10 ** digits;
  const n = (/** @type {number} */ v) => { const r = digits === Infinity ? v : Math.round(v * k) / k; return Object.is(r, -0) ? '0' : String(r); };
  let out = '';
  for (const s of path) {
    switch (s.tag) {
      case 'MoveTo': out += `M${n(s.x)} ${n(s.y)}`; break;
      case 'LineTo': out += `L${n(s.x)} ${n(s.y)}`; break;
      case 'QuadTo': out += `Q${n(s.x1)} ${n(s.y1)} ${n(s.x)} ${n(s.y)}`; break;
      case 'CubicTo': out += `C${n(s.x1)} ${n(s.y1)} ${n(s.x2)} ${n(s.y2)} ${n(s.x)} ${n(s.y)}`; break;
      case 'Close': out += 'Z'; break;
      default: throw new TypeError(`exactPathData: not a Seg: ${JSON.stringify(s)}`); // bug: a value outside the Path type
    }
  }
  return out;
}

/**
 * Recognise a path that is only circles (as ellipse() draws them) or only axis-aligned rectangles
 * (as rect() draws them), and return the compact numbers: [cx, cy, r, …] or [x, y, w, h, …].
 * Halftones, particles, grids and scanlines are thousands of these; as path data they dominated
 * the specs (riso: 5.8 MB, nearly all dots).
 * @param {Path} p @returns {{ kind: 'circles' | 'rects', args: number[] } | null}
 */
function shapes(p) {
  const near = (/** @type {number} */ a, /** @type {number} */ b, /** @type {number} */ s) => Math.abs(a - b) <= 1e-9 * Math.max(1, s);
  if (p.length && p.length % 6 === 0 && p.every((s, i) => s.tag === ['MoveTo', 'CubicTo', 'CubicTo', 'CubicTo', 'CubicTo', 'Close'][i % 6])) {
    const out = [];
    for (let i = 0; i < p.length; i += 6) {
      const m = /** @type {any} */ (p[i]), c2 = /** @type {any} */ (p[i + 2]), c1 = /** @type {any} */ (p[i + 1]);
      const cx = (m.x + c2.x) / 2, cy = m.y, r = (m.x - c2.x) / 2;
      if (!(r > 0) || !near(c1.x, cx, r) || !near(c1.y, cy + r, r) || !near(c2.y, cy, r)) return null;
      out.push(cx, cy, r);
    }
    return { kind: 'circles', args: out };
  }
  if (p.length && p.length % 5 === 0 && p.every((s, i) => s.tag === ['MoveTo', 'LineTo', 'LineTo', 'LineTo', 'Close'][i % 5])) {
    const out = [];
    for (let i = 0; i < p.length; i += 5) {
      const [a, b, c, d] = /** @type {any[]} */ (p.slice(i, i + 4));
      if (!(a.y === b.y && b.x === c.x && c.y === d.y && d.x === a.x && b.x > a.x && c.y > b.y)) return null;
      out.push(a.x, a.y, b.x - a.x, c.y - b.y);
    }
    return { kind: 'rects', args: out };
  }
  return null;
}
const round3 = (/** @type {number} */ v) => Math.round(v * 1000) / 1000;

const hex2 = (/** @type {number} */ v) => v.toString(16).padStart(2, '0');
/** @param {import('../../render/src/scene.js').RGBA} c */
const colour = (c) => `#${hex2(c[0])}${hex2(c[1])}${hex2(c[2])}${c[3] === 255 ? '' : hex2(c[3])}`;
/** @param {import('../../render/src/paint.js').Paint} p */
const paint = (p) => (isSolid(p) ? colour(p)
  : p.kind === 'linear' ? { linear: [p.x0, p.y0, p.x1, p.y1], stops: p.stops.map(([t, c]) => [t, colour(c)]) }
    : { radial: [p.cx, p.cy, p.r], stops: p.stops.map(([t, c]) => [t, colour(c)]) });

/**
 * @param {import('../../render/src/scene.js').Scene} scene  built in CSS px (DPR 1); the renderer scales
 * @param {Map<string, { url: string, sha256: string }>} fonts  by the fontKey the scene's glyph keys use
 * @param {{ params?: Record<string, string> }} [extra]
 * @returns {import('../../otel-compact/src/adt.js').Result<object, string>}
 */
export function toSpec(scene, fonts, extra = {}) {
  const used = new Set();
  const items = [];
  for (const it of scene.items) {
    /** @type {Record<string, unknown>} */
    const base = isSolid(it.fill) && it.fill.join() === '0,0,0,255' ? {} : { paint: paint(it.fill) };
    if (it.rule === 'evenodd') base.rule = 'evenodd';
    const t = it.transform;
    if (!(t[0] === 1 && t[1] === 0 && t[2] === 0 && t[3] === 1 && t[4] === 0 && t[5] === 0)) base.transform = [...t];
    if (isDeferred(it.path)) {
      const d = /** @type {Record<string, any>} */ (it.path);
      if (!('source' in d)) return { tag: 'Err', error: `item ${items.length}: deferred geometry with no source to serialise` };
      const o = d.options;
      /** @type {Record<string, unknown>} */
      const stroke = { width: o.width };
      if ((o.join ?? 'miter') !== 'miter') stroke.join = o.join;
      if ((o.cap ?? 'butt') !== 'butt') stroke.cap = o.cap;
      if ((o.miterLimit ?? 4) !== 4) stroke.miterLimit = o.miterLimit;
      const sh = shapes(d.source);
      items.push({ ...(sh ? { [sh.kind]: sh.args.map(round3) } : { path: exactPathData(d.source, 3) }), stroke, ...base });
      continue;
    }
    const m = /^(.*)-(\d+)$/.exec(it.key);
    if (m && fonts.has(m[1])) {
      used.add(m[1]);
      items.push({ glyph: Number(m[2]), font: m[1], ...base });
      continue;
    }
    const sh = shapes(it.path);
    items.push({ ...(sh ? { [sh.kind]: sh.args.map(round3) } : { path: exactPathData(it.path, 3) }), ...base });
  }
  return {
    tag: 'Ok',
    value: {
      glyph: 1, size: [scene.width, scene.height], background: colour(scene.background),
      fonts: Object.fromEntries([...used].map((k) => [k, /** @type {{ url: string, sha256: string }} */ (fonts.get(k))])),
      ...(extra.params ? { params: extra.params } : {}),
      items,
    },
  };
}
