// @ts-check
// TrueType point contours -> Path. Off-curve runs imply on-curve midpoints.

import { Seg } from './path.js';

/**
 * @param {import('../../sfnt/src/glyf.js').Points} p
 * @returns {import('./path.js').Path}
 */
export function contoursToPath({ xs, ys, on, endPts }) {
  /** @type {import('./path.js').SegT[]} */
  const out = [];
  let first = 0;
  for (const last of endPts) {
    const n = last - first + 1;
    if (n > 0) emitContour(out, xs, ys, on, first, n);
    first = last + 1;
  }
  return out;
}

/**
 * @param {import('./path.js').SegT[]} out
 * @param {Float64Array} xs @param {Float64Array} ys @param {Uint8Array} on
 * @param {number} first @param {number} n
 */
function emitContour(out, xs, ys, on, first, n) {
  const X = (/** @type {number} */ i) => xs[first + ((i % n) + n) % n];
  const Y = (/** @type {number} */ i) => ys[first + ((i % n) + n) % n];
  const ON = (/** @type {number} */ i) => on[first + ((i % n) + n) % n] === 1;

  // Start at an on-curve point; with none, at the implied midpoint of the last and first.
  let k = 0;
  while (k < n && !ON(k)) k++;
  let sx, sy, i0;
  if (k < n) { sx = X(k); sy = Y(k); i0 = k + 1; }
  else { sx = (X(n - 1) + X(0)) / 2; sy = (Y(n - 1) + Y(0)) / 2; i0 = 0; k = -1; }
  out.push(Seg.MoveTo(sx, sy));

  /** @type {[number, number] | null} */
  let ctrl = null;
  const stop = k < 0 ? n : k + n; // walk once around, ending back at the start point
  for (let i = i0; i <= stop; i++) {
    const atEnd = i === stop;
    const x = atEnd ? sx : X(i), y = atEnd ? sy : Y(i);
    const isOn = atEnd || ON(i);
    if (isOn) {
      out.push(ctrl ? Seg.QuadTo(ctrl[0], ctrl[1], x, y) : Seg.LineTo(x, y));
      ctrl = null;
    } else {
      if (ctrl) out.push(Seg.QuadTo(ctrl[0], ctrl[1], (ctrl[0] + x) / 2, (ctrl[1] + y) / 2));
      ctrl = [x, y];
    }
  }
  out.push(Seg.Close);
}
