// @ts-check
// Scene -> RGBA pixels. Two rasterizers behind one interface:
//
//   accumulate  exact-area coverage via signed-area accumulation (after
//               Raph Levien's font-rs). One pass per edge, one prefix sum per
//               row. Winding is |Σ| clamped to 1: exact for non-overlapping
//               contours and for same-direction overlaps (nonzero).
//   scanline    16 sub-scanlines per pixel row, exact horizontal coverage per
//               span, true nonzero or even-odd winding. Independent algorithm;
//               differs from `accumulate` only by vertical sampling error (≤ 1/16
//               per pixel). Even-odd batches always use scanline.
//
// Each returns a fresh Float32Array of coverage in [0, 1]. Internals mutate
// their own scratch buffers only.

import { flattenLinear, hullBounds } from '../../outline/src/path.js';
import { isDeferred, geometry } from './scene.js';
import { LIMITS } from '../../sfnt/src/limits.js';
import { NOOP_SPAN } from '../../otel-compact/src/trace.js';
import { memo, Policy } from '../../cache/src/policy.js';
import { isSolid, isOpaque, colours, paintKey, lut, lutIndices } from './paint.js';

/**
 * @typedef {object} Rasterizer
 * @property {string} name
 * @property {(polys: Float64Array[], w: number, h: number, span?: import('../../otel-compact/src/trace.js').Span, evenOdd?: boolean) => Float32Array} fill
 *   whole-image coverage, w·h. evenOdd: only `scanline` implements it; callers route even-odd batches there.
 * @property {(polys: Float64Array[], w: number, h: number, rows: number, span?: import('../../otel-compact/src/trace.js').Span, shared?: Float32Array, evenOdd?: boolean, from?: number) => Generator<Band, void, void>} bands
 *   coverage `rows` rows at a time, top to bottom from row `from` (a multiple of `rows`; default 0;
 *   every row above it must be empty of ink); each yielded buffer is valid until the next step.
 *   `shared` (zeroed, ≥ rows·w): render into it; the caller must zero [x0, x1) of each row it consumed
 */
/**
 * @typedef {object} Band
 * @property {Float32Array} cov   rows·w coverage, row-major
 * @property {number} x0          coverage is zero outside columns [x0, x1) (x0 = x1: empty band)
 * @property {number} x1
 */

/** @type {Rasterizer['fill']} */
function accumulateFill(polys, w, h, span = NOOP_SPAN) {
  const stride = w + 2; // +2: right-clamped edges land in padding, never in the next row
  const acc = span.span('acc.alloc', { atomic: true, items: stride * h }, () => new Float32Array(stride * h));
  let edges = 0;
  span.span('acc.edges', { atomic: true }, (es) => {
    for (const p of polys) {
      const n = p.length / 2;
      edges += n;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        line(acc, stride, w, h, p[2 * i], p[2 * i + 1], p[2 * j], p[2 * j + 1]);
      }
    }
    es.set('items', edges);
  });
  return span.span('acc.prefix', { atomic: true, items: h }, () => {
    const out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      let s = 0;
      for (let x = 0; x < w; x++) {
        s += acc[y * stride + x];
        out[y * w + x] = Math.min(1, Math.abs(s));
      }
    }
    return out;
  });
}

/** @type {Rasterizer} */
export const accumulate = Object.freeze({ name: 'accumulate', fill: accumulateFill, bands: bandsFromFill(accumulateFill) });

/**
 * Deposit one edge's signed area and cover into the accumulation buffer.
 * x is clamped to [0, w]: coverage left of the canvas folds into column 0,
 * right of it into padding.
 * @param {Float32Array} a @param {number} stride @param {number} w @param {number} h
 * @param {number} x0 @param {number} y0 @param {number} x1 @param {number} y1
 */
function line(a, stride, w, h, x0, y0, x1, y1) {
  if (y0 === y1) return;
  const dir = y0 < y1 ? 1 : -1;
  if (dir < 0) { [x0, y0, x1, y1] = [x1, y1, x0, y0]; }
  const dxdy = (x1 - x0) / (y1 - y0);
  let x = x0;
  if (y0 < 0) { x -= y0 * dxdy; }
  const yStart = Math.max(0, Math.floor(y0)), yEnd = Math.min(h, Math.ceil(y1));
  for (let y = yStart; y < yEnd; y++) {
    const row = y * stride;
    const dy = Math.min(y + 1, y1) - Math.max(y, y0);
    const xnext = x + dxdy * dy;
    const d = dy * dir;
    const xa = Math.min(Math.max(Math.min(x, xnext), 0), w);
    const xb = Math.min(Math.max(Math.max(x, xnext), 0), w);
    const x0f = Math.floor(xa), x0i = x0f;
    const x1c = Math.ceil(xb), x1i = x1c;
    if (x1i <= x0i + 1) {
      const xm = 0.5 * (xa + xb) - x0f;
      a[row + x0i] += d - d * xm;
      a[row + x0i + 1] += d * xm;
    } else {
      const s = 1 / (xb - xa);
      const fx0 = xa - x0f;
      const a0 = 0.5 * s * (1 - fx0) * (1 - fx0);
      const fx1 = xb - x1c + 1;
      const am = 0.5 * s * fx1 * fx1;
      a[row + x0i] += d * a0;
      if (x1i === x0i + 2) {
        a[row + x0i + 1] += d * (1 - a0 - am);
      } else {
        const a1 = s * (1.5 - fx0);
        a[row + x0i + 1] += d * (a1 - a0);
        for (let xi = x0i + 2; xi < x1i - 1; xi++) a[row + xi] += d * s;
        const a2 = a1 + (x1i - x0i - 3) * s;
        a[row + x1i - 1] += d * (1 - a2 - am);
      }
      a[row + x1i] += d * am;
    }
    x = xnext;
  }
}

const SUB = 16;
const ROWS = 8;

/**
 * Exact nonzero scan converter as a resumable state machine. `rows(yb, yEnd, out, base)`
 * accumulates coverage for rows [yb, yEnd) into `out` at row index y − base; calls must
 * walk y upward with no gaps. Whole-image `fill` and banded `bands` share this code, so a
 * pixel's coverage is the same float sum in the same order either way.
 * @param {Float64Array[]} polys @param {number} w @param {number} h
 * @param {import('../../otel-compact/src/trace.js').Span} [span]
 */
function scanner(polys, w, h, span = NOOP_SPAN, evenOdd = false) {
  // Edges as structure-of-arrays (y0 < y1), wind = +1 downward, -1 upward.
  const E = span.span('scan.edges', { atomic: true }, (es) => {
    let n = 0;
    for (const p of polys) n += p.length / 2;
    const X0 = new Float64Array(n), Y0 = new Float64Array(n), X1 = new Float64Array(n), Y1 = new Float64Array(n), W = new Int8Array(n);
    let m = 0;
    for (const p of polys) {
      const k = p.length / 2;
      for (let i = 0; i < k; i++) {
        const j = i + 1 === k ? 0 : i + 1;
        const ax = p[2 * i], ay = p[2 * i + 1], bx = p[2 * j], by = p[2 * j + 1];
        if (ay === by) continue;
        if (ay < by) { X0[m] = ax; Y0[m] = ay; X1[m] = bx; Y1[m] = by; W[m] = 1; }
        else { X0[m] = bx; Y0[m] = by; X1[m] = ax; Y1[m] = ay; W[m] = -1; }
        m++;
      }
    }
    es.set('items', m);
    return { X0, Y0, X1, Y1, W, m };
  });
  const { X0, Y0, X1, Y1, W, m } = E;
  // Stable index sort by y0 (same order as sorting the edge objects).
  const order = span.span('scan.sort', { atomic: true, items: m }, () => stableOrder(Y0, m));
  // Active edges are kept ordered by their current x. Between sub-scanlines
  // 1/16 px apart edges barely move, so re-sorting is nearly free; sorting
  // crossings from start-y order instead was O(k²) and the top cost in profiles.
  const active = new Int32Array(m), xs = new Float64Array(m);
  // Scratch for merging newly started edges: sorted by x on their own, then
  // merged in one linear pass. Appending them and insertion-sorting was O(n²)
  // when a line's glyph tops all start together (bench/sweep.js: exponent 1.42).
  // Shared across scanners (only one scans at a time) and sized to the largest seen: they are
  // rewritten before every read. Allocating them per batch was most of the render's GC.
  const { fresh, fx, mA, mX, cnt } = scratch(m, w);
  let nActive = 0, next = 0;
  const weight = 1 / SUB;
  // Interior pixels of a span are fully covered: count those per row in a difference
  // array (O(1) per span) and add count/SUB once per row, instead of += 1/SUB per pixel
  // per sub-scanline (O(span width)). Partial end pixels are still added exactly.
  // (cnt comes from scratch: every row zeroes what it touched, so it is all zeros between rows.)
  /**
   * @param {number} yb @param {number} yEnd @param {Float32Array} out @param {number} base
   * @returns {number} packed dirty columns: x0 · 65536 + x1 (x1 ≤ x0 when nothing was touched)
   */
  const rows = (yb, yEnd, out, base) => {
    let lo = w, hi = 0;
    for (let y = yb; y < yEnd; y++) {
      const row = (y - base) * w;
      let c0 = w, c1 = 0; // this row's touched range in cnt
      for (let k = 0; k < SUB; k++) {
        const sy = y + (k + 0.5) / SUB;
        // 1. Existing edges: drop finished, update x in place (bit-identical expression).
        let live = 0;
        for (let a = 0; a < nActive; a++) {
          const e = active[a];
          if (Y1[e] <= sy) continue;
          active[live] = e;
          xs[live++] = X0[e] + (sy - Y0[e]) * (X1[e] - X0[e]) / (Y1[e] - Y0[e]);
        }
        nActive = live;
        // Re-sort: O(k) on a list that was sorted one sub-scanline ago.
        for (let i = 1; i < nActive; i++) {
          const x = xs[i];
          if (xs[i - 1] <= x) continue;
          const e = active[i];
          let j = i;
          while (j > 0 && xs[j - 1] > x) { xs[j] = xs[j - 1]; active[j] = active[j - 1]; j--; }
          xs[j] = x; active[j] = e;
        }
        // 2. Edges starting at this sub-scanline: sort the batch, then merge.
        let nf = 0;
        while (next < m && Y0[order[next]] <= sy) {
          const e = order[next++];
          if (Y1[e] <= sy) continue;
          const x = X0[e] + (sy - Y0[e]) * (X1[e] - X0[e]) / (Y1[e] - Y0[e]);
          let j = nf++;
          while (j > 0 && fx[j - 1] > x) { fx[j] = fx[j - 1]; fresh[j] = fresh[j - 1]; j--; }
          fx[j] = x; fresh[j] = e;
        }
        if (nf) {
          let i = 0, j = 0, o = 0;
          while (i < nActive && j < nf) {
            if (fx[j] < xs[i]) { mA[o] = fresh[j]; mX[o++] = fx[j++]; }
            else { mA[o] = active[i]; mX[o++] = xs[i++]; }
          }
          while (i < nActive) { mA[o] = active[i]; mX[o++] = xs[i++]; }
          while (j < nf) { mA[o] = fresh[j]; mX[o++] = fx[j++]; }
          active.set(mA.subarray(0, o)); xs.set(mX.subarray(0, o));
          nActive = o;
        }
        // Inside where the winding number is nonzero, or (even-odd) odd. A span opens where
        // `inside` becomes true and closes at the first edge where it is false again.
        const mask = evenOdd ? 1 : -1;
        let wind = 0;
        for (let i = 0; i < nActive; i++) {
          const before = wind;
          wind += W[active[i]];
          if ((before & mask) === 0 && (wind & mask) !== 0) {
            let j = i + 1, ww = wind;
            for (; j < nActive; j++) { ww += W[active[j]]; if ((ww & mask) === 0) break; }
            let xa = xs[i], xb = j < nActive ? xs[j] : w;
            i = j; wind = 0;
            xa = Math.max(0, xa); xb = Math.min(w, xb);
            if (xb <= xa) continue;
            const ia = Math.floor(xa), ib = Math.floor(xb);
            if (ia === ib) { out[row + ia] += (xb - xa) * weight; }
            else {
              out[row + ia] += (ia + 1 - xa) * weight;
              if (ib > ia + 1) { cnt[ia + 1]++; cnt[ib]--; if (ia + 1 < c0) c0 = ia + 1; if (ib > c1) c1 = ib; }
              if (ib < w) out[row + ib] += (xb - ib) * weight;
            }
            if (ia < lo) lo = ia;
            const e = Math.min(w, Math.ceil(xb));
            if (e > hi) hi = e;
          }
        }
      }
      if (c1 > c0) {
        let run = 0;
        for (let x = c0; x < c1; x++) { run += cnt[x]; cnt[x] = 0; if (run) out[row + x] += run * weight; }
        cnt[c1] = 0;
      }
    }
    return lo * 65536 + hi;
  };
  // Vertical extent of this polygon set: bands wholly outside it have nothing to scan.
  let yMax = -Infinity;
  for (let i = 0; i < m; i++) if (Y1[i] > yMax) yMax = Y1[i];
  const yMin = m ? Y0[order[0]] : Infinity;
  return { rows, yMin, yMax };
}

/** Scanner scratch, grown on demand. */
const SCRATCH = { fresh: new Int32Array(0), fx: new Float64Array(0), mA: new Int32Array(0), mX: new Float64Array(0), cnt: new Int32Array(0) };
/** @param {number} m  edges @param {number} w  width */
function scratch(m, w) {
  if (SCRATCH.fresh.length < m) {
    const k = Math.max(m, SCRATCH.fresh.length * 2);
    SCRATCH.fresh = new Int32Array(k); SCRATCH.fx = new Float64Array(k); SCRATCH.mA = new Int32Array(k); SCRATCH.mX = new Float64Array(k);
  }
  if (SCRATCH.cnt.length < w + 1) SCRATCH.cnt = new Int32Array(w + 1);
  return SCRATCH;
}

/**
 * Indices 0..m-1 ordered by key, ties in index order: the order a stable comparator sort
 * gives, without a callback per comparison (that sort was 7% of the poster's render).
 * Insertion sort for short runs, then bottom-up merges.
 * @param {Float64Array} key @param {number} m @returns {Int32Array}
 */
export function stableOrder(key, m) {
  let a = new Int32Array(m), b = new Int32Array(m);
  for (let i = 0; i < m; i++) a[i] = i;
  const RUN = 16;
  for (let lo = 0; lo < m; lo += RUN) {
    const hi = Math.min(m, lo + RUN);
    for (let i = lo + 1; i < hi; i++) {
      const v = a[i], kv = key[v];
      let j = i;
      while (j > lo && key[a[j - 1]] > kv) { a[j] = a[j - 1]; j--; }
      a[j] = v;
    }
  }
  for (let width = RUN; width < m; width *= 2) {
    for (let lo = 0; lo < m; lo += 2 * width) {
      const mid = Math.min(m, lo + width), hi = Math.min(m, lo + 2 * width);
      let i = lo, j = mid, o = lo;
      while (i < mid && j < hi) b[o++] = key[a[j]] < key[a[i]] ? a[j++] : a[i++];
      while (i < mid) b[o++] = a[i++];
      while (j < hi) b[o++] = a[j++];
    }
    const t = a; a = b; b = t;
  }
  return a;
}

/**
 * Banded coverage from a whole-image `fill`: the adapter for rasterizers with no
 * native banding. Same API, whole-image memory.
 * @param {(polys: Float64Array[], w: number, h: number, span?: any, evenOdd?: boolean) => Float32Array} fill
 * @returns {Rasterizer['bands']}
 */
function bandsFromFill(fill) {
  return function* (polys, w, h, rows, span = NOOP_SPAN, shared, evenOdd = false, from = 0) {
    const all = fill(polys, w, h, span, evenOdd);
    for (let yb = from; yb < h; yb += rows) yield { cov: all.subarray(yb * w, Math.min(h, yb + rows) * w), x0: 0, x1: w };
  };
}

/** @type {Rasterizer} */
export const scanline = Object.freeze({
  name: 'scanline',
  fill(polys, w, h, span = NOOP_SPAN, evenOdd = false) {
    const sc = scanner(polys, w, h, span, evenOdd);
    const out = span.span('scan.alloc', { atomic: true, items: w * h }, () => new Float32Array(w * h));
    for (let yb = 0; yb < h; yb += ROWS) span.span('scan.rows', { atomic: true, items: Math.min(ROWS, h - yb), y: yb }, () => sc.rows(yb, Math.min(h, yb + ROWS), out, 0));
    return out;
  },
  /**
   * Native bands: one `rows`-row coverage buffer, refilled per band. Only the columns the
   * previous band touched are re-zeroed, and the dirty columns are reported, so callers
   * touch O(ink) pixels per colour rather than O(band).
   */
  *bands(polys, w, h, rows, span = NOOP_SPAN, shared, evenOdd = false, from = 0) {
    const sc = scanner(polys, w, h, span, evenOdd);
    // With `shared`, the caller owns the buffer and re-zeroes what it consumed (one buffer
    // serves every fill colour in turn); without it, this generator keeps its own and re-zeroes.
    const buf = shared ?? new Float32Array(w * Math.min(rows, h));
    let px0 = 0, px1 = 0, prows = 0;
    // Starting below row 0 is exact: bands above yMin are skipped below anyway, leaving the
    // scanner's state as it was.
    for (let yb = from; yb < h; yb += rows) {
      const yEnd = Math.min(h, yb + rows), band = buf.subarray(0, (yEnd - yb) * w);
      if (!shared && px1 > px0) for (let r = 0; r < prows; r++) buf.fill(0, r * w + px0, r * w + px1);
      // Outside [yMin, yMax) no edge is active or starts: skipping the band leaves the scanner's
      // state exactly as scanning it would (nothing to retire, nothing to admit).
      const d = yEnd <= sc.yMin || yb >= sc.yMax ? 0
        : span.span('scan.rows', { atomic: true, items: yEnd - yb, y: yb }, () => sc.rows(yb, yEnd, band, yb));
      px0 = Math.floor(d / 65536); px1 = d % 65536; prows = yEnd - yb;
      yield { cov: band, x0: px0, x1: Math.max(px0, px1) };
    }
  },

});

/** Add `weight` × exact horizontal overlap of [xa, xb) with each pixel of row y. */
function addSpan(/** @type {Float32Array} */ out, /** @type {number} */ w, /** @type {number} */ row, /** @type {number} */ xa, /** @type {number} */ xb, /** @type {number} */ weight) {
  xa = Math.max(0, xa); xb = Math.min(w, xb);
  if (xb <= xa) return;
  const ia = Math.floor(xa), ib = Math.floor(xb);
  if (ia === ib) { out[row + ia] += (xb - xa) * weight; return; }
  out[row + ia] += (ia + 1 - xa) * weight;
  for (let x = ia + 1; x < ib; x++) out[row + x] += weight;
  if (ib < w) out[row + ib] += (xb - ib) * weight;
}

// ---------------------------------------------------------------------------

/** Flatten tolerance in pixels: well under one 8-bit coverage step at the edge. */
export const FLATTEN_TOL = 0.02;

/**
 * Flattened outlines keyed by glyph key + the transform's linear part (a, b, c, d).
 * Values are polygons in that linear space; each instance adds its own translation.
 * A byte-bounded memo with a pluggable eviction policy (cache/src/policy.js); the default
 * policy is the one bench/replay.js measured best for glyph traffic.
 * @typedef {import('../../cache/src/policy.js').Memo<Float64Array[]>} FlattenCache
 * @param {{ policy?: import('../../cache/src/policy.js').PolicyT, maxBytes?: number }} [opts]
 * @returns {FlattenCache}
 */
export const flattenCache = ({ policy = Policy.Sieve, maxBytes = 8 << 20 } = {}) =>
  memo(policy, { maxBytes, sizeOf: (polys) => polys.reduce((n, p) => n + p.byteLength + 64, 64) });

/**
 * @typedef {object} Batch
 * @property {import('./paint.js').Paint} fill
 * @property {Float64Array[]} polys   pixel space
 * @property {boolean} evenOdd
 * @property {number} y0   vertical extent (pixel space), from the items' hulls: ⊇ the ink
 * @property {number} y1
 */

/**
 * A batch before its geometry exists: which items, and conservative bounds.
 * @typedef {object} PlannedBatch
 * @property {import('./paint.js').Paint} fill
 * @property {boolean} evenOdd
 * @property {number[]} items   indices into scene.items, in paint order
 * @property {number} x0 @property {number} y0 @property {number} x1 @property {number} y1
 */

/** Control-point hulls of concrete paths, memoised by path object (glyph paths recur). */
const HULLS = new WeakMap();
const EMPTY_HULL = Object.freeze(/** @type {const} */ ([Infinity, Infinity, -Infinity, -Infinity]));
/** @param {import('./scene.js').Geometry} g @returns {readonly [number, number, number, number]} */
function hullOf(g) {
  if (isDeferred(g)) return g.hull;
  if (HULLS.has(g)) return HULLS.get(g);
  const h = hullBounds(g);
  const v = h ? /** @type {const} */ ([h[0], h[1], h[2], h[3]]) : EMPTY_HULL;
  HULLS.set(g, v);
  return v;
}

/**
 * Batch the scene from hulls alone: no geometry is built. An item's device bounds are its hull's
 * corners under its transform, a superset of its ink, so every decision below is conservative
 * (a join refused that ink bounds would allow costs a coverage pass, never correctness).
 *
 * Batches are in paint order. An item joins the latest batch of its paint and rule only if no
 * batch started after that one overlaps it; otherwise it starts a new batch. So painter's order
 * holds wherever it is visible (overlap), and disjoint items of one paint still share a coverage
 * pass. (Keying batches by colour alone painted a colour at its first use, under anything drawn
 * later: found by the range posters.) A batch is one coverage pass, so overlaps inside it are
 * unioned, not stacked. For an opaque paint that is the same picture (minus the faint seam
 * stacking leaves where two anti-aliased edges abut). A translucent paint must stack, as SVG and
 * Canvas do: such an item joins only if it misses the batch's bounds. (Unioning 40 translucent
 * bands into one pass painted them as one band: found by a 22k-item poster.)
 * @param {import('./scene.js').Scene} scene
 * @returns {PlannedBatch[]}
 */
export function planBatches(scene) {
  /** @type {(PlannedBatch & { key: string })[]} */
  const groups = [];
  /** @type {Map<string, number>} latest batch index per paint and rule */
  const latest = new Map();
  scene.items.forEach((it, idx) => {
    const h = hullOf(it.path);
    if (!(h[0] <= h[2] && h[1] <= h[3])) return; // no geometry
    const [a, b, c, d, e, f] = it.transform;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [hx, hy] of [[h[0], h[1]], [h[2], h[1]], [h[0], h[3]], [h[2], h[3]]]) {
      const x = a * hx + c * hy + e, y = b * hx + d * hy + f;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    const evenOdd = it.rule === 'evenodd';
    const k = `${evenOdd ? 'eo' : 'nz'}|${paintKey(it.fill)}`;
    let joinable = latest.has(k);
    const gi = joinable ? /** @type {number} */ (latest.get(k)) : -1;
    // Translucent items stack; even-odd items cannot be unioned either (overlaps would cancel by
    // parity). Either joins a batch only where it misses the batch's bounds.
    if (joinable && (!isOpaque(it.fill) || evenOdd)) {
      const o = groups[gi];
      if (x0 < o.x1 && o.x0 < x1 && y0 < o.y1 && o.y0 < y1) joinable = false;
    }
    for (let j = gi + 1; joinable && j < groups.length; j++) {
      const o = groups[j];
      if (x0 < o.x1 && o.x0 < x1 && y0 < o.y1 && o.y0 < y1) joinable = false;
    }
    let g;
    if (joinable) g = groups[gi];
    else { g = { fill: it.fill, evenOdd, key: k, items: [], x0, y0, x1, y1 }; latest.set(k, groups.length); groups.push(g); }
    g.items.push(idx);
    if (x0 < g.x0) g.x0 = x0; if (y0 < g.y0) g.y0 = y0; if (x1 > g.x1) g.x1 = x1; if (y1 > g.y1) g.y1 = y1;
  });
  return groups.map(({ fill, evenOdd, items, x0, y0, x1, y1 }) => ({ fill, evenOdd, items, x0, y0, x1, y1 }));
}

/**
 * One item's polygons in pixel space: flatten(L·path) + t, where the flattening under the linear
 * part L is memoised by (key, L). That definition is what makes the cache a pure memo: a hit and
 * a miss produce the same bits. Deferred geometry is built here, flattened, and not kept.
 * @param {import('./scene.js').SceneItem} it @param {FlattenCache} cache
 * @param {import('../../otel-compact/src/trace.js').Span} span
 * @returns {Float64Array[]}
 */
function itemPolygons(it, cache, span) {
  const [a, b, c, d, e, f] = it.transform;
  const key = `${it.key}|${a},${b},${c},${d}`;
  const cached = cache.get(key);
  let base;
  if (cached.tag === 'Some') base = cached.value;
  else {
    base = span.span('flatten.glyph', { key: it.key }, (fs) => {
      const path = isDeferred(it.path) ? fs.span('flatten.build', () => geometry(it.path)) : it.path;
      const polys = fs.span('flatten.subdivide', { segs: path.length }, () => {
        // = flatten(transform(path, [a, b, c, d, 0, 0])), bit for bit, without the intermediate path.
        const r = flattenLinear(path, [a, b, c, d], FLATTEN_TOL, { maxPieces: LIMITS.curvePieces, maxPoints: LIMITS.glyphFlatPoints });
        if (r.tag === 'Ok') return it.rule === 'evenodd' ? r.value : positive(r.value);
        fs.set('skipped', 'flatten budget'); // an absurd outline costs this glyph, not the render
        return [];
      });
      if (fs.recording) fs.set('points', polys.reduce((n, p) => n + p.length / 2, 0));
      return polys;
    });
    cache.set(key, base);
  }
  // No translation (every `draw` item in scene coordinates): share the cached polygons rather
  // than copy them. Polygons are read-only from here on, and p + 0 differs from p only for −0,
  // which every consumer treats as 0.
  if (e === 0 && f === 0) return base;
  return base.map((p) => {
    const q = new Float64Array(p.length);
    for (let i = 0; i < p.length; i += 2) { q[i] = p[i] + e; q[i + 1] = p[i + 1] + f; }
    return q;
  });
}

/**
 * A nonzero item's polygons with its net winding made positive (every contour reversed when the
 * signed area is negative). Alone, an item looks the same either way: nonzero is symmetric in
 * the sign. But a batch is one coverage pass over the union of its items, and a union is only
 * right when the items wind alike: a TrueType glyph (negative after the y flip) and its stroke
 * outline (positive) cancelled to zero where they overlapped, and an outlined headline rendered
 * hollow (found by the OG card).
 * @param {Float64Array[]} polys @returns {Float64Array[]}
 */
function positive(polys) {
  let area = 0;
  for (const p of polys) {
    const n = p.length;
    for (let i = 0; i < n; i += 2) { const j = i + 2 === n ? 0 : i + 2; area += p[i] * p[j + 1] - p[j] * p[i + 1]; }
  }
  if (area >= 0) return polys;
  return polys.map((p) => {
    const q = new Float64Array(p.length);
    for (let i = 0, j = p.length - 2; j >= 0; i += 2, j -= 2) { q[i] = p[j]; q[i + 1] = p[j + 1]; }
    return q;
  });
}

/**
 * A planned batch's polygons, built now.
 * @param {import('./scene.js').Scene} scene @param {PlannedBatch} pb
 * @param {FlattenCache} cache @param {import('../../otel-compact/src/trace.js').Span} [span]
 * @returns {Float64Array[]}
 */
export function materialize(scene, pb, cache, span = NOOP_SPAN) {
  /** @type {Float64Array[]} */
  const out = [];
  for (const i of pb.items) for (const p of itemPolygons(scene.items[i], cache, span)) out.push(p);
  return out;
}

/**
 * Every batch with its polygons: planBatches + materialize, all at once. The streaming PNG path
 * does the same a band at a time instead (stream.js), so peak memory is the geometry in flight.
 * Pass a long-lived cache to reuse outlines across renders; the default is per call.
 * @param {import('./scene.js').Scene} scene
 * @param {import('../../otel-compact/src/trace.js').Span} [span]
 * @param {FlattenCache} [cache]
 * @returns {Batch[]}
 */
export function scenePolygons(scene, span = NOOP_SPAN, cache = flattenCache()) {
  const plan = planBatches(scene);
  const out = [];
  for (const pb of plan) {
    const polys = materialize(scene, pb, cache, span);
    if (polys.length) out.push(/** @type {Batch} */ ({ fill: pb.fill, polys, evenOdd: pb.evenOdd, y0: pb.y0, y1: pb.y1 }));
  }
  if (span.recording) { span.set('cache.hits', cache.stats.hits); span.set('cache.misses', cache.stats.misses); span.set('cache.bytes', cache.stats.bytes); span.set('batches', out.length); }
  return out;
}

/**
 * Narrowest PNG-able pixel format that represents the composite exactly.
 *   1 channel (gray): opaque background and every colour has r = g = b, so the
 *     per-channel composite round(bg·(1−a) + fg·a) is the same in every channel
 *     and alpha stays 255.
 *   3 channels (RGB): opaque background.
 *   4 channels (RGBA): otherwise.
 * @param {import('./scene.js').Scene} scene
 * @returns {1 | 3 | 4}
 */
export function channelsFor(scene) {
  const bg = scene.background;
  if (bg[3] !== 255) return 4;
  const gray = (/** @type {import('./scene.js').RGBA} */ c) => c[0] === c[1] && c[1] === c[2];
  return gray(bg) && scene.items.every((it) => colours(it.fill).every(gray)) ? 1 : 3;
}

/**
 * @typedef {object} Image
 * @property {number} width
 * @property {number} height
 * @property {1 | 3 | 4} channels
 * @property {Uint8Array} data       width·height·channels bytes
 * @property {Uint8Array} rgba       the same image as RGBA (computed on first read)
 * @property {Float32Array[]} coverage
 */

/**
 * @param {import('./scene.js').Scene} scene
 * @param {Rasterizer} r
 * @param {import('../../otel-compact/src/trace.js').Span} [span]
 * @param {{ channels?: 1 | 3 | 4, cache?: FlattenCache }} [opts]
 *   channels: force a format (default: channelsFor(scene)); cache: reuse flattened outlines across calls
 * @returns {Image}
 */
export function rasterize(scene, r, span = NOOP_SPAN, { channels = channelsFor(scene), cache = flattenCache() } = {}) {
  const { width: w, height: h } = scene;
  const n = w * h, C = channels;
  const data = span.span('raster.clear', { atomic: true, items: n, channels: C }, () => paint(new Uint8Array(n * C), scene.background, C));
  const coverage = [];
  const groups = span.span('raster.flatten', (fs) => scenePolygons(scene, fs, cache));
  for (const { fill, polys, evenOdd } of groups) {
    const rr = evenOdd ? scanline : r;
    const cov = span.span(`raster.fill`, { rasterizer: rr.name, polys: polys.length }, (fs) => rr.fill(polys, w, h, fs, evenOdd));
    coverage.push(cov);
    span.span('raster.composite', { atomic: true, items: n, channels: C }, () => {
      if (isSolid(fill)) composite(data, C, cov, fill, n);
      else for (let y = 0; y < h; y++) compositeRow(data, C, cov, fill, w, 0, y, y * w * C, y * w);
    });
  }
  /** @type {Uint8Array | null} */
  let rgba = null;
  return {
    width: w, height: h, channels: C, data, coverage,
    get rgba() { return (rgba ??= expand(data, C, n)); },
  };
}

/**
 * Fill `px` with the background colour in C channels.
 * @param {Uint8Array} px @param {import('./scene.js').RGBA} bg @param {number} C
 */
export function paint(px, bg, C) {
  if (C === 1) return px.fill(bg[0]);
  if (px.length === 0) return px;
  // Seed one pixel, then double the filled prefix with copyWithin (memmove): log₂(n) calls.
  px.set(bg.slice(0, C));
  for (let len = C; len < px.length; len *= 2) px.copyWithin(len, 0, Math.min(len, px.length - len));
  return px;
}

/**
 * Same per-channel formula for every format: round(dst·(1−a) + src·a).
 * Reads cov[cOff + i] and writes pixel i at byte dOff + i·C (offsets, not subarrays: the banded
 * stream composites a row segment per batch per row, and a subarray view per call was ~2 M short-
 * lived objects on the 22k-item poster).
 * @param {Uint8Array} d @param {number} C @param {Float32Array} cov @param {import('./scene.js').RGBA} fill @param {number} n
 * @param {number} [dOff] @param {number} [cOff]
 */
export function composite(d, C, cov, fill, n, dOff = 0, cOff = 0) {
  const fa = fill[3] / 255;
  const r = fill[0], g = fill[1], b = fill[2];
  if (C === 1) {
    for (let i = 0, o = dOff; i < n; i++, o++) {
      const a = cov[cOff + i] * fa;
      if (a === 0) continue;
      d[o] = a === 1 ? r : Math.round(d[o] * (1 - a) + r * a);
    }
  } else if (C === 3) {
    for (let i = 0, o = dOff; i < n; i++, o += 3) {
      const a = cov[cOff + i] * fa;
      if (a === 0) continue;
      if (a === 1) { d[o] = r; d[o + 1] = g; d[o + 2] = b; continue; }
      const k = 1 - a;
      d[o] = Math.round(d[o] * k + r * a); d[o + 1] = Math.round(d[o + 1] * k + g * a); d[o + 2] = Math.round(d[o + 2] * k + b * a);
    }
  } else {
    for (let i = 0, o = dOff; i < n; i++, o += 4) {
      const a = cov[cOff + i] * fa;
      if (a === 0) continue;
      if (a === 1) { d[o] = r; d[o + 1] = g; d[o + 2] = b; d[o + 3] = 255; continue; }
      const k = 1 - a;
      d[o] = Math.round(d[o] * k + r * a); d[o + 1] = Math.round(d[o + 1] * k + g * a);
      d[o + 2] = Math.round(d[o + 2] * k + b * a); d[o + 3] = Math.round(d[o + 3] * k + 255 * a);
    }
  }
}

const IDX = { buf: new Int32Array(0) };

/**
 * composite() for any paint, over one row segment starting at pixel (x, y): a gradient's colour
 * is looked up per pixel, then blended with the same formula as a solid colour.
 * @param {Uint8Array} d @param {number} C @param {Float32Array} cov
 * @param {import('./paint.js').Paint} fill @param {number} n @param {number} x @param {number} y
 * @param {number} [dOff] @param {number} [cOff]  as in composite()
 */
export function compositeRow(d, C, cov, fill, n, x, y, dOff = 0, cOff = 0) {
  if (isSolid(fill)) return composite(d, C, cov, fill, n, dOff, cOff);
  if (IDX.buf.length < n) IDX.buf = new Int32Array(n);
  const idx = lutIndices(fill, x, y, n, IDX.buf), L = lut(fill);
  for (let i = 0, o = dOff; i < n; i++, o += C) {
    const c = cov[cOff + i];
    if (c === 0) continue;
    const l = idx[i] * 4, a = c * L[l + 3] / 255;
    if (a === 0) continue;
    const k = 1 - a;
    if (C === 1) { d[o] = Math.round(d[o] * k + L[l] * a); continue; }
    d[o] = Math.round(d[o] * k + L[l] * a); d[o + 1] = Math.round(d[o + 1] * k + L[l + 1] * a); d[o + 2] = Math.round(d[o + 2] * k + L[l + 2] * a);
    if (C === 4) d[o + 3] = Math.round(d[o + 3] * k + 255 * a);
  }
}

/** @param {Uint8Array} d @param {number} C @param {number} n */
function expand(d, C, n) {
  if (C === 4) return d;
  const out = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    const s = i * C, o = i * 4;
    out[o] = d[s]; out[o + 1] = d[s + (C === 3 ? 1 : 0)]; out[o + 2] = d[s + (C === 3 ? 2 : 0)]; out[o + 3] = 255;
  }
  return out;
}
