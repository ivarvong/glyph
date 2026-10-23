// @ts-check
// Math layout: AST → boxes → positioned glyphs and rules. The algorithms are MathML Core's
// (§3, built on the OpenType MATH table), the atom classes, inter-atom spacing and style rules
// TeX's (TeXbook App. G, rules 5–6 and 20; the table on p. 170; styles D T S SS, cramped).
// Where the two disagree the choice is TeX's and is listed in README "Math"; every number below
// is in design units of the font at the formula's root size, y up, origin on the baseline.
//
//   layoutMath(font, math, ast, { display }) → Result<MathBox, MathLayoutError>
//
// A box is { w, h, d, ic } plus ink: glyphs (gid, x, y, scale k), rules, and nested boxes.
// h and d are ink extents (MathML's ink line-ascent/descent; TeX's box height/depth): a glyph
// lying wholly above the baseline (an accent) has a negative d.

import { variants, ok, err } from '../../otel-compact/src/adt.js';
import { Seg } from '../../outline/src/path.js';
import { shape } from '../../shape/src/shape.js';

/** @typedef {import('./tex.js').Node} Node */
/** @typedef {import('./symbols.js').Cls} Cls */
/** @typedef {import('./table.js').MathTable} MathTable */
/** @typedef {import('./table.js').ConstantName} ConstantName */
/** @typedef {import('../../sfnt/src/font.js').Font} Font */

export const MathLayoutError = variants('MathLayoutError', {
  MissingGlyph: ['cp', 'at'],    // the font maps no glyph for a character of the formula
  Outline: ['gid', 'error'],     // a glyph the formula needs has an outline error
  Shape: ['text', 'at', 'error'],
  TooBig: ['what', 'limit'],     // an assembly or the whole formula past its glyph budget
});
/** @typedef {import('../../otel-compact/src/adt.js').Of<typeof MathLayoutError>} MathLayoutErrorT */

export const LAYOUT_LIMITS = Object.freeze({ glyphs: 1 << 16, assemblyParts: 1024 });

/**
 * @typedef {{ t: 'g', gid: number, x: number, y: number, k: number }
 *   | { t: 'r', x: number, y: number, w: number, h: number }
 *   | { t: 'b', box: Box, x: number, y: number }} Ink
 * Box: w advance, h ink above the baseline, d ink below, ic italic correction, ta top accent
 * attachment (x; NaN: none, use w/2: attachments of combining marks are negative); op: an operator (MathML "embellished operator": no
 * italic-correction slant in rows), large: a large operator (limits use the limit constants);
 * gid: the glyph when the box is one glyph (accents attach to it; math kerns read it); cls: its TeX class.
 * @typedef {{ w: number, h: number, d: number, ic: number, ta: number, op: boolean, large: boolean, gid: number, k: number, ink: Ink[] }} Box
 */
/** A laid-out formula: ink flattened to absolute positions (design units, y up, baseline origin). */
/** @typedef {{ width: number, ascent: number, descent: number, glyphs: { gid: number, x: number, y: number, k: number }[], rules: { x: number, y: number, w: number, h: number }[], tokens: Token[] }} MathBox */
/**
 * Every leaf (glyph, glyph run or stretched glyph) as MathML would box it, in MathML document order:
 * for comparisons. ic: its italic correction (lic: a large operator's), k: its scale (font units at the root size).
 * @typedef {{ kind: string, at: number, x: number, w: number, top: number, bottom: number, ic: number, lic: number, k: number }} Token
 */

/** TeX style: level 0 D, 1 T, 2 S, 3 SS; cramped. @typedef {{ level: number, cramped: boolean }} St */
const sup = (/** @type {St} */ s) => ({ level: s.level < 2 ? 2 : 3, cramped: s.cramped });
const sub = (/** @type {St} */ s) => ({ level: s.level < 2 ? 2 : 3, cramped: true });
const num = (/** @type {St} */ s) => ({ level: Math.min(s.level + 1, 3), cramped: s.cramped });
const den = (/** @type {St} */ s) => ({ level: Math.min(s.level + 1, 3), cramped: true });
const cramp = (/** @type {St} */ s) => ({ level: s.level, cramped: true });

// TeXbook p. 170: spacing between atom classes, in mu; negative = only in D and T styles.
//            Ord Op Bin Rel Open Close Punct Inner
const SPACING = [
  /* Ord   */ [0, 3, -4, -5, 0, 0, 0, -3],
  /* Op    */ [3, 3, 0, -5, 0, 0, 0, -3],
  /* Bin   */ [-4, -4, 0, 0, -4, 0, 0, -4],
  /* Rel   */ [-5, -5, 0, 0, -5, 0, 0, -5],
  /* Open  */ [0, 0, 0, 0, 0, 0, 0, 0],
  /* Close */ [0, 3, -4, -5, 0, 0, 0, -3],
  /* Punct */ [-3, -3, 0, -3, -3, -3, -3, -3],
  /* Inner */ [-3, 3, -4, -5, -3, 0, -3, -3],
];
const CLASS_INDEX = /** @type {Record<Cls, number>} */ ({ ord: 0, op: 1, bin: 2, rel: 3, open: 4, close: 5, punct: 6, inner: 7 });

/** Exact ink bounds of a path (cubic and quadratic extrema solved, not the control hull). @param {import('../../outline/src/path.js').Path} p */
export function inkBounds(p) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, cx = 0, cy = 0;
  const add = (/** @type {number} */ x, /** @type {number} */ y) => { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; };
  /** Roots in (0, 1) of the derivative of a cubic (or quadratic) in one axis. */
  const ext = (/** @type {number[]} */ c, /** @type {(t: number) => void} */ at) => {
    // B'(t)/3 = a t² + b t + c for p0..p3: a = -p0+3p1-3p2+p3, b = 2(p0-2p1+p2), c = p1-p0
    const [p0, p1, p2, p3] = c, a = -p0 + 3 * p1 - 3 * p2 + p3, b = 2 * (p0 - 2 * p1 + p2), k = p1 - p0;
    if (Math.abs(a) < 1e-12) { if (Math.abs(b) > 1e-12) { const t = -k / b; if (t > 0 && t < 1) at(t); } return; }
    const disc = b * b - 4 * a * k;
    if (disc < 0) return;
    const r = Math.sqrt(disc);
    for (const t of [(-b + r) / (2 * a), (-b - r) / (2 * a)]) if (t > 0 && t < 1) at(t);
  };
  for (const s of p) {
    Seg.match(s, {
      MoveTo: ({ x, y }) => { add(x, y); cx = x; cy = y; },
      LineTo: ({ x, y }) => { add(x, y); cx = x; cy = y; },
      QuadTo: ({ x1: qx, y1: qy, x, y }) => {
        // As a cubic: p1 = p0 + 2/3 (q - p0), p2 = p + 2/3 (q - p).
        const c = [cx, cx + (2 / 3) * (qx - cx), x + (2 / 3) * (qx - x), x], d = [cy, cy + (2 / 3) * (qy - cy), y + (2 / 3) * (qy - y), y];
        const pt = (/** @type {number} */ t) => add(bez(c, t), bez(d, t));
        ext(c, pt); ext(d, pt); add(x, y); cx = x; cy = y;
      },
      CubicTo: ({ x1: ax, y1: ay, x2: bx, y2: by, x, y }) => {
        const c = [cx, ax, bx, x], d = [cy, ay, by, y];
        const pt = (/** @type {number} */ t) => add(bez(c, t), bez(d, t));
        ext(c, pt); ext(d, pt); add(x, y); cx = x; cy = y;
      },
      Close: () => {},
    });
  }
  return x0 === Infinity ? null : /** @type {[number, number, number, number]} */ ([x0, y0, x1, y1]);
}
/** @param {number[]} c @param {number} t */
const bez = (c, t) => { const u = 1 - t; return u * u * u * c[0] + 3 * u * u * t * c[1] + 3 * u * t * t * c[2] + t * t * t * c[3]; };

/**
 * @param {Font} font @param {MathTable} math @param {Node} ast
 * @param {{ display?: boolean, limits?: typeof LAYOUT_LIMITS }} [opts]
 * @returns {import('../../otel-compact/src/adt.js').Result<MathBox, MathLayoutErrorT>}
 */
export function layoutMath(font, math, ast, { display = false, limits = LAYOUT_LIMITS } = {}) {
  const C = math.constants;
  /** A constant at style s (MathML: the element's font size; TeX: the style's fam2 size). */
  const c = (/** @type {ConstantName} */ n, /** @type {St} */ s) => C[n] * kOf(s);
  const kOf = (/** @type {St} */ s) => (s.level < 2 ? 1 : s.level === 2 ? C.ScriptPercentScaleDown / 100 : C.ScriptScriptPercentScaleDown / 100);
  const em = (/** @type {St} */ s) => font.unitsPerEm * kOf(s);
  // Sticky fault (as the parser): the first error is kept; layout continues on empty boxes.
  /** @type {MathLayoutErrorT | null} */
  let fault = null;
  let glyphCount = 0;
  const fail = (/** @type {MathLayoutErrorT} */ e) => { if (!fault) fault = e; return empty(); };
  /** @type {Token[]} */
  const tokens = [];

  /** @type {Map<number, { adv: number, bb: [number, number, number, number] | null }>} */
  const metrics = new Map();
  const glyphMetrics = (/** @type {number} */ gid) => {
    let m = metrics.get(gid);
    if (!m) {
      const p = font.path(gid);
      if (p.tag === 'Err') { fail(MathLayoutError.Outline(gid, p.error)); m = { adv: 0, bb: null }; }
      else m = { adv: font.advance(gid), bb: inkBounds(p.value) };
      metrics.set(gid, m);
    }
    return m;
  };
  /** @returns {Box} */
  const empty = () => ({ w: 0, h: 0, d: 0, ic: 0, ta: NaN, op: false, large: false, gid: -1, k: 1, ink: [] });
  /** One glyph at scale k. @returns {Box} */
  const glyphBox = (/** @type {number} */ gid, /** @type {number} */ k) => {
    if (++glyphCount > limits.glyphs) return fail(MathLayoutError.TooBig('glyphs', limits.glyphs));
    const m = glyphMetrics(gid);
    const ta = math.topAccent.get(gid);
    return {
      w: m.adv * k, h: m.bb ? m.bb[3] * k : 0, d: m.bb ? -m.bb[1] * k : 0, ic: (math.italics.get(gid) ?? 0) * k,
      ta: ta === undefined ? NaN : ta * k, op: false, large: false, gid, k, ink: [{ t: 'g', gid, x: 0, y: 0, k }], // edge: Map.get miss
    };
  };
  const gidOf = (/** @type {number} */ cp, /** @type {number} */ at) => {
    const g = font.glyphOf(cp);
    if (!g) fail(MathLayoutError.MissingGlyph(cp, at));
    return g;
  };
  /** A box made of others: children at (x, y). @param {Partial<Box>} m @param {{ box: Box, x: number, y: number }[]} kids @returns {Box} */
  const compose = (m, kids) => ({ w: 0, h: 0, d: 0, ic: 0, ta: NaN, op: false, large: false, gid: -1, k: 1, ...m, ink: kids.map((q) => ({ t: /** @type {const} */ ('b'), ...q })) });
  const token = (/** @type {string} */ kind, /** @type {number} */ at, /** @type {Box} */ b) => {
    const tk = { kind, at, x: 0, w: b.w, top: b.h, bottom: -b.d, ic: b.op ? 0 : b.ic, lic: b.large ? b.ic : 0, k: b.k };
    tokens.push(tk);
    return /** @type {Box & { tok?: Token }} */ ({ ...b, tok: tk });
  };

  // ---- stretchy glyphs (MathML Core §5.3) -------------------------------------------------
  /**
   * The glyph, a size variant, or an assembly covering T along an axis (MathML Core §5.3.2).
   * Vertical: returns a box with the construction's own ascent/descent (assemblies: all above
   * the baseline, as the spec defines them); the caller centres it.
   * @param {number} gid @param {number} T @param {number} k @param {boolean} vertical
   */
  const stretch = (gid, T, k, vertical) => {
    const con = (vertical ? math.vertical : math.horizontal).get(gid);
    const base = glyphBox(gid, k);
    if (!con) return base;
    if ((vertical ? base.h + base.d : base.w) >= T) return base;
    let last = base;
    for (const v of con.variants) {
      last = glyphBox(v.gid, k);
      if (v.advance * k >= T) return last;
    }
    const a = con.assembly;
    return a ? assembly(a, T, k, vertical) ?? last : last; // edge: null = invalid assembly, keep the last variant
  };
  /**
   * GlyphAssembly (MathML Core §5.3.1): each extender repeated r_min times with one overlap
   * o_max, so the size is at least T. Null when the assembly is invalid or over budget.
   * @param {import('./table.js').Assembly} a @param {number} T @param {number} k @param {boolean} vertical
   * @returns {Box | null}
   */
  const assembly = (a, T, k, vertical) => {
    const omin = math.minConnectorOverlap * k;
    const parts = a.parts.map((p) => ({ gid: p.gid, start: p.start * k, end: p.end * k, full: p.full * k, ext: (p.flags & 1) === 1 }));
    const ext = parts.filter((p) => p.ext), non = parts.filter((p) => !p.ext);
    const sExt = ext.reduce((s, p) => s + p.full, 0), sNon = non.reduce((s, p) => s + p.full, 0);
    const sExtNon = sExt - omin * ext.length;
    // Invalid (MathML Core §5.3.1): no extender, extenders that cannot grow, or a connector that
    // meets another part shorter than the minimum overlap (the outer ends of the first and last
    // parts meet nothing: a bottom piece has no start connector).
    if (!ext.length || !(sExtNon > 0) || parts.some((p, i) => (i > 0 && p.start < omin - 1e-9) || (i < parts.length - 1 && p.end < omin - 1e-9))) return null;
    const r = Math.max(0, Math.ceil((T - sNon + omin * (non.length - 1)) / sExtNon));
    const count = non.length + r * ext.length;
    if (count > limits.assemblyParts) return null;
    const size0 = sNon + r * sExt;
    let o = count > 1 ? (size0 - T) / (count - 1) : 0;
    // The overlap at each joint is bounded by the two connectors that meet there: a part's end and
    // the next part's start. So every start counts but the first part's, every end but the last's
    // (an extender, repeated, meets itself on both sides). MathML Core §5.3.1 names the opposite
    // ends ("start … excluding the last", "end … excluding the first"): read literally, the first
    // part's start of 0 forces the minimum overlap, and an overbrace came out 5914 units for 5096.
    parts.forEach((p, i) => {
      if (i > 0 || p.ext) o = Math.min(o, p.start);
      if (i < parts.length - 1 || p.ext) o = Math.min(o, p.end);
    });
    o = Math.max(o, omin);
    /** @type {{ box: Box, x: number, y: number }[]} */
    const kids = [];
    let pos = 0, w = 0, h = 0, d = 0;
    for (const p of parts) {
      for (let n = p.ext ? r : 1; n > 0; n--) {
        const g = glyphBox(p.gid, k);
        kids.push(vertical ? { box: g, x: 0, y: pos } : { box: g, x: pos, y: 0 });
        pos += p.full - o;
        if (vertical) w = Math.max(w, g.w); else { h = Math.max(h, g.h); d = Math.max(d, g.d); }
      }
    }
    const size = pos + o;
    return compose(vertical ? { w, h: size, d: 0, ic: a.italic * k } : { w: size, h, d, ic: a.italic * k }, kids);
  };
  /**
   * A vertically stretched glyph centred on the target (MathML Core §3.2.4.3), symmetric about
   * the axis when `symmetric`: covers ascent U above and U' below the baseline.
   * @param {number} gid @param {number} Ua @param {number} Ud @param {St} s @param {boolean} symmetric
   */
  const stretchV = (gid, Ua, Ud, s, symmetric) => {
    const axis = c('AxisHeight', s);
    let Ta = Ua, Td = Ud;
    if (symmetric) { const m = Math.max(Ua - axis, Ud + axis); Ta = m + axis; Td = m - axis; }
    const g = stretch(gid, Ta + Td, kOf(s), true);
    const delta = ((g.h - g.d) - (Ta - Td)) / 2;
    return compose({ w: g.w, h: g.h - delta, d: g.d + delta, ic: g.ic, op: true, gid: g.ink.length === 1 ? g.gid : -1, k: g.k }, [{ box: g, x: 0, y: -delta }]);
  };

  // ---- atoms ------------------------------------------------------------------------------
  /** @param {Node} n @returns {Cls} */
  const clsOf = (n) => {
    switch (n.kind) {
      case 'sym': case 'big': case 'class': case 'stack': return n.cls;
      case 'scripts': return clsOf(n.base);
      case 'bigop': case 'opname': case 'brace': return 'op';
      case 'frac': case 'fenced': return 'inner';
      case 'matrix': return n.open || n.close ? 'inner' : 'ord';
      default: return 'ord';
    }
  };

  /** Shaped upright text in the math font (\text, \sin): one token. @param {string} text @param {number} at @param {St} s */
  const textBox = (text, at, s) => {
    const r = shape(font, text);
    if (r.tag === 'Err') return fail(MathLayoutError.Shape(text, at, r.error));
    const k = kOf(s);
    /** @type {{ box: Box, x: number, y: number }[]} */
    const kids = [];
    let pen = 0, h = 0, d = 0;
    for (const g of r.value) {
      if (g.gid === 0) return fail(MathLayoutError.MissingGlyph(text.codePointAt(Math.min(g.cluster, text.length - 1)) ?? 0, at));
      const b = glyphBox(g.gid, k);
      if (b.ink.length && glyphMetrics(g.gid).bb) { kids.push({ box: b, x: pen + g.dx * k, y: g.dy * k }); h = Math.max(h, b.h + g.dy * k); d = Math.max(d, b.d - g.dy * k); }
      pen += g.ax * k;
    }
    return compose({ w: pen, h, d }, kids);
  };

  /** @param {Node} n @param {St} s @returns {Box} */
  const node = (n, s) => {
    switch (n.kind) {
      case 'sym': {
        const b = glyphBox(gidOf(n.cp, n.at), kOf(s));
        return token(n.cls !== 'ord' ? 'mo' : n.cp >= 0x30 && n.cp <= 0x39 ? 'mn' : 'mi', n.at, { ...b, op: n.cls !== 'ord' });
      }
      case 'row': return row(n.items, s);
      case 'text': return token('mtext', n.at, textBox(n.text, n.at, s));
      case 'space': return { ...empty(), w: (n.mu / 18) * em(s) };
      case 'style': return empty();
      case 'class': { const b = node(n.body, s); return { ...b, op: n.cls !== 'ord' }; }
      case 'opname': return token('mo', n.at, { ...textBox(n.name, n.at, s), op: true, large: true });
      case 'bigop': {
        const gid = gidOf(n.cp, n.at), k = kOf(s);
        // Display style: the variant reaching DisplayOperatorMinHeight, centred on the axis (MathML Core §3.2.4.3, TeX rule 13).
        const g = s.level === 0 ? stretch(gid, C.DisplayOperatorMinHeight * k, k, true) : glyphBox(gid, k);
        const delta = ((g.h - g.d) - 2 * c('AxisHeight', s)) / 2;
        return token('mo', n.at, compose({ w: g.w, h: g.h - delta, d: g.d + delta, ic: g.ic, op: true, large: true, gid: g.gid, k }, [{ box: g, x: 0, y: -delta }]));
      }
      case 'big': {
        // \big…\Bigg: a delimiter for a box of height n.em em on the baseline (plain.tex: \vbox to 8.5pt…).
        if (!n.cp) return { ...empty(), w: 0.12 * font.unitsPerEm };
        return token('mo', n.at, stretchV(gidOf(n.cp, n.at), n.em * font.unitsPerEm, 0, s, true));
      }
      case 'scripts': return scripts(n, s);
      case 'frac': return frac(n, s);
      case 'sqrt': return radical(n, s);
      case 'fenced': return fenced(n, s);
      case 'accent': return accent(n, s);
      case 'line': return line(n, s);
      case 'brace': return brace(n, s);
      case 'stack': return stack(n, s);
      case 'matrix': return matrix(n, s);
    }
  };

  /**
   * A math list (TeXbook App. G rules 5–6, 20; MathML Core §3.3.1.2 for italic correction):
   * classes with Bin→Ord fixups, inter-atom spacing by the p. 170 table, style changes, and
   * the italic correction of a slanted (non-operator) item added before a non-slanted one.
   * @param {Node[]} items @param {St} s0
   */
  const row = (items, s0) => {
    let s = s0;
    /** @type {{ box: Box, cls: Cls | '', s: St }[]} */
    const atoms = [];
    for (const it of items) {
      if (it.kind === 'style') { s = { level: { D: 0, T: 1, S: 2, SS: 3 }[it.style], cramped: s.cramped }; continue; }
      atoms.push({ box: node(it, s), cls: it.kind === 'space' ? '' : clsOf(it), s });
    }
    return joinAtoms(atoms);
  };
  /** @param {{ box: Box, cls: Cls | 'middle' | '', s: St }[]} atoms */
  const joinAtoms = (atoms) => {
    // Rules 5 and 6: a Bin is an Ord at the start, after Bin Op Rel Open Punct, and before Rel Close Punct or the end.
    let prev = -1;
    for (let i = 0; i < atoms.length; i++) {
      const a = atoms[i];
      if (!a.cls) continue;
      const p = prev >= 0 ? atoms[prev].cls : 'open';
      if (a.cls === 'bin' && (p === 'bin' || p === 'op' || p === 'rel' || p === 'open' || p === 'punct' || p === 'middle')) a.cls = 'ord';
      if ((a.cls === 'rel' || a.cls === 'close' || a.cls === 'punct' || a.cls === 'middle') && prev >= 0 && atoms[prev].cls === 'bin') atoms[prev].cls = 'ord';
      prev = i;
    }
    if (prev >= 0 && atoms[prev].cls === 'bin') atoms[prev].cls = 'ord';
    /** @type {{ box: Box, x: number, y: number }[]} */
    const kids = [];
    let x = 0, h = -Infinity, d = -Infinity, pic = 0, last = '';
    for (const a of atoms) {
      const b = a.box;
      if (a.cls) {
        if (last) {
          // A \middle delimiter spaces as a Close on its left and an Open on its right (e-TeX).
          const l = last === 'middle' ? 'open' : last, r = a.cls === 'middle' ? 'close' : a.cls;
          const mu = SPACING[CLASS_INDEX[/** @type {Cls} */ (l)]][CLASS_INDEX[/** @type {Cls} */ (r)]];
          if (mu > 0 || (mu < 0 && a.s.level < 2)) x += (Math.abs(mu) / 18) * em(a.s);
        }
        last = a.cls;
      }
      const slanted = !b.op && b.ic !== 0;
      if (!slanted) x += pic;
      kids.push({ box: b, x, y: 0 });
      x += b.w;
      pic = slanted ? b.ic : 0;
      if (b.ink.length || b.w) { h = Math.max(h, b.h); d = Math.max(d, b.d); }
    }
    const one = atoms.length === 1 ? atoms[0].box : null;
    // The trailing italic correction is the row's ic, not part of its width (MathML Core adds it to
    // both, so nested rows would count it twice); the parent row or the root adds it once.
    return compose({ w: x, h: h === -Infinity ? 0 : h, d: d === -Infinity ? 0 : d, ic: pic, op: one ? one.op : false, large: one ? one.large : false, gid: one ? one.gid : -1, k: one ? one.k : 1, ta: one ? one.ta : NaN }, kids);
  };

  /** Read a math kern staircase at a height. @param {import('./table.js').MathKern | null} mk @param {number} y */
  const kernAt = (mk, y) => {
    if (!mk) return 0;
    let i = 0;
    while (i < mk.heights.length && y >= mk.heights[i]) i++;
    return mk.kerns[i] ?? 0;
  };
  /** OpenType math kerns (cut-ins) for a script on a one-glyph base, at the script's near edge. @param {Box} b @param {Box} scr @param {boolean} top @param {number} shift */
  const cutIn = (b, scr, top, shift) => {
    const bk = b.gid >= 0 ? math.kerns.get(b.gid) : null, sk = scr.gid >= 0 ? math.kerns.get(scr.gid) : null;
    if (!bk && !sk) return 0;
    // Base corner at the script's edge nearest the base; script corner at the base's edge, in each glyph's own units.
    const yb = top ? shift - scr.d : -shift + scr.h;
    const ys = top ? b.h - shift : -b.d + shift;
    return (bk ? kernAt(top ? bk.TopRight : bk.BottomRight, yb / b.k) * b.k : 0) + (sk ? kernAt(top ? sk.BottomLeft : sk.TopLeft, ys / scr.k) * scr.k : 0);
  };

  /** Scripts or limits (MathML Core §3.4.1 msub/msup/msubsup, §3.4.2 munder/mover/munderover). @param {Extract<Node, { kind: 'scripts' }>} n @param {St} s */
  const scripts = (n, s) => {
    const b = node(n.base, s);
    const bk = n.base.kind === 'row' && n.base.items.length === 1 ? n.base.items[0] : n.base;
    const lim = bk.kind === 'brace' || ((bk.kind === 'bigop' || bk.kind === 'opname') && (bk.limits === 'limits' || (bk.limits === 'auto' && s.level === 0)));
    // Built in MathML order (base, sub, sup), so the token list pairs with <msubsup>/<munderover>.
    const under = n.sub ? node(n.sub, sub(s)) : null, over = n.sup ? node(n.sup, sup(s)) : null;
    if (lim) return limitsBox(b, over, under, s);
    const largeIc = b.large ? b.ic : 0, ic = b.large ? 0 : b.ic;
    let subShift = 0, supShift = 0;
    if (under) subShift = Math.max(c('SubscriptShiftDown', s), under.h - c('SubscriptTopMax', s), c('SubscriptBaselineDropMin', s) + b.d);
    if (over) supShift = Math.max(c(s.cramped ? 'SuperscriptShiftUpCramped' : 'SuperscriptShiftUp', s), c('SuperscriptBottomMin', s) + over.d, b.h - c('SuperscriptBaselineDropMax', s));
    if (under && over) {
      const gap = (subShift - under.h) + (supShift - over.d), min = c('SubSuperscriptGapMin', s);
      if (gap < min) {
        let delta = c('SuperscriptBottomMaxWithSubscript', s) - (supShift - over.d);
        if (delta > 0) { delta = Math.min(delta, min - gap); supShift += delta; }
        const gap2 = (subShift - under.h) + (supShift - over.d);
        if (min - gap2 > 0) subShift += min - gap2;
      }
    }
    /** @type {{ box: Box, x: number, y: number }[]} */
    const kids = [{ box: b, x: 0, y: 0 }];
    let w = b.w, h = b.h, d = b.d;
    if (under) {
      const x = b.w - largeIc + cutIn(b, under, false, subShift);
      kids.push({ box: under, x, y: -subShift });
      w = Math.max(w, x + under.w); h = Math.max(h, under.h - subShift); d = Math.max(d, under.d + subShift);
    }
    if (over) {
      const x = b.w + ic + cutIn(b, over, true, supShift);
      kids.push({ box: over, x, y: supShift });
      w = Math.max(w, x + over.w); h = Math.max(h, over.h + supShift); d = Math.max(d, over.d - supShift);
    }
    return compose({ w: w + c('SpaceAfterScript', s), h, d, op: b.op }, kids);
  };

  /**
   * Over and under a base, centred (MathML Core §3.4.2): limits of a large operator (the limit
   * constants), or a plain stack (the overbar and underbar gaps).
   * @param {Box} b @param {Box | null} over @param {Box | null} under @param {St} s
   */
  const limitsBox = (b, over, under, s) => {
    const largeIc = b.large ? b.ic : 0;
    /** @type {{ box: Box, x: number, y: number }[]} */
    const kids = [];
    // Horizontal: centres aligned; over moved right by ic/2, under left by ic/2.
    const cs = [{ box: b, dx: 0 }, ...(over ? [{ box: over, dx: largeIc / 2 }] : []), ...(under ? [{ box: under, dx: -largeIc / 2 }] : [])];
    const lo = Math.min(...cs.map((q) => q.dx - q.box.w / 2)), hi = Math.max(...cs.map((q) => q.dx + q.box.w / 2));
    let h = b.h, d = b.d;
    kids.push({ box: b, x: -lo - b.w / 2, y: 0 });
    if (over) {
      const shift = b.large ? Math.max(c('UpperLimitBaselineRiseMin', s), c('UpperLimitGapMin', s) + over.d) : c('OverbarVerticalGap', s) + over.d;
      const y = b.h + shift;
      kids.push({ box: over, x: -lo - over.w / 2 + largeIc / 2, y });
      h = Math.max(h, y + over.h + (b.large ? 0 : c('OverbarExtraAscender', s)));
    }
    if (under) {
      const shift = b.large ? Math.max(c('LowerLimitBaselineDropMin', s), c('LowerLimitGapMin', s) + under.h) : c('UnderbarVerticalGap', s) + under.h;
      const y = -b.d - shift;
      kids.push({ box: under, x: -lo - under.w / 2 - largeIc / 2, y });
      d = Math.max(d, -y + under.d + (b.large ? 0 : c('UnderbarExtraDescender', s)));
    }
    return compose({ w: hi - lo, h, d, op: b.op }, kids);
  };

  /** Fractions and \binom (MathML Core §3.3.2; TeX rule 15e for the null delimiter space). @param {Extract<Node, { kind: 'frac' }>} n @param {St} s */
  const frac = (n, s) => {
    const fs = n.style === 'D' ? { level: 0, cramped: s.cramped } : n.style === 'T' ? { level: Math.max(1, s.level), cramped: s.cramped } : s;
    const disp = fs.level === 0, mark = tokens.length;
    const top = node(n.num, num(fs)), bot = node(n.den, den(fs));
    const w = Math.max(top.w, bot.w), axis = c('AxisHeight', fs);
    let up = 0, down = 0;
    /** @type {{ box: Box, x: number, y: number }[]} */
    const kids = [];
    if (n.bar) {
      const t = c('FractionRuleThickness', fs);
      up = Math.max(c(disp ? 'FractionNumeratorDisplayStyleShiftUp' : 'FractionNumeratorShiftUp', fs), axis + t / 2 + c(disp ? 'FractionNumDisplayStyleGapMin' : 'FractionNumeratorGapMin', fs) + top.d);
      down = Math.max(c(disp ? 'FractionDenominatorDisplayStyleShiftDown' : 'FractionDenominatorShiftDown', fs), t / 2 + c(disp ? 'FractionDenomDisplayStyleGapMin' : 'FractionDenominatorGapMin', fs) + bot.h - axis);
      kids.push({ box: rule(w, t), x: 0, y: axis - t / 2 });
    } else {
      up = c(disp ? 'StackTopDisplayStyleShiftUp' : 'StackTopShiftUp', fs);
      down = c(disp ? 'StackBottomDisplayStyleShiftDown' : 'StackBottomShiftDown', fs);
      const gap = (down - bot.h) + (up - top.d), min = c(disp ? 'StackDisplayStyleGapMin' : 'StackGapMin', fs);
      if (min - gap > 0) { up += (min - gap) / 2; down += (min - gap) - (min - gap) / 2; }
    }
    kids.push({ box: top, x: (w - top.w) / 2, y: up }, { box: bot, x: (w - bot.w) / 2, y: -down });
    const h = Math.max(up + top.h, -down + bot.h, n.bar ? axis + c('FractionRuleThickness', fs) / 2 : -Infinity);
    const d = Math.max(-up + top.d, down + bot.d, n.bar ? -axis + c('FractionRuleThickness', fs) / 2 : -Infinity);
    const core = compose({ w, h, d }, kids);
    if (n.open || n.close) return fencedBoxes(n.open, n.close, [core], fs, n.at, mark);
    // \nulldelimiterspace (1.2pt at 10pt: 0.12 em) on each side, TeX rule 15e.
    const pad = 0.12 * font.unitsPerEm;
    return compose({ w: w + 2 * pad, h, d }, [{ box: core, x: pad, y: 0 }]);
  };
  /** A filled rectangle from the baseline up. @param {number} w @param {number} t @returns {Box} */
  const rule = (w, t) => ({ ...empty(), w, h: t, ink: [{ t: 'r', x: 0, y: 0, w, h: t }] });

  /** \sqrt and \sqrt[n] (MathML Core §3.3.3). @param {Extract<Node, { kind: 'sqrt' }>} n @param {St} s */
  const radical = (n, s) => {
    const base = node(n.body, cramp(s));
    const t = c('RadicalRuleThickness', s), gap = c(s.level === 0 ? 'RadicalDisplayStyleVerticalGap' : 'RadicalVerticalGap', s);
    const extra = c('RadicalExtraAscender', s);
    const surd = stretch(gidOf(0x221a, n.at), t + gap + base.h + base.d, kOf(s), true); // no MathML token: <msqrt> draws it
    const h = Math.max(base.h, base.h + gap + t + extra);
    const d = Math.max(base.d, surd.h + surd.d + extra - h);
    const barTop = h - extra;
    const B = compose({ w: surd.w + base.w, h, d }, [
      { box: surd, x: 0, y: barTop - surd.h },
      { box: rule(base.w, t), x: surd.w, y: barTop - t },
      { box: base, x: surd.w, y: 0 },
    ]);
    if (!n.index) return B;
    const idx = node(n.index, { level: 3, cramped: s.cramped });
    const before = Math.max(0, c('RadicalKernBeforeDegree', s)), after = Math.max(-idx.w, c('RadicalKernAfterDegree', s));
    const raise = (C.RadicalDegreeBottomRaisePercent / 100) * (B.h + B.d);
    const iy = -B.d + raise + idx.d;
    return compose({ w: before + idx.w + after + B.w, h: Math.max(B.h, iy + idx.h), d: Math.max(B.d, idx.d - iy) }, [
      { box: idx, x: before, y: iy }, { box: B, x: before + idx.w + after, y: 0 },
    ]);
  };

  /**
   * Delimiters around boxes, stretched to their ink (MathML Core §3.3.1.1: the stretchy
   * operators of a row cover the max ascent and descent of the rest, symmetric about the axis).
   * @param {number} open @param {number} close @param {Box[]} parts @param {St} s @param {number} at @param {number} mark  token index where the content's tokens start
   */
  const fencedBoxes = (open, close, parts, s, at, mark) => {
    let Ua = 0, Ud = 0;
    for (const p of parts) { Ua = Math.max(Ua, p.h); Ud = Math.max(Ud, p.d); }
    const del = (/** @type {number} */ cp) => (cp ? token('mo', at, stretchV(gidOf(cp, at), Ua, Ud, s, true)) : { ...empty(), w: 0.12 * font.unitsPerEm });
    /** @type {{ box: Box, cls: Cls | 'middle' | '', s: St }[]} */
    const atoms = [{ box: del(open), cls: 'open', s }];
    moveToken(atoms[0].box, mark);
    for (const p of parts) atoms.push({ box: p, cls: '', s });
    atoms.push({ box: del(close), cls: 'close', s });
    return joinAtoms(atoms);
  };
  /** \left…\middle…\right: the inner lists are laid out as one math list between the delimiters. @param {Extract<Node, { kind: 'fenced' }>} n @param {St} s */
  const fenced = (n, s) => {
    // The delimiters are atoms of the same list as the parts (TeX: \left is an Open, \right a Close,
    // so spacing and Bin rules see them); the parts' boxes are built first to know the stretch size.
    /** @type {{ box: Box, cls: Cls | 'middle' | '', s: St }[]} */
    const atoms = [];
    /** @type {number[]} */
    const slots = [];
    /** @type {number[]} */
    const ends = [];
    const mark = tokens.length;
    let Ua = 0, Ud = 0;
    n.parts.forEach((p, i) => {
      if (i > 0) { slots.push(atoms.length); atoms.push({ box: empty(), cls: 'middle', s }); ends.push(tokens.length); }
      const items = p.kind === 'row' ? p.items : [p];
      let st = s;
      for (const it of items) {
        if (it.kind === 'style') { st = { level: { D: 0, T: 1, S: 2, SS: 3 }[it.style], cramped: st.cramped }; continue; }
        const b = node(it, st);
        if (b.ink.length || b.w) { Ua = Math.max(Ua, b.h); Ud = Math.max(Ud, b.d); }
        atoms.push({ box: b, cls: it.kind === 'space' ? '' : clsOf(it), s: st });
      }
    });
    const del = (/** @type {number} */ cp) => (cp ? token('mo', n.at, stretchV(gidOf(cp, n.at), Ua, Ud, s, true)) : { ...empty(), w: 0.12 * font.unitsPerEm });
    // Tokens in MathML order: open, content, each middle after its part, close.
    const open = del(n.open);
    moveToken(open, mark);
    slots.forEach((at, i) => { atoms[at].box = del(n.middles[i]); moveToken(atoms[at].box, ends[i] + 1 + i); });
    const close = del(n.close);
    return joinAtoms([{ box: open, cls: 'open', s }, ...atoms, { box: close, cls: 'close', s }]);
  };
  /** Move a box's token to index i of the token list (delimiters are built after their content). @param {Box} b @param {number} i */
  const moveToken = (b, i) => {
    const t = /** @type {Box & { tok?: Token }} */ (b).tok;
    const j = t ? tokens.indexOf(t) : -1;
    if (j > i) { tokens.splice(j, 1); tokens.splice(i, 0, /** @type {Token} */ (t)); }
  };

  /** Accents (MathML Core §3.4.2.4 with accent="true"; attachment by the OpenType top accent points). @param {Extract<Node, { kind: 'accent' }>} n @param {St} s */
  const accent = (n, s) => {
    const base = node(n.base, cramp(s));
    const gid = gidOf(n.cp, n.at), k = kOf(s);
    const acc = token('mo', n.at, n.stretchy ? stretch(gid, base.w, k, false) : glyphBox(gid, k));
    const at = base.gid >= 0 && !Number.isNaN(base.ta) ? base.ta : base.w / 2;
    const aa = Number.isNaN(acc.ta) ? acc.w / 2 : acc.ta;
    const shift = Math.max(0, c('AccentBaseHeight', s) - base.h);
    const y = base.h + shift + acc.d;
    const x0 = Math.min(0, at - aa), w = Math.max(base.w, at - aa + acc.w) - x0;
    return compose({ w, h: Math.max(base.h, y + acc.h), d: base.d, ic: base.ic, gid: -1 }, [{ box: base, x: -x0, y: 0 }, { box: acc, x: at - aa - x0, y }]);
  };
  /** \overline, \underline (TeX rules 9 and 10, with the OpenType overbar/underbar constants). @param {Extract<Node, { kind: 'line' }>} n @param {St} s */
  const line = (n, s) => {
    const base = node(n.base, n.under ? s : cramp(s));
    if (n.under) {
      const t = c('UnderbarRuleThickness', s), y = -base.d - c('UnderbarVerticalGap', s) - t;
      return compose({ w: base.w, h: base.h, d: -y + c('UnderbarExtraDescender', s) }, [{ box: base, x: 0, y: 0 }, { box: rule(base.w, t), x: 0, y }]);
    }
    const t = c('OverbarRuleThickness', s), y = base.h + c('OverbarVerticalGap', s);
    return compose({ w: base.w, h: y + t + c('OverbarExtraAscender', s), d: base.d }, [{ box: base, x: 0, y: 0 }, { box: rule(base.w, t), x: 0, y }]);
  };
  /** \overbrace, \underbrace: a horizontally stretched brace over or under the base (an Op; its scripts are limits). @param {Extract<Node, { kind: 'brace' }>} n @param {St} s */
  const brace = (n, s) => {
    const base = node(n.base, s);
    const br = token('mo', n.at, stretch(gidOf(n.cp, n.at), base.w, kOf(s), false));
    return n.under ? limitsBox(base, null, br, s) : limitsBox(base, br, null, s);
  };
  /** \overset, \underset, \stackrel (MathML munder/mover, not accents). @param {Extract<Node, { kind: 'stack' }>} n @param {St} s */
  const stack = (n, s) => {
    const base = node(n.base, s);
    const under = n.under ? node(n.under, sub(s)) : null;
    return limitsBox(base, n.over ? node(n.over, sup(s)) : null, under, s);
  };
  /**
   * Matrices and cases (amsmath: cells in text style, columns 2 × \arraycolsep = 1 em apart and
   * centred, cases left-aligned with a quad; rows at least a strut, 0.7/0.3 of 1.2 em; centred on the axis).
   * @param {Extract<Node, { kind: 'matrix' }>} n @param {St} s
   */
  const matrix = (n, s) => {
    const cs = n.small ? { level: Math.max(2, s.level), cramped: s.cramped } : { level: Math.max(1, s.level), cramped: s.cramped };
    const mark = tokens.length, e = em(cs), cells = n.rows.map((r) => r.map((x) => node(x, cs)));
    const cols = Math.max(...cells.map((r) => r.length));
    const colW = Array.from({ length: cols }, (_, j) => Math.max(0, ...cells.map((r) => (r[j] ? r[j].w : 0))));
    const sep = n.cases ? e : n.small ? e / 3 : e;
    const rows = cells.map((r) => ({ h: Math.max(0.84 * e, ...r.map((b) => b.h)), d: Math.max(0.36 * e, ...r.map((b) => b.d)) }));
    const total = rows.reduce((a, r) => a + r.h + r.d, 0);
    /** @type {{ box: Box, x: number, y: number }[]} */
    const kids = [];
    let y = total / 2 + c('AxisHeight', s);
    cells.forEach((r, i) => {
      y -= rows[i].h;
      let x = 0;
      r.forEach((b, j) => { kids.push({ box: b, x: n.cases ? x : x + (colW[j] - b.w) / 2, y }); x += colW[j] + sep; });
      y -= rows[i].d;
    });
    const w = colW.reduce((a, b) => a + b, 0) + sep * (cols - 1);
    const core = compose({ w, h: total / 2 + c('AxisHeight', s), d: total / 2 - c('AxisHeight', s) }, kids);
    return n.open || n.close ? fencedBoxes(n.open, n.close, [core], s, n.at, mark) : core;
  };

  const st = { level: display ? 0 : 1, cramped: false };
  const root = node(ast, st);
  if (fault) return err(fault);
  // Flatten to absolute positions; tokens get their x from the walk.
  /** @type {MathBox['glyphs']} */
  const glyphs = [];
  /** @type {MathBox['rules']} */
  const rules = [];
  /** @param {Box} b @param {number} ox @param {number} oy */
  const walk = (b, ox, oy) => {
    const tk = /** @type {Box & { tok?: Token }} */ (b).tok;
    if (tk) { tk.x = ox; tk.top += oy; tk.bottom += oy; }
    for (const i of b.ink) {
      if (i.t === 'g') glyphs.push({ gid: i.gid, x: ox + i.x, y: oy + i.y, k: i.k });
      else if (i.t === 'r') rules.push({ x: ox + i.x, y: oy + i.y, w: i.w, h: i.h });
      else walk(i.box, ox + i.x, oy + i.y);
    }
  };
  walk(root, 0, 0);
  return ok({ width: root.w + root.ic, ascent: root.h, descent: root.d, glyphs, rules, tokens });
}
