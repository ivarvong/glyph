// @ts-check
// Brotli ports. All share one signature: (Uint8Array) => Promise<Uint8Array>.
// The decoder never knows which one it got; tests check they agree byte-for-byte.
//
//   jsBrotli      pure JS (./brotli-js.js): runs everywhere
//   nativeBrotli  DecompressionStream('brotli'): faster, not yet in every runtime
//                 (absent in Chromium 141, present in Node 22)
//   autoBrotli    native when the runtime has it, else pure JS

import { brotliDecode } from './brotli-js.js';
import { NOOP_SPAN } from '../../otel-compact/src/trace.js';
import { ok, err } from '../../otel-compact/src/adt.js';
import { LIMITS } from '../../sfnt/src/limits.js';

/** Is DecompressionStream('brotli') available in this runtime? */
export function hasNativeBrotli() {
  try {
    new DecompressionStream(/** @type {any} */ ('brotli'));
    return true;
  } catch {
    return false;
  }
}

/**
 * A decompression port: bytes in, Result out. Errors are values; nothing here rejects.
 * @typedef {(input: Uint8Array, span?: import('../../otel-compact/src/trace.js').Span, maxOutput?: number) => Promise<import('../../otel-compact/src/adt.js').Result<Uint8Array, string>>} Port
 */

/**
 * The one place platform exceptions become values: wrap any throwing or rejecting decompressor
 * (node:zlib, a platform stream) as a Port.
 * @param {(input: Uint8Array, maxOutput: number) => Uint8Array | Promise<Uint8Array>} f
 * @returns {Port}
 */
export const portOf = (f) => async (input, _span, maxOutput = LIMITS.decompressedBytes) => {
  try { return ok(await f(input, maxOutput)); } catch (e) { return err(e instanceof Error ? e.message : String(e)); }
};

/**
 * Read a decompression stream to the end, stopping as soon as it passes `max` bytes.
 * @param {ReadableStream<Uint8Array>} stream @param {number} max @param {string} what
 * @returns {Promise<import('../../otel-compact/src/adt.js').Result<Uint8Array, string>>}
 */
export async function drainCapped(stream, max, what) {
  const r = stream.getReader();
  /** @type {Uint8Array[]} */
  const parts = [];
  let n = 0;
  try {
    for (;;) {
      const { done, value } = await r.read();
      if (done) break;
      n += value.length;
      if (n > max) { await r.cancel(); return err(`${what}: output exceeds ${max} bytes`); }
      parts.push(value);
    }
  } catch (e) {
    return err(`${what}: ${e instanceof Error ? e.message : String(e)}`); // the platform stream rejected
  }
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return ok(out);
}

/** Web Compression Streams port. @type {Port} */
export async function nativeBrotli(input, span = NOOP_SPAN, maxOutput = LIMITS.decompressedBytes) {
  const stream = span.span('brotli.native.pipe', { atomic: true }, () =>
    new Blob([/** @type {BlobPart} */ (input)]).stream().pipeThrough(new DecompressionStream(/** @type {any} */ ('brotli'))));
  return span.span('brotli.native.drain', { atomic: true }, () => drainCapped(stream, maxOutput, 'brotli'));
}

/** Pure-JS port. @type {Port} */
export async function jsBrotli(input, span = NOOP_SPAN, maxOutput = LIMITS.decompressedBytes) {
  const r = brotliDecode(input, { span, maxOutput, sizeHint: Math.min(maxOutput, 16 << 20) });
  return r.tag === 'Ok' ? r : err(`brotli: ${JSON.stringify(r.error)}`);
}

/** Native when the runtime has it, else pure JS. @type {Port} */
export const autoBrotli = hasNativeBrotli() ? nativeBrotli : jsBrotli;
