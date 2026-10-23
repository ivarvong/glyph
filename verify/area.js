// Exact signed area of a Path by Green's theorem, A = ½∮(x dy − y dx), with
// closed forms per segment. Lines: ½(x0·y1 − x1·y0). Quadratic Bézier (P0,P1,P2):
//   ½(x0y2−x2y0) + ⅓[(x0y1−x1y0) + (x1y2−x2y1) − (x0y2−x2y0)]... computed below via
// the control-polygon form: for Bézier of degree n the integral is a fixed
// bilinear form in the control points. Derived by integrating B(t)×B'(t).
import { Seg } from '../outline/src/path.js';

const cross = (ax, ay, bx, by) => ax * by - ay * bx;

// ∫₀¹ (x y' − y x') dt / 2 for the segment, in closed form.
const lineA = (x0, y0, x1, y1) => cross(x0, y0, x1, y1) / 2;
const quadA = (x0, y0, x1, y1, x2, y2) =>
  (2 * cross(x0, y0, x1, y1) + 2 * cross(x1, y1, x2, y2) + cross(x0, y0, x2, y2)) / 6;
const cubicA = (x0, y0, x1, y1, x2, y2, x3, y3) =>
  (6 * cross(x0, y0, x1, y1) + 3 * cross(x0, y0, x2, y2) + cross(x0, y0, x3, y3)
    + 3 * cross(x1, y1, x2, y2) + 3 * cross(x1, y1, x3, y3) + 6 * cross(x2, y2, x3, y3)) / 20;

/** Signed area (positive = counter-clockwise in y-up space). */
export function signedArea(path) {
  let a = 0, px = 0, py = 0, sx = 0, sy = 0;
  for (const s of path) {
    Seg.match(s, {
      MoveTo: ({ x, y }) => { px = sx = x; py = sy = y; },
      LineTo: ({ x, y }) => { a += lineA(px, py, x, y); px = x; py = y; },
      QuadTo: ({ x1, y1, x, y }) => { a += quadA(px, py, x1, y1, x, y); px = x; py = y; },
      CubicTo: ({ x1, y1, x2, y2, x, y }) => { a += cubicA(px, py, x1, y1, x2, y2, x, y); px = x; py = y; },
      Close: () => { a += lineA(px, py, sx, sy); px = sx; py = sy; },
    });
  }
  return a;
}
