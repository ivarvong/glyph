// @ts-check
// WOFF2 transformed 'glyf' (W3C WOFF2 §5.1–5.2) -> Glyph[].
// Mirrors google/woff2 src/woff2_dec.cc ReconstructGlyf/TripletDecode, but
// produces the shared Glyph IR directly instead of re-serialising 'glyf' bytes:
// the renderer has no use for TrueType byte layout, and the raw-glyf parser
// (sfnt/src/glyf.js) is the second producer this one is checked against.

import { ok, err, variants, some, NONE } from '../../otel-compact/src/adt.js';
import { NOOP_SPAN } from '../../otel-compact/src/trace.js';
import { view, u8, u16, i16, u32, guard } from '../../sfnt/src/bin.js';
import { Glyph, parseComponents, skipComponents } from '../../sfnt/src/glyf.js';

export const GlyfTransformError = variants('GlyfTransformError', {
  Truncated: ['stream', 'at'],
  StreamsOverflow: ['need', 'have'],
  CompositeWithoutBbox: ['glyph'],
  EmptyWithBbox: ['glyph'],
  NumGlyphs: ['header', 'expected'],
});

const STREAMS = /** @type {const} */ (['nContour', 'nPoints', 'flag', 'glyph', 'composite', 'bbox', 'instruction']);

/** First sub-stream overrun of one decode: errors as values, shared by that decode's streams. */
/** @typedef {{ stream: string, at: number }} Overrun  at = -1: none */
const noOverrun = () => /** @type {Overrun} */ ({ stream: '', at: -1 });

/**
 * A sequential reader over one sub-stream. Local mutation, pure externally: a fresh reader per
 * decode, never shared. Reading past the end records the first overrun in `rec` and yields 0
 * (through the total reads of bin.js), so the decode finishes and its boundary reports it.
 * @param {Uint8Array} bytes
 * @param {string} name
 * @param {Overrun} rec
 */
function stream(bytes, name, rec) {
  const v = view(bytes);
  let pos = 0;
  /** @param {number} n */
  const take = (n) => {
    if (pos + n > bytes.length && rec.at < 0) { rec.stream = name; rec.at = pos; }
    const at = pos;
    pos += n;
    return at;
  };
  return {
    get pos() { return pos; },
    u8: () => u8(v, take(1)),
    u16: () => u16(v, take(2)),
    i16: () => i16(v, take(2)),
    bytes: (/** @type {number} */ n) => bytes.subarray(take(n), pos),
    seek: (/** @type {number} */ p) => { pos = p; },
    /** 255UInt16 (MicroType Express §6.1.1; variable_length.cc Read255UShort). */
    u255: () => {
      const code = u8(v, take(1));
      if (code === 253) return u16(v, take(2));
      if (code === 255) return u8(v, take(1)) + 253;
      if (code === 254) return u8(v, take(1)) + 253 * 2;
      return code;
    },
    view: v,
    skip: (/** @type {number} */ n) => { take(n); },
  };
}

const BATCH = 16;

/** @param {number} flag @param {number} base */
const withSign = (flag, base) => ((flag & 1) ? base : -base);

/**
 * Triplet decoding of point deltas (spec table "Triplet Encoding").
 * @param {Uint8Array} flags  one byte per point; bit 7 set = off-curve
 * @param {ReturnType<typeof stream>} glyph
 */
export function decodeTriplets(flags, glyph) {
  const n = flags.length;
  const xs = new Int32Array(n), ys = new Int32Array(n), on = new Uint8Array(n);
  let x = 0, y = 0;
  for (let i = 0; i < n; i++) {
    const f = flags[i] & 0x7f;
    on[i] = flags[i] >> 7 ? 0 : 1;
    let dx, dy;
    if (f < 10) {
      dx = 0;
      dy = withSign(f, ((f & 14) << 7) + glyph.u8());
    } else if (f < 20) {
      dx = withSign(f, (((f - 10) & 14) << 7) + glyph.u8());
      dy = 0;
    } else if (f < 84) {
      const b0 = f - 20, b1 = glyph.u8();
      dx = withSign(f, 1 + (b0 & 0x30) + (b1 >> 4));
      dy = withSign(f >> 1, 1 + ((b0 & 0x0c) << 2) + (b1 & 0x0f));
    } else if (f < 120) {
      const b0 = f - 84, b1 = glyph.u8(), b2 = glyph.u8();
      dx = withSign(f, 1 + (Math.floor(b0 / 12) << 8) + b1);
      dy = withSign(f >> 1, 1 + (((b0 % 12) >> 2) << 8) + b2);
    } else if (f < 124) {
      const b1 = glyph.u8(), b2 = glyph.u8(), b3 = glyph.u8();
      dx = withSign(f, (b1 << 4) + (b2 >> 4));
      dy = withSign(f >> 1, ((b2 & 0x0f) << 8) + b3);
    } else {
      const b1 = glyph.u8(), b2 = glyph.u8(), b3 = glyph.u8(), b4 = glyph.u8();
      dx = withSign(f, (b1 << 8) + b2);
      dy = withSign(f >> 1, (b3 << 8) + b4);
    }
    x += dx; y += dy;
    xs[i] = x; ys[i] = y;
  }
  return { xs, ys, on };
}

/** @param {Int32Array} xs @param {Int32Array} ys */
const computeBbox = (xs, ys) => {
  if (xs.length === 0) return [0, 0, 0, 0];
  let x0 = xs[0], y0 = ys[0], x1 = xs[0], y1 = ys[0];
  for (let i = 1; i < xs.length; i++) {
    if (xs[i] < x0) x0 = xs[i]; if (xs[i] > x1) x1 = xs[i];
    if (ys[i] < y0) y0 = ys[i]; if (ys[i] > y1) y1 = ys[i];
  }
  return [x0, y0, x1, y1];
};

/**
 * Decode one glyph from streams positioned at its data. Shared by the eager
 * decoder (streams advance glyph by glyph) and the indexed one (streams seeked).
 * @param {Record<string, ReturnType<typeof stream>>} s
 * @param {number} g @param {number} nContours @param {boolean} hasBbox
 * @returns {import('../../otel-compact/src/adt.js').Result<import('../../sfnt/src/glyf.js').GlyphT, any>}
 */
function decodeOne(s, g, nContours, hasBbox) {
  if (nContours === -1) {
    if (!hasBbox) return err(GlyfTransformError.CompositeWithoutBbox(g));
    const bbox = [s.bbox.i16(), s.bbox.i16(), s.bbox.i16(), s.bbox.i16()];
    const start = s.composite.pos;
    const { components, end, hasInstructions } = parseComponents(s.composite.view, start);
    s.composite.skip(end - start);
    let instructions = 0;
    if (hasInstructions) {
      instructions = s.glyph.u255();
      s.instruction.skip(instructions);
    }
    return ok(Glyph.Composite(components, bbox, instructions));
  }
  if (nContours > 0) {
    const endPts = [];
    let total = 0;
    for (let c = 0; c < nContours; c++) {
      total += s.nPoints.u255();
      endPts.push(total - 1);
    }
    const flags = s.flag.bytes(total);
    const { xs, ys, on } = decodeTriplets(flags, s.glyph);
    const instructions = s.glyph.u255();
    s.instruction.skip(instructions);
    const bbox = hasBbox ? [s.bbox.i16(), s.bbox.i16(), s.bbox.i16(), s.bbox.i16()] : computeBbox(xs, ys);
    return ok(Glyph.Simple(endPts, xs, ys, on, bbox, instructions));
  }
  if (nContours === 0) return hasBbox ? err(GlyfTransformError.EmptyWithBbox(g)) : ok(Glyph.Empty);
  return err(GlyfTransformError.Truncated('nContour', g));
}

/** Triplet data bytes per flag value (low 7 bits), from TripletDecode. */
const TRIPLET_BYTES = Uint8Array.from({ length: 128 }, (_, f) => (f < 84 ? 1 : f < 120 ? 2 : f < 124 ? 3 : 4));

/**
 * Shared front half: header, stream split, overlap bitmap.
 * @param {Uint8Array} data @param {number} numGlyphsMaxp @param {import('../../otel-compact/src/trace.js').Span} span
 */
function splitStreams(data, numGlyphsMaxp, span) {
  const header = span.span('glyf.header', () => guard(() => {
    const v = view(data);
    const optionFlags = u16(v, 2);
    const numGlyphs = u16(v, 4);
    const indexFormat = u16(v, 6);
    const sizes = STREAMS.map((_, i) => u32(v, 8 + i * 4));
    return { optionFlags, numGlyphs, indexFormat, sizes };
  }, (e) => GlyfTransformError.Truncated('header', e.at)));
  if (header.tag === 'Err') return header;
  const { optionFlags, numGlyphs, indexFormat, sizes } = header.value;
  if (numGlyphs !== numGlyphsMaxp) return err(GlyfTransformError.NumGlyphs(numGlyphs, numGlyphsMaxp));
  let off = 8 + STREAMS.length * 4;
  /** @type {Record<string, Uint8Array>} */
  const raw = {};
  for (let i = 0; i < STREAMS.length; i++) {
    if (off + sizes[i] > data.length) return err(GlyfTransformError.StreamsOverflow(off + sizes[i], data.length));
    raw[STREAMS[i]] = data.subarray(off, off + sizes[i]);
    off += sizes[i];
  }
  /** @type {import('../../otel-compact/src/adt.js').Option<Uint8Array>} */
  let overlap = NONE;
  if (optionFlags & 1) {
    const len = (numGlyphs + 7) >> 3;
    if (off + len > data.length) return err(GlyfTransformError.StreamsOverflow(off + len, data.length));
    overlap = some(data.subarray(off, off + len));
  }
  return ok({ numGlyphs, indexFormat, raw, overlap });
}

/**
 * One decode's three error channels, in priority order, to one Result: a sub-stream overrun,
 * an out-of-range read (composite records are read in place), or a semantic failure.
 * @template T
 * @param {Overrun} rec @param {import('../../otel-compact/src/adt.js').Result<T, import('../../sfnt/src/bin.js').Fault>} r
 * @returns {import('../../otel-compact/src/adt.js').Result<T, any>}
 */
const settle = (rec, r) => {
  if (rec.at >= 0) return err(GlyfTransformError.Truncated(rec.stream, rec.at));
  if (r.tag === 'Err') return err(GlyfTransformError.Truncated('composite', r.error.at));
  return r;
};

/**
 * Indexed (lazy) decoder: one cheap pass records where each glyph's data starts
 * in every stream and checks all lengths; glyph(g) then decodes on first use.
 * A render of "Cloudflare" needs 9 of Inter's 518 glyphs.
 * @param {Uint8Array} data @param {number} numGlyphsMaxp
 * @param {import('../../otel-compact/src/trace.js').Span} [span]
 * @returns {import('../../otel-compact/src/adt.js').Result<{ glyph: (g: number) => import('../../otel-compact/src/adt.js').Result<import('../../sfnt/src/glyf.js').GlyphT, any>, numGlyphs: number, indexFormat: number, overlap: import('../../otel-compact/src/adt.js').Option<Uint8Array> }, any>}
 */
export function indexGlyfV0(data, numGlyphsMaxp, span = NOOP_SPAN) {
  const split = splitStreams(data, numGlyphsMaxp, span);
  if (split.tag === 'Err') return split;
  const { numGlyphs, indexFormat, raw, overlap } = split.value;
  const rec = noOverrun();
  const indexed = settle(rec, guard(() => span.span('glyf.index', { atomic: true, items: numGlyphs }, () => {
    const nc = view(raw.nContour), cv = view(raw.composite);
    const np255 = stream(raw.nPoints, 'nPoints', rec), gl = stream(raw.glyph, 'glyph', rec);
    const bboxLen = ((numGlyphs + 31) >> 5) << 2;
    if (bboxLen > raw.bbox.length) return err(GlyfTransformError.Truncated('bbox', 0));
    const bitmap = raw.bbox.subarray(0, bboxLen);
    const flags = raw.flag;
    const pos = new Int32Array(numGlyphs * 6); // nPoints, flag, glyph, composite, bbox, instruction
    let fc = 0, cc = 0, bc = bboxLen, ic = 0;
    for (let g = 0; g < numGlyphs; g++) {
      const hasBbox = (bitmap[g >> 3] & (0x80 >> (g & 7))) !== 0;
      const n = i16(nc, g * 2);
      const o = g * 6;
      pos[o] = np255.pos; pos[o + 1] = fc; pos[o + 2] = gl.pos; pos[o + 3] = cc; pos[o + 4] = bc; pos[o + 5] = ic;
      if (n === -1) {
        if (!hasBbox) return err(GlyfTransformError.CompositeWithoutBbox(g));
        const { end, hasInstructions } = skipComponents(cv, cc);
        cc = end;
        if (hasInstructions) ic += gl.u255();
      } else if (n > 0) {
        let total = 0;
        for (let c = 0; c < n; c++) total += np255.u255();
        if (fc + total > flags.length) return err(GlyfTransformError.Truncated('flag', fc));
        let tb = 0;
        for (let i = fc; i < fc + total; i++) tb += TRIPLET_BYTES[flags[i] & 0x7f];
        fc += total;
        gl.skip(tb);
        ic += gl.u255();
      } else if (n === 0) {
        if (hasBbox) return err(GlyfTransformError.EmptyWithBbox(g));
      } else return err(GlyfTransformError.Truncated('nContour', g));
      if (hasBbox) bc += 8;
      if (rec.at >= 0) break;
    }
    if (bc > raw.bbox.length) return err(GlyfTransformError.Truncated('bbox', bc));
    if (ic > raw.instruction.length) return err(GlyfTransformError.Truncated('instruction', ic));
    return ok({ pos, nc, bitmap });
  }), (f) => f));
  if (indexed.tag === 'Err') return indexed;
  if (indexed.value.tag === 'Err') return indexed.value;
  const { pos, nc, bitmap } = indexed.value.value;
  /** @type {Map<number, import('../../otel-compact/src/adt.js').Result<import('../../sfnt/src/glyf.js').GlyphT, any>>} */
  const memo = new Map();
  /** Lazy, memoised; a glyph whose data the index pass did not fully cover still fails as a value. @param {number} g */
  const glyph = (g) => {
    const hit = memo.get(g);
    if (hit) return hit;
    if (!(g >= 0 && g < numGlyphs)) return err(GlyfTransformError.Truncated('nContour', g));
    const grec = noOverrun();
    const s = Object.fromEntries(STREAMS.map((k) => [k, stream(raw[k], k, grec)]));
    const o = g * 6;
    s.nPoints.seek(pos[o]); s.flag.seek(pos[o + 1]); s.glyph.seek(pos[o + 2]);
    s.composite.seek(pos[o + 3]); s.bbox.seek(pos[o + 4]); s.instruction.seek(pos[o + 5]);
    const r = settle(grec, guard(() => decodeOne(s, g, i16(nc, g * 2), (bitmap[g >> 3] & (0x80 >> (g & 7))) !== 0), (f) => f));
    const out = r.tag === 'Err' ? r : r.value;
    memo.set(g, out);
    return out;
  };
  return ok({ glyph, numGlyphs, indexFormat, overlap });
}

/** Eager decoder: every glyph, in stream order. The indexed decoder is checked against it. */
/**
 * @param {Uint8Array} data  the transformed glyf table as stored in the WOFF2 stream
 * @param {number} numGlyphsMaxp
 * @param {import('../../otel-compact/src/trace.js').Span} [span]
 * @returns {import('../../otel-compact/src/adt.js').Result<{ glyphs: import('../../sfnt/src/glyf.js').GlyphT[], indexFormat: number, overlap: import('../../otel-compact/src/adt.js').Option<Uint8Array> }, any>}
 */
export function decodeGlyfV0(data, numGlyphsMaxp, span = NOOP_SPAN) {
  const split = splitStreams(data, numGlyphsMaxp, span);
  if (split.tag === 'Err') return split;
  const { numGlyphs, indexFormat, raw, overlap } = split.value;
  const rec = noOverrun();
  const decoded = settle(rec, guard(() => {
    const { s, bboxBitmap } = span.span('glyf.streams', () => {
      const s = Object.fromEntries(STREAMS.map((k) => [k, stream(raw[k], k, rec)]));
      return { s, bboxBitmap: s.bbox.bytes(((numGlyphs + 31) >> 5) << 2) };
    });
    /** @type {import('../../sfnt/src/glyf.js').GlyphT[]} */
    const glyphs = [];
    /** First failing glyph's Err; empty = all decoded. @type {any[]} */
    const failed = [];
    // Batches of BATCH glyphs: one span each, so per-glyph cost is visible without a span per glyph.
    for (let g0 = 0; g0 < numGlyphs && !failed.length; g0 += BATCH) span.span('glyf.batch', { atomic: true, items: Math.min(BATCH, numGlyphs - g0), first: g0 }, () => {
      for (let g = g0; g < Math.min(numGlyphs, g0 + BATCH) && !failed.length; g++) {
        const r = decodeOne(s, g, s.nContour.i16(), (bboxBitmap[g >> 3] & (0x80 >> (g & 7))) !== 0);
        if (r.tag === 'Err') failed.push(r); else glyphs.push(r.value);
      }
    });
    return failed.length ? failed[0] : ok(glyphs);
  }, (f) => f));
  if (decoded.tag === 'Err') return decoded;
  if (decoded.value.tag === 'Err') return decoded.value;
  return ok({ glyphs: decoded.value.value, indexFormat, overlap });
}
