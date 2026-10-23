// Canonical outline form, mirrored exactly from ref/make_refs.py (class Canon):
// explicit segments, explicit closing line, degenerate lines dropped, each
// contour rotated to its lexicographically least segment.
import { Seg } from '../../outline/src/path.js';

export function canonical(path) {
  const contours = [];
  let segs = null, cur = null, start = null;
  const flush = () => {
    if (!segs) return;
    if (cur[0] !== start[0] || cur[1] !== start[1]) segs.push(['L', ...cur, ...start]);
    const kept = segs.filter((s) => !(s[0] === 'L' && s[1] === s[3] && s[2] === s[4]));
    if (kept.length) {
      let k = 0;
      for (let i = 1; i < kept.length; i++) if (lexLess(kept[i], kept[k])) k = i;
      contours.push([...kept.slice(k), ...kept.slice(0, k)]);
    }
    segs = null;
  };
  for (const s of path) {
    Seg.match(s, {
      MoveTo: ({ x, y }) => { flush(); segs = []; start = cur = [x, y]; },
      LineTo: ({ x, y }) => { segs.push(['L', ...cur, x, y]); cur = [x, y]; },
      QuadTo: ({ x1, y1, x, y }) => { segs.push(['Q', ...cur, x1, y1, x, y]); cur = [x, y]; },
      CubicTo: ({ x1, y1, x2, y2, x, y }) => { segs.push(['C', ...cur, x1, y1, x2, y2, x, y]); cur = [x, y]; },
      Close: () => flush(),
    });
  }
  flush();
  return contours;
}

// Python compares [str(type)] + floats; a shorter list that is a prefix is less.
function lexLess(a, b) {
  if (a[0] !== b[0]) return a[0] < b[0];
  for (let i = 1; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] < b[i];
  return a.length < b.length;
}

/** Max absolute coordinate difference, or Infinity if the structure differs. */
export function outlineDistance(a, b) {
  if (a.length !== b.length) return Infinity;
  let d = 0;
  for (let c = 0; c < a.length; c++) {
    if (a[c].length !== b[c].length) return Infinity;
    for (let s = 0; s < a[c].length; s++) {
      const p = a[c][s], q = b[c][s];
      if (p[0] !== q[0] || p.length !== q.length) return Infinity;
      for (let i = 1; i < p.length; i++) d = Math.max(d, Math.abs(p[i] - q[i]));
    }
  }
  return d;
}
