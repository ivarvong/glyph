// @ts-check
// Banded PNG: rasterize, composite, filter and deflate `rows` rows at a time, emitting
// one IDAT per ~`idat` compressed bytes. Memory is O(width · rows) for pixels plus the
// deflate window, not O(width · height) several times over. Output pixels and the
// concatenated zlib stream are byte-identical to the whole-image path (encodePng).
import { NOOP_SPAN } from '../../otel-compact/src/trace.js';
import { planBatches, materialize, channelsFor, compositeRow, paint, flattenCache, scanline } from './raster.js';
import { chunk, COLOR_TYPE, filterRows, unfilteredRows } from './png.js';

const SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * @typedef {object} StreamOpts
 * @property {number} [rows]       rows per band (default 32)
 * @property {number} [idat]       flush an IDAT once this many compressed bytes are pending (default 16 KiB)
 * @property {1 | 3 | 4} [channels]
 * @property {import('./png.js').PngFilter} [filter]
 * @property {import('./raster.js').FlattenCache} [cache]
 * @property {import('../../otel-compact/src/trace.js').Span} [span]
 */

/**
 * PNG file chunks, top to bottom: signature + IHDR, IDATs, IEND.
 * @param {import('./scene.js').Scene} scene
 * @param {import('./raster.js').Rasterizer} r
 * @param {import('./png.js').Zlib} zlib
 * @param {StreamOpts} [opts]
 * @returns {AsyncGenerator<Uint8Array, void, void>}
 */
export async function* pngChunks(scene, r, zlib, { rows = 32, idat = 16384, channels = channelsFor(scene), filter = 'none', cache = flattenCache(), span = NOOP_SPAN } = {}) {
  const { width: w, height: h } = scene, C = channels, stride = w * C;
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w); dv.setUint32(4, h);
  ihdr.set([8, COLOR_TYPE[C], 0, 0, 0], 8);
  const head = new Uint8Array(SIGNATURE.length + 25);
  head.set(SIGNATURE); head.set(chunk('IHDR', ihdr), SIGNATURE.length);
  yield head;

  // Plan from hulls (no geometry built); each batch's polygons are built when the sweep reaches its
  // first band and dropped after its last, so peak memory is the geometry in flight, not the scene's.
  const groups = span.span('raster.plan', { items: scene.items.length }, () => planBatches(scene));
  // One coverage buffer for all colours: each colour's band is composited, then its dirty
  // columns are zeroed, before the next colour scans into the same memory.
  const shared = new Float32Array(w * Math.min(rows, h));
  // Each batch is scanned only in the bands its hull reaches. Its generator starts at its first
  // band and is closed after its last, so a band visits the batches inking it, not all of them:
  // O(Σ bands per batch) instead of O(batches × bands), found by tracing the 22k-item poster
  // (169 bands × 10k batches of mostly-empty generator steps was 70% of its render).
  const nb = Math.ceil(h / rows);
  /** @type {number[][]} batch indices per band, ascending (paint order) */
  const perBand = Array.from({ length: nb }, () => []);
  /** @type {Int32Array} last band of each batch */
  const lastBand = new Int32Array(groups.length).fill(-1);
  groups.forEach((g, i) => {
    if (!(g.y1 >= 0 && g.y0 < h)) return;
    const b0 = Math.max(0, Math.floor(g.y0 / rows)), b1 = Math.min(nb - 1, Math.floor(g.y1 / rows));
    for (let b = b0; b <= b1; b++) perBand[b].push(i);
    lastBand[i] = b1;
  });
  /** @type {(Generator<import('./raster.js').Band, void, void> | null)[]} */
  const gens = groups.map(() => null);
  const z = zlib.stream();
  const px = new Uint8Array(stride * Math.min(rows, h) + stride); // + one row: the previous band's last, for filters
  const rowsOut = new Uint8Array(Math.min(rows, h) * (stride + 1)); // unfiltered rows, reused per band
  /** @type {Uint8Array[]} */
  let pending = [];
  let pendLen = 0;
  const flush = () => { const c = chunk('IDAT', concat(pending, pendLen)); pending = []; pendLen = 0; return c; };
  for (let yb = 0, bi = 0; yb < h; yb += rows, bi++) {
    const nRows = Math.min(rows, h - yb), n = nRows * w;
    const band = px.subarray(stride, stride + n * C);
    const raw = span.span('band', { y: yb, rows: nRows, batches: perBand[bi].length }, (bs) => {
      bs.span('raster.clear', { atomic: true, items: n }, () => paint(band, scene.background, C));
      for (const g of perBand[bi]) {
        let gen = gens[g];
        if (!gen) {
          const polys = bs.span('raster.flatten', { items: groups[g].items.length }, (fs) => materialize(scene, groups[g], cache, fs));
          gen = gens[g] = (groups[g].evenOdd ? scanline : r).bands(polys, w, h, rows, span, shared, groups[g].evenOdd, yb);
        }
        const { cov, x0, x1 } = /** @type {import('./raster.js').Band} */ (gen.next().value);
        if (bi === lastBand[g]) { gen.return(); gens[g] = null; } // done: let its scanner go
        if (x1 <= x0) continue; // this batch has no ink in this band
        bs.span('raster.composite', { atomic: true, items: (x1 - x0) * nRows }, () => {
          // Dirty columns only, row by row: same per-pixel formula, O(ink) instead of O(band).
          for (let r = 0; r < nRows; r++) {
            const o = r * w + x0;
            compositeRow(band, C, cov, groups[g].fill, x1 - x0, x0, yb + r, o * C, o);
            cov.fill(0, o, o + x1 - x0); // hand the shared buffer back clean
          }
        });
      }
      return bs.span('png.filter', { atomic: true, items: nRows }, () => {
        // One output buffer for every band: the zlib stream copies what it keeps (ZlibStream contract).
        if (filter !== 'adaptive') return unfilteredRows(band, w, nRows, C, rowsOut);
        if (yb === 0) return filterRows(band, w, nRows, C);
        // Filters read the row above: filter (previous row + band) and drop the first row.
        return filterRows(px.subarray(0, stride + n * C), w, nRows + 1, C).subarray(stride + 1);
      });
    });
    const out = await span.span('png.deflate', { atomic: true, items: raw.length }, () => z.push(raw));
    px.copyWithin(0, stride + (nRows - 1) * stride, stride + nRows * stride); // keep the last row
    if (out.length) { pending.push(out); pendLen += out.length; }
    if (pendLen >= idat) yield span.span('png.chunks', { atomic: true, items: pendLen }, flush);
  }
  const tail = await span.span('png.deflate', { atomic: true, items: 0 }, () => z.finish());
  pending.push(tail); pendLen += tail.length;
  yield span.span('png.chunks', { atomic: true, items: pendLen }, flush);
  yield chunk('IEND', new Uint8Array(0));
}

/**
 * The same chunks as a byte stream (e.g. a Workers `Response` body). Pull-driven: a band
 * is rendered only when the consumer asks for more.
 * @param {import('./scene.js').Scene} scene
 * @param {import('./raster.js').Rasterizer} r
 * @param {import('./png.js').Zlib} zlib
 * @param {StreamOpts} [opts]
 * @returns {ReadableStream<Uint8Array>}
 */
export function pngStream(scene, r, zlib, opts) {
  const it = pngChunks(scene, r, zlib, opts);
  return new ReadableStream({
    async pull(c) { const { done, value } = await it.next(); if (done) c.close(); else c.enqueue(value); },
    async cancel() { await it.return(); },
  });
}

/**
 * Collect the stream into one PNG.
 * @param {import('./scene.js').Scene} scene
 * @param {import('./raster.js').Rasterizer} r
 * @param {import('./png.js').Zlib} zlib
 * @param {StreamOpts} [opts]
 */
export async function encodePngBanded(scene, r, zlib, opts) {
  /** @type {Uint8Array[]} */
  const parts = [];
  let n = 0;
  for await (const c of pngChunks(scene, r, zlib, opts)) { parts.push(c); n += c.length; }
  return concat(parts, n);
}

/** @param {Uint8Array[]} parts @param {number} n */
function concat(parts, n) {
  if (parts.length === 1) return parts[0];
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
