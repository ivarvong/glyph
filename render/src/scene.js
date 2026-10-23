// @ts-check
// Shaped lines -> Scene: a resolution-independent list of filled paths in
// pixel space (y down). Every target consumes a Scene and nothing else.
//
// Layout rule (mirrored in ref/make_refs.py for the FreeType reference):
//   s      = size / unitsPerEm
//   width  = ceil(2·pad + max line advance · s)
//   line   = (ascender − descender) · s, lines stacked top to bottom
//   origin = (pad + (pen + dx)·s,  top + pad + ascender·s − dy·s)

import { NOOP_SPAN } from '../../otel-compact/src/trace.js';
import { LIMITS } from '../../sfnt/src/limits.js';

/** @typedef {readonly [number, number, number, number]} RGBA  0-255 each */

/**
 * Geometry built on demand. A scene can describe far more geometry than it should hold at once
 * (22k strokes: 690k path segments, 84 MiB as objects); a deferred path keeps only its source and
 * a conservative hull, and the renderer builds it when the band sweep reaches it, flattens it,
 * and lets it go. `describe` names the geometry exactly, for content keys.
 * @typedef {object} DeferredPath
 * @property {'Deferred'} tag
 * @property {readonly [number, number, number, number]} hull  bounds in the item's own space, ⊇ the ink
 * @property {() => import('../../outline/src/path.js').Path} force
 * @property {() => string} describe
 */
/** @typedef {import('../../outline/src/path.js').Path | DeferredPath} Geometry */

/** @param {Geometry} g @returns {g is DeferredPath} */
export const isDeferred = (g) => !Array.isArray(g);
/** The path itself (built now if deferred). @param {Geometry} g @returns {import('../../outline/src/path.js').Path} */
export const geometry = (g) => (isDeferred(g) ? g.force() : g);

/**
 * @typedef {object} SceneItem
 * @property {Geometry} path   font units (or any units: `transform` maps them to pixels)
 * @property {import('../../outline/src/path.js').Affine} transform  font units -> pixels
 * @property {string} key   stable id for de-duplicating identical outlines
 * @property {import('./paint.js').Paint} fill   a colour or a gradient (gradient geometry in scene pixels)
 * @property {FillRule} rule   which points are inside: nonzero winding (fonts) or even-odd
 */
/** @typedef {'nonzero' | 'evenodd'} FillRule */

/** @typedef {{ width: number, height: number, background: RGBA, items: SceneItem[] }} Scene */

/**
 * @typedef {object} Line
 * @property {import('../../sfnt/src/font.js').Font} font
 * @property {string} fontKey
 * @property {import('../../shape/src/shape.js').PositionedGlyph[]} glyphs
 * @property {number} size   px per em
 * @property {RGBA} [fill]
 */

export const BLACK = /** @type {RGBA} */ (Object.freeze([0, 0, 0, 255]));
export const WHITE = /** @type {RGBA} */ (Object.freeze([255, 255, 255, 255]));

/**
 * @param {Line[]} lines
 * @param {{ padding?: number, gap?: number, background?: RGBA, maxPixels?: number, span?: import('../../otel-compact/src/trace.js').Span }} [opts]
 *   gap: px between lines (beyond ascender − descender); defaults to padding.
 *   maxPixels: canvas cap (default LIMITS.canvasPixels, 2^25). Render cost is linear in pixels and
 *   a font's metrics decide the canvas, so with untrusted fonts set it to what the product needs.
 * @returns {import('../../otel-compact/src/adt.js').Result<Scene, any>}
 */
export function layout(lines, { padding = 8, gap = padding, background = WHITE, maxPixels = LIMITS.canvasPixels, span = NOOP_SPAN } = {}) {
  /** @type {SceneItem[]} */
  const items = [];
  let top = 0, maxW = 0;
  for (const line of lines) {
    const { font, glyphs, size } = line;
    const s = size / font.unitsPerEm;
    const base = top + padding + font.ascender * s;
    let pen = 0;
    for (const g of glyphs) {
      const p = font.path(g.gid, span);
      if (p.tag === 'Err') return p;
      if (p.value.length) {
        items.push({
          path: p.value,
          transform: [s, 0, 0, -s, padding + (pen + g.dx) * s, base - g.dy * s],
          key: `${line.fontKey}-${g.gid}`,
          fill: line.fill ?? BLACK,
          rule: 'nonzero',
        });
      }
      pen += g.ax;
    }
    maxW = Math.max(maxW, pen * s);
    top += (font.ascender - font.descender) * s + (lines.length > 1 ? gap : 0);
  }
  const lineBlock = lines.length > 1 ? top - gap : top;
  const width = Math.ceil(2 * padding + maxW), height = Math.ceil(2 * padding + lineBlock);
  // A font's metrics decide the canvas: a hostile advance or ascender must not become a
  // gigapixel image. (Also catches NaN/negative sizes.)
  const limit = Math.min(maxPixels, LIMITS.canvasPixels);
  if (!(width > 0 && height > 0 && width * height <= limit)) {
    return { tag: 'Err', error: { tag: 'CanvasTooLarge', width, height, limit } };
  }
  return {
    tag: 'Ok',
    value: { width, height, background, items },
  };
}
