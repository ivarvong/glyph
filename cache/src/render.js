// @ts-check
// Jobs for rendered outputs: the key is the content key of (scene, configuration), and `make`
// is the render itself. Feed them to any stack from layers.js.
import { sceneKey } from './key.js';
import { ok } from '../../otel-compact/src/adt.js';
import { scanline } from '../../render/src/raster.js';
import { fastZlib } from '../../render/src/png.js';
import { encodePngBanded } from '../../render/src/stream.js';
import { toSvg } from '../../render/src/svg.js';

/**
 * @param {import('../../render/src/scene.js').Scene} scene
 * @param {{ rasterizer?: import('../../render/src/raster.js').Rasterizer, zlib?: import('../../render/src/png.js').Zlib,
 *           outlines?: import('../../render/src/raster.js').FlattenCache, meta?: Record<string, any>, version?: string }} [opts]
 * @returns {import('./layers.js').Job}
 */
export function pngJob(scene, { rasterizer = scanline, zlib = fastZlib, outlines, meta, version } = {}) {
  const key = sceneKey(scene, { format: 'png', rasterizer: rasterizer.name, zlib: zlib.name }, version);
  return { key, meta, make: async () => ok(await encodePngBanded(scene, rasterizer, zlib, { cache: outlines })) };
}

/**
 * @param {import('../../render/src/scene.js').Scene} scene
 * @param {{ title?: string, meta?: Record<string, any>, version?: string }} [opts]
 * @returns {import('./layers.js').Job}
 */
export function svgJob(scene, { title = '', meta, version } = {}) {
  const key = sceneKey(scene, { format: 'svg', title }, version);
  return { key, meta, make: async () => ok(new TextEncoder().encode(toSvg(scene, { title }))) };
}
