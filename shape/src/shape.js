// @ts-check
// Text -> positioned glyph run. Pure at the boundary: shape(font, text) has no
// effects and returns a fresh value. Inside, one local mutable buffer, because
// OpenType lookups are specified as in-place edits of a glyph stream; mirroring
// that keeps this checkable line-by-line against HarfBuzz.
//
// Coverage: GSUB 1-8 (all), GPOS 1, 2, 7, 8. GPOS 3-6 (cursive, mark
// attachment) are counted as skipped, never silently applied wrong.

import { variants, ok, err } from '../../otel-compact/src/adt.js';
import { parseKern, applyKern } from './kern.js';
import { CCC_RANGES } from './ccc-data.js';
import { NOOP_SPAN } from '../../otel-compact/src/trace.js';
import { u16, i16, guard, times } from '../../sfnt/src/bin.js';
import { coverageView, classView, parseGdef, parseLayout, selectLookups, EMPTY_GDEF } from './layout.js';

/** @typedef {{ gid: number, cluster: number, ax: number, ay: number, dx: number, dy: number }} PositionedGlyph */
/** A glyph while shaping: the output fields plus internal state, stripped before returning. @typedef {PositionedGlyph & { k: number, chain: number, atype: number }} WorkGlyph */
const SYNTH_MARK = /^\p{Mn}$/u, DEFAULT_IGNORABLE = /^\p{Default_Ignorable_Code_Point}$/u;
const UNICODE_MARK = /^\p{M}$/u, PICTOGRAPHIC = /^\p{Extended_Pictographic}$/u;
const isRI = (/** @type {number} */ cp) => cp >= 0x1f1e6 && cp <= 0x1f1ff;

/** HarfBuzz's modified combining class of a codepoint (0 for most). @param {number} cp */
export function combiningClass(cp) {
  let lo = 0, hi = CCC_RANGES.length / 3 - 1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1, a = CCC_RANGES[3 * m], b = CCC_RANGES[3 * m + 1];
    if (cp < a) hi = m - 1; else if (cp > b) lo = m + 1; else return CCC_RANGES[3 * m + 2];
  }
  return 0;
}

/**
 * Canonical ordering of marks (UAX #15), as HarfBuzz does it in normalisation: each run of
 * characters with a non-zero combining class, if at most 32 long, is insertion-sorted by class
 * (stable), and the clusters over each moved range are merged to their minimum.
 * @param {WorkGlyph[]} buf @param {number[]} ccc combining class per entry
 */
function reorderMarks(buf, ccc) {
  for (let i = 0; i < buf.length; i++) {
    if (!ccc[i]) continue;
    let end = i + 1;
    while (end < buf.length && ccc[end]) end++;
    if (end - i <= 32) {
      for (let a = i + 1; a < end; a++) {
        let j = a;
        while (j > i && ccc[j - 1] > ccc[a]) j--;
        if (j === a) continue;
        const cl = Math.min(...buf.slice(j, a + 1).map((g) => g.cluster));
        for (let k = j; k <= a; k++) buf[k].cluster = cl;
        buf.splice(j, 0, ...buf.splice(a, 1));
        ccc.splice(j, 0, ...ccc.splice(a, 1));
      }
    }
    i = end - 1;
  }
}

/**
 * Grapheme clusters, as HarfBuzz forms them by default (cluster level 0: hb_set_unicode_props +
 * hb_form_clusters). A character continues the previous cluster if it is a mark (Mn, Mc, Me), an
 * emoji modifier, a ZWJ (and the pictograph after it), the second of a regional-indicator pair,
 * U+FF9E–FF9F, or a tag. Each grapheme takes the cluster of its first character.
 * @param {string[]} chars @returns {number[]} cluster per character
 */
export function graphemeClusters(chars) {
  const cont = new Array(chars.length).fill(false);
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i], cp = /** @type {number} */ (ch.codePointAt(0));
    if (cp < 0x80) continue;
    if (UNICODE_MARK.test(ch) || (cp >= 0x1f3fb && cp <= 0x1f3ff) || (cp >= 0xff9e && cp <= 0xff9f) || (cp >= 0xe0020 && cp <= 0xe007f)) cont[i] = true;
    else if (i && isRI(cp)) { if (isRI(/** @type {number} */ (chars[i - 1].codePointAt(0))) && !cont[i - 1]) cont[i] = true; }
    else if (cp === 0x200d) { cont[i] = true; if (i + 1 < chars.length && PICTOGRAPHIC.test(chars[i + 1])) cont[++i] = true; }
  }
  const out = new Array(chars.length);
  for (let i = 0, start = 0; i < chars.length; i++) { if (!cont[i]) start = i; out[i] = start; }
  return out;
}

// HarfBuzz's default horizontal feature set for simple scripts (hb-ot-shape.cc).
export const DEFAULT_GSUB = Object.freeze(new Set(['rvrn', 'ccmp', 'locl', 'rlig', 'calt', 'clig', 'liga', 'rclt']));
export const DEFAULT_GPOS = Object.freeze(new Set(['kern', 'mark', 'mkmk', 'curs', 'dist', 'abvm', 'blwm']));

export const Skipped = variants('Skipped', { Lookup: ['table', 'index', 'type', 'format'] });

/** @typedef {{ v: import('../../sfnt/src/bin.js').View, lookups: import('./layout.js').Lookup[] }} Tbl */

/**
 * Parse a font's layout tables once (memoised by font identity). A table that
 * is present but unparseable is an Err, never a silent "no shaping".
 * @param {import('../../sfnt/src/font.js').Font} font
 * @param {import('../../otel-compact/src/trace.js').Span} [span]
 * @returns {import('../../otel-compact/src/adt.js').Result<{ gsub: import('./layout.js').LayoutTable | null, gpos: import('./layout.js').LayoutTable | null, gdef: import('./layout.js').Gdef, kern: import('./kern.js').Kerner[] }, any>}
 */
export function prepare(font, span = NOOP_SPAN) {
  const hit = prepared.get(font);
  if (hit) return hit;
  const gsubB = font.tables.get('GSUB'), gposB = font.tables.get('GPOS'), gdefB = font.tables.get('GDEF');
  const gsub = gsubB ? span.span('layout.parse.gsub', { bytes: gsubB.length }, (ps) => parseLayout(gsubB, 'GSUB', ps)) : ok(null);
  const gpos = gposB ? span.span('layout.parse.gpos', { bytes: gposB.length }, (ps) => parseLayout(gposB, 'GPOS', ps)) : ok(null);
  const gdef = gdefB ? span.span('layout.parse.gdef', { bytes: gdefB.length }, () => parseGdef(gdefB)) : ok(EMPTY_GDEF);
  const kernB = font.tables.get('kern');
  const kern = kernB ? span.span('layout.parse.kern', { bytes: kernB.length }, () => parseKern(kernB)) : ok(/** @type {import('./kern.js').Kerner[]} */ ([]));
  const r = gsub.tag === 'Err' ? gsub : gpos.tag === 'Err' ? gpos : gdef.tag === 'Err' ? gdef : kern.tag === 'Err' ? kern
    : ok({ gsub: gsub.value, gpos: gpos.value, gdef: gdef.value, kern: kern.value });
  prepared.set(font, r);
  return r;
}
const prepared = new WeakMap();

/**
 * @param {import('../../sfnt/src/font.js').Font} font
 * @param {string} text
 * @param {{ gsubFeatures?: ReadonlySet<string>, gposFeatures?: ReadonlySet<string>, span?: import('../../otel-compact/src/trace.js').Span }} [opts]
 * @returns {import('../../otel-compact/src/adt.js').Result<PositionedGlyph[], any>}
 */
export function shape(font, text, { gsubFeatures = DEFAULT_GSUB, gposFeatures = DEFAULT_GPOS, span = NOOP_SPAN } = {}) {
  return span.span('shape', { chars: text.length }, (s) => {
    const p = s.span('shape.prepare', (ps) => prepare(font, ps));
    if (p.tag === 'Err') { s.fail(JSON.stringify(p.error)); return err(p.error); }
    const { gsub, gpos, gdef, kern } = p.value;
    /** @type {WorkGlyph[]} */
    const buf = s.span('shape.cmap', { atomic: true, items: text.length }, () =>
      ((chars) => { const cl = graphemeClusters(chars); return chars.map((ch, i) => ({ gid: font.glyphOf(/** @type {number} */ (ch.codePointAt(0))), cluster: cl[i], ax: 0, ay: 0, dx: 0, dy: 0,
        // Internal: synthesised glyph class (HarfBuzz hb_synthesize_glyph_classes: a mark iff the
        // character is general category Mn and not default-ignorable), used when GDEF has no
        // GlyphClassDef; and the GPOS attachment chain (relative index) and type, 1 mark, 2 cursive.
        k: SYNTH_MARK.test(ch) && !DEFAULT_IGNORABLE.test(ch) ? 3 : 1, chain: 0, atype: 0 })); })([...text]));
    // Normalisation is otherwise not done (no decomposition or composition); marks are put in
    // canonical order, which decides which mark stacks on which.
    s.span('shape.reorder', { atomic: true, items: buf.length }, () => reorderMarks(buf, [...text].map((ch) => combiningClass(/** @type {number} */ (ch.codePointAt(0))))));
    /** @type {any[]} */
    const skipped = [];
    const scripts = ['latn', 'DFLT', 'dflt'];

    if (gsub) s.span('shape.gsub', (gs) => {
      const { sel, ctx } = gs.span('gsub.select', () => ({ sel: selectLookups(gsub, scripts, gsubFeatures), ctx: context(gsub, gdef, buf, 'GSUB', skipped) }));
      gs.set('features', sel.features);
      gs.set('lookups', sel.lookups.length);
      for (const l of sel.lookups) traceLookup(gs, ctx, l);
    });
    s.span('shape.advances', { atomic: true, items: buf.length }, () => { for (const g of buf) g.ax = font.advance(g.gid); });
    for (const g of buf) { g.chain = 0; g.atype = 0; } // position_start
    const klassAt = (/** @type {number} */ i) => (gdef.hasClasses ? gdef.glyphClass(buf[i].gid) : buf[i].k);
    if (gpos) s.span('shape.gpos', (gs) => {
      const { sel, ctx } = gs.span('gpos.select', () => ({ sel: selectLookups(gpos, scripts, gposFeatures), ctx: context(gpos, gdef, buf, 'GPOS', skipped) }));
      gs.set('features', sel.features);
      gs.set('lookups', sel.lookups.length);
      for (const l of sel.lookups) traceLookup(gs, ctx, l);
    });
    // Legacy 'kern', as HarfBuzz: only when GPOS does not kern (no GPOS, or no 'kern' feature),
    // and only when kerning is requested.
    if (kern.length && gposFeatures.has('kern') && !(gpos && gpos.features.some((f) => f.tag === 'kern'))) {
      s.span('shape.kern', { atomic: true, items: buf.length }, () => applyKern(kern, buf, (i) => klassAt(i) === 3));
    }
    s.span('shape.finish', { atomic: true, items: buf.length }, () => finishPositions(buf, klassAt, !!(gpos && gpos.lookups.length)));
    if (skipped.length) s.set('skippedSubtables', skipped.length);
    s.set('glyphs', buf.length);
    return ok(buf.map((g) => ({ gid: g.gid, cluster: g.cluster, ax: g.ax, ay: g.ay, dx: g.dx, dy: g.dy })));
  });
}

// ---------------------------------------------------------------------------

/**
 * Work limits for one shape() call, as HarfBuzz sets them: operations max(16384, 64·len),
 * buffer length max(8192, 32·len), nested lookups 8 deep. A hostile GSUB/GPOS can then cost
 * at most a bounded amount; past it, shaping stops and keeps what it has.
 */
export const SHAPE_LIMITS = Object.freeze({ opsPerGlyph: 64, minOps: 16384, growth: 32, minLen: 8192, nesting: 8 });
/**
 * @param {import('./layout.js').LayoutTable} t
 * @param {import('./layout.js').Gdef} gdef
 * @param {WorkGlyph[]} buf
 * @param {'GSUB' | 'GPOS'} table
 * @param {any[]} skipped
 */
function context(t, gdef, buf, table, skipped) {
  /** @type {Map<number, ReturnType<typeof coverageView>>} */
  const covCache = new Map();
  /** @type {Map<number, (g: number) => number>} */
  const clsCache = new Map();
  const L = SHAPE_LIMITS;
  return {
    v: t.v, lookups: t.lookups, gdef, buf, table, skipped,
    ops: Math.max(L.minOps, L.opsPerGlyph * buf.length), maxLen: Math.max(L.minLen, L.growth * buf.length), depth: 0,
    /** Why shaping stopped early ('' = it did not): a budget, as a value. */
    stopped: '',
    /** Glyph class at buffer position i: GDEF's when it has classes, else the synthesised one. */
    klass: (/** @type {number} */ i) => (gdef.hasClasses ? gdef.glyphClass(buf[i].gid) : buf[i].k),
    cov: (/** @type {number} */ o) => { let c = covCache.get(o); if (!c) covCache.set(o, (c = coverageView(t.v, o))); return c; },
    cls: (/** @type {number} */ o) => { let c = clsCache.get(o); if (!c) clsCache.set(o, (c = classView(t.v, o))); return c; },
  };
}
/** @typedef {ReturnType<typeof context>} Ctx */

/** LookupFlag filtering (OpenType "Lookup Table", LookupFlag bit enumeration). */
function ignored(/** @type {Ctx} */ c, /** @type {import('./layout.js').Lookup} */ l, /** @type {number} */ i) {
  const gid = c.buf[i].gid, k = c.klass(i);
  if ((l.flag & 0x2) && k === 1) return true;
  if ((l.flag & 0x4) && k === 2) return true;
  if ((l.flag & 0x8) && k === 3) return true;
  if (k === 3) {
    // UseMarkFilteringSet: skip marks outside the set; a set index past the table skips all marks.
    if (l.flag & 0x10) { const ms = c.gdef.markSets; return !(l.markSet < ms.length && ms[l.markSet].has(gid)); }
    const t = l.flag >> 8;
    if (t && c.gdef.markAttachClass(gid) !== t) return true;
  }
  return false;
}
const next = (/** @type {Ctx} */ c, /** @type {import('./layout.js').Lookup} */ l, /** @type {number} */ i) => {
  for (let j = i + 1; j < c.buf.length; j++) if (!ignored(c, l, j)) return j;
  return -1;
};
const prev = (/** @type {Ctx} */ c, /** @type {import('./layout.js').Lookup} */ l, /** @type {number} */ i) => {
  for (let j = i - 1; j >= 0; j--) if (!ignored(c, l, j)) return j;
  return -1;
};

/**
 * One span per lookup, with how many positions it changed. Untrusted fonts: each lookup is a
 * transaction. It runs inside a fault scope over a snapshot of the buffer; if any read was out of
 * range, the buffer is restored and the lookup recorded in `skipped` as malformed. An exhausted
 * budget stops all further lookups but keeps the work done so far.
 * @param {import('../../otel-compact/src/trace.js').Span} span @param {Ctx} c @param {import('./layout.js').Lookup} l
 */
function traceLookup(span, c, l) {
  if (c.stopped) return;
  span.span(`${c.table.toLowerCase()}.lookup`, { atomic: true, index: l.index, type: l.type, subtables: l.subtables.length, items: c.buf.length }, (ls) => {
    const before = c.buf.map((g) => ({ ...g }));
    const r = guard(() => runLookup(c, l), (f) => f);
    if (r.tag === 'Err') {
      c.buf.length = 0;
      for (const g of before) c.buf.push(g);
      c.skipped.push(Skipped.Lookup(c.table, l.index, l.type, 'malformed'));
      ls.set('malformed', true);
      return;
    }
    if (c.stopped) { c.skipped.push(Skipped.Lookup(c.table, l.index, l.type, `budget: ${c.stopped}`)); ls.set('budget', c.stopped); }
    if (ls.recording) ls.set('applied', r.value);
  });
}

/** @param {Ctx} c @param {import('./layout.js').Lookup} l */
function runLookup(c, l) {
  let applied = 0;
  if (c.table === 'GSUB' && l.type === 8) {
    for (let i = c.buf.length - 1; i >= 0 && !c.stopped; i--) if (!ignored(c, l, i) && applyAt(c, l, i) !== -1) applied++;
    return applied;
  }
  let i = 0;
  while (i < c.buf.length && !c.stopped) {
    if (ignored(c, l, i)) { i++; continue; }
    const r = applyAt(c, l, i);
    if (r >= 0) applied++;
    i = r < 0 ? i + 1 : r;
  }
  return applied;
}

/** First subtable that applies wins. Returns the next index, or -1. @param {Ctx} c @param {import('./layout.js').Lookup} l @param {number} i */
function applyAt(c, l, i) {
  if (--c.ops < 0) { c.stopped = 'operations'; return -1; }
  if (c.buf.length > c.maxLen) { c.stopped = 'buffer length'; return -1; }
  for (const off of l.subtables) {
    const r = c.table === 'GSUB' ? gsubSubtable(c, l, off, i) : gposSubtable(c, l, off, i);
    if (r >= 0) return r;
  }
  return -1;
}

/** @param {Ctx} c @param {import('./layout.js').Lookup} l @param {number} off */
const skip = (c, l, off) => { c.skipped.push(Skipped.Lookup(c.table, l.index, l.type, u16(c.v, off))); return -1; };

// ---------------------------------------------------------------------------
// GSUB

/** @param {Ctx} c @param {import('./layout.js').Lookup} l @param {number} off @param {number} i */
function gsubSubtable(c, l, off, i) {
  const { v, buf } = c;
  const fmt = u16(v, off);
  const g = buf[i].gid;
  switch (l.type) {
    case 1: {
      const ci = c.cov(off + u16(v, off + 2)).get(g);
      if (ci < 0) return -1;
      buf[i].gid = fmt === 1 ? (g + i16(v, off + 4)) & 0xffff : u16(v, off + 6 + ci * 2);
      return i + 1;
    }
    case 2: case 3: {
      const ci = c.cov(off + u16(v, off + 2)).get(g);
      if (ci < 0) return -1;
      const seq = off + u16(v, off + 6 + ci * 2);
      const n = u16(v, seq);
      const gids = times(n, (k) => u16(v, seq + 2 + k * 2));
      if (l.type === 3) { if (n) buf[i].gid = gids[0]; return i + 1; } // feature value 1 = first alternate
      buf.splice(i, 1, ...gids.map((gid) => ({ ...buf[i], gid })));
      return i + n;
    }
    case 4: {
      const ci = c.cov(off + u16(v, off + 2)).get(g);
      if (ci < 0) return -1;
      const set = off + u16(v, off + 6 + ci * 2);
      for (let k = 0, n = u16(v, set); k < n; k++) {
        const lig = set + u16(v, set + 2 + k * 2);
        const ligGlyph = u16(v, lig), comps = u16(v, lig + 2);
        /** @type {number[]} */
        const pos = [i];
        for (let m = 1; m < comps; m++) {
          const j = next(c, l, pos[pos.length - 1]);
          if (j < 0 || buf[j].gid !== u16(v, lig + 4 + (m - 1) * 2)) break;
          pos.push(j);
        }
        if (pos.length !== comps) continue;
        const cluster = Math.min(...buf.slice(i, pos[pos.length - 1] + 1).map((x) => x.cluster));
        for (let k2 = i; k2 <= pos[pos.length - 1]; k2++) buf[k2].cluster = cluster;
        buf[i].gid = ligGlyph;
        buf[i].k = 2; // HarfBuzz's class guess for a ligature (used when GDEF has no classes)
        for (const j of pos.slice(1).reverse()) buf.splice(j, 1);
        return i + 1;
      }
      return -1;
    }
    case 5: case 6: return contextual(c, l, off, i, l.type === 6);
    case 8: {
      const ci = c.cov(off + u16(v, off + 2)).get(g);
      if (ci < 0) return -1;
      const nb = u16(v, off + 4);
      const back = times(nb, (k) => off + u16(v, off + 6 + k * 2));
      const la = off + 6 + nb * 2;
      const nl = u16(v, la);
      const ahead = times(nl, (k) => off + u16(v, la + 2 + k * 2));
      if (!matchCoverages(c, l, i, back, -1) || !matchCoverages(c, l, i, ahead, +1)) return -1;
      buf[i].gid = u16(v, la + 2 + nl * 2 + 2 + ci * 2);
      return i - 1;
    }
    default: return skip(c, l, off);
  }
}

// ---------------------------------------------------------------------------
// GPOS

/** ValueRecord: returns [record, byteLength]. @param {Ctx} c @param {number} o @param {number} fmt */
function valueRecord(c, o, fmt) {
  const r = { dx: 0, dy: 0, ax: 0, ay: 0 };
  let p = o;
  if (fmt & 0x1) { r.dx = i16(c.v, p); p += 2; }
  if (fmt & 0x2) { r.dy = i16(c.v, p); p += 2; }
  if (fmt & 0x4) { r.ax = i16(c.v, p); p += 2; }
  if (fmt & 0x8) { r.ay = i16(c.v, p); p += 2; }
  for (const bit of [0x10, 0x20, 0x40, 0x80]) if (fmt & bit) p += 2; // device/variation tables: ignored at this scale
  return /** @type {const} */ ([r, p - o]);
}
const vrSize = (/** @type {number} */ fmt) => { let n = 0; for (let b = fmt & 0xff; b; b >>= 1) n += b & 1; return n * 2; };
/** @param {PositionedGlyph} g @param {{dx:number,dy:number,ax:number,ay:number}} r */
const addValue = (g, r) => { g.dx += r.dx; g.dy += r.dy; g.ax += r.ax; g.ay += r.ay; };

/** @param {Ctx} c @param {import('./layout.js').Lookup} l @param {number} off @param {number} i */
function gposSubtable(c, l, off, i) {
  const { v, buf } = c;
  const fmt = u16(v, off);
  const g = buf[i].gid;
  switch (l.type) {
    case 1: {
      const ci = c.cov(off + u16(v, off + 2)).get(g);
      if (ci < 0) return -1;
      const vf = u16(v, off + 4);
      const at = fmt === 1 ? off + 6 : off + 8 + ci * vrSize(vf);
      addValue(buf[i], valueRecord(c, at, vf)[0]);
      return i + 1;
    }
    case 2: {
      const ci = c.cov(off + u16(v, off + 2)).get(g);
      if (ci < 0) return -1;
      const j = next(c, l, i);
      if (j < 0) return -1;
      const vf1 = u16(v, off + 4), vf2 = u16(v, off + 6);
      const s1 = vrSize(vf1), s2 = vrSize(vf2);
      let rec = -1;
      if (fmt === 1) {
        const set = off + u16(v, off + 10 + ci * 2);
        const n = u16(v, set), stride = 2 + s1 + s2;
        let lo = 0, hi = n - 1;
        while (lo <= hi) {
          const m = (lo + hi) >> 1, second = u16(v, set + 2 + m * stride);
          if (second === buf[j].gid) { rec = set + 2 + m * stride + 2; break; }
          if (second < buf[j].gid) lo = m + 1; else hi = m - 1;
        }
      } else if (fmt === 2) {
        const k1 = c.cls(off + u16(v, off + 8))(g), k2 = c.cls(off + u16(v, off + 10))(buf[j].gid);
        const n1 = u16(v, off + 12), n2 = u16(v, off + 14);
        if (k1 < n1 && k2 < n2) rec = off + 16 + (k1 * n2 + k2) * (s1 + s2);
      } else return skip(c, l, off);
      if (rec < 0) return -1;
      addValue(buf[i], valueRecord(c, rec, vf1)[0]);
      addValue(buf[j], valueRecord(c, rec + s1, vf2)[0]);
      return vf2 ? j + 1 : j;
    }
    case 3: return cursive(c, l, off, i);
    case 4: case 5: case 6: return markAttach(c, l, off, i);
    case 7: case 8: return contextual(c, l, off, i, l.type === 8);
    default: return skip(c, l, off);
  }
}

// ---------------------------------------------------------------------------
// GPOS 3–6: cursive and mark attachment, ported from HarfBuzz (src/OT/Layout/GPOS/*.hh at
// cb56bae: CursivePosFormat1, MarkBasePosFormat1, MarkLigPosFormat1, MarkMarkPosFormat1,
// MarkArray, propagate_attachment_offsets). Anchors of every format resolve to (x, y) here:
// formats 2 and 3 only differ under hinting (ppem) or at non-default variation coordinates.
// Ligature-component tracking is not kept, so a mark on a ligature attaches to its last
// component (HarfBuzz's choice when the mark's ligature id does not match).

/** Anchor (x, y) at an absolute offset, or null when the offset is 0 (no anchor). */
const anchor = (/** @type {Ctx} */ c, /** @type {number} */ at) => (at ? [i16(c.v, at + 2), i16(c.v, at + 4)] : null);

/** Previous position whose class is not mark (LookupFlag IgnoreMarks, nothing else), or -1. */
const prevNonMark = (/** @type {Ctx} */ c, /** @type {number} */ i) => { for (let j = i - 1; j >= 0; j--) if (c.klass(j) !== 3) return j; return -1; };

/** @param {Ctx} c @param {import('./layout.js').Lookup} l @param {number} off @param {number} i */
function markAttach(c, l, off, i) {
  const { v, buf } = c;
  if (u16(v, off) !== 1) return skip(c, l, off);
  const mi = c.cov(off + u16(v, off + 2)).get(buf[i].gid);
  if (mi < 0) return -1;
  const classCount = u16(v, off + 6), markArray = off + u16(v, off + 8), baseArrayOff = off + u16(v, off + 10);
  let j = -1, row = 0;
  if (l.type === 4 || l.type === 5) {
    j = prevNonMark(c, i);
    if (j < 0) return -1;
    const bi = c.cov(off + u16(v, off + 4)).get(buf[j].gid);
    if (bi < 0) return -1;
    if (l.type === 4) row = baseArrayOff + 2 + bi * classCount * 2;
    else {
      const attach = baseArrayOff + u16(v, baseArrayOff + 2 + bi * 2), comps = u16(v, attach);
      if (!comps) return -1;
      row = attach + 2 + (comps - 1) * classCount * 2; // last component (see above)
      return attachMark(c, markArray, mi, attach, row, classCount, i, j);
    }
    return attachMark(c, markArray, mi, baseArrayOff, row, classCount, i, j);
  }
  // MarkToMark: the previous glyph under the lookup's flags minus the Ignore* bits, which must be a mark.
  const flags = { ...l, flag: l.flag & ~0x0e };
  j = prev(c, flags, i);
  if (j < 0 || c.klass(j) !== 3) return -1;
  const m2 = c.cov(off + u16(v, off + 4)).get(buf[j].gid);
  if (m2 < 0) return -1;
  return attachMark(c, markArray, mi, baseArrayOff, baseArrayOff + 2 + m2 * classCount * 2, classCount, i, j);
}

/**
 * MarkArray::apply + apply_mark_attachment: the mark's class picks the base anchor in `row`
 * (offsets relative to `base`); no anchor there means this subtable does not apply.
 * @param {Ctx} c @param {number} markArray @param {number} mi @param {number} base @param {number} row
 * @param {number} classCount @param {number} i @param {number} j
 */
function attachMark(c, markArray, mi, base, row, classCount, i, j) {
  const { v, buf } = c;
  const rec = markArray + 2 + mi * 4, klass = u16(v, rec);
  if (klass >= classCount) return -1;
  const markOff = u16(v, rec + 2);
  const markA = anchor(c, markOff ? markArray + markOff : 0);
  const baseOff = u16(v, row + klass * 2);
  const baseA = anchor(c, baseOff ? base + baseOff : 0);
  if (!markA || !baseA) return -1;
  // Cross-direction offset of the base, accumulated along its cursive chain (resolve_cross_offset).
  let cross = buf[j].dy;
  for (let k = j, n = 0; buf[k].atype === 2 && buf[k].chain && n < 64; n++) { k += buf[k].chain; if (k < 0 || k >= buf.length) break; cross += buf[k].dy; }
  const g = buf[i];
  g.chain = j - i; g.atype = 1;
  g.dx = Math.round(baseA[0] - markA[0]);
  g.dy = Math.round(baseA[1] - markA[1]) + cross;
  return i + 1;
}

/** CursivePosFormat1 + apply_cursive_attachment, left-to-right. @param {Ctx} c @param {import('./layout.js').Lookup} l @param {number} off @param {number} i */
function cursive(c, l, off, i) {
  const { v, buf } = c;
  if (u16(v, off) !== 1) return skip(c, l, off);
  const cov = c.cov(off + u16(v, off + 2));
  const ci = cov.get(buf[i].gid);
  if (ci < 0) return -1;
  const entryOff = u16(v, off + 6 + ci * 4);
  if (!entryOff) return -1;
  const p = prev(c, l, i);
  if (p < 0) return -1;
  const pi = cov.get(buf[p].gid);
  if (pi < 0) return -1;
  const exitOff = u16(v, off + 6 + pi * 4 + 2);
  if (!exitOff) return -1;
  const exit = /** @type {number[]} */ (anchor(c, off + exitOff)), entry = /** @type {number[]} */ (anchor(c, off + entryOff));
  // Main direction (LTR).
  buf[p].ax = Math.round(exit[0]) + buf[p].dx;
  const d = Math.round(entry[0]) + buf[i].dx;
  buf[i].ax -= d; buf[i].dx -= d;
  // Cross direction: the child aligns to its parent. Without RightToLeft the child is the later glyph.
  let child = p, parent = i, y = Math.round(entry[1] - exit[1]);
  if (!(l.flag & 0x1)) { child = i; parent = p; y = -y; }
  reverseCursive(buf, child, parent, 0);
  buf[child].chain = parent - child; buf[child].atype = 2; buf[child].dy = y;
  if (buf[parent].chain === -buf[child].chain) { buf[parent].chain = 0; buf[parent].dy = 0; }
  return i + 1;
}

/** reverse_cursive_minor_offset: re-root a child's old cursive chain at its new parent. @param {WorkGlyph[]} buf @param {number} i @param {number} newParent @param {number} depth */
function reverseCursive(buf, i, newParent, depth) {
  if (depth > 64) return;
  const chain = buf[i].chain, type = buf[i].atype;
  if (!chain || type !== 2) return;
  buf[i].chain = 0;
  const j = i + chain;
  if (j < 0 || j >= buf.length || j === newParent) return;
  reverseCursive(buf, j, newParent, depth + 1);
  buf[j].dy = -buf[i].dy;
  buf[j].chain = -chain; buf[j].atype = type;
}

/**
 * After GPOS (hb_ot_position_complex, default shaper): zero mark advances (BY_GDEF_LATE; when
 * the font has no GPOS, also shift the mark back by its advance), then turn attachment chains
 * into offsets (position_finish_offsets, forward direction).
 * @param {WorkGlyph[]} buf @param {(i: number) => number} klass @param {boolean} hadGpos
 */
function finishPositions(buf, klass, hadGpos) {
  for (let i = 0; i < buf.length; i++) if (klass(i) === 3) {
    if (!hadGpos) { buf[i].dx -= buf[i].ax; buf[i].dy -= buf[i].ay; }
    buf[i].ax = 0; buf[i].ay = 0;
  }
  for (let i = 0; i < buf.length; i++) if (buf[i].chain) propagate(buf, i, 64);
}
/** propagate_attachment_offsets (horizontal, forward). @param {WorkGlyph[]} buf @param {number} i @param {number} nesting */
function propagate(buf, i, nesting) {
  const chain = buf[i].chain, type = buf[i].atype;
  buf[i].chain = 0;
  const j = i + chain;
  if (j < 0 || j >= buf.length || !nesting) return;
  if (buf[j].chain) propagate(buf, j, nesting - 1);
  if (type === 2) { buf[i].dy += buf[j].dy; return; }
  buf[i].dx += buf[j].dx;
  if (j < i) for (let k = j; k < i; k++) { buf[i].dx -= buf[k].ax; buf[i].dy -= buf[k].ay; }
  else for (let k = i; k < j; k++) { buf[i].dx += buf[k].ax; buf[i].dy += buf[k].ay; }
}

// ---------------------------------------------------------------------------
// Sequence / chained sequence context (GSUB 5/6, GPOS 7/8), formats 1-3.

/** Match coverages walking from i in direction dir (exclusive of i). */
function matchCoverages(/** @type {Ctx} */ c, /** @type {import('./layout.js').Lookup} */ l, /** @type {number} */ i, /** @type {number[]} */ covs, /** @type {1 | -1} */ dir) {
  let j = i;
  for (const o of covs) {
    j = dir > 0 ? next(c, l, j) : prev(c, l, j);
    if (j < 0 || !c.cov(o).has(c.buf[j].gid)) return null;
  }
  return j;
}

/** Match a sequence of predicates; returns positions or null. */
function matchSeq(/** @type {Ctx} */ c, /** @type {import('./layout.js').Lookup} */ l, /** @type {number} */ i, /** @type {number} */ n, /** @type {(k: number, gid: number) => boolean} */ test, /** @type {1 | -1} */ dir) {
  const pos = [];
  let j = i;
  for (let k = 0; k < n; k++) {
    j = dir > 0 ? next(c, l, j) : prev(c, l, j);
    if (j < 0 || !test(k, c.buf[j].gid)) return null;
    pos.push(j);
  }
  return pos;
}

/**
 * @param {Ctx} c @param {import('./layout.js').Lookup} l @param {number} off @param {number} i @param {boolean} chained
 */
function contextual(c, l, off, i, chained) {
  const { v, buf } = c;
  const fmt = u16(v, off);
  const g = buf[i].gid;
  if (fmt === 1 || fmt === 2) {
    if (c.cov(off + u16(v, off + 2)).get(g) < 0) return -1;
    const id = (/** @type {number} */ x) => x;
    // Rule-set array position and the three matchers, per (format, chained).
    const [setsAt, bk, inp, la] = fmt === 1
      ? [off + 6, id, id, id]
      : chained
        ? [off + 12, c.cls(off + u16(v, off + 4)), c.cls(off + u16(v, off + 6)), c.cls(off + u16(v, off + 8))]
        : [off + 8, id, c.cls(off + u16(v, off + 4)), id];
    const key = fmt === 1 ? c.cov(off + u16(v, off + 2)).get(g) : inp(g);
    if (key >= u16(v, setsAt - 2)) return -1;
    const setOff = u16(v, setsAt + key * 2);
    if (!setOff) return -1;
    const set = off + setOff;
    /** @param {number} at @param {number} n */
    const arr = (at, n) => times(n, (k) => u16(v, at + k * 2));
    /** @param {(g: number) => number} f @param {number[]} want */
    const eq = (f, want) => (/** @type {number} */ k, /** @type {number} */ gid) => f(gid) === want[k];
    for (let r = 0, nr = u16(v, set); r < nr; r++) {
      let p = set + u16(v, set + 2 + r * 2);
      let back = /** @type {number[]} */ ([]), ahead = /** @type {number[]} */ ([]), nRec = 0;
      if (chained) { const nb = u16(v, p); back = arr(p + 2, nb); p += 2 + nb * 2; }
      const ni = u16(v, p); p += 2;
      if (!chained) { nRec = u16(v, p); p += 2; }
      const input = arr(p, ni - 1); p += (ni - 1) * 2;
      if (chained) { const na = u16(v, p); ahead = arr(p + 2, na); p += 2 + na * 2; nRec = u16(v, p); p += 2; }
      const inPos = matchSeq(c, l, i, input.length, eq(inp, input), 1);
      if (!inPos) continue;
      if (!matchSeq(c, l, i, back.length, eq(bk, back), -1)) continue;
      if (!matchSeq(c, l, inPos.length ? inPos[inPos.length - 1] : i, ahead.length, eq(la, ahead), 1)) continue;
      return applyRecords(c, l, [i, ...inPos], p, nRec);
    }
    return -1;
  }

  if (fmt === 3) {
    let p = off + 2;
    const nb = chained ? u16(v, p) : 0;
    if (chained) p += 2 + nb * 2;
    const ni = u16(v, p);
    const covAt = chained ? p + 2 : p + 4;
    // Reject on the first input coverage before building anything: most subtables
    // of a big chained lookup fail here (Inter's calt #39 has 69 of them).
    if (ni === 0 || !c.cov(off + u16(v, covAt)).has(g)) return -1;
    const nLookPlain = chained ? 0 : u16(v, p + 2);
    const back = times(nb, (k) => off + u16(v, off + 4 + k * 2));
    const input = times(ni, (k) => off + u16(v, covAt + k * 2));
    p = covAt + ni * 2;
    /** @type {number[]} */ let ahead = [];
    if (chained) { const na = u16(v, p); ahead = times(na, (k) => off + u16(v, p + 2 + k * 2)); p += 2 + na * 2; }
    const inPos = matchSeq(c, l, i, ni - 1, (k, gid) => c.cov(input[k + 1]).has(gid), 1);
    if (!inPos) return -1;
    if (chained && matchCoverages(c, l, i, back, -1) === null) return -1;
    const last = inPos.length ? inPos[inPos.length - 1] : i;
    if (chained && matchCoverages(c, l, last, ahead, 1) === null) return -1;
    return chained ? applyRecords(c, l, [i, ...inPos], p + 2, u16(v, p)) : applyRecords(c, l, [i, ...inPos], p, nLookPlain);
  }
  return skip(c, l, off);
}

/**
 * Apply SequenceLookupRecords at matched positions, adjusting for length changes.
 * Returns the index after the matched input.
 * @param {Ctx} c @param {import('./layout.js').Lookup} l @param {number[]} pos @param {number} at @param {number} n
 */
function applyRecords(c, l, pos, at, n) {
  pos = [...pos];
  let end = pos[pos.length - 1] + 1;
  for (let r = 0; r < n; r++) {
    const seq = u16(c.v, at + r * 4), li = u16(c.v, at + r * 4 + 2);
    const nested = c.lookups[li];
    if (!nested || seq >= pos.length) continue;
    if (c.depth >= SHAPE_LIMITS.nesting) continue; // a lookup calling itself, directly or not
    const before = c.buf.length;
    c.depth++;
    applyAt(c, nested, pos[seq]);
    c.depth--;
    const delta = c.buf.length - before;
    if (delta) {
      for (let k = seq + 1; k < pos.length; k++) pos[k] += delta;
      end += delta;
    }
  }
  void l;
  return end;
}
