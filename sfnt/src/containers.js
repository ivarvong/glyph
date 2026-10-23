// @ts-check
// Containers: bytes -> { flavor, tables[] }. Three formats, one output shape:
//   Sfnt   bare TrueType / OpenType            (tables stored raw)
//   Woff   WOFF 1.0, per-table zlib            (DecompressionStream 'deflate')
//   Woff2  WOFF 2.0, one Brotli stream         (glyf/loca may be transformed)
// Downstream code never learns which container a font came in; it only sees
// each table's Transform, which is Identity everywhere except WOFF2 glyf/loca.

import { variants, ok, err } from '../../otel-compact/src/adt.js';
import { NOOP_SPAN } from '../../otel-compact/src/trace.js';
import { decodeWoff2, Transform } from '../../woff2/src/woff2.js';
import { view, u16, u32, tag, guard, times } from './bin.js';
import { LIMITS } from './limits.js';
import { drainCapped } from '../../woff2/src/brotli.js';

export const Container = variants('Container', { Sfnt: [], Woff: [], Woff2: [] });

export const ContainerError = variants('ContainerError', {
  UnknownSignature: ['got'],
  Truncated: ['at'],
  TableOutOfRange: ['table'],
  Inflate: ['table', 'message'],
  InflatedSize: ['table', 'expected', 'actual'],
  Woff2: ['cause'],
  TooLarge: ['what', 'size', 'limit'],
});

/** @typedef {{ tag: string, transform: import('../../otel-compact/src/adt.js').Of<typeof Transform>, data: Uint8Array }} Table */
/** @typedef {{ container: import('../../otel-compact/src/adt.js').Of<typeof Container>, flavor: string, tables: Table[] }} FontFile */

/** Pure: sniff the container from its first four bytes. @param {Uint8Array} b */
export function sniff(b) {
  if (b.length < 4) return err(ContainerError.Truncated(0));
  const sig = String.fromCharCode(b[0], b[1], b[2], b[3]);
  if (sig === 'wOF2') return ok(Container.Woff2);
  if (sig === 'wOFF') return ok(Container.Woff);
  if (sig === 'OTTO' || sig === 'true' || (b[0] === 0 && b[1] === 1 && b[2] === 0 && b[3] === 0)) return ok(Container.Sfnt);
  return err(ContainerError.UnknownSignature(sig));
}

/** Pure. @param {Uint8Array} bytes */
function readSfnt(bytes) {
  const v = view(bytes);
  const dir = guard(() => {
    const n = u16(v, 4);
    return {
      flavor: tag(v, 0),
      entries: times(n, (i) => ({ tag: tag(v, 12 + i * 16), off: u32(v, 20 + i * 16), len: u32(v, 24 + i * 16) })),
    };
  }, (e) => ContainerError.Truncated(e.at));
  if (dir.tag === 'Err') return dir;
  const bad = dir.value.entries.find((e) => e.off + e.len > bytes.length);
  if (bad) return err(ContainerError.TableOutOfRange(bad.tag));
  /** @type {FontFile} */
  const file = {
    container: Container.Sfnt,
    flavor: dir.value.flavor,
    tables: dir.value.entries.map((e) => ({ tag: e.tag, transform: Transform.Identity, data: bytes.subarray(e.off, e.off + e.len) })),
  };
  return ok(file);
}

/**
 * WOFF 1.0. Each table is zlib-compressed iff compLength < origLength.
 * @param {Uint8Array} bytes
 * @param {(b: Uint8Array, maxOutput?: number) => Promise<import('../../otel-compact/src/adt.js').Result<Uint8Array, string>>} inflate
 */
async function readWoff(bytes, inflate) {
  const v = view(bytes);
  const dir = guard(() => {
    const flavor = tag(v, 4);
    const n = u16(v, 12);
    const entries = [];
    for (let i = 0; i < n; i++) {
      const r = 44 + i * 20;
      entries.push({ tag: tag(v, r), off: u32(v, r + 4), comp: u32(v, r + 8), orig: u32(v, r + 12) });
    }
    return { flavor, entries };
  }, (e) => ContainerError.Truncated(e.at));
  if (dir.tag === 'Err') return dir;
  /** @type {Table[]} */
  const tables = [];
  let inflated = 0;
  for (const e of dir.value.entries) {
    if (e.off + e.comp > bytes.length) return err(ContainerError.TableOutOfRange(e.tag));
    inflated += e.orig;
    if (inflated > LIMITS.decompressedBytes) return err(ContainerError.TooLarge('tables', inflated, LIMITS.decompressedBytes));
    const stored = bytes.subarray(e.off, e.off + e.comp);
    let data = stored;
    if (e.comp < e.orig) {
      const r = await inflate(stored, e.orig);
      if (r.tag === 'Err') return err(ContainerError.Inflate(e.tag, r.error));
      data = r.value;
    }
    if (data.length !== e.orig) return err(ContainerError.InflatedSize(e.tag, e.orig, data.length));
    tables.push({ tag: e.tag, transform: Transform.Identity, data });
  }
  return ok({ container: Container.Woff, flavor: dir.value.flavor, tables });
}

/**
 * zlib inflate via the Web Compression Streams API, stopped at `maxOutput`. Errors are values.
 * @param {Uint8Array} b @param {number} [maxOutput]
 * @returns {Promise<import('../../otel-compact/src/adt.js').Result<Uint8Array, string>>}
 */
export async function nativeInflate(b, maxOutput = LIMITS.decompressedBytes) {
  const s = new Blob([/** @type {BlobPart} */ (b)]).stream().pipeThrough(new DecompressionStream('deflate'));
  return drainCapped(s, maxOutput, 'inflate');
}

/**
 * @typedef {object} Ports
 * @property {import('../../woff2/src/brotli.js').Port} brotli
 * @property {(b: Uint8Array, maxOutput?: number) => Promise<import('../../otel-compact/src/adt.js').Result<Uint8Array, string>>} [inflate]
 * @property {import('../../otel-compact/src/trace.js').Span} [span]
 */

/**
 * bytes -> FontFile, whatever the container.
 * @param {Uint8Array} bytes
 * @param {Ports} ports
 * @returns {Promise<import('../../otel-compact/src/adt.js').Result<FontFile, any>>}
 */
export async function openFontFile(bytes, { brotli, inflate = nativeInflate, span = NOOP_SPAN }) {
  return span.span('font.container', { bytes: bytes.length }, async (s) => {
    if (bytes.length > LIMITS.fileBytes) return err(ContainerError.TooLarge('file', bytes.length, LIMITS.fileBytes));
    const kind = sniff(bytes);
    if (kind.tag === 'Err') { s.fail(kind.error.tag); return kind; }
    s.set('container', kind.value.tag);
    /** @type {import('../../otel-compact/src/adt.js').Result<FontFile, any>} */
    const r = await Container.match(kind.value, {
      Sfnt: async () => readSfnt(bytes),
      Woff: () => readWoff(bytes, inflate),
      Woff2: async () => {
        const d = await decodeWoff2(bytes, { decompress: brotli, span: s });
        if (d.tag === 'Err') return err(ContainerError.Woff2(d.error));
        return ok({ container: Container.Woff2, flavor: d.value.flavor, tables: d.value.tables.map((t) => ({ tag: t.tag, transform: t.transform, data: t.data })) });
      },
    });
    if (r.tag === 'Ok') s.set('tables', r.value.tables.length);
    else s.fail(r.error.tag);
    return r;
  });
}
