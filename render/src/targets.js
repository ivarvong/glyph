// @ts-check
// Scene -> bytes, for each target. The only place that knows about formats.

import { variants } from '../../otel-compact/src/adt.js';
import { NOOP_SPAN } from '../../otel-compact/src/trace.js';
import { toSvg } from './svg.js';
import { rasterize, accumulate, scanline } from './raster.js';
import { encodePng, storedZlib, nativeZlib, fastZlib, balancedZlib, maxZlib } from './png.js';

export const Target = variants('Target', {
  Svg: [],
  Png: ['rasterizer', 'zlib'],
});
/** @typedef {import('../../otel-compact/src/adt.js').Of<typeof Target>} TargetT */

/**
 * The default pair: one vector, one raster. PNG uses `scanline`: exact nonzero
 * winding. `accumulate` is 4-6× faster but over-covers pixels where contours
 * overlap (Inter's static instances keep overlaps); see verify/compare.js.
 * zlib: `fast` (pure JS, fixed Huffman) is 2.3× faster than CompressionStream on
 * filtered rows, at ~23% more bytes; `native` when size matters more.
 */
export const TARGETS = Object.freeze([Target.Svg, Target.Png(scanline, fastZlib)]);
export const RASTERIZERS = Object.freeze([accumulate, scanline]);
export const ZLIBS = Object.freeze([nativeZlib, storedZlib, fastZlib, balancedZlib, maxZlib]);

/** @typedef {{ target: string, mime: string, ext: string, bytes: Uint8Array }} Output */

/**
 * @param {import('./scene.js').Scene} scene
 * @param {TargetT} target
 * @param {{ title?: string, span?: import('../../otel-compact/src/trace.js').Span, cache?: import('./raster.js').FlattenCache }} [opts]
 * @returns {Promise<Output>}
 */
export async function renderTarget(scene, target, { title, span = NOOP_SPAN, cache } = {}) {
  return Target.match(target, {
    Svg: () => span.span('render.svg', (s) => {
      const svg = toSvg(scene, { title, span: s });
      const bytes = s.span('svg.encode', { atomic: true, items: svg.length }, () => new TextEncoder().encode(svg));
      s.set('bytes', bytes.length);
      return Promise.resolve({ target: 'svg', mime: 'image/svg+xml', ext: 'svg', bytes });
    }),
    Png: ({ rasterizer, zlib }) => span.span('render.png', { rasterizer: rasterizer.name, zlib: zlib.name }, async (s) => {
      const img = s.span('raster', { w: scene.width, h: scene.height }, (rs) => rasterize(scene, rasterizer, rs, { cache }));
      const bytes = await s.span('png.encode', (es) => encodePng(img, zlib, es));
      s.set('bytes', bytes.length);
      return { target: `png-${rasterizer.name}-${zlib.name}`, mime: 'image/png', ext: 'png', bytes };
    }),
  });
}
