// @ts-check
// TrueType glyph records. One IR, two producers:
//   parseGlyfTable  raw 'glyf' + 'loca'           (sfnt, WOFF1, WOFF2 null-transform)
//   decodeGlyfV0    WOFF2 transformed glyf stream (woff2/src/glyf-transform.js)
// Both return Glyph[], compared against each other in tests.

import { variants, ok, err } from '../../otel-compact/src/adt.js';
import { view, u8, i8, u16, i16, u32, f2dot14, guard, times } from './bin.js';

export const Glyph = variants('Glyph', {
  Empty: [],
  // endPts: last point index of each contour. on: 1 = on-curve.
  Simple: ['endPts', 'xs', 'ys', 'on', 'bbox', 'instructions'],
  Composite: ['components', 'bbox', 'instructions'],
});
/** @typedef {import('../../otel-compact/src/adt.js').Of<typeof Glyph>} GlyphT */

// Where a component sits: by offset, or by matching a parent point to a child point.
export const Offset = variants('Offset', { XY: ['dx', 'dy'], Anchor: ['parent', 'child'] });

/**
 * @typedef {object} Component
 * @property {number} glyph
 * @property {number} flags
 * @property {import('../../otel-compact/src/adt.js').Of<typeof Offset>} offset
 * @property {[number, number, number, number]} matrix  x' = a·x + c·y, y' = b·x + d·y
 */

export const GlyfError = variants('GlyfError', {
  Truncated: ['glyph', 'at'],
  BadLoca: ['glyph', 'start', 'end'],
  Cycle: ['glyph'],
  TooDeep: ['glyph'],
  BadAnchor: ['glyph', 'point'],
  TooComplex: ['glyph', 'what', 'limit'],
  BadContours: ['glyph', 'contour'],
});

export const COMPOSITE = Object.freeze({
  ARG_1_AND_2_ARE_WORDS: 0x0001,
  ARGS_ARE_XY_VALUES: 0x0002,
  ROUND_XY_TO_GRID: 0x0004,
  WE_HAVE_A_SCALE: 0x0008,
  MORE_COMPONENTS: 0x0020,
  WE_HAVE_AN_X_AND_Y_SCALE: 0x0040,
  WE_HAVE_A_TWO_BY_TWO: 0x0080,
  WE_HAVE_INSTRUCTIONS: 0x0100,
  USE_MY_METRICS: 0x0200,
  SCALED_COMPONENT_OFFSET: 0x0800,
});

/**
 * Component records, as stored in 'glyf' and verbatim in the WOFF2 composite stream.
 * @param {import('./bin.js').View} v
 * @param {number} o
 * @returns {{ components: Component[], end: number, hasInstructions: boolean }}
 */
export function parseComponents(v, o) {
  const C = COMPOSITE;
  /** @type {Component[]} */
  const components = [];
  /** @type {number} */
  let flags = C.MORE_COMPONENTS;
  let hasInstructions = false;
  while (flags & C.MORE_COMPONENTS) {
    flags = u16(v, o);
    const glyph = u16(v, o + 2);
    o += 4;
    hasInstructions ||= (flags & C.WE_HAVE_INSTRUCTIONS) !== 0;
    const words = (flags & C.ARG_1_AND_2_ARE_WORDS) !== 0;
    const xy = (flags & C.ARGS_ARE_XY_VALUES) !== 0;
    let a1, a2;
    if (words) {
      a1 = xy ? i16(v, o) : u16(v, o);
      a2 = xy ? i16(v, o + 2) : u16(v, o + 2);
      o += 4;
    } else {
      a1 = xy ? i8(v, o) : u8(v, o);
      a2 = xy ? i8(v, o + 1) : u8(v, o + 1);
      o += 2;
    }
    /** @type {[number, number, number, number]} */
    let matrix = [1, 0, 0, 1];
    if (flags & C.WE_HAVE_A_SCALE) {
      const s = f2dot14(v, o);
      matrix = [s, 0, 0, s];
      o += 2;
    } else if (flags & C.WE_HAVE_AN_X_AND_Y_SCALE) {
      matrix = [f2dot14(v, o), 0, 0, f2dot14(v, o + 2)];
      o += 4;
    } else if (flags & C.WE_HAVE_A_TWO_BY_TWO) {
      // Stored order: xscale, scale01, scale10, yscale.
      matrix = [f2dot14(v, o), f2dot14(v, o + 2), f2dot14(v, o + 4), f2dot14(v, o + 6)];
      o += 8;
    }
    components.push({ glyph, flags, offset: xy ? Offset.XY(a1, a2) : Offset.Anchor(a1, a2), matrix });
  }
  return { components, end: o, hasInstructions };
}

/**
 * Length of a composite record and whether it carries instructions, without
 * building components (for indexing). Mirrors woff2_dec.cc SizeOfComposite.
 * @param {import('./bin.js').View} v @param {number} o
 */
export function skipComponents(v, o) {
  const C = COMPOSITE;
  /** @type {number} */
  let flags = C.MORE_COMPONENTS;
  let hasInstructions = false;
  while (flags & C.MORE_COMPONENTS) {
    flags = u16(v, o);
    hasInstructions ||= (flags & C.WE_HAVE_INSTRUCTIONS) !== 0;
    o += 4 + (flags & C.ARG_1_AND_2_ARE_WORDS ? 4 : 2)
      + (flags & C.WE_HAVE_A_SCALE ? 2 : flags & C.WE_HAVE_AN_X_AND_Y_SCALE ? 4 : flags & C.WE_HAVE_A_TWO_BY_TWO ? 8 : 0);
    u8(v, o - 1); // bounds
  }
  return { end: o, hasInstructions };
}

/**
 * Simple-glyph point data in 'glyf' encoding (flags with repeats, then x, then y deltas).
 * @param {import('./bin.js').View} v
 * @param {number} o        offset of the first flag byte
 * @param {number} nPoints
 */
export function parseSimplePoints(v, o, nPoints) {
  const flags = new Uint8Array(nPoints);
  for (let i = 0; i < nPoints;) {
    const f = u8(v, o++);
    flags[i++] = f;
    if (f & 0x08) {
      const r = u8(v, o++);
      for (let k = 0; k < r && i < nPoints; k++) flags[i++] = f;
    }
  }
  /** @param {number} short @param {number} same @returns {Int32Array} */
  const coords = (short, same) => {
    const out = new Int32Array(nPoints);
    let c = 0;
    for (let i = 0; i < nPoints; i++) {
      const f = flags[i];
      if (f & short) c += (f & same ? 1 : -1) * u8(v, o++);
      else if (!(f & same)) { c += i16(v, o); o += 2; }
      out[i] = c;
    }
    return out;
  };
  const xs = coords(0x02, 0x10);
  const ys = coords(0x04, 0x20);
  const on = flags.map((f) => f & 1);
  return { xs, ys, on, end: o };
}

/**
 * Raw 'glyf' + 'loca'.
 * @param {Uint8Array} glyf
 * @param {Uint8Array} loca
 * @param {number} numGlyphs
 * @param {0 | 1} indexToLocFormat  0 = u16 (×2), 1 = u32
 * @returns {import('../../otel-compact/src/adt.js').Result<GlyphT[], any>}
 */
export function parseGlyfTable(glyf, loca, numGlyphs, indexToLocFormat) {
  const gv = view(glyf);
  const lv = view(loca);
  /** @param {number} i */
  const locaAt = (i) => (indexToLocFormat === 0 ? u16(lv, i * 2) * 2 : u32(lv, i * 4));
  /** @type {GlyphT[]} */
  const glyphs = [];
  for (let g = 0; g < numGlyphs; g++) {
    const r = guard(() => {
      const start = locaAt(g), end = locaAt(g + 1);
      if (end < start || end > glyf.length) return /** @type {const} */ ({ bad: [start, end] });
      if (end === start) return Glyph.Empty;
      const n = i16(gv, start);
      const bbox = [i16(gv, start + 2), i16(gv, start + 4), i16(gv, start + 6), i16(gv, start + 8)];
      if (n >= 0) {
        const endPts = times(n, (k) => u16(gv, start + 10 + k * 2));
        // The spec requires strictly increasing end points. Without it, contours overlap and each
        // re-walks the points: 32767 contours × 65535 points is 2³¹ segments from one glyph.
        for (let k = 1; k < n; k++) if (endPts[k] <= endPts[k - 1]) return /** @type {const} */ ({ contours: k });
        const il = u16(gv, start + 10 + n * 2);
        const nPoints = n === 0 ? 0 : endPts[n - 1] + 1;
        const { xs, ys, on } = parseSimplePoints(gv, start + 12 + n * 2 + il, nPoints);
        return Glyph.Simple(endPts, xs, ys, on, bbox, il);
      }
      const { components, end: cEnd, hasInstructions } = parseComponents(gv, start + 10);
      return Glyph.Composite(components, bbox, hasInstructions ? u16(gv, cEnd) : 0);
    }, (e) => GlyfError.Truncated(g, e.at));
    if (r.tag === 'Err') return r;
    if ('bad' in r.value && r.value.bad) return err(GlyfError.BadLoca(g, r.value.bad[0], r.value.bad[1]));
    if ('contours' in r.value) return err(GlyfError.BadContours(g, r.value.contours));
    glyphs.push(r.value);
  }
  return ok(glyphs);
}

// ---------------------------------------------------------------------------
// Resolution: composite trees -> flat point lists (needed for anchor matching
// and for outline conversion).

/** @typedef {{ xs: Float64Array, ys: Float64Array, on: Uint8Array, endPts: number[] }} Points */

const MAX_DEPTH = 16;
/** A resolved glyph's points: the most a 16-bit maxp.maxCompositePoints can describe. */
export const MAX_POINTS = 65535;
/** Component visits while resolving one glyph: bounds composites of (empty) composites, whose
 *  cost grows as fan-out^depth without ever adding a point. */
export const MAX_VISITS = 4096;

/**
 * @param {GlyphT[] | ((g: number) => import('../../otel-compact/src/adt.js').Result<GlyphT, any>)} glyphs  array, or an accessor (lazy sources)
 * @param {number} gid
 * @returns {import('../../otel-compact/src/adt.js').Result<Points, any>}
 */
export function resolvePoints(glyphs, gid) {
  /** @type {(g: number) => import('../../otel-compact/src/adt.js').Result<GlyphT, any>} */
  const get = typeof glyphs === 'function' ? glyphs
    : (g) => (g >= 0 && g < glyphs.length ? ok(glyphs[g]) : err(GlyfError.Truncated(g, -1)));
  let visits = 0;
  /**
   * Errors are values: each level returns Result and stops at the first Err.
   * @param {number} g @param {number} depth @param {Set<number>} path
   * @returns {import('../../otel-compact/src/adt.js').Result<Points, any>}
   */
  const go = (g, depth, path) => {
    if (depth > MAX_DEPTH) return err(GlyfError.TooDeep(gid));
    if (++visits > MAX_VISITS) return err(GlyfError.TooComplex(gid, 'component visits', MAX_VISITS));
    if (path.has(g)) return err(GlyfError.Cycle(g));
    const got = get(g);
    if (got.tag === 'Err') return got;
    return Glyph.match(got.value, {
      Empty: () => ok({ xs: new Float64Array(0), ys: new Float64Array(0), on: new Uint8Array(0), endPts: [] }),
      Simple: (sg) => ok({ xs: Float64Array.from(sg.xs), ys: Float64Array.from(sg.ys), on: sg.on, endPts: sg.endPts }),
      Composite: (c) => {
        const next = new Set(path).add(g);
        /** @type {Points} */
        let acc = { xs: new Float64Array(0), ys: new Float64Array(0), on: new Uint8Array(0), endPts: [] };
        for (const comp of /** @type {Component[]} */ (c.components)) {
          const sub = go(comp.glyph, depth + 1, next);
          if (sub.tag === 'Err') return sub;
          const child = sub.value;
          const [a, b, cc, d] = comp.matrix;
          const n = child.xs.length;
          if (acc.xs.length + n > MAX_POINTS) return err(GlyfError.TooComplex(gid, 'points', MAX_POINTS));
          const xs = new Float64Array(n), ys = new Float64Array(n);
          for (let i = 0; i < n; i++) {
            xs[i] = a * child.xs[i] + cc * child.ys[i];
            ys[i] = b * child.xs[i] + d * child.ys[i];
          }
          /** @type {[number, number]} */
          let delta;
          if (comp.offset.tag === 'Anchor') {
            const o = comp.offset;
            if (o.parent >= acc.xs.length || o.child >= n) return err(GlyfError.BadAnchor(g, o.parent));
            delta = [acc.xs[o.parent] - xs[o.child], acc.ys[o.parent] - ys[o.child]];
          } else {
            const o = comp.offset;
            delta = comp.flags & COMPOSITE.SCALED_COMPONENT_OFFSET ? [a * o.dx + cc * o.dy, b * o.dx + d * o.dy] : [o.dx, o.dy];
          }
          for (let i = 0; i < n; i++) { xs[i] += delta[0]; ys[i] += delta[1]; }
          acc = concatPoints(acc, { xs, ys, on: child.on, endPts: child.endPts });
        }
        return ok(acc);
      },
    });
  };
  return go(gid, 0, new Set());
}

/** @param {Points} a @param {Points} b @returns {Points} */
function concatPoints(a, b) {
  const n = a.xs.length;
  const xs = new Float64Array(n + b.xs.length); xs.set(a.xs); xs.set(b.xs, n);
  const ys = new Float64Array(n + b.ys.length); ys.set(a.ys); ys.set(b.ys, n);
  const on = new Uint8Array(n + b.on.length); on.set(a.on); on.set(b.on, n);
  return { xs, ys, on, endPts: [...a.endPts, ...b.endPts.map((e) => e + n)] };
}


