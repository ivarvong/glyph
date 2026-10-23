// @ts-check
// Scene composition beyond lines of text: any affine per glyph, text along a circle,
// per-glyph colour, and plain vector shapes. Everything returns SceneItem[] and is
// pure, so scenes are data: concatenate the arrays and render.
import { shape } from '../../shape/src/shape.js';
import { Seg, compose } from '../../outline/src/path.js';
import { err, ok } from '../../otel-compact/src/adt.js';

/** @typedef {import('./scene.js').SceneItem} SceneItem */
/** @typedef {import('./scene.js').RGBA} RGBA */
/** @typedef {import('./paint.js').Paint} Paint */
/** @typedef {import('../../outline/src/path.js').Affine} Affine */

/** @param {number} x @param {number} y @returns {Affine} */
export const translate = (x, y) => [1, 0, 0, 1, x, y];
/** Clockwise on screen (y down). @param {number} t radians @returns {Affine} */
export const rotate = (t) => [Math.cos(t), Math.sin(t), -Math.sin(t), Math.cos(t), 0, 0];
/** @param {number} sx @param {number} [sy] @returns {Affine} */
export const scale = (sx, sy = sx) => [sx, 0, 0, sy, 0, 0];
/** Compose left to right as written: `chain(T, R, S)` applies S first. @param {...Affine} ms @returns {Affine} */
export const chain = (...ms) => ms.reduce((acc, m) => compose(acc, m));

/**
 * A shaped run: glyphs with outlines, advances in px at `size`.
 * @typedef {object} Run
 * @property {string} fontKey
 * @property {number} size
 * @property {number} s                 px per font unit
 * @property {number} width             total advance, px
 * @property {number} ascent            px
 * @property {number} descent           px (positive, below baseline)
 * @property {{ gid: number, cluster: number, x: number, dx: number, dy: number, ax: number, path: import('../../outline/src/path.js').Path, fontKey?: string, s?: number }[]} glyphs
 *   x, dx, dy, ax in px; fontKey / s set when the glyph came from a fallback face
 * @property {number} [missing]   characters no face could map (rendered as .notdef)
 */

/**
 * @param {import('../../sfnt/src/font.js').Font} font @param {string} fontKey @param {string} text @param {number} size
 * @param {{ tracking?: number, gsubFeatures?: ReadonlySet<string>, gposFeatures?: ReadonlySet<string> }} [opts]  tracking: extra px after every glyph; features as shape()
 * @returns {import('../../otel-compact/src/adt.js').Result<Run, any>}
 */
export function run(font, fontKey, text, size, { tracking = 0, gsubFeatures, gposFeatures } = {}) {
  const r = shape(font, text, { ...(gsubFeatures ? { gsubFeatures } : {}), ...(gposFeatures ? { gposFeatures } : {}) });
  if (r.tag === 'Err') return r;
  const s = size / font.unitsPerEm;
  /** @type {Run['glyphs']} */
  const glyphs = [];
  let pen = 0;
  for (const g of r.value) {
    const p = font.path(g.gid);
    if (p.tag === 'Err') return err(p.error);
    glyphs.push({ gid: g.gid, cluster: g.cluster, x: pen, dx: g.dx * s, dy: g.dy * s, ax: g.ax * s + tracking, path: p.value });
    pen += g.ax * s + tracking;
  }
  const missing = r.value.filter((g) => g.gid === 0).length;
  return ok({ fontKey, size, s, width: pen, ascent: font.ascender * s, descent: -font.descender * s, glyphs, missing });
}

/**
 * Shape with font fallback: each character goes to the first face that maps it, runs of
 * the same face are shaped together (so ligatures and kerning still work inside a run),
 * and the runs are joined on one pen line. Metrics (ascent, descent) are the first face's.
 * @param {{ font: import('../../sfnt/src/font.js').Font, key: string }[]} faces
 * @param {string} text @param {number} size @param {{ tracking?: number }} [opts]
 * @returns {import('../../otel-compact/src/adt.js').Result<Run, any>}
 */
export function runFallback(faces, text, size, opts = {}) {
  const chars = [...text];
  const faceOf = chars.map((ch) => { const cp = /** @type {number} */ (ch.codePointAt(0)); const k = faces.findIndex((f) => f.font.glyphOf(cp) !== 0); return k < 0 ? 0 : k; });
  /** @type {Run['glyphs']} */
  const glyphs = [];
  let pen = 0, missing = 0, start = 0;
  for (let i = 1; i <= chars.length; i++) {
    if (i < chars.length && faceOf[i] === faceOf[start]) continue;
    const face = faces[faceOf[start]];
    const r = run(face.font, face.key, chars.slice(start, i).join(''), size, opts);
    if (r.tag === 'Err') return r;
    for (const g of r.value.glyphs) glyphs.push({ ...g, x: g.x + pen, cluster: g.cluster + start, fontKey: face.key, s: r.value.s });
    pen += r.value.width; missing += r.value.missing ?? 0; start = i;
  }
  const f0 = faces[0].font, s0 = size / f0.unitsPerEm;
  return ok({ fontKey: faces[0].key, size, s: s0, width: pen, ascent: f0.ascender * s0, descent: -f0.descender * s0, glyphs, missing });
}

/** Unwrap for scene scripts, where a missing glyph is a bug in the script. @template T @param {import('../../otel-compact/src/adt.js').Result<T, any>} r @returns {T} */
export const must = (r) => { if (r.tag === 'Err') throw new Error(JSON.stringify(r.error)); return r.value; }; // bug: explicit unwrap, for scripts that treat Err as fatal

/**
 * Lay a run on a straight baseline under `m` (origin = start of the baseline).
 * @param {Run} rn @param {Affine} m @param {Paint | ((i: number, g: Run['glyphs'][number]) => Paint)} fill
 * @returns {SceneItem[]}
 */
export function place(rn, m, fill) {
  /** @type {SceneItem[]} */
  const out = [];
  rn.glyphs.forEach((g, i) => {
    if (!g.path.length) return;
    out.push({
      path: g.path, key: `${g.fontKey ?? rn.fontKey}-${g.gid}`,
      transform: chain(m, [g.s ?? rn.s, 0, 0, -(g.s ?? rn.s), g.x + g.dx, -g.dy]),
      fill: typeof fill === 'function' ? fill(i, g) : fill, rule: 'nonzero',
    });
  });
  return out;
}

/**
 * Set a run along a circle, clockwise, baseline on the circle, glyph tops outward.
 * @param {Run} rn @param {{ cx: number, cy: number, r: number, start?: number, fit?: boolean }} c
 *   start: angle of the first glyph's left edge (radians, 0 = top). fit: spread the run to close the ring exactly.
 * @param {Paint | ((i: number, g: Run['glyphs'][number]) => Paint)} fill
 * @returns {SceneItem[]}
 */
export function onCircle(rn, { cx, cy, r, start = 0, fit = false }, fill) {
  const extra = fit && rn.glyphs.length ? (2 * Math.PI * r - rn.width) / rn.glyphs.length : 0;
  /** @type {SceneItem[]} */
  const out = [];
  rn.glyphs.forEach((g, i) => {
    if (!g.path.length) return;
    const mid = g.x + i * extra + g.ax / 2; // arc length to the glyph's centre
    const t = start + mid / r;
    out.push({
      path: g.path, key: `${g.fontKey ?? rn.fontKey}-${g.gid}`,
      transform: chain(translate(cx, cy), rotate(t), translate(-g.ax / 2 + g.dx, -r - g.dy), [g.s ?? rn.s, 0, 0, -(g.s ?? rn.s), 0, 0]),
      fill: typeof fill === 'function' ? fill(i, g) : fill, rule: 'nonzero',
    });
  });
  return out;
}

/** Bézier circle constant: max radial error 0.027%. */
const K = 0.5522847498;

/** @param {number} r @returns {import('../../outline/src/path.js').Path} */
const circlePath = (r) => [
  Seg.MoveTo(r, 0),
  Seg.CubicTo(r, K * r, K * r, r, 0, r), Seg.CubicTo(-K * r, r, -r, K * r, -r, 0),
  Seg.CubicTo(-r, -K * r, -K * r, -r, 0, -r), Seg.CubicTo(K * r, -r, r, -K * r, r, 0),
  Seg.Close,
];

/** @param {number} cx @param {number} cy @param {number} r @param {Paint} fill @returns {SceneItem} */
export const circle = (cx, cy, r, fill) => ({ path: circlePath(r), key: `circle:${r}`, transform: translate(cx, cy), fill, rule: 'nonzero' });

/**
 * Ring of width `w` centred on radius r: outer contour clockwise, inner counter-clockwise (nonzero hole).
 * @param {number} cx @param {number} cy @param {number} r @param {number} w @param {Paint} fill @returns {SceneItem}
 */
export const ring = (cx, cy, r, w, fill) => {
  const ro = r + w / 2, ri = r - w / 2;
  const inner = [
    Seg.MoveTo(ri, 0),
    Seg.CubicTo(ri, -K * ri, K * ri, -ri, 0, -ri), Seg.CubicTo(-K * ri, -ri, -ri, -K * ri, -ri, 0),
    Seg.CubicTo(-ri, K * ri, -K * ri, ri, 0, ri), Seg.CubicTo(K * ri, ri, ri, K * ri, ri, 0),
    Seg.Close,
  ];
  return { path: [...circlePath(ro), ...inner], key: `ring:${r}:${w}`, transform: translate(cx, cy), fill, rule: 'nonzero' };
};

/** @param {number} x @param {number} y @param {number} w @param {number} h @param {number} r @param {Paint} fill @returns {SceneItem} */
export const roundRect = (x, y, w, h, r, fill) => {
  const k = (1 - K) * r;
  return {
    key: `rrect:${w}:${h}:${r}`, transform: translate(x, y), fill, rule: 'nonzero',
    path: [
      Seg.MoveTo(r, 0), Seg.LineTo(w - r, 0), Seg.CubicTo(w - k, 0, w, k, w, r),
      Seg.LineTo(w, h - r), Seg.CubicTo(w, h - k, w - k, h, w - r, h),
      Seg.LineTo(r, h), Seg.CubicTo(k, h, 0, h - k, 0, h - r),
      Seg.LineTo(0, r), Seg.CubicTo(0, k, k, 0, r, 0), Seg.Close,
    ],
  };
};

/** Linear interpolation between colour stops at t ∈ [0, 1], rounded to bytes. @param {RGBA[]} stops @param {number} t @returns {RGBA} */
export function gradient(stops, t) {
  const u = Math.min(1, Math.max(0, t)) * (stops.length - 1), i = Math.min(stops.length - 2, Math.floor(u)), f = u - i;
  const a = stops[i], b = stops[i + 1];
  const mix = (/** @type {number} */ k) => Math.round(a[k] + (b[k] - a[k]) * f);
  return [mix(0), mix(1), mix(2), mix(3)];
}

/** '#rrggbb' or '#rrggbbaa'. @param {string} h @returns {RGBA} */
export const hex = (h) => {
  const at = (/** @type {number} */ i) => (i < h.length ? parseInt(h.slice(i, i + 2), 16) : 255);
  return [at(1), at(3), at(5), at(7)];
};

/**
 * Arc-length parametrisation of a curve f: [0, 1] → (x, y), by `samples` chords.
 * `at(s)` gives the point and tangent angle at arc length s (clamped to the curve).
 * @param {(t: number) => [number, number]} f @param {number} [samples]
 */
export function arcLength(f, samples = 4096) {
  const xs = new Float64Array(samples + 1), ys = new Float64Array(samples + 1), S = new Float64Array(samples + 1);
  for (let i = 0; i <= samples; i++) { const [x, y] = f(i / samples); xs[i] = x; ys[i] = y; if (i) S[i] = S[i - 1] + Math.hypot(x - xs[i - 1], y - ys[i - 1]); }
  return {
    length: S[samples],
    /** @param {number} s @returns {{ x: number, y: number, angle: number }} */
    at(s) {
      s = Math.min(S[samples], Math.max(0, s));
      let lo = 0, hi = samples;
      while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (S[mid] <= s) lo = mid; else hi = mid; }
      const k = S[hi] > S[lo] ? (s - S[lo]) / (S[hi] - S[lo]) : 0;
      return { x: xs[lo] + (xs[hi] - xs[lo]) * k, y: ys[lo] + (ys[hi] - ys[lo]) * k, angle: Math.atan2(ys[hi] - ys[lo], xs[hi] - xs[lo]) };
    },
  };
}

/**
 * Set a run along any curve: each glyph's baseline centre sits on the curve at its arc
 * length, rotated to the tangent there. `offset` shifts the start along the curve; `spacing`
 * scales advances (fit a phrase to a curve's length). Baseline-on-curve, like onCircle.
 * @param {Run} rn @param {ReturnType<typeof arcLength>} curve
 * @param {Paint | ((i: number, g: Run['glyphs'][number], s: number) => Paint)} fill   s: arc position ∈ [0, 1]
 * @param {{ offset?: number, spacing?: number, rise?: number }} [opts]   rise: baseline shift off the curve (px, up)
 * @returns {SceneItem[]}
 */
export function alongPath(rn, curve, fill, { offset = 0, spacing = 1, rise = 0 } = {}) {
  /** @type {SceneItem[]} */
  const out = [];
  rn.glyphs.forEach((g, i) => {
    if (!g.path.length) return;
    const mid = offset + (g.x + g.ax / 2) * spacing;
    if (mid < 0 || mid > curve.length) return;
    const { x, y, angle } = curve.at(mid);
    out.push({
      path: g.path, key: `${g.fontKey ?? rn.fontKey}-${g.gid}`,
      transform: chain(translate(x, y), rotate(angle), translate(-g.ax / 2 + g.dx, -rise - g.dy), [g.s ?? rn.s, 0, 0, -(g.s ?? rn.s), 0, 0]),
      fill: typeof fill === 'function' ? fill(i, g, mid / curve.length) : fill, rule: 'nonzero',
    });
  });
  return out;
}

/** y = cy + A·sin(2π·x/λ + φ)·envelope(u) for x across [x0, x1]; u ∈ [0, 1]. */
export const sine = (/** @type {{ x0: number, x1: number, cy: number, amp: number, wavelength: number, phase?: number, envelope?: (u: number) => number }} */ o) =>
  (/** @type {number} */ u) => /** @type {[number, number]} */ ([o.x0 + (o.x1 - o.x0) * u, o.cy + o.amp * (o.envelope ? o.envelope(u) : 1) * Math.sin((2 * Math.PI * (o.x0 + (o.x1 - o.x0) * u)) / o.wavelength + (o.phase ?? 0))]);

/**
 * The curve offset by `d` px along its left normal (the "up" side of text set along it), re-
 * parametrised by its own arc length. Setting text on the offset at its x-height centre keeps
 * letter spacing even through crests and troughs, where baseline arc length fans or crowds.
 * @param {ReturnType<typeof arcLength>} curve @param {number} d @param {number} [samples]
 */
export function offsetCurve(curve, d, samples = 4096) {
  return arcLength((t) => {
    const { x, y, angle } = curve.at(t * curve.length);
    return [x + Math.sin(angle) * d, y - Math.cos(angle) * d];
  }, samples);
}
