// @ts-check
// The whole pipeline, n fonts × n targets:
//   bytes --load--> Font --shape--> glyphs --layout--> Scene --render--> Output[]

import { ok, err } from '../../otel-compact/src/adt.js';
import { NOOP_SPAN } from '../../otel-compact/src/trace.js';
import { loadFont } from '../../sfnt/src/font.js';
import { shape } from '../../shape/src/shape.js';
import { layout } from './scene.js';
import { renderTarget, TARGETS } from './targets.js';

/**
 * @typedef {object} TextSpec
 * @property {string} fontKey
 * @property {import('../../sfnt/src/font.js').Font} font
 * @property {string} text
 * @property {number} size
 * @property {import('./scene.js').RGBA} [fill]
 */

/**
 * Lines -> one Scene -> every target.
 * @param {TextSpec[]} lines
 * @param {{ targets?: readonly import('./targets.js').TargetT[], padding?: number, gap?: number, background?: import('./scene.js').RGBA, maxPixels?: number, span?: import('../../otel-compact/src/trace.js').Span, cache?: import('./raster.js').FlattenCache }} [opts]  cache: reuse flattened outlines across renders (see flattenCache)
 * @returns {Promise<import('../../otel-compact/src/adt.js').Result<{ scene: import('./scene.js').Scene, outputs: import('./targets.js').Output[] }, any>>}
 */
export async function renderText(lines, { targets = TARGETS, padding, gap, background, maxPixels, span = NOOP_SPAN, cache } = {}) {
  return span.span('render.text', { lines: lines.length, targets: targets.length }, async (s) => {
    /** @type {import('./scene.js').Line[]} */
    const shaped = [];
    for (const l of lines) {
      const r = shape(l.font, l.text, { span: s });
      if (r.tag === 'Err') return r;
      shaped.push({ font: l.font, fontKey: l.fontKey, glyphs: r.value, size: l.size, fill: l.fill });
    }
    const scene = s.span('layout', (ls) => layout(shaped, { padding, gap, background, maxPixels, span: ls }));
    if (scene.tag === 'Err') return err(scene.error);
    const title = lines.map((l) => l.text).join('\n');
    const outputs = [];
    for (const t of targets) outputs.push(await renderTarget(scene.value, t, { title, span: s, cache }));
    return ok({ scene: scene.value, outputs });
  });
}

export { loadFont };
