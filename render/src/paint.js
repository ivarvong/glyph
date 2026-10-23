// @ts-check
// Paints: what fills a shape. A solid colour is an RGBA tuple (as it always was); a gradient
// is a frozen object. Gradient geometry is in scene pixels (y down), whatever the item's
// transform, so one gradient can run across a whole word of separately placed glyphs.
//
// Constructors are total: there is no bad input to report. Offsets are clamped to [0, 1], and one
// below an earlier stop's is raised to it (SVG and CSS both do this); outside the gradient's extent the end
// colours continue (SVG spreadMethod="pad"). Colours between stops are interpolated in
// premultiplied sRGB, as CSS Images 4 specifies; a fully transparent stop fades its neighbour's
// alpha without dragging its colour towards black.

/** @typedef {import('./scene.js').RGBA} RGBA */
/** @typedef {readonly [number, RGBA]} Stop  [offset ∈ [0, 1], colour] */
/** @typedef {{ readonly kind: 'linear', readonly x0: number, readonly y0: number, readonly x1: number, readonly y1: number, readonly stops: readonly Stop[] }} LinearGradient */
/** @typedef {{ readonly kind: 'radial', readonly cx: number, readonly cy: number, readonly r: number, readonly stops: readonly Stop[] }} RadialGradient */
/** @typedef {LinearGradient | RadialGradient} Gradient */
/** @typedef {RGBA | Gradient} Paint */

/**
 * Stops from either [offset, colour] pairs or bare colours (evenly spaced).
 * @param {readonly (Stop | RGBA)[]} stops @returns {readonly Stop[]}
 */
function normalise(stops) {
  const n = stops.length;
  /** @type {Stop[]} */
  const out = stops.map((s, i) => (isStop(s) ? s : /** @type {Stop} */ ([n === 1 ? 0 : i / (n - 1), s])))
    .map(([t, c]) => /** @type {Stop} */ ([Number.isFinite(t) ? Math.min(1, Math.max(0, t)) : 0, c]));
  // SVG's and CSS's rule: an offset below an earlier one is raised to it (stops are not sorted).
  let floor = 0;
  return Object.freeze(out.map(([t, c]) => Object.freeze(/** @type {Stop} */ ([(floor = Math.max(floor, t)), c]))));
}
/** @param {Stop | RGBA} s @returns {s is Stop} */
const isStop = (s) => s.length === 2;

/**
 * A linear gradient from (x0, y0) to (x1, y1) in scene pixels. Zero length paints the last stop.
 * @param {number} x0 @param {number} y0 @param {number} x1 @param {number} y1
 * @param {readonly (Stop | RGBA)[]} stops  [offset, colour] pairs or colours spread evenly; none paints transparent
 * @returns {LinearGradient}
 */
export const linear = (x0, y0, x1, y1, stops) => Object.freeze({ kind: 'linear', x0, y0, x1, y1, stops: normalise(stops) });

/**
 * A radial gradient: offset 0 at (cx, cy), 1 at radius r (scene pixels). r ≤ 0 paints the last stop.
 * @param {number} cx @param {number} cy @param {number} r
 * @param {readonly (Stop | RGBA)[]} stops
 * @returns {RadialGradient}
 */
export const radial = (cx, cy, r, stops) => Object.freeze({ kind: 'radial', cx, cy, r, stops: normalise(stops) });

/** @param {Paint} p @returns {p is RGBA} */
export const isSolid = (p) => Array.isArray(p);

/** @param {Paint} p @returns {readonly RGBA[]} every colour the paint can produce (for format and opacity checks) */
export const colours = (p) => (isSolid(p) ? [p] : p.stops.length ? p.stops.map(([, c]) => c) : [TRANSPARENT]);

/** True when every pixel the paint produces is opaque. @param {Paint} p */
export const isOpaque = (p) => colours(p).every((c) => c[3] === 255);

/** A string equal for paints that render identically (batching key). @param {Paint} p */
export const paintKey = (p) => (isSolid(p) ? p.join(',') : JSON.stringify(p));

const TRANSPARENT = /** @type {RGBA} */ (Object.freeze([0, 0, 0, 0]));
const LUT_SIZE = 1024;

/** @type {WeakMap<Gradient, Uint8ClampedArray>} */
const LUTS = new WeakMap();

/**
 * The gradient's colours at LUT_SIZE evenly spaced offsets, RGBA, unpremultiplied (premultiplied
 * interpolation, divided back out). 1024 entries: adjacent entries differ by < 1/4 of an 8-bit step
 * for any gradient spanning ≤ 256 levels per channel.
 * @param {Gradient} g @returns {Uint8ClampedArray}
 */
export function lut(g) {
  const hit = LUTS.get(g);
  if (hit) return hit;
  const out = new Uint8ClampedArray(LUT_SIZE * 4);
  const s = g.stops;
  for (let i = 0; i < LUT_SIZE; i++) {
    const c = colourAt(g.stops, i / (LUT_SIZE - 1));
    out.set(c.map(Math.round), i * 4);
  }
  LUTS.set(g, out);
  return out;
}

/**
 * The colour at offset t (unrounded RGBA): end colours beyond the ends, equal offsets a hard
 * edge, and between stops premultiplied interpolation divided back out.
 * @param {readonly Stop[]} s @param {number} t @returns {number[]}
 */
export function colourAt(s, t) {
  if (!s.length) return [0, 0, 0, 0];
  if (t <= s[0][0]) return [...s[0][1]];
  if (t >= s[s.length - 1][0]) return [...s[s.length - 1][1]];
  let k = 0;
  while (k + 1 < s.length && s[k + 1][0] < t) k++;
  // s[k][0] < t ≤ s[k + 1][0]
  const [t0, a] = s[k], [t1, b] = s[k + 1];
  const f = t1 > t0 ? (t - t0) / (t1 - t0) : 1;
  const A = a[3] + (b[3] - a[3]) * f;
  const pm = (/** @type {number} */ j) => a[j] * a[3] + (b[j] * b[3] - a[j] * a[3]) * f;
  return A > 0 ? [pm(0) / A, pm(1) / A, pm(2) / A, A] : [0, 0, 0, 0];
}

/**
 * Offset t at the centre of each pixel of a row segment, as LUT indices.
 * @param {Gradient} g @param {number} x  first pixel's column @param {number} y  row @param {number} n
 * @param {Int32Array} into  ≥ n
 */
export function lutIndices(g, x, y, n, into) {
  const M = LUT_SIZE - 1, py = y + 0.5;
  if (g.kind === 'linear') {
    const dx = g.x1 - g.x0, dy = g.y1 - g.y0, L2 = dx * dx + dy * dy;
    if (L2 === 0) { into.fill(M, 0, n); return into; }
    const base = (py - g.y0) * dy, k = M / L2;
    for (let i = 0; i < n; i++) {
      const t = ((x + i + 0.5 - g.x0) * dx + base) * k;
      into[i] = t <= 0 ? 0 : t >= M ? M : Math.round(t);
    }
  } else {
    if (!(g.r > 0)) { into.fill(M, 0, n); return into; }
    const ry = py - g.cy, k = M / g.r;
    for (let i = 0; i < n; i++) {
      const rx = x + i + 0.5 - g.cx, t = Math.sqrt(rx * rx + ry * ry) * k;
      into[i] = t >= M ? M : Math.round(t);
    }
  }
  return into;
}
