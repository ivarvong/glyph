// @ts-check
// Scene -> SVG. Each distinct outline is written once in <defs> (font units,
// y up) and placed with <use transform="matrix(...)">, so repeated glyphs cost
// one reference each and coordinates stay exact integers for TrueType.

import { Seg } from '../../outline/src/path.js';
import { NOOP_SPAN } from '../../otel-compact/src/trace.js';
import { isSolid, colourAt } from './paint.js';
import { geometry } from './scene.js';

/**
 * Outline coordinates (font units): shortest decimal within 1e-4 units.
 * Never use this for transforms: a scale of 13/2048 rounded to 4 places is
 * 0.75% too small (found by the Chromium convergence check in verify/compare.js).
 * @param {number} n
 */
export const num = (n) => {
  const r = Math.round(n * 1e4) / 1e4;
  return Object.is(r, -0) ? '0' : String(r);
};

/** Transforms: shortest string that round-trips to the same double. @param {number} n */
export const exact = (n) => (Object.is(n, -0) ? '0' : String(n));

/** @param {import('../../outline/src/path.js').Path} path */
export function pathData(path) {
  return path.map((s) => Seg.match(s, {
    MoveTo: ({ x, y }) => `M${num(x)} ${num(y)}`,
    LineTo: ({ x, y }) => `L${num(x)} ${num(y)}`,
    QuadTo: ({ x1, y1, x, y }) => `Q${num(x1)} ${num(y1)} ${num(x)} ${num(y)}`,
    CubicTo: ({ x1, y1, x2, y2, x, y }) => `C${num(x1)} ${num(y1)} ${num(x2)} ${num(y2)} ${num(x)} ${num(y)}`,
    Close: () => 'Z',
  })).join('');
}

/** @param {readonly number[]} c  RGB(A) bytes */
const hexOf = ([r, g, b]) => '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');

/** @param {import('./scene.js').RGBA} c */
const color = (c) => (c[3] === 255 ? `fill="${hexOf(c)}"` : `fill="${hexOf(c)}" fill-opacity="${num(c[3] / 255)}"`);

/**
 * Inverse of an affine map, or null when it is singular (the item then covers no area).
 * @param {import('../../outline/src/path.js').Affine} m @returns {number[] | null}
 */
const invert = ([a, b, c, d, e, f]) => {
  const det = a * d - b * c;
  if (det === 0 || !Number.isFinite(det)) return null;
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
};

/**
 * A gradient element for one item. Our gradients live in scene pixels; the referencing <use>
 * draws in the item's own space, so the gradient carries the inverse of the item's transform.
 * @param {import('./paint.js').Gradient} g @param {string} id @param {number[]} inv
 */
const gradientDef = (g, id, inv) => {
  const geo = g.kind === 'linear'
    ? `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${exact(g.x0)}" y1="${exact(g.y0)}" x2="${exact(g.x1)}" y2="${exact(g.y1)}"`
    : `<radialGradient id="${id}" gradientUnits="userSpaceOnUse" cx="${exact(g.cx)}" cy="${exact(g.cy)}" r="${exact(Math.max(0, g.r))}"`;
  const stop = (/** @type {number} */ t, /** @type {readonly number[]} */ c) => {
    const q = c.map(Math.round);
    return `<stop offset="${exact(t)}" stop-color="${hexOf(q)}"${q[3] === 255 ? '' : ` stop-opacity="${num(c[3] / 255)}"`}/>`;
  };
  // SVG renderers interpolate stops unpremultiplied (Chromium does: verify/draw.js); our paints
  // interpolate premultiplied. Where alpha changes between two stops the two differ, so the
  // span is resampled with SUB extra stops from our own colourAt.
  const SUB = 16, out = [];
  for (let i = 0; i < g.stops.length; i++) {
    const [t, c] = g.stops[i];
    out.push(stop(t, c));
    if (i + 1 === g.stops.length) break;
    const nx = g.stops[i + 1];
    if (nx[1][3] !== c[3] && nx[0] > t) for (let j = 1; j < SUB; j++) { const u = t + ((nx[0] - t) * j) / SUB; out.push(stop(u, colourAt(g.stops, u))); }
  }
  const stops = out.join('');
  return `${geo} gradientTransform="matrix(${inv.map(exact).join(' ')})">${stops}</${g.kind}Gradient>`;
};

/**
 * @param {import('./scene.js').Scene} scene
 * @param {{ title?: string, span?: import('../../otel-compact/src/trace.js').Span }} [opts]  title becomes <title>, so the text stays accessible
 * @returns {string}
 */
export function toSvg(scene, { title = '', span = NOOP_SPAN } = {}) {
  const { width: w, height: h } = scene;
  /** @type {Map<string, string>} */
  const defs = new Map();
  const ids = (/** @type {string} */ k) => 'g' + k.replace(/[^A-Za-z0-9_-]/g, '_');
  for (const it of scene.items) {
    if (!defs.has(it.key)) defs.set(it.key, span.span('svg.pathdata', { atomic: true, key: it.key }, () => pathData(geometry(it.path))));
  }
  return span.span('svg.document', { atomic: true, items: scene.items.length }, () => document(scene, defs, ids, title, w, h));
}

/**
 * @param {import('./scene.js').Scene} scene @param {Map<string, string>} defs @param {(k: string) => string} ids
 * @param {string} title  '' for none @param {number} w @param {number} h
 */
function document(scene, defs, ids, title, w, h) {
  const esc = (/** @type {string} */ s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"${title ? ' role="img"' : ''}>`,
    title ? `<title>${esc(title)}</title>` : '',
    `<rect width="${w}" height="${h}" ${color(scene.background)}/>`,
    `<defs>${[...defs].map(([k, d]) => `<path id="${ids(k)}" d="${d}"/>`).join('')}</defs>`,
    ...scene.items.map((it, i) => {
      const at = `<use href="#${ids(it.key)}" transform="matrix(${it.transform.map(exact).join(' ')})"${it.rule === 'evenodd' ? ' fill-rule="evenodd"' : ''}`;
      if (isSolid(it.fill)) return `${at} ${color(it.fill)}/>`;
      const inv = invert(it.transform);
      return inv ? `<defs>${gradientDef(it.fill, `p${i}`, inv)}</defs>${at} fill="url(#p${i})"/>` : '';
    }),
    '</svg>',
  ].filter(Boolean).join('\n') + '\n';
}
