// @ts-check
// CFF (Compact Font Format 1) + Type 2 charstrings -> Path.
// Adobe TN #5176 (CFF) and TN #5177 (Type 2 Charstring Format).

import { variants, ok, err } from '../../otel-compact/src/adt.js';
import { view, u8, u16, i16, i32, guard, times } from './bin.js';
import { Seg } from '../../outline/src/path.js';

export const CffError = variants('CffError', {
  Truncated: ['at'],
  Version: ['major'],
  Unsupported: ['feature'],
  NoCharStrings: [],
  BadGlyph: ['glyph'],
  Charstring: ['glyph', 'reason'],
});

/**
 * INDEX: count, offSize, offsets, data. Returns item slices.
 * @param {import('./bin.js').View} v @param {number} o
 * @returns {{ items: Uint8Array[], end: number }}
 */
function readIndex(v, o) {
  const count = u16(v, o);
  if (count === 0) return { items: [], end: o + 2 };
  const offSize = u8(v, o + 2);
  /** @param {number} i */
  const off = (i) => {
    let x = 0;
    for (let k = 0; k < offSize; k++) x = x * 256 + u8(v, o + 3 + i * offSize + k);
    return x;
  };
  const base = o + 2 + (count + 1) * offSize; // = data start - 1 (offsets are 1-based)
  const items = times(count, (i) => {
    const a = base + off(i), b = base + off(i + 1);
    u8(v, b - 1); // bounds
    return v.bytes.subarray(a, b);
  });
  return { items, end: base + off(count) };
}

/**
 * DICT: operand stack + operators. Map<op, number[]> (op 12 x -> 1200 + x), or the reserved byte
 * that made it unreadable.
 * @param {Uint8Array} b
 * @returns {import('../../otel-compact/src/adt.js').Result<Map<number, number[]>, number>}
 */
function readDict(b) {
  const v = view(b);
  /** @type {Map<number, number[]>} */
  const out = new Map();
  /** @type {number[]} */
  let args = [];
  let o = 0;
  while (o < b.length) {
    const b0 = u8(v, o);
    if (b0 <= 21) {
      let op = b0;
      o++;
      if (b0 === 12) op = 1200 + u8(v, o++);
      out.set(op, args);
      args = [];
    } else if (b0 === 28) { args.push(i16(v, o + 1)); o += 3; }
    else if (b0 === 29) { args.push(i32(v, o + 1)); o += 5; }
    else if (b0 === 30) {
      // Real: nibbles 0-9 digits, a '.', b 'E', c 'E-', e '-', f end.
      let s = '';
      o++;
      // Bounded by the data, not only by the terminator: past the end, reads are 0 and never stop.
      for (let done = false; !done && o < b.length; o++) {
        const byte = u8(v, o);
        for (const nib of [byte >> 4, byte & 15]) {
          if (nib === 0xf) { done = true; break; }
          s += nib <= 9 ? String(nib) : ['.', 'E', 'E-', '', '-'][nib - 10];
        }
      }
      args.push(Number(s));
    } else if (b0 >= 32 && b0 <= 246) { args.push(b0 - 139); o++; }
    else if (b0 >= 247 && b0 <= 250) { args.push((b0 - 247) * 256 + u8(v, o + 1) + 108); o += 2; }
    else if (b0 >= 251 && b0 <= 254) { args.push(-(b0 - 251) * 256 - u8(v, o + 1) - 108); o += 2; }
    else return err(b0);
  }
  return ok(out);
}

/** @param {number} n */
const subrBias = (n) => (n < 1240 ? 107 : n < 33900 ? 1131 : 32768);

/**
 * @typedef {object} Cff
 * @property {number} numGlyphs
 * @property {(gid: number) => import('../../otel-compact/src/adt.js').Result<import('../../outline/src/path.js').Path, any>} path
 */

/** @param {Uint8Array} bytes @returns {import('../../otel-compact/src/adt.js').Result<Cff, any>} */
export function parseCff(bytes) {
  const v = view(bytes);
  const parsed = guard(() => {
    const major = u8(v, 0);
    if (major !== 1) return { error: CffError.Version(major) };
    const hdrSize = u8(v, 2);
    const names = readIndex(v, hdrSize);
    const tops = readIndex(v, names.end);
    const strings = readIndex(v, tops.end);
    const gsubrs = readIndex(v, strings.end);
    if (tops.items.length === 0) return { error: CffError.NoCharStrings };
    const topR = readDict(tops.items[0]);
    if (topR.tag === 'Err') return { error: CffError.Unsupported(`DICT: reserved byte ${topR.error}`) };
    const top = topR.value;
    /** First operand of a DICT operator, or `dflt` when the operator is absent. */
    const num = (/** @type {number} */ op, /** @type {number} */ dflt) => { const a = top.get(op); return a && a.length ? a[0] : dflt; };
    if (top.has(1230)) return { error: CffError.Unsupported('CID-keyed CFF') };
    if (num(1206, 2) !== 2) return { error: CffError.Unsupported('charstring type 1') };
    if (!top.has(17)) return { error: CffError.NoCharStrings };
    const charStrings = readIndex(v, num(17, 0)).items;
    const privArgs = top.get(18);
    const [privSize, privOff] = privArgs && privArgs.length >= 2 ? privArgs : [0, 0];
    const privR = readDict(bytes.subarray(privOff, privOff + privSize));
    if (privR.tag === 'Err') return { error: CffError.Unsupported(`DICT: reserved byte ${privR.error}`) };
    const priv = privR.value;
    const subrs = priv.get(19);
    const lsubrs = subrs && subrs.length ? readIndex(v, privOff + subrs[0]).items : [];
    return { charStrings, gsubrs: gsubrs.items, lsubrs };
  }, (f) => CffError.Truncated(f.at));
  if (parsed.tag === 'Err') return parsed;
  if ('error' in parsed.value) return err(parsed.value.error);
  const { charStrings, gsubrs, lsubrs } = parsed.value;
  return ok({
    numGlyphs: charStrings.length,
    path: (gid) => (gid < 0 || gid >= charStrings.length
      ? err(CffError.BadGlyph(gid))
      : runCharstring(charStrings[gid], gsubrs, lsubrs, gid)),
  });
}

/**
 * Type 2 interpreter. Local mutable state, pure result.
 * @param {Uint8Array} cs @param {Uint8Array[]} gsubrs @param {Uint8Array[]} lsubrs @param {number} gid
 */
export function runCharstring(cs, gsubrs, lsubrs, gid) {
  /** @type {import('../../outline/src/path.js').SegT[]} */
  const path = [];
  /** @type {number[]} */
  const st = [];
  let x = 0, y = 0, nStems = 0, open = false, widthDone = false, depth = 0;
  /** First failure, as a value; non-empty stops the interpreter. */
  let fail = '';
  /** @param {string} why @returns {true} */
  const stop = (why) => { if (!fail) fail = why; return true; };
  // Operands past the stack top read as undefined → NaN coordinates. Every emitted point must be
  // finite, which turns stack underflow on any operator into an error instead of a garbage outline.
  const finite = (/** @type {number[]} */ ...n) => {
    if (n.every(Number.isFinite)) return true;
    stop('stack underflow');
    return false;
  };

  const moveTo = (/** @type {number} */ dx, /** @type {number} */ dy) => {
    if (!finite(x + dx, y + dy)) return;
    if (open) path.push(Seg.Close);
    x += dx; y += dy;
    path.push(Seg.MoveTo(x, y));
    open = true;
  };
  const lineTo = (/** @type {number} */ dx, /** @type {number} */ dy) => { if (!finite(x + dx, y + dy)) return; x += dx; y += dy; path.push(Seg.LineTo(x, y)); };
  /** @param {number} a @param {number} b @param {number} c @param {number} d @param {number} e @param {number} f */
  const curveTo = (a, b, c, d, e, f) => {
    const x1 = x + a, y1 = y + b, x2 = x1 + c, y2 = y1 + d;
    if (!finite(x1, y1, x2, y2, x2 + e, y2 + f)) return;
    x = x2 + e; y = y2 + f;
    path.push(Seg.CubicTo(x1, y1, x2, y2, x, y));
  };
  // The first stack-clearing operator may carry a leading width argument.
  const width = (/** @type {boolean} */ hasExtra) => {
    if (!widthDone && hasExtra) st.shift();
    widthDone = true;
  };
  const stems = () => { width(st.length % 2 === 1); nStems += st.length >> 1; st.length = 0; };

  /** @param {Uint8Array} code @returns {boolean} true = stop (endchar reached, or a failure recorded) */
  const exec = (code) => {
    if (++depth > 10) return stop('subroutine nesting > 10');
    const v = view(code);
    let i = 0;
    while (i < code.length) {
      const b0 = code[i];
      if (b0 >= 32 || b0 === 28) {
        if (b0 === 28) { st.push(i16(v, i + 1)); i += 3; }
        else if (b0 <= 246) { st.push(b0 - 139); i++; }
        else if (b0 <= 250) { st.push((b0 - 247) * 256 + u8(v, i + 1) + 108); i += 2; }
        else if (b0 <= 254) { st.push(-(b0 - 251) * 256 - u8(v, i + 1) - 108); i += 2; }
        else { st.push(i32(v, i + 1) / 65536); i += 5; }
        if (st.length > 48) return stop('argument stack overflow');
        continue;
      }
      i++;
      switch (b0) {
        case 1: case 3: case 18: case 23: stems(); break;               // hstem vstem hstemhm vstemhm
        case 19: case 20:                                                 // hintmask cntrmask
          if (st.length) stems();
          width(false);
          i += (nStems + 7) >> 3;
          break;
        case 21: width(st.length > 2); moveTo(st[0], st[1]); st.length = 0; break;  // rmoveto
        case 22: width(st.length > 1); moveTo(st[0], 0); st.length = 0; break;      // hmoveto
        case 4: width(st.length > 1); moveTo(0, st[0]); st.length = 0; break;       // vmoveto
        case 5: for (let k = 0; k + 1 < st.length; k += 2) lineTo(st[k], st[k + 1]); st.length = 0; break; // rlineto
        case 6: case 7: {                                                 // hlineto vlineto
          let horiz = b0 === 6;
          for (const d of st) { horiz ? lineTo(d, 0) : lineTo(0, d); horiz = !horiz; }
          st.length = 0;
          break;
        }
        case 8: for (let k = 0; k + 5 < st.length; k += 6) curveTo(st[k], st[k + 1], st[k + 2], st[k + 3], st[k + 4], st[k + 5]); st.length = 0; break; // rrcurveto
        case 24: {                                                        // rcurveline
          let k = 0;
          for (; k + 5 < st.length - 2; k += 6) curveTo(st[k], st[k + 1], st[k + 2], st[k + 3], st[k + 4], st[k + 5]);
          lineTo(st[k], st[k + 1]);
          st.length = 0;
          break;
        }
        case 25: {                                                        // rlinecurve
          let k = 0;
          for (; k + 1 < st.length - 6; k += 2) lineTo(st[k], st[k + 1]);
          curveTo(st[k], st[k + 1], st[k + 2], st[k + 3], st[k + 4], st[k + 5]);
          st.length = 0;
          break;
        }
        case 26: {                                                        // vvcurveto
          let k = 0, dx1 = 0;
          if (st.length % 2) dx1 = st[k++];
          for (; k + 3 < st.length; k += 4) { curveTo(dx1, st[k], st[k + 1], st[k + 2], 0, st[k + 3]); dx1 = 0; }
          st.length = 0;
          break;
        }
        case 27: {                                                        // hhcurveto
          let k = 0, dy1 = 0;
          if (st.length % 2) dy1 = st[k++];
          for (; k + 3 < st.length; k += 4) { curveTo(st[k], dy1, st[k + 1], st[k + 2], st[k + 3], 0); dy1 = 0; }
          st.length = 0;
          break;
        }
        case 30: case 31: {                                               // vhcurveto hvcurveto
          let horiz = b0 === 31;
          for (let k = 0; k + 3 < st.length; k += 4) {
            const last = k + 4 >= st.length - 1;
            const f = last && st.length - k === 5 ? st[k + 4] : 0;
            if (horiz) curveTo(st[k], 0, st[k + 1], st[k + 2], f, st[k + 3]);
            else curveTo(0, st[k], st[k + 1], st[k + 2], st[k + 3], f);
            horiz = !horiz;
          }
          st.length = 0;
          break;
        }
        case 10: case 29: {                                               // callsubr callgsubr
          const subrs = b0 === 10 ? lsubrs : gsubrs;
          if (st.length === 0) return stop('stack underflow');
          const idx = st[st.length - 1] + subrBias(subrs.length);
          st.length--;
          if (!(Number.isInteger(idx) && idx >= 0 && idx < subrs.length)) return stop(`subr ${idx} out of range`);
          if (exec(subrs[idx])) return true;
          break;
        }
        case 11: depth--; return false;                                   // return
        case 14:                                                          // endchar
          if (st.length === 4 || st.length === 5) return stop('seac (endchar accent) unsupported');
          width(st.length > 0);
          if (open) path.push(Seg.Close);
          open = false;
          return true;
        case 12: {
          const op = code[i++];
          const a = st;
          if (op === 35) { curveTo(a[0], a[1], a[2], a[3], a[4], a[5]); curveTo(a[6], a[7], a[8], a[9], a[10], a[11]); }        // flex
          else if (op === 34) { curveTo(a[0], 0, a[1], a[2], a[3], 0); curveTo(a[4], 0, a[5], -a[2], a[6], 0); }                // hflex
          else if (op === 36) { curveTo(a[0], a[1], a[2], a[3], a[4], 0); curveTo(a[5], 0, a[6], a[7], a[8], -(a[1] + a[3] + a[7])); } // hflex1
          else if (op === 37) {                                                                                                 // flex1
            const dx = a[0] + a[2] + a[4] + a[6] + a[8], dy = a[1] + a[3] + a[5] + a[7] + a[9];
            curveTo(a[0], a[1], a[2], a[3], a[4], a[5]);
            if (Math.abs(dx) > Math.abs(dy)) curveTo(a[6], a[7], a[8], a[9], a[10], -dy);
            else curveTo(a[6], a[7], a[8], a[9], -dx, a[10]);
          } else return stop(`escape operator 12 ${op} unsupported`);
          st.length = 0;
          break;
        }
        default: return stop(`reserved operator ${b0}`);
      }
    }
    depth--;
    return false;
  };

  const run = guard(() => exec(cs), () => 'truncated');
  if (run.tag === 'Err') return err(CffError.Charstring(gid, run.error));
  if (fail) return err(CffError.Charstring(gid, fail));
  if (open) path.push(Seg.Close);
  return ok(/** @type {import('../../outline/src/path.js').Path} */ (path));
}
