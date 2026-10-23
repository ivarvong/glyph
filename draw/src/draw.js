// @ts-check
// Vector drawing on the glyph engine: shapes, SVG path data, strokes and paints, as items of
// the same Scene text renders into. Nothing here rasterises: geometry becomes paths, paths
// become SceneItems, and the existing targets (PNG stream, SVG) draw them.
//
//   geometry   rect, roundRect, circle, ellipse, polygon, polyline, line, star  → Path
//              svgPath(d)                                                       → Result<Path, PathError>
//              stroke(path, { width, join, cap, miterLimit })                   → Path (its filled outline)
//   items      fill(path, paint, { transform, rule })                           → SceneItem
//   paints     an RGBA tuple, linear(...), radial(...)                          (render/src/paint.js)
//
// Coordinates are scene pixels, y down. Every function is total or returns a Result.

import { Seg, IDENTITY, transform, hullBounds } from '../../outline/src/path.js';
import { ok, err, some, NONE } from '../../otel-compact/src/adt.js';
import { pngStream } from '../../render/src/stream.js';
import { geometry } from '../../render/src/scene.js';
import { scanline } from '../../render/src/raster.js';
import { balancedZlib } from '../../render/src/png.js';

/** @typedef {import('../../outline/src/path.js').Path} Path */
/** @typedef {import('../../outline/src/path.js').Affine} Affine */
/** @typedef {import('../../render/src/scene.js').SceneItem} SceneItem */
/** @typedef {import('../../render/src/scene.js').FillRule} FillRule */
/** @typedef {import('../../render/src/paint.js').Paint} Paint */

const K = 0.5522847498; // cubic circle constant: max radial error 0.027%

// ------------------------------------------------------------------------------------- shapes

/** @param {number} x @param {number} y @param {number} w @param {number} h @returns {Path} */
export const rect = (x, y, w, h) =>
  [Seg.MoveTo(x, y), Seg.LineTo(x + w, y), Seg.LineTo(x + w, y + h), Seg.LineTo(x, y + h), Seg.Close];

/** Ellipse centred on (cx, cy), four cubic arcs, clockwise on screen. @param {number} cx @param {number} cy @param {number} rx @param {number} ry @returns {Path} */
export const ellipse = (cx, cy, rx, ry) => [
  Seg.MoveTo(cx + rx, cy),
  Seg.CubicTo(cx + rx, cy + K * ry, cx + K * rx, cy + ry, cx, cy + ry),
  Seg.CubicTo(cx - K * rx, cy + ry, cx - rx, cy + K * ry, cx - rx, cy),
  Seg.CubicTo(cx - rx, cy - K * ry, cx - K * rx, cy - ry, cx, cy - ry),
  Seg.CubicTo(cx + K * rx, cy - ry, cx + rx, cy - K * ry, cx + rx, cy),
  Seg.Close,
];

/** @param {number} cx @param {number} cy @param {number} r @returns {Path} */
export const circle = (cx, cy, r) => ellipse(cx, cy, r, r);

/** Rectangle with corner radius r (clamped to half the shorter side). @param {number} x @param {number} y @param {number} w @param {number} h @param {number} r @returns {Path} */
export const roundRect = (x, y, w, h, r) => {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  const k = (1 - K) * r;
  return [
    Seg.MoveTo(x + r, y), Seg.LineTo(x + w - r, y), Seg.CubicTo(x + w - k, y, x + w, y + k, x + w, y + r),
    Seg.LineTo(x + w, y + h - r), Seg.CubicTo(x + w, y + h - k, x + w - k, y + h, x + w - r, y + h),
    Seg.LineTo(x + r, y + h), Seg.CubicTo(x + k, y + h, x, y + h - k, x, y + h - r),
    Seg.LineTo(x, y + r), Seg.CubicTo(x, y + k, x + k, y, x + r, y), Seg.Close,
  ];
};

/** Closed polygon through the points. @param {readonly (readonly [number, number])[]} pts @returns {Path} */
export const polygon = (pts) => (pts.length ? [Seg.MoveTo(...pts[0]), ...pts.slice(1).map((p) => Seg.LineTo(...p)), Seg.Close] : []);

/** Open polyline (stroke it; filling an open path closes it implicitly). @param {readonly (readonly [number, number])[]} pts @returns {Path} */
export const polyline = (pts) => (pts.length ? [Seg.MoveTo(...pts[0]), ...pts.slice(1).map((p) => Seg.LineTo(...p))] : []);

/** @param {number} x0 @param {number} y0 @param {number} x1 @param {number} y1 @returns {Path} */
export const line = (x0, y0, x1, y1) => [Seg.MoveTo(x0, y0), Seg.LineTo(x1, y1)];

/** n-pointed star: outer radius r, inner radius ri, first point straight up. @param {number} cx @param {number} cy @param {number} n @param {number} r @param {number} ri @returns {Path} */
export const star = (cx, cy, n, r, ri) =>
  polygon(Array.from({ length: 2 * n }, (_, i) => {
    const a = -Math.PI / 2 + (i * Math.PI) / n, q = i % 2 ? ri : r;
    return /** @type {[number, number]} */ ([cx + Math.cos(a) * q, cy + Math.sin(a) * q]);
  }));

// ------------------------------------------------------------------------------------- items

/** @type {WeakMap<object, string>} */
const KEYS = new WeakMap();
let nextKey = 0;
/**
 * The flatten cache is keyed by item key, so a key must name exactly one geometry: one per
 * Path object (reuse the object to reuse its flattening).
 * @param {import('../../render/src/scene.js').Geometry} path
 */
const keyOf = (path) => {
  const k = KEYS.get(path);
  if (k) return k;
  const fresh = `draw:${nextKey++}`;
  KEYS.set(path, fresh);
  return fresh;
};

/**
 * A scene item that fills `path` with `paint`.
 * @param {import('../../render/src/scene.js').Geometry} path  a Path, or deferred geometry (stroked)
 * @param {Paint} paint  RGBA, or a gradient (in scene pixels, independent of `transform`)
 * @param {{ transform?: Affine, rule?: FillRule }} [opts]  rule: 'nonzero' (default, as SVG) or 'evenodd'
 * @returns {SceneItem}
 */
export const fill = (path, paint, { transform = IDENTITY, rule = 'nonzero' } = {}) =>
  ({ path, key: keyOf(path), transform, fill: paint, rule });

// ------------------------------------------------------------------------------------- flattening

/**
 * Subpaths as polylines, curves cut by Wang's formula so every chord is within `tol` of the
 * curve. Repeated points are dropped; a closed subpath does not repeat its first point.
 * @param {Path} path @param {number} tol
 * @returns {{ pts: number[], corner: number[], closed: boolean }[]}  corner: 1 at a command boundary, 0 inside a curve
 */
export function subpaths(path, tol) {
  /** @type {{ pts: number[], corner: number[], closed: boolean }[]} */
  const out = [];
  /** @type {number[]} */
  let pts = [];
  /** @type {number[]} 1 where a vertex ends a path command (a join may go there), 0 inside a curve */
  let corner = [];
  let x = 0, y = 0, sx = 0, sy = 0;
  const push = (/** @type {number} */ px, /** @type {number} */ py, /** @type {number} */ c) => {
    const n = pts.length;
    if (n && pts[n - 2] === px && pts[n - 1] === py) { corner[n / 2 - 1] |= c; return; }
    pts.push(px, py); corner.push(c);
  };
  const end = (/** @type {boolean} */ closed) => {
    if (closed && pts.length > 2 && pts[0] === pts[pts.length - 2] && pts[1] === pts[pts.length - 1]) {
      pts.length -= 2; corner[0] |= /** @type {number} */ (corner.pop());
    }
    if (pts.length) out.push({ pts, corner, closed });
    pts = []; corner = [];
  };
  for (const s of path) {
    switch (s.tag) {
      case 'MoveTo': end(false); x = sx = s.x; y = sy = s.y; push(x, y, 1); break;
      case 'LineTo': if (!pts.length) push(x, y, 1); x = s.x; y = s.y; push(x, y, 1); break;
      case 'QuadTo': {
        if (!pts.length) push(x, y, 1);
        const dd = Math.hypot(x - 2 * s.x1 + s.x, y - 2 * s.y1 + s.y);
        const n = Math.max(1, Math.min(1024, Math.ceil(Math.sqrt(dd / (4 * tol)))));
        for (let i = 1; i <= n; i++) {
          const t = i / n, u = 1 - t;
          push(u * u * x + 2 * u * t * s.x1 + t * t * s.x, u * u * y + 2 * u * t * s.y1 + t * t * s.y, i === n ? 1 : 0);
        }
        x = s.x; y = s.y; break;
      }
      case 'CubicTo': {
        if (!pts.length) push(x, y, 1);
        const dd = Math.max(Math.hypot(x - 2 * s.x1 + s.x2, y - 2 * s.y1 + s.y2), Math.hypot(s.x1 - 2 * s.x2 + s.x, s.y1 - 2 * s.y2 + s.y));
        const n = Math.max(1, Math.min(1024, Math.ceil(Math.sqrt((3 * dd) / (4 * tol)))));
        for (let i = 1; i <= n; i++) {
          const t = i / n, u = 1 - t;
          push(u * u * u * x + 3 * u * u * t * s.x1 + 3 * u * t * t * s.x2 + t * t * t * s.x,
            u * u * u * y + 3 * u * u * t * s.y1 + 3 * u * t * t * s.y2 + t * t * t * s.y, i === n ? 1 : 0);
        }
        x = s.x; y = s.y; break;
      }
      case 'Close': end(true); x = sx; y = sy; break;
      default: throw new TypeError(`subpaths: not a Seg: ${JSON.stringify(s)}`); // bug: a value outside the Path type
    }
  }
  end(false);
  return out;
}

/**
 * Ink bounds of scene items, in scene pixels: the extent of the outlines themselves (curves
 * flattened to within `tol` px), not their control points, which overshoot round letters. For
 * centring and aligning shapes and type optically. NONE when nothing has ink.
 * @param {readonly SceneItem[]} items @param {number} [tol]
 * @returns {import('../../otel-compact/src/adt.js').Option<readonly [number, number, number, number]>}  [x0, y0, x1, y1]
 */
export function bounds(items, tol = 0.01) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const it of items) {
    for (const { pts } of subpaths(transform(geometry(it.path), it.transform), tol)) {
      for (let i = 0; i < pts.length; i += 2) {
        const x = pts[i], y = pts[i + 1];
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
  }
  return x0 <= x1 ? some(Object.freeze(/** @type {const} */ ([x0, y0, x1, y1]))) : NONE;
}

// ------------------------------------------------------------------------------------- stroke

/** @typedef {'miter' | 'round' | 'bevel'} LineJoin */
/** @typedef {'butt' | 'round' | 'square'} LineCap */

/**
 * The outline of a stroke along `path`, as a path to fill (nonzero). Matches SVG's stroke
 * geometry for these joins and caps, and its zero-length-subpath rule (round and square caps draw
 * a dot, butt draws nothing).
 *
 * Built as a union of pieces, every piece wound the same way, so nonzero fills the union exactly:
 *   ribbons  a run of segments whose joins are gentle becomes one polygon: its left offset
 *            forward, its right offset back (a closed run: two loops, outer and inner). A join is
 *            gentle when the inner offset cannot fold (hw·tan(θ/2) ≤ half of each neighbouring
 *            segment) and the miter it implies equals the requested join to within `tolerance`.
 *            A flattened curve is gentle almost everywhere, so a stroked circle is two loops.
 *   joins    at every other vertex, a miter or bevel wedge, or a disc for round.
 *   caps     a disc (round) or a square, per open end.
 *   discs    four cubic arcs, not a polygon.
 * The first version made a quad per segment and a wedge per vertex: the 22k-item poster's scene
 * held 2.9 M path segments (278 MiB). Ribbons and cubic discs cut that ~10× (bench/memory.js).
 * @param {Path} path
 * @param {{ width: number, join?: LineJoin, cap?: LineCap, miterLimit?: number, tolerance?: number }} opts
 *   width (px); join 'miter' (default, as SVG) | 'round' | 'bevel'; cap 'butt' (default) | 'round' | 'square';
 *   miterLimit 4 (SVG's default); tolerance: flattening error in path units (default 0.02, for 1 unit = 1 px)
 * @returns {Path}
 */
export function stroke(path, { width, join = 'miter', cap = 'butt', miterLimit = 4, tolerance = 0.02 }) {
  const hw = width / 2;
  if (!(hw > 0)) return [];
  /** @type {import('../../outline/src/path.js').SegT[]} */
  const out = [];
  /** Emit a polygon (flat x, y list) wound positively. @param {number[]} p */
  const poly = (p) => {
    let area = 0;
    for (let i = 0; i < p.length; i += 2) { const j = (i + 2) % p.length; area += p[i] * p[j + 1] - p[j] * p[i + 1]; }
    if (area === 0) return;
    const q = area > 0 ? p : reversePoly(p);
    out.push(Seg.MoveTo(q[0], q[1]));
    for (let i = 2; i < q.length; i += 2) out.push(Seg.LineTo(q[i], q[i + 1]));
    out.push(Seg.Close);
  };
  /** A disc: four cubics, wound positively (as ellipse() is). */
  const disc = (/** @type {number} */ x, /** @type {number} */ y) => { out.push(...ellipse(x, y, hw, hw)); };
  /** Would the inner offset fold at a vertex turning d0 → d1 between segments la and lb long? */
  const folds = (/** @type {number[]} */ d0, /** @type {number[]} */ d1, /** @type {number} */ la, /** @type {number} */ lb) => {
    const dot = d0[0] * d1[0] + d0[1] * d1[1];
    if (dot <= 0) return true;
    const c = Math.sqrt((1 + dot) / 2);
    return hw * (Math.sqrt(Math.max(0, 1 - c * c)) / c) > Math.min(la, lb) / 2;
  };
  /** Is the join between directions d0 → d1 (segments la, lb long) gentle enough for a ribbon? */
  const gentle = (/** @type {number[]} */ d0, /** @type {number[]} */ d1, /** @type {number} */ la, /** @type {number} */ lb) => {
    const dot = d0[0] * d1[0] + d0[1] * d1[1];
    if (dot <= 0) return false;
    const c = Math.sqrt((1 + dot) / 2); // cos(θ/2)
    const tanHalf = Math.sqrt(Math.max(0, 1 - c * c)) / c;
    if (hw * tanHalf > Math.min(la, lb) / 2) return false; // the inner offset would fold
    if (join === 'miter') return 1 / c <= miterLimit;
    const excess = join === 'round' ? hw * (1 / c - 1) : hw * (1 / c - c); // miter beyond round arc / bevel chord
    return excess <= tolerance;
  };
  for (const { pts, corner, closed } of subpaths(path, tolerance)) {
    const n = pts.length / 2;
    const X = (/** @type {number} */ i) => pts[2 * i], Y = (/** @type {number} */ i) => pts[2 * i + 1];
    if (n === 1) {
      if (cap === 'round') disc(X(0), Y(0));
      else if (cap === 'square') poly([X(0) - hw, Y(0) - hw, X(0) + hw, Y(0) - hw, X(0) + hw, Y(0) + hw, X(0) - hw, Y(0) + hw]);
      continue;
    }
    const segs = closed ? n : n - 1;
    /** @type {number[][]} */ const dir = [];
    /** @type {number[]} */ const len = [];
    for (let i = 0; i < segs; i++) {
      const j = (i + 1) % n, dx = X(j) - X(i), dy = Y(j) - Y(i), l = Math.hypot(dx, dy);
      dir.push([dx / l, dy / l]); len.push(l);
    }
    // Vertex v joins segment v-1 to segment v. Interior vertices of an open path: 1..n-2.
    const joinAt = (/** @type {number} */ v) => [(v - 1 + segs) % segs, v % segs];
    // Per vertex: 1 ribbon passes through; 0 a join goes there. Inside a curve there is no join in
    // SVG's model (joins sit between path commands), so a curve vertex is always smooth: a ribbon
    // where its offset cannot fold, else a disc (the swept-disc stroke, exact for tight curvature).
    const isGentle = new Uint8Array(n), smooth = new Uint8Array(n);
    for (let v = closed ? 0 : 1; v < (closed ? n : n - 1); v++) {
      const [a, b] = joinAt(v);
      if (corner[v]) isGentle[v] = gentle(dir[a], dir[b], len[a], len[b]) ? 1 : 0;
      else { smooth[v] = 1; isGentle[v] = folds(dir[a], dir[b], len[a], len[b]) ? 0 : 1; }
    }
    // Offset of vertex v inside a ribbon: the miter point (normals averaged, scaled by 1/cos(θ/2));
    // at a ribbon's end, the segment's own normal (a butt end; the join or cap covers the rest).
    const offset = (/** @type {number} */ v, /** @type {number} */ seg, /** @type {boolean} */ mitre, /** @type {number} */ side) => {
      if (!mitre) { const d = dir[seg]; return [X(v) - side * d[1] * hw, Y(v) + side * d[0] * hw]; }
      const [a, b] = joinAt(v), d0 = dir[a], d1 = dir[b];
      const mx = -d0[1] - d1[1], my = d0[0] + d1[0], ml = Math.hypot(mx, my), c = Math.sqrt((1 + d0[0] * d1[0] + d0[1] * d1[1]) / 2);
      if (ml === 0) { const d = dir[seg]; return [X(v) - side * d[1] * hw, Y(v) + side * d[0] * hw]; }
      return [X(v) + side * (mx / ml) * (hw / c), Y(v) + side * (my / ml) * (hw / c)];
    };
    /** A ribbon over segments s0..s1 (inclusive, indices mod segs), polygon left out, right back. */
    const ribbon = (/** @type {number} */ s0, /** @type {number} */ count) => {
      const L = [], Rr = [];
      for (let k = 0; k <= count; k++) {
        const v = (s0 + k) % n, seg = (s0 + Math.min(k, count - 1)) % segs;
        const inner = k > 0 && k < count;
        const [lx, ly] = offset(v, k === count ? (s0 + count - 1) % segs : seg, inner, 1);
        const [rx, ry] = offset(v, k === count ? (s0 + count - 1) % segs : seg, inner, -1);
        L.push(lx, ly); Rr.push(rx, ry);
      }
      poly([...L, ...reversePoly(Rr)]);
    };
    const allGentle = closed && isGentle.every((g) => g === 1);
    if (allGentle) {
      // A closed run with no corners: two loops, the left forward and the right backward, so the
      // band between them winds once and the inside not at all.
      const L = [], Rr = [];
      for (let v = 0; v < n; v++) { const [lx, ly] = offset(v, v % segs, true, 1), [rx, ry] = offset(v, v % segs, true, -1); L.push(lx, ly); Rr.push(rx, ry); }
      let area = 0;
      const ring = [L, reversePoly(Rr)];
      for (const p of ring) for (let i = 0; i < p.length; i += 2) { const j = (i + 2) % p.length; area += p[i] * p[j + 1] - p[j] * p[i + 1]; }
      for (const p0 of ring) {
        const p = area > 0 ? p0 : reversePoly(p0);
        out.push(Seg.MoveTo(p[0], p[1]));
        for (let i = 2; i < p.length; i += 2) out.push(Seg.LineTo(p[i], p[i + 1]));
        out.push(Seg.Close);
      }
      continue;
    }
    // Runs between corners. For a closed path, start at a corner so no run wraps across it.
    const first = closed ? isGentle.findIndex((g) => g === 0) : 0;
    let start = first, count = 0;
    for (let k = 0; k < segs; k++) {
      count++;
      const endV = (first + k + 1) % n;
      const corner = closed ? isGentle[endV] === 0 : endV === n - 1 || isGentle[endV] === 0;
      if (corner) { ribbon(start, count); start = endV; count = 0; }
    }
    // Joins at the corners.
    for (let v = closed ? 0 : 1; v < (closed ? n : n - 1); v++) {
      if (isGentle[v]) continue;
      const [a, b] = joinAt(v), d0 = dir[a], d1 = dir[b], x = X(v), y = Y(v);
      const cross = d0[0] * d1[1] - d0[1] * d1[0], dot = d0[0] * d1[0] + d0[1] * d1[1];
      if (Math.abs(cross) < 1e-12 && dot > 0) continue;
      if (join === 'round' || smooth[v]) { disc(x, y); continue; }
      const sgn = cross > 0 ? -1 : 1; // the outer side is opposite the turn
      const ax = x + sgn * -d0[1] * hw, ay = y + sgn * d0[0] * hw, bx = x + sgn * -d1[1] * hw, by = y + sgn * d1[0] * hw;
      const sinHalf = Math.sqrt(Math.max(0, (1 + dot) / 2)); // sin(interior/2) = cos(turn/2)
      if (join === 'miter' && sinHalf > 0 && 1 / sinHalf <= miterLimit) {
        const mx = -d0[1] - d1[1], my = d0[0] + d1[0], ml = Math.hypot(mx, my);
        const reach = hw / Math.sqrt(Math.max(1e-24, (1 + dot) / 2));
        poly([x, y, ax, ay, x + (sgn * mx / ml) * reach, y + (sgn * my / ml) * reach, bx, by]);
      } else poly([x, y, ax, ay, bx, by]);
    }
    if (!closed) {
      for (const [v, d, back] of /** @type {const} */ ([[0, dir[0], -1], [n - 1, dir[segs - 1], 1]])) {
        const x = X(v), y = Y(v);
        if (cap === 'round') disc(x, y);
        else if (cap === 'square') {
          const nx = -d[1] * hw, ny = d[0] * hw, ex = back * d[0] * hw, ey = back * d[1] * hw;
          poly([x + nx, y + ny, x + nx + ex, y + ny + ey, x - nx + ex, y - ny + ey, x - nx, y - ny]);
        }
      }
    }
  }
  return out;
}

/**
 * A stroke as deferred geometry: the scene keeps the source path and these options; the outline is
 * built when the renderer reaches it and released after flattening. Same pixels as
 * fill(stroke(path, opts)); far less held: the 22k-stroke poster's scene fell from 84 to ~N MiB
 * (bench/memory.js). Its hull is the source's control-point hull grown by the furthest the
 * outline can reach: hw, or hw·miterLimit for miter joins, or hw·√2 for square caps.
 * @param {Path} path
 * @param {Parameters<typeof stroke>[1]} opts
 * @returns {StrokedPath}
 */
export function stroked(path, opts) {
  const hw = opts.width / 2, h = hullBounds(path);
  const reach = !(hw > 0) ? 0 : hw * Math.max(1, (opts.join ?? 'miter') === 'miter' ? (opts.miterLimit ?? 4) : 1, opts.cap === 'square' ? Math.SQRT2 : 1);
  /** @type {readonly [number, number, number, number]} */
  const hull = h ? [h[0] - reach, h[1] - reach, h[2] + reach, h[3] + reach] : [Infinity, Infinity, -Infinity, -Infinity];
  return Object.freeze({
    tag: /** @type {const} */ ('Deferred'),
    hull,
    force: () => stroke(path, opts),
    describe: () => `stroke(${JSON.stringify(opts)}):${path.map((s) => Object.values(s).join(' ')).join(';')}`,
    source: path,
    options: opts,
  });
}

/** @typedef {import('../../render/src/scene.js').DeferredPath & { source: Path, options: Parameters<typeof stroke>[1] }} StrokedPath  what to stroke, kept for serialisers */

/** @param {number[]} p */
const reversePoly = (p) => {
  const q = [];
  for (let i = p.length - 2; i >= 0; i -= 2) q.push(p[i], p[i + 1]);
  return q;
};

// ------------------------------------------------------------------------------------- SVG path data

/** @type {Record<string, number>} */
const ARITY = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2 };

/** @typedef {{ at: number, expected: string, found: string }} PathError  at: offset into the d string */

/**
 * Parse SVG path data (SVG 2 §9.3: M L H V C S Q T A Z, absolute and relative) into a Path.
 * Arcs become cubics (≤ 90° each). Like browsers, a parse error ends the path; unlike them we
 * report it rather than draw the prefix silently: Err carries where and what.
 * @param {string} d
 * @returns {import('../../otel-compact/src/adt.js').Result<Path, PathError>}
 */
export function svgPath(d) {
  /** @type {import('../../outline/src/path.js').SegT[]} */
  const out = [];
  let i = 0;
  const fail = (/** @type {string} */ expected) => err(/** @type {PathError} */ ({ at: i, expected, found: i < d.length ? d[i] : 'end of data' }));
  const ws = () => { while (i < d.length && /[\s,]/.test(d[i])) i++; };
  const NUM = /[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;
  /** @returns {number} NaN when there is no number here */
  const num = () => {
    ws();
    NUM.lastIndex = i;
    const m = NUM.exec(d);
    if (!m) return NaN;
    i += m[0].length;
    return Number(m[0]);
  };
  const flag = () => {
    ws();
    if (d[i] === '0' || d[i] === '1') return d[i++] === '1' ? 1 : 0;
    return NaN;
  };
  const startsNumber = () => { ws(); return i < d.length && /[+\-.\d]/.test(d[i]); };
  let x = 0, y = 0, sx = 0, sy = 0, cx2 = 0, cy2 = 0, prev = '';
  ws();
  if (i < d.length && !/[Mm]/.test(d[i])) return fail('M or m');
  while (true) {
    ws();
    if (i >= d.length) break;
    let cmd = d[i];
    if (/[MmLlHhVvCcSsQqTtAaZz]/.test(cmd)) i++;
    else if (prev && prev !== 'Z' && prev !== 'z' && startsNumber()) cmd = prev === 'M' ? 'L' : prev === 'm' ? 'l' : prev;
    else return fail('a command');
    const rel = cmd === cmd.toLowerCase(), C = cmd.toUpperCase();
    const ox = rel ? x : 0, oy = rel ? y : 0;
    /** @param {number} k */
    const nums = (k) => { const v = []; for (let j = 0; j < k; j++) { const n = num(); if (Number.isNaN(n)) return null; v.push(n); } return v; };
    if (C === 'Z') { out.push(Seg.Close); x = sx; y = sy; cx2 = x; cy2 = y; prev = cmd; continue; }
    if (C === 'A') {
      const at = i;
      const rx = num(), ry = num(), rot = num(), large = flag(), sweep = flag(), ex = num(), ey = num();
      if ([rx, ry, rot, large, sweep, ex, ey].some(Number.isNaN)) { i = Math.max(i, at); return fail('arc parameters: rx ry rotation large-arc-flag sweep-flag x y'); }
      arcTo(out, x, y, rx, ry, rot, large, sweep, ox + ex, oy + ey);
      x = ox + ex; y = oy + ey; cx2 = x; cy2 = y;
    } else {
      const arity = ARITY[C];
      const v = nums(arity);
      if (!v) return fail(`${arity} number${arity === 1 ? '' : 's'} for ${cmd}`);
      if (C === 'M') { x = sx = ox + v[0]; y = sy = oy + v[1]; out.push(Seg.MoveTo(x, y)); cx2 = x; cy2 = y; }
      else if (C === 'L') { x = ox + v[0]; y = oy + v[1]; out.push(Seg.LineTo(x, y)); cx2 = x; cy2 = y; }
      else if (C === 'H') { x = ox + v[0]; out.push(Seg.LineTo(x, y)); cx2 = x; cy2 = y; }
      else if (C === 'V') { y = (rel ? y : 0) + v[0]; out.push(Seg.LineTo(x, y)); cx2 = x; cy2 = y; }
      else if (C === 'C') {
        out.push(Seg.CubicTo(ox + v[0], oy + v[1], ox + v[2], oy + v[3], ox + v[4], oy + v[5]));
        cx2 = ox + v[2]; cy2 = oy + v[3]; x = ox + v[4]; y = oy + v[5];
      } else if (C === 'S') {
        const smooth = /[CcSs]/.test(prev), x1 = smooth ? 2 * x - cx2 : x, y1 = smooth ? 2 * y - cy2 : y;
        out.push(Seg.CubicTo(x1, y1, ox + v[0], oy + v[1], ox + v[2], oy + v[3]));
        cx2 = ox + v[0]; cy2 = oy + v[1]; x = ox + v[2]; y = oy + v[3];
      } else if (C === 'Q') {
        out.push(Seg.QuadTo(ox + v[0], oy + v[1], ox + v[2], oy + v[3]));
        cx2 = ox + v[0]; cy2 = oy + v[1]; x = ox + v[2]; y = oy + v[3];
      } else {
        const smooth = /[QqTt]/.test(prev), x1 = smooth ? 2 * x - cx2 : x, y1 = smooth ? 2 * y - cy2 : y;
        x = ox + v[0]; y = oy + v[1];
        out.push(Seg.QuadTo(x1, y1, x, y));
        cx2 = x1; cy2 = y1;
      }
    }
    prev = cmd;
  }
  return ok(out);
}

/**
 * Endpoint-parameterised elliptical arc → cubics (SVG 2 implementation notes B.2.4–B.2.5:
 * out-of-range radii scaled up, zero radius is a line).
 * @param {import('../../outline/src/path.js').SegT[]} out
 * @param {number} x1 @param {number} y1 @param {number} rx @param {number} ry @param {number} rotDeg
 * @param {number} large @param {number} sweep @param {number} x2 @param {number} y2
 */
function arcTo(out, x1, y1, rx, ry, rotDeg, large, sweep, x2, y2) {
  if (x1 === x2 && y1 === y2) return;
  rx = Math.abs(rx); ry = Math.abs(ry);
  if (rx === 0 || ry === 0) { out.push(Seg.LineTo(x2, y2)); return; }
  const phi = (rotDeg * Math.PI) / 180, cos = Math.cos(phi), sin = Math.sin(phi);
  const dx = (x1 - x2) / 2, dy = (y1 - y2) / 2;
  const xp = cos * dx + sin * dy, yp = -sin * dx + cos * dy;
  const lam = (xp * xp) / (rx * rx) + (yp * yp) / (ry * ry);
  if (lam > 1) { const s = Math.sqrt(lam); rx *= s; ry *= s; }
  const num = rx * rx * ry * ry - rx * rx * yp * yp - ry * ry * xp * xp, den = rx * rx * yp * yp + ry * ry * xp * xp;
  const co = (large === sweep ? -1 : 1) * Math.sqrt(Math.max(0, num / den));
  const cxp = (co * rx * yp) / ry, cyp = (-co * ry * xp) / rx;
  const cx = cos * cxp - sin * cyp + (x1 + x2) / 2, cy = sin * cxp + cos * cyp + (y1 + y2) / 2;
  const ang = (/** @type {number} */ ux, /** @type {number} */ uy, /** @type {number} */ vx, /** @type {number} */ vy) =>
    Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const t1 = ang(1, 0, (xp - cxp) / rx, (yp - cyp) / ry);
  let dt = ang((xp - cxp) / rx, (yp - cyp) / ry, (-xp - cxp) / rx, (-yp - cyp) / ry);
  if (!sweep && dt > 0) dt -= 2 * Math.PI;
  else if (sweep && dt < 0) dt += 2 * Math.PI;
  const n = Math.max(1, Math.ceil(Math.abs(dt) / (Math.PI / 2) - 1e-9)), h = dt / n, k = (4 / 3) * Math.tan(h / 4);
  const pt = (/** @type {number} */ t) => {
    const ex = rx * Math.cos(t), ey = ry * Math.sin(t);
    return [cos * ex - sin * ey + cx, sin * ex + cos * ey + cy];
  };
  const tan = (/** @type {number} */ t) => {
    const ex = -rx * Math.sin(t), ey = ry * Math.cos(t);
    return [cos * ex - sin * ey, sin * ex + cos * ey];
  };
  for (let j = 0; j < n; j++) {
    const a = t1 + j * h, b = a + h;
    const [ax, ay] = pt(a), [bx, by] = j === n - 1 ? [x2, y2] : pt(b), [tax, tay] = tan(a), [tbx, tby] = tan(b);
    out.push(Seg.CubicTo(ax + k * tax, ay + k * tay, bx - k * tbx, by - k * tby, bx, by));
  }
}

// ------------------------------------------------------------------------------------- scenes

/**
 * A scene: what every target draws. Items paint in order (later on top).
 * @param {number} width @param {number} height  pixels
 * @param {import('../../render/src/scene.js').RGBA} background
 * @param {readonly SceneItem[]} items
 * @returns {import('../../render/src/scene.js').Scene}
 */
export const scene = (width, height, background, items) => ({ width, height, background, items: [...items] });

/**
 * The scene as a PNG byte stream, rendered a band at a time (a Workers Response body as is).
 * Defaults: the scanline rasterizer (true nonzero and even-odd) and balanced deflate.
 * @param {import('../../render/src/scene.js').Scene} s
 * @param {import('../../render/src/stream.js').StreamOpts & { rasterizer?: import('../../render/src/raster.js').Rasterizer, zlib?: import('../../render/src/png.js').Zlib }} [opts]
 */
export const png = (s, opts = {}) => pngStream(s, opts.rasterizer ?? scanline, opts.zlib ?? balancedZlib, opts);
