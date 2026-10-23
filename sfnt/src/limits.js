// @ts-check
// Resource limits for untrusted fonts. Every limit turns into a typed Err (or a skipped glyph or
// lookup) at the boundary where it is checked; none of them throws past the public API.
// Sized for a Workers isolate (128 MB shared by concurrent requests) and for fonts people ship:
// the largest Noto CJK WOFF2 is ~10 MB, and decoded tables of real fonts are well under 64 MB.
export const LIMITS = Object.freeze({
  /** Font file as given (also fetchFont's download cap). */
  fileBytes: 16 << 20,
  /** Bytes produced by Brotli (WOFF2 stream) or zlib (WOFF tables): decompression bombs. */
  decompressedBytes: 64 << 20,
  /** A laid-out canvas, width × height. 2²⁵ ≈ 8192 × 4096. */
  canvasPixels: 1 << 25,
  /** Pieces one curve may be flattened into (accuracy beyond this is invisible at the canvas cap). */
  curvePieces: 256,
  /** Flattened points for one glyph instance; over it, the glyph is skipped, not the render. */
  glyphFlatPoints: 1 << 20,
});
