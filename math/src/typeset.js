// @ts-check
// LaTeX math → a run of positioned glyphs and rules → SceneItems. The one entry point:
//
//   typeset(font, fontKey, latex, { size, display })  → Result<MathRun, TypesetError>
//   placeMath(run, m, paint)                           → SceneItem[]   (origin: start of the baseline)
//
// The MATH table is parsed once per font (memoised by the Font object).

import { variants, ok, err } from '../../otel-compact/src/adt.js';
import { Seg } from '../../outline/src/path.js';
import { chain } from '../../render/src/compose.js';
import { mathOf } from './table.js';
import { parseTex, TEX_LIMITS } from './tex.js';
import { layoutMath } from './layout.js';

export const TypesetError = variants('TypesetError', {
  Tex: ['error'],     // TexError: the source, with an offset
  Table: ['error'],   // MathError: the font has no usable MATH table
  Layout: ['error'],  // MathLayoutError: a glyph the formula needs
  Size: ['size'],
});
/** @typedef {import('../../otel-compact/src/adt.js').Of<typeof TypesetError>} TypesetErrorT */

/**
 * @typedef {object} MathRun
 * @property {string} fontKey
 * @property {number} size     px per em
 * @property {number} s        px per font unit
 * @property {number} width    px
 * @property {number} ascent   px above the baseline (ink)
 * @property {number} descent  px below the baseline (ink)
 * @property {{ gid: number, x: number, y: number, k: number, path: import('../../outline/src/path.js').Path }[]} glyphs  font units, y up; k: script scale
 * @property {{ x: number, y: number, w: number, h: number }[]} rules  font units, y up (y: bottom)
 * @property {import('./layout.js').Token[]} tokens  font units: leaves as MathML boxes them (comparisons)
 */

/** @type {WeakMap<import('../../sfnt/src/font.js').Font, ReturnType<typeof mathOf>>} */
const TABLES = new WeakMap();

/**
 * @param {import('../../sfnt/src/font.js').Font} font @param {string} fontKey @param {string} latex
 * @param {{ size: number, display?: boolean, limits?: typeof TEX_LIMITS }} opts
 * @returns {import('../../otel-compact/src/adt.js').Result<MathRun, TypesetErrorT>}
 */
export function typeset(font, fontKey, latex, { size, display = false, limits = TEX_LIMITS }) {
  if (!(size > 0 && size <= 1e5)) return err(TypesetError.Size(size));
  let t = TABLES.get(font);
  if (!t) { t = mathOf(font); TABLES.set(font, t); }
  if (t.tag === 'Err') return err(TypesetError.Table(t.error));
  const ast = parseTex(latex, limits);
  if (ast.tag === 'Err') return err(TypesetError.Tex(ast.error));
  const box = layoutMath(font, t.value, ast.value, { display });
  if (box.tag === 'Err') return err(TypesetError.Layout(box.error));
  const s = size / font.unitsPerEm;
  /** @type {MathRun['glyphs']} */
  const glyphs = [];
  for (const g of box.value.glyphs) {
    const p = font.path(g.gid);
    // layoutMath read every outline it placed, so an Err here was already reported; skip defensively.
    if (p.tag === 'Ok' && p.value.length) glyphs.push({ ...g, path: p.value });
  }
  return ok({ fontKey, size, s, width: box.value.width * s, ascent: box.value.ascent * s, descent: box.value.descent * s, glyphs, rules: box.value.rules, tokens: box.value.tokens });
}

/**
 * A run's scene items under `m` (origin = the start of the baseline, y down, px).
 * @param {MathRun} run @param {import('../../outline/src/path.js').Affine} m @param {import('../../render/src/paint.js').Paint} paint
 * @returns {import('../../render/src/scene.js').SceneItem[]}
 */
export function placeMath(run, m, paint) {
  const s = run.s;
  /** @type {import('../../render/src/scene.js').SceneItem[]} */
  const out = run.glyphs.map((g) => ({
    path: g.path, key: `${run.fontKey}-${g.gid}`, transform: chain(m, [s * g.k, 0, 0, -s * g.k, g.x * s, -g.y * s]), fill: paint, rule: /** @type {const} */ ('nonzero'),
  }));
  for (const r of run.rules) {
    const x0 = r.x * s, y0 = -(r.y + r.h) * s, x1 = (r.x + r.w) * s, y1 = -r.y * s;
    out.push({
      path: [Seg.MoveTo(x0, y0), Seg.LineTo(x1, y0), Seg.LineTo(x1, y1), Seg.LineTo(x0, y1), Seg.Close],
      key: `math-rule:${x0},${y0},${x1},${y1}`, transform: m, fill: paint, rule: 'nonzero',
    });
  }
  return out;
}
