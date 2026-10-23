// @ts-check
// Public API. Everything here is pure JS with zero dependencies; see README.md.
import { loadFont as loadWith } from './sfnt/src/font.js';
import { autoBrotli } from './woff2/src/brotli.js';

export { renderText } from './render/src/text.js';
export { layout } from './render/src/scene.js';
export { toSvg } from './render/src/svg.js';
export { rasterize, scanline, accumulate, flattenCache, channelsFor } from './render/src/raster.js';
export { encodePng, fastZlib, nativeZlib, storedZlib, balancedZlib, maxZlib, zlibOf } from './render/src/png.js';
export { Lz, Entropy } from './render/src/deflate.js';
export { pngStream, pngChunks, encodePngBanded } from './render/src/stream.js';
export * from './render/src/compose.js';
export { linear, radial } from './render/src/paint.js';
export * as draw from './draw/src/draw.js';
export { typeset, placeMath, TypesetError } from './math/src/typeset.js';
export { parseTex, TexError } from './math/src/tex.js';
export { parseMath, mathOf, MathError } from './math/src/table.js';
export { tracer, Config } from './otel-compact/src/trace.js';
export { ok, err, some, NONE, option, getOr, mapOption, okOr } from './otel-compact/src/adt.js';
export { fetchFont, fetchBytes, fontJob, fontCost, publicHttps, allowHosts, FetchError, FontFetchError, describe as describeFetchError } from './net/src/fetch.js';

/**
 * Load a WOFF2, WOFF or bare sfnt font. Brotli defaults to the platform's
 * DecompressionStream where it exists, else the pure-JS decoder.
 * @param {Uint8Array | ArrayBuffer} bytes
 * @param {Partial<Parameters<typeof loadWith>[1]>} [ports]
 */
export const loadFont = (bytes, ports = {}) =>
  loadWith(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), { brotli: autoBrotli, ...ports });
