// @ts-check
// The outline IR every producer emits and every target consumes.
// Producers: TrueType contours (quadratic), CFF charstrings (cubic).
// Consumers: SVG (serialise), PNG (flatten -> rasterise).

import { variants, ok, err } from '../../otel-compact/src/adt.js';

export const Seg = variants('Seg', {
  MoveTo: ['x', 'y'],
  LineTo: ['x', 'y'],
  QuadTo: ['x1', 'y1', 'x', 'y'],
  CubicTo: ['x1', 'y1', 'x2', 'y2', 'x', 'y'],
  Close: [],
});
/** @typedef {import('../../otel-compact/src/adt.js').Of<typeof Seg>} SegT */
/** @typedef {readonly SegT[]} Path */

/** Affine [a, b, c, d, e, f]: x' = a·x + c·y + e, y' = b·x + d·y + f (SVG order). */
/** @typedef {readonly [number, number, number, number, number, number]} Affine */

/** @type {Affine} */
export const IDENTITY = Object.freeze([1, 0, 0, 1, 0, 0]);

/** m1 ∘ m2: apply m2 first. @param {Affine} m1 @param {Affine} m2 @returns {Affine} */
export const compose = ([a, b, c, d, e, f], [A, B, C, D, E, F]) =>
  [a * A + c * B, b * A + d * B, a * C + c * D, b * C + d * D, a * E + c * F + e, b * E + d * F + f];

/** @param {Path} path @param {Affine} m @returns {Path} */
export function transform(path, [a, b, c, d, e, f]) {
  const X = (/** @type {number} */ x, /** @type {number} */ y) => a * x + c * y + e;
  const Y = (/** @type {number} */ x, /** @type {number} */ y) => b * x + d * y + f;
  return path.map((s) => Seg.match(s, {
    MoveTo: ({ x, y }) => Seg.MoveTo(X(x, y), Y(x, y)),
    LineTo: ({ x, y }) => Seg.LineTo(X(x, y), Y(x, y)),
    QuadTo: ({ x1, y1, x, y }) => Seg.QuadTo(X(x1, y1), Y(x1, y1), X(x, y), Y(x, y)),
    CubicTo: ({ x1, y1, x2, y2, x, y }) => Seg.CubicTo(X(x1, y1), Y(x1, y1), X(x2, y2), Y(x2, y2), X(x, y), Y(x, y)),
    Close: () => Seg.Close,
  }));
}

/**
 * Control-point hull bounds (a superset of the ink bounds), or null if empty.
 * @param {Path} path @returns {[number, number, number, number] | null}
 */
export function hullBounds(path) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const add = (/** @type {number} */ x, /** @type {number} */ y) => {
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  };
  for (const s of path) {
    Seg.match(s, {
      MoveTo: ({ x, y }) => add(x, y),
      LineTo: ({ x, y }) => add(x, y),
      QuadTo: ({ x1, y1, x, y }) => { add(x1, y1); add(x, y); },
      CubicTo: ({ x1, y1, x2, y2, x, y }) => { add(x1, y1); add(x2, y2); add(x, y); },
      Close: () => {},
    });
  }
  return x0 === Infinity ? null : [x0, y0, x1, y1];
}

/**
 * Flatten to closed polygons within `tol` (max distance from the true curve, in
 * output units). Subdivision counts from the second-difference bound:
 * a quadratic's deviation from its chord is ≤ |p0 − 2p1 + p2| / 4, and n uniform
 * pieces cut that by n², so n = ceil(sqrt(dev / tol)). Cubics use the larger of
 * their two second differences, × 3/4.
 * @param {Path} path
 * @param {number} tol
 * @param {{ maxPieces?: number, maxPoints?: number }} [budgets]  pieces per curve; points per call
 * @returns {import('../../otel-compact/src/adt.js').Result<Float64Array[], { points: number, limit: number }>}
 *   one [x0,y0,x1,y1,...] per contour, implicitly closed; Err past the point budget
 */
export const flatten = (path, tol, budgets = {}) => flattenWith(path, null, tol, budgets);

/**
 * flatten(transform(path, [a, b, c, d, 0, 0]), tol), bit for bit, without building the
 * transformed path: each point is mapped as transform() maps it (a·x + c·y + 0) as it is read.
 * The renderer's hot path: transform() + flatten() allocated a Seg and a match per segment
 * (on a 22k-item poster: 21% of the render, plus GC).
 * @param {Path} path @param {readonly [number, number, number, number]} lin  [a, b, c, d]
 * @param {number} tol @param {{ maxPieces?: number, maxPoints?: number }} [budgets]
 */
export const flattenLinear = (path, lin, tol, budgets = {}) => flattenWith(path, lin, tol, budgets);

/**
 * @param {Path} path @param {readonly [number, number, number, number] | null} lin
 * @param {number} tol @param {{ maxPieces?: number, maxPoints?: number }} budgets
 * @returns {import('../../otel-compact/src/adt.js').Result<Float64Array[], { points: number, limit: number }>}
 */
function flattenWith(path, lin, tol, { maxPieces = 256, maxPoints = 1 << 20 }) {
  /** @type {Float64Array[]} */
  const out = [];
  // One growable buffer per call; each contour is sliced out of it.
  let buf = new Float64Array(64), n = 0, start = 0;
  const push = (/** @type {number} */ x, /** @type {number} */ y) => {
    if (n + 2 > buf.length) { const b = new Float64Array(buf.length * 2); b.set(buf); buf = b; }
    buf[n++] = x; buf[n++] = y;
  };
  let points = 0;
  let px = 0, py = 0, sx = 0, sy = 0;
  const [a, b, c, d] = lin || [1, 0, 0, 1];
  // Map as transform() does (a·x + c·y + 0); null maps nothing, as flatten() always did.
  const X = (/** @type {number} */ x, /** @type {number} */ y) => (lin ? a * x + c * y + 0 : x);
  const Y = (/** @type {number} */ x, /** @type {number} */ y) => (lin ? b * x + d * y + 0 : y);
  const end = () => { if (n - start >= 6) out.push(buf.slice(start, n)); n = start = 0; };
  for (const s of path) {
    switch (s.tag) {
      case 'MoveTo': {
        end(); points += 1; if (points > maxPoints) break;
        const x = X(s.x, s.y), y = Y(s.x, s.y);
        push(x, y); px = sx = x; py = sy = y; break;
      }
      case 'LineTo': {
        points += 1; if (points > maxPoints) break;
        const x = X(s.x, s.y), y = Y(s.x, s.y);
        push(x, y); px = x; py = y; break;
      }
      case 'QuadTo': {
        const x1 = X(s.x1, s.y1), y1 = Y(s.x1, s.y1), x = X(s.x, s.y), y = Y(s.x, s.y);
        const dev = Math.hypot(px - 2 * x1 + x, py - 2 * y1 + y) / 4;
        const k = Math.min(maxPieces, Math.max(1, Math.ceil(Math.sqrt(dev / tol))));
        points += k; if (points > maxPoints) break;
        for (let i = 1; i <= k; i++) {
          const t = i / k, u = 1 - t;
          push(u * u * px + 2 * u * t * x1 + t * t * x, u * u * py + 2 * u * t * y1 + t * t * y);
        }
        px = x; py = y; break;
      }
      case 'CubicTo': {
        const x1 = X(s.x1, s.y1), y1 = Y(s.x1, s.y1), x2 = X(s.x2, s.y2), y2 = Y(s.x2, s.y2), x = X(s.x, s.y), y = Y(s.x, s.y);
        const dev = 0.75 * Math.max(Math.hypot(px - 2 * x1 + x2, py - 2 * y1 + y2), Math.hypot(x1 - 2 * x2 + x, y1 - 2 * y2 + y));
        const k = Math.min(maxPieces, Math.max(1, Math.ceil(Math.sqrt(dev / tol))));
        points += k; if (points > maxPoints) break;
        for (let i = 1; i <= k; i++) {
          const t = i / k, u = 1 - t;
          const A = u * u * u, B = 3 * u * u * t, C = 3 * u * t * t, D = t * t * t;
          push(A * px + B * x1 + C * x2 + D * x, A * py + B * y1 + C * y2 + D * y);
        }
        px = x; py = y; break;
      }
      case 'Close': end(); px = sx; py = sy; break;
      default: throw new TypeError(`flatten: not a Seg: ${JSON.stringify(s)}`); // bug: a value outside the Path type
    }
  }
  end();
  return points <= maxPoints ? ok(out) : err({ points, limit: maxPoints });
}
