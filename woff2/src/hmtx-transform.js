// @ts-check
// WOFF2 transformed 'hmtx' (W3C WOFF2 §5.4) → a real hmtx table.
//
//   u8      flags          bit 0: proportional lsbs omitted · bit 1: monospaced lsbs omitted
//   u16[h]  advanceWidth   h = hhea.numberOfHMetrics
//   i16[h]  lsb            if bit 0 is clear
//   i16[n-h] lsb           if bit 1 is clear (n = numGlyphs)
//
// An omitted lsb is the glyph's xMin from glyf (0 for an empty glyph). Rules follow the
// reference decoder (google/woff2 woff2_dec.cc ReconstructTransformedHmtx): reserved flag bits
// must be 0, at least one array must be omitted (else the transform should not have been used),
// 1 ≤ numberOfHMetrics ≤ numGlyphs, and the data must hold what the flags say.
// Found by the W3C WOFF2 suite: real encoders emit this, and glyph did not reconstruct it.
import { ok, err } from '../../otel-compact/src/adt.js';
import { Woff2Error } from './woff2.js';

/**
 * @param {Uint8Array} data  the transformed table
 * @param {number} numGlyphs @param {number} numHMetrics
 * @param {(gid: number) => number} xMin  glyph bbox xMin (0 for empty glyphs)
 * @returns {import('../../otel-compact/src/adt.js').Result<Uint8Array, any>}
 */
export function reconstructHmtx(data, numGlyphs, numHMetrics, xMin) {
  const bad = (/** @type {string} */ why) => err(Woff2Error.BadTransform('hmtx', why));
  if (data.length < 1) return bad('empty');
  const flags = data[0];
  if (flags & 0xfc) return bad(`reserved flag bits 0x${flags.toString(16)}`);
  const hasProportional = (flags & 1) === 0, hasMonospace = (flags & 2) === 0;
  if (hasProportional && hasMonospace) return bad('flags omit nothing');
  if (numHMetrics < 1 || numHMetrics > numGlyphs) return bad(`numberOfHMetrics ${numHMetrics} with ${numGlyphs} glyphs`);
  const need = 1 + 2 * numHMetrics + (hasProportional ? 2 * numHMetrics : 0) + (hasMonospace ? 2 * (numGlyphs - numHMetrics) : 0);
  if (data.length < need) return bad(`needs ${need} bytes, has ${data.length}`);
  const src = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const out = new Uint8Array(4 * numHMetrics + 2 * (numGlyphs - numHMetrics));
  const dst = new DataView(out.buffer);
  let o = 1;
  for (let i = 0; i < numHMetrics; i++, o += 2) dst.setUint16(4 * i, src.getUint16(o));
  for (let i = 0; i < numHMetrics; i++) {
    const lsb = hasProportional ? src.getInt16(o) : xMin(i);
    if (hasProportional) o += 2;
    dst.setInt16(4 * i + 2, lsb);
  }
  for (let i = numHMetrics; i < numGlyphs; i++) {
    const lsb = hasMonospace ? src.getInt16(o) : xMin(i);
    if (hasMonospace) o += 2;
    dst.setInt16(4 * numHMetrics + 2 * (i - numHMetrics), lsb);
  }
  return ok(out);
}
