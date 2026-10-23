// @ts-check
// WOFF2 container stage: bytes -> sfnt table slices (still transformed).
//
// Split into pure phases around one effectful port (Brotli):
//   readContainer(bytes)            pure   header + directory + compressed slice
//   splitTables(container, raw)     pure   decompressed stream -> per-table views
//   decodeWoff2(bytes, {decompress}) async orchestrator, traced
//
// Behaviour cross-checked against google/woff2 (src/woff2_dec.cc,
// src/variable_length.cc, src/table_tags.cc). Every failure is a typed
// Woff2Error variant; nothing throws across the module boundary.

import { variants, ok, err, some, NONE, option } from '../../otel-compact/src/adt.js';
import { NOOP_SPAN } from '../../otel-compact/src/trace.js';
import { LIMITS } from '../../sfnt/src/limits.js';

export const Woff2Error = variants('Woff2Error', {
  BadSignature: ['got'],
  Truncated: ['at', 'need', 'have'],
  LengthMismatch: ['header', 'actual'],
  BadBase128: ['at', 'reason'],
  BadTransform: ['table', 'reason'],
  BadLayout: ['block', 'at', 'expected'],
  DuplicateTable: ['table'],
  UnsupportedCollection: [],
  DecompressFailed: ['message'],
  DecompressedSize: ['expected', 'actual'],
  TooLarge: ['what', 'size', 'limit'],
  Invariant: ['table', 'reason'],
});

// How a table's bytes are encoded in the decompressed stream.
export const Transform = variants('Transform', {
  Identity: [],      // stored as-is
  GlyfV0: [],        // WOFF2 glyf transform (triplet streams)
  LocaV0: [],        // derived from glyf; zero bytes stored
  HmtxV1: [],        // lsb arrays elided
});

// Order is normative: index = flags & 0x3f. Copied from table_tags.cc.
export const KNOWN_TAGS = Object.freeze([
  'cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'OS/2', 'post', 'cvt ', 'fpgm',
  'glyf', 'loca', 'prep', 'CFF ', 'VORG', 'EBDT', 'EBLC', 'gasp', 'hdmx', 'kern',
  'LTSH', 'PCLT', 'VDMX', 'vhea', 'vmtx', 'BASE', 'GDEF', 'GPOS', 'GSUB', 'EBSC',
  'JSTF', 'MATH', 'CBDT', 'CBLC', 'COLR', 'CPAL', 'SVG ', 'sbix', 'acnt', 'avar',
  'bdat', 'bloc', 'bsln', 'cvar', 'fdsc', 'feat', 'fmtx', 'fvar', 'gvar', 'hsty',
  'just', 'lcar', 'mort', 'morx', 'opbd', 'prop', 'trak', 'Zapf', 'Silf', 'Glat',
  'Gloc', 'Feat', 'Sill',
]);

const SIGNATURE = 0x774f4632; // 'wOF2'

/** @param {number} u32 */
const tagString = (u32) => String.fromCharCode(u32 >>> 24, (u32 >>> 16) & 255, (u32 >>> 8) & 255, u32 & 255);

/** 'OTTO' stays 'OTTO'; '\0\1\0\0' becomes '0x00010000'. @param {string} t */
export const printableTag = (t) =>
  /^[\x20-\x7e]{4}$/.test(t) ? t : '0x' + [...t].map((ch) => ch.charCodeAt(0).toString(16).padStart(2, '0')).join('');

/**
 * Bounds-checked big-endian cursor with a sticky error: the first failure is kept as a value
 * (`error`, an Option), every later read returns 0, and the parser checks `failed` at each
 * decision point. No exceptions on any input.
 * @param {Uint8Array} bytes
 */
function cursor(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 0;
  /** @type {import('../../otel-compact/src/adt.js').Option<any>} */
  let error = NONE;
  /** @param {any} e */
  const fail = (e) => { if (error.tag === 'None') error = some(e); return 0; };
  /** @param {number} n */
  const has = (n) => {
    if (error.tag === 'Some') return false;
    if (pos + n <= bytes.length) return true;
    fail(Woff2Error.Truncated(pos, n, bytes.length - pos));
    return false;
  };
  return {
    get pos() { return pos; },
    get failed() { return error.tag === 'Some'; },
    get error() { return error.tag === 'Some' ? error.value : null; },
    fail,
    u8: () => (has(1) ? bytes[pos++] : 0),
    u16: () => (has(2) ? ((pos += 2), dv.getUint16(pos - 2)) : 0),
    u32: () => (has(4) ? ((pos += 4), dv.getUint32(pos - 4)) : 0),
    /** UIntBase128 per variable_length.cc: ≤5 bytes, no leading zero, no u32 overflow. */
    base128: () => {
      const at = pos;
      let result = 0;
      for (let i = 0; i < 5; i++) {
        if (!has(1)) return 0;
        const code = bytes[pos++];
        if (i === 0 && code === 0x80) return fail(Woff2Error.BadBase128(at, 'leading zero'));
        if (result & 0xfe000000) return fail(Woff2Error.BadBase128(at, 'overflow'));
        result = ((result << 7) | (code & 0x7f)) >>> 0;
        if ((code & 0x80) === 0) return result;
      }
      return fail(Woff2Error.BadBase128(at, 'longer than 5 bytes'));
    },
  };
}

/**
 * @typedef {object} DirEntry
 * @property {string} tag
 * @property {any} transform        Transform variant
 * @property {number} origLength    length of the reconstructed sfnt table
 * @property {number} storedLength  bytes this table occupies in the decompressed stream
 */

/**
 * @typedef {object} Container
 * @property {string} flavor
 * @property {number} totalSfntSize
 * @property {DirEntry[]} directory
 * @property {Uint8Array} compressed
 * @property {number} expectedStream  sum of storedLength
 */

/**
 * Pure and total: Ok(Container) or Err(Woff2Error), never a throw.
 * @param {Uint8Array} bytes @param {import('../../otel-compact/src/trace.js').Span} [span]
 * @returns {import('../../otel-compact/src/adt.js').Result<Container, any>}
 */
export function readContainer(bytes, span = NOOP_SPAN) {
  const c = cursor(bytes);
  const hdr = span.span('woff2.header', () => {
    const sig = c.u32();
    if (!c.failed && sig !== SIGNATURE) c.fail(Woff2Error.BadSignature(tagString(sig)));
    const flavor = tagString(c.u32());
    const length = c.u32();
    if (!c.failed && length !== bytes.length) c.fail(Woff2Error.LengthMismatch(length, bytes.length));
    const numTables = c.u16();
    c.u16(); // reserved
    const totalSfntSize = c.u32();
    const totalCompressedSize = c.u32();
    c.u16(); c.u16(); // major, minor version
    const metaOffset = c.u32(), metaLength = c.u32();
    c.u32(); // metaOrigLength
    const privOffset = c.u32(), privLength = c.u32();
    return { flavor, numTables, totalSfntSize, totalCompressedSize, metaOffset, metaLength, privOffset, privLength };
  });
  if (c.failed) return err(c.error);
  const { flavor, numTables, totalSfntSize, totalCompressedSize, metaOffset, metaLength, privOffset, privLength } = hdr;
  // Collections are out of scope; say so before their directory (which repeats tags) is read.
  if (flavor === 'ttcf') return err(Woff2Error.UnsupportedCollection);

  const { directory, expectedStream } = span.span('woff2.directory', { tables: numTables }, () => {
    /** @type {DirEntry[]} */
    const directory = [];
    const seen = new Set();
    let expectedStream = 0;
    for (let i = 0; i < numTables && !c.failed; i++) {
      const flags = c.u8();
      const idx = flags & 0x3f;
      const version = flags >>> 6;
      const tag = idx === 63 ? tagString(c.u32()) : KNOWN_TAGS[idx];
      if (seen.has(tag)) { c.fail(Woff2Error.DuplicateTable(tag)); break; }
      seen.add(tag);
      const origLength = c.base128();

      const isGlyfLoca = tag === 'glyf' || tag === 'loca';
      // glyf/loca: version 0 = transformed, 3 = null. Others: 0 = null, else transformed.
      const transformed = isGlyfLoca ? version === 0 : version !== 0;
      let storedLength = origLength;
      /** @type {import('../../otel-compact/src/adt.js').Of<typeof Transform>} */
      let transform = Transform.Identity;
      if (transformed) {
        storedLength = c.base128();
        if (tag === 'glyf') transform = Transform.GlyfV0;
        else if (tag === 'loca') {
          if (storedLength !== 0) { c.fail(Woff2Error.BadTransform(tag, 'transformed loca must store 0 bytes')); break; }
          transform = Transform.LocaV0;
        } else if (tag === 'hmtx' && version === 1) transform = Transform.HmtxV1;
        else { c.fail(Woff2Error.BadTransform(tag, `unknown transform version ${version}`)); break; }
      } else if (isGlyfLoca && version !== 3) {
        c.fail(Woff2Error.BadTransform(tag, `reserved transform version ${version}`)); break;
      }
      expectedStream += storedLength;
      directory.push({ tag, transform, origLength, storedLength });
    }
    return { directory, expectedStream };
  });
  if (c.failed) return err(c.error);

  const glyf = option(directory.find((d) => d.tag === 'glyf'));
  const loca = option(directory.find((d) => d.tag === 'loca'));
  if (glyf.tag === 'Some' && loca.tag === 'Some' && (glyf.value.transform.tag === 'GlyfV0') !== (loca.value.transform.tag === 'LocaV0')) {
    return err(Woff2Error.BadTransform('glyf', 'glyf and loca must be transformed together'));
  }
  const start = c.pos;
  if (start + totalCompressedSize > bytes.length) {
    return err(Woff2Error.Truncated(start, totalCompressedSize, bytes.length - start));
  }
  // Block layout, as the reference decoder (woff2_dec.cc ReadWOFF2Header) requires: compressed
  // data, then metadata, then private data, each starting 4-aligned exactly where the previous
  // one ends, and the file ending there. Extraneous or overlapping data is a rejection (W3C
  // blocks-extraneous-data-*, blocks-overlap-*).
  const round4 = (/** @type {number} */ n) => (n + 3) & ~3;
  let end = round4(start + totalCompressedSize);
  if (metaOffset) {
    if (metaOffset !== end || metaOffset + metaLength > bytes.length) return err(Woff2Error.BadLayout('metadata', metaOffset, end));
    end = round4(metaOffset + metaLength);
  }
  if (privOffset) {
    if (privOffset !== end || privOffset + privLength > bytes.length) return err(Woff2Error.BadLayout('private data', privOffset, end));
    end = round4(privOffset + privLength);
  }
  if (end !== round4(bytes.length)) return err(Woff2Error.BadLayout('end of file', bytes.length, end));
  return ok(/** @type {Container} */ ({
    flavor,
    totalSfntSize,
    directory,
    compressed: bytes.subarray(start, start + totalCompressedSize),
    expectedStream,
  }));
}

/**
 * Pure. Views into `raw`; no copies.
 * @param {Container} container
 * @param {Uint8Array} raw  decompressed stream
 */
export function splitTables(container, raw) {
  if (raw.length !== container.expectedStream) {
    return err(Woff2Error.DecompressedSize(container.expectedStream, raw.length));
  }
  let off = 0;
  const tables = container.directory.map((d) => {
    const data = raw.subarray(off, off + d.storedLength);
    off += d.storedLength;
    return { ...d, data };
  });
  return ok({ flavor: container.flavor, tables });
}

// ---------------------------------------------------------------------------
// Structural checks that differ by outline format: one per path, so both the
// TrueType (glyf transform) and CFF paths are exercised on every run.

/** @param {Uint8Array} b @param {number} o */
const u16at = (b, o) => (b[o] << 8) | b[o + 1];
/** @param {Uint8Array} b @param {number} o */
const u32at = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;

/**
 * @param {{ flavor: string, tables: Array<DirEntry & { data: Uint8Array }> }} font
 * @returns {import('../../otel-compact/src/adt.js').Result<Record<string, number|string|boolean>, any>}
 */
export function checkInvariants(font) {
  const t = Object.fromEntries(font.tables.map((x) => [x.tag, x]));
  const fail = (/** @type {string} */ tag, /** @type {string} */ reason) => err(Woff2Error.Invariant(tag, reason));

  const head = t.head;
  if (!head || head.data.length < 54) return fail('head', 'missing or short');
  if (u32at(head.data, 12) !== 0x5f0f3cf5) return fail('head', 'bad magicNumber');
  const maxp = t.maxp;
  if (!maxp || maxp.data.length < 6) return fail('maxp', 'missing or short');
  const numGlyphs = u16at(maxp.data, 4);

  const outlines = t.glyf ? 'glyf' : t['CFF '] ? 'CFF' : t.CFF2 ? 'CFF2' : 'none';
  /** @type {Record<string, number|string|boolean>} */
  const facts = { numGlyphs, outlines, unitsPerEm: u16at(head.data, 18) };

  if (t.glyf && t.glyf.transform.tag === 'GlyfV0') {
    // Transformed glyf header (woff2_dec.cc ReconstructGlyf):
    // u16 reserved, u16 optionFlags, u16 numGlyphs, u16 indexFormat, 7×u32 stream sizes.
    const g = t.glyf.data;
    if (g.length < 36) return fail('glyf', 'transformed header truncated');
    const optionFlags = u16at(g, 2);
    const gNum = u16at(g, 4);
    if (gNum !== numGlyphs) return fail('glyf', `numGlyphs ${gNum} != maxp ${numGlyphs}`);
    let sum = 36;
    for (let i = 0; i < 7; i++) sum += u32at(g, 8 + i * 4);
    if (optionFlags & 1) sum += (numGlyphs + 7) >> 3;
    // Reference decoder only requires streams to fit; equality is recorded, not required.
    if (sum > g.length) return fail('glyf', `streams need ${sum} bytes, have ${g.length}`);
    facts.glyfStreamsExact = sum === g.length;
    facts.indexFormat = u16at(g, 6);
    // The reconstructed loca has a known size; a directory that declares another is rejected,
    // as the reference decoder does (W3C tabledata-bad-origlength-loca-*).
    const loca = t.loca;
    const want = (numGlyphs + 1) * (facts.indexFormat ? 4 : 2);
    if (loca && loca.origLength !== want) return fail('loca', `origLength ${loca.origLength}, reconstructs to ${want}`);
  }
  if (t['CFF ']) {
    const c = t['CFF '].data;
    if (c.length < 4 || c[0] !== 1) return fail('CFF ', `expected CFF major version 1, got ${c[0]}`);
  }
  if (font.flavor === 'OTTO' && outlines !== 'CFF' && outlines !== 'CFF2') return fail('flavor', 'OTTO without CFF');
  if (font.flavor === '\x00\x01\x00\x00' && outlines !== 'glyf') return fail('flavor', 'TrueType flavor without glyf');
  return ok(facts);
}

// ---------------------------------------------------------------------------

/**
 * @param {Uint8Array} bytes
 * @param {{ decompress: import('./brotli.js').Port, span?: import('../../otel-compact/src/trace.js').Span }} deps
 */
export async function decodeWoff2(bytes, { decompress, span = NOOP_SPAN }) {
  return span.span('woff2.decode', { bytes: bytes.length }, async (s) => {
    const c = s.span('woff2.container', (cs) => {
      const r = readContainer(bytes, cs);
      if (r.tag === 'Ok') {
        cs.set('tables', r.value.directory.length);
        cs.set('flavor', printableTag(r.value.flavor));
        cs.set('compressed', r.value.compressed.length);
      } else cs.fail(r.error.tag);
      return r;
    });
    if (c.tag === 'Err') return c;
    const container = c.value;

    // Decompression bombs: the directory declares the stream size; refuse anything above the
    // global limit, and stop the decoder at the declared size.
    if (container.expectedStream > LIMITS.decompressedBytes) return err(Woff2Error.TooLarge('stream', container.expectedStream, LIMITS.decompressedBytes));
    const raw = await s.span('woff2.brotli', { in: container.compressed.length }, async (bs) => {
      const out = await decompress(container.compressed, bs, container.expectedStream);
      if (out.tag === 'Err') { bs.fail(out.error); return err(Woff2Error.DecompressFailed(out.error)); }
      bs.set('out', out.value.length);
      return out;
    });
    if (raw.tag === 'Err') return raw;

    const font = s.span('woff2.split', () => splitTables(container, raw.value));
    if (font.tag === 'Err') { s.fail(font.error.tag); return font; }

    const facts = s.span('woff2.invariants', (is) => {
      const r = checkInvariants(font.value);
      if (r.tag === 'Ok') for (const k in r.value) is.set(k, r.value[k]);
      else is.fail(`${r.error.tag}: ${r.error.tag === 'Invariant' ? r.error.reason : ''}`);
      return r;
    });
    if (facts.tag === 'Err') return facts;
    return ok({ ...font.value, facts: facts.value });
  });
}
