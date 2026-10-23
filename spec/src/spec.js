// @ts-check
// Scene specs: a scene as JSON data, so a generic renderer (a Worker) needs no fonts, no code and
// no configuration of its own. Fonts are referenced by URL; geometry is SVG path data or shapes;
// text is shaped by the renderer; `params` let a request fill in text.
//
//   parseSpec(json, limits)  → Result<Spec, SpecError[]>   validate everything, report every error
//   compile(spec, ctx)       → Result<Scene, SpecError[]>  with fonts loaded, at a device pixel ratio
//
// Coordinates are CSS px (y down); `dpr` scales the whole scene. Gradients are in page space.
// Geometry compiles to *deferred* paths (render/src/scene.js): the scene holds the source string
// and a hull, and the renderer builds each path when its band sweep reaches it.
//
// {
//   "glyph": 1, "size": [w, h], "background": Paint,
//   "fonts": { "<name>": "https://…" | { "url": "https://…", "sha256": "<hex>" } },
//   "params": { "<name>": "default text" },
//   "items": [ Item, … ]
// }
// Item: exactly one geometry key, plus optional "paint" (default "#000"), "stroke"
// { width, join, cap, miterLimit }, "rule" ("nonzero" | "evenodd"), "transform" [a b c d e f]:
//   "path": "M…"          SVG path data
//   "rect": [x, y, w, h], "r"?: corner radius     "circle": [cx, cy, r]     "ellipse": [cx, cy, rx, ry]
//   "polygon" | "polyline": [x0, y0, x1, y1, …]    "line": [x0, y0, x1, y1]   "star": [cx, cy, n, r, ri]
//   "circles": [cx, cy, r, …]   "rects": [x, y, w, h, …]   many in one item (dots, grids, scanlines)
//   "glyph": gid, "font": name                     one glyph, font units → page by "transform"
//   "text": "…${param}…", "font", "size", "tracking"?, "at"?: [x, y], "align"?: start|center|end,
//           "on"?: { "circle": [cx, cy, r], "start"?: rad, "fit"?: bool } | { "path": "M…", "spacing"?: "fit" | n, "offset"?: n },
//           "outline"?: [{ "width", "paint" }, …]  strokes under the glyphs, first painted first
//           "fit"?: max width: the size shrinks so the text fits (params can be any length)
//   "math": "\\frac{a}{b}…${param}…", "font", "size", "at"?: [x, y], "display"?: bool, "align"?: start|center|end
//           LaTeX math (math/src/tex.js) laid out with the font's OpenType MATH table; at = start of the baseline
//   "group": [Item, …]                             children under the group's "transform"
// Paint: "#rgb" | "#rgba" | "#rrggbb" | "#rrggbbaa" | [r, g, b, a?]
//        | { "linear": [x0, y0, x1, y1], "stops": [[t, Colour], …] } | { "radial": [cx, cy, r], "stops": … }

import { ok, err } from '../../otel-compact/src/adt.js';
import { hullBounds } from '../../outline/src/path.js';
import { svgPath, stroke as strokeOutline, rect, roundRect, circle, ellipse, polygon, polyline, line, star, subpaths } from '../../draw/src/draw.js';
import { linear, radial, isSolid } from '../../render/src/paint.js';
import { run, place, onCircle, alongPath, arcLength, chain, translate, scale } from '../../render/src/compose.js';
import { parseTex } from '../../math/src/tex.js';
import { typeset, placeMath } from '../../math/src/typeset.js';

/** @typedef {import('../../render/src/scene.js').RGBA} RGBA */
/** @typedef {import('../../render/src/paint.js').Paint} Paint */
/** @typedef {import('../../outline/src/path.js').Affine} Affine */
/** @typedef {import('../../render/src/scene.js').SceneItem} SceneItem */
/** @typedef {{ at: string, expected: string, found: string }} SpecError  at: JSON pointer */

/** Bounds on what a spec may ask for; a renderer serving the public should keep these. */
export const SPEC_LIMITS = Object.freeze({
  items: 250_000,        // after group expansion
  depth: 16,             // group nesting
  pathChars: 16 << 20,   // all path data, total
  textChars: 4096,       // one text or math item, after params
  fonts: 16,
  params: 32,
  paramChars: 512,
  side: 16384,           // CSS px per side
  stops: 64,
});

/** @typedef {{ name: string, url: string, sha256: string }} FontRef  sha256 '' when not pinned */
/** @typedef {{ width: number, join: 'miter' | 'round' | 'bevel', cap: 'butt' | 'round' | 'square', miterLimit: number }} StrokeSpec */
/**
 * @typedef {object} Common
 * @property {Paint} paint @property {StrokeSpec | null} stroke @property {'nonzero' | 'evenodd'} rule @property {Affine} transform
 */
/**
 * @typedef {(Common & { kind: 'path', d: string, hull: readonly [number, number, number, number] })
 *   | (Common & { kind: 'shape', shape: string, args: number[] })
 *   | (Common & { kind: 'glyph', gid: number, font: string })
 *   | (Common & { kind: 'text', text: string, font: string, size: number, fit: number, tracking: number, at: [number, number], align: 'start' | 'center' | 'end',
 *       on: { kind: 'none' } | { kind: 'circle', cx: number, cy: number, r: number, start: number, fit: boolean } | { kind: 'path', d: string, spacing: number | 'fit', offset: number },
 *       outline: { width: number, paint: Paint }[] })
 *   | (Common & { kind: 'math', tex: string, font: string, size: number, at: [number, number], display: boolean, align: 'start' | 'center' | 'end' })
 *   | (Common & { kind: 'group', items: Item[] })} Item
 */
/** @typedef {{ width: number, height: number, background: RGBA, fonts: FontRef[], params: Record<string, string>, items: Item[], count: number }} Spec */

const IDENTITY = /** @type {Affine} */ (Object.freeze([1, 0, 0, 1, 0, 0]));
const BLACK = /** @type {RGBA} */ (Object.freeze([0, 0, 0, 255]));
const has = (/** @type {object} */ o, /** @type {string} */ k) => Object.prototype.hasOwnProperty.call(o, k);
const isObj = (/** @type {unknown} */ v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const show = (/** @type {unknown} */ v) => { const s = JSON.stringify(v); return typeof s === 'string' ? (s.length > 60 ? `${s.slice(0, 57)}...` : s) : String(v); };
const GEOMETRY = ['path', 'rect', 'circle', 'ellipse', 'polygon', 'polyline', 'line', 'star', 'circles', 'rects', 'glyph', 'text', 'math', 'group'];
const SHAPE_ARITY = /** @type {Record<string, number>} */ ({ rect: 4, circle: 3, ellipse: 4, line: 4, star: 5 });

/**
 * Validate a spec. Every problem is reported (not just the first), each with a JSON pointer.
 * @param {unknown} json @param {typeof SPEC_LIMITS} [limits]
 * @returns {import('../../otel-compact/src/adt.js').Result<Spec, SpecError[]>}
 */
export function parseSpec(json, limits = SPEC_LIMITS) {
  /** @type {SpecError[]} */
  const errors = [];
  const bad = (/** @type {string} */ at, /** @type {string} */ expected, /** @type {unknown} */ found) => { if (errors.length < 50) errors.push({ at, expected, found: show(found) }); };
  if (!isObj(json)) return err([{ at: '', expected: 'an object', found: show(json) }]);
  const o = /** @type {Record<string, unknown>} */ (json);
  if (o.glyph !== 1) bad('/glyph', 'spec version 1', o.glyph);
  const num = (/** @type {string} */ at, /** @type {unknown} */ v, lo = -1e7, hi = 1e7) => {
    if (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi) return v;
    bad(at, `a number in [${lo}, ${hi}]`, v); return 0;
  };
  const nums = (/** @type {string} */ at, /** @type {unknown} */ v, /** @type {number} */ n, multipleOf = 0) => {
    if (!Array.isArray(v) || (n && v.length !== n) || (multipleOf && (v.length % multipleOf || !v.length))) { bad(at, n ? `${n} numbers` : `numbers, a multiple of ${multipleOf}`, v); return []; }
    return v.map((x, i) => num(`${at}/${i}`, x));
  };
  const str = (/** @type {string} */ at, /** @type {unknown} */ v, max = 1 << 20) => {
    if (typeof v === 'string' && v.length <= max) return v;
    bad(at, `a string of at most ${max} characters`, v); return '';
  };
  const colour = (/** @type {string} */ at, /** @type {unknown} */ v) => {
    if (typeof v === 'string' && /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(v)) {
      const h = v.slice(1), full = h.length <= 4 ? [...h].map((c) => c + c).join('') : h;
      const b = [0, 2, 4, 6].map((i) => (i < full.length ? parseInt(full.slice(i, i + 2), 16) : 255));
      return /** @type {RGBA} */ (Object.freeze(b));
    }
    if (Array.isArray(v) && (v.length === 3 || v.length === 4) && v.every((x) => Number.isInteger(x) && x >= 0 && x <= 255)) {
      return /** @type {RGBA} */ (Object.freeze(v.length === 3 ? [...v, 255] : [...v]));
    }
    bad(at, 'a colour: #rgb, #rgba, #rrggbb, #rrggbbaa or [r, g, b, a?] (0-255)', v); return BLACK;
  };
  /** @returns {Paint} */
  const paint = (/** @type {string} */ at, /** @type {unknown} */ v) => {
    if (!isObj(v)) return colour(at, v);
    const p = /** @type {Record<string, unknown>} */ (v);
    const stops = () => {
      if (!Array.isArray(p.stops) || !p.stops.length || p.stops.length > limits.stops) { bad(`${at}/stops`, `1 to ${limits.stops} stops`, p.stops); return []; }
      return p.stops.map((s, i) => (Array.isArray(s) && s.length === 2
        ? /** @type {[number, RGBA]} */ ([num(`${at}/stops/${i}/0`, s[0], 0, 1), colour(`${at}/stops/${i}/1`, s[1])])
        : (bad(`${at}/stops/${i}`, '[offset 0..1, colour]', s), /** @type {[number, RGBA]} */ ([0, BLACK]))));
    };
    if (has(p, 'linear')) { const [x0, y0, x1, y1] = nums(`${at}/linear`, p.linear, 4); return linear(x0, y0, x1, y1, stops()); }
    if (has(p, 'radial')) { const [cx, cy, r] = nums(`${at}/radial`, p.radial, 3); return radial(cx, cy, r, stops()); }
    bad(at, 'a colour, or { linear } or { radial } with stops', v); return BLACK;
  };
  const transform = (/** @type {string} */ at, /** @type {unknown} */ v) => {
    const t = nums(at, v, 6);
    return t.length === 6 ? /** @type {Affine} */ (/** @type {unknown} */ (t)) : IDENTITY;
  };
  const strokeSpec = (/** @type {string} */ at, /** @type {unknown} */ v) => {
    if (!isObj(v)) { bad(at, '{ width, join?, cap?, miterLimit? }', v); return null; }
    const s = /** @type {Record<string, unknown>} */ (v);
    const join = has(s, 'join') ? s.join : 'miter', cap = has(s, 'cap') ? s.cap : 'butt';
    if (join !== 'miter' && join !== 'round' && join !== 'bevel') bad(`${at}/join`, 'miter | round | bevel', join);
    if (cap !== 'butt' && cap !== 'round' && cap !== 'square') bad(`${at}/cap`, 'butt | round | square', cap);
    return /** @type {StrokeSpec} */ ({ width: num(`${at}/width`, s.width, 0, 1e4), join, cap, miterLimit: has(s, 'miterLimit') ? num(`${at}/miterLimit`, s.miterLimit, 1, 100) : 4 });
  };

  // Size, background.
  const size = nums('/size', o.size, 2);
  const [width, height] = size.length === 2 ? size : [0, 0];
  if (size.length === 2 && !(width >= 1 && height >= 1 && width <= limits.side && height <= limits.side)) bad('/size', `[w, h], each 1..${limits.side}`, o.size);
  // A colour: a gradient background is a full-size rect item.
  const background = has(o, 'background') ? colour('/background', o.background) : /** @type {RGBA} */ ([255, 255, 255, 255]);

  // Fonts.
  /** @type {FontRef[]} */
  const fonts = [];
  if (has(o, 'fonts')) {
    if (!isObj(o.fonts)) bad('/fonts', 'an object of name → url', o.fonts);
    else {
      const entries = Object.entries(/** @type {Record<string, unknown>} */ (o.fonts));
      if (entries.length > limits.fonts) bad('/fonts', `at most ${limits.fonts} fonts`, entries.length);
      for (const [name, v] of entries) {
        const at = `/fonts/${name}`;
        const r = isObj(v) ? /** @type {Record<string, unknown>} */ (v) : { url: v };
        const url = str(`${at}/url`, r.url, 2048);
        if (url && !/^https:\/\//.test(url)) bad(`${at}/url`, 'an https:// URL', url);
        const sha = has(r, 'sha256') ? str(`${at}/sha256`, r.sha256, 64) : '';
        if (sha && !/^[0-9a-f]{64}$/.test(sha)) bad(`${at}/sha256`, '64 lowercase hex digits', sha);
        fonts.push({ name, url, sha256: sha });
      }
    }
  }
  const fontNames = new Set(fonts.map((f) => f.name));

  // Params.
  /** @type {Record<string, string>} */
  const params = {};
  if (has(o, 'params')) {
    if (!isObj(o.params)) bad('/params', 'an object of name → default text', o.params);
    else {
      const entries = Object.entries(/** @type {Record<string, unknown>} */ (o.params));
      if (entries.length > limits.params) bad('/params', `at most ${limits.params} params`, entries.length);
      for (const [k, v] of entries) {
        if (!/^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(k)) bad(`/params/${k}`, 'a name: a letter, then letters, digits or _', k);
        params[k] = str(`/params/${k}`, v, limits.paramChars);
      }
    }
  }

  // Items.
  let count = 0, pathChars = 0;
  /** @returns {Item[]} */
  const items = (/** @type {string} */ at, /** @type {unknown} */ v, /** @type {number} */ depth) => {
    if (!Array.isArray(v)) { bad(at, 'an array of items', v); return []; }
    if (depth > limits.depth) { bad(at, `groups nested at most ${limits.depth} deep`, depth); return []; }
    /** @type {Item[]} */
    const out = [];
    v.forEach((raw, i) => {
      const ia = `${at}/${i}`;
      if (++count > limits.items) { if (count === limits.items + 1) bad(ia, `at most ${limits.items} items`, count); return; }
      if (!isObj(raw)) { bad(ia, 'an item object', raw); return; }
      const it = /** @type {Record<string, unknown>} */ (raw);
      const kinds = GEOMETRY.filter((k) => has(it, k));
      if (kinds.length !== 1) { bad(ia, `exactly one of ${GEOMETRY.join(', ')}`, Object.keys(it)); return; }
      const kind = kinds[0];
      const rule = has(it, 'rule') ? it.rule : 'nonzero';
      if (rule !== 'nonzero' && rule !== 'evenodd') bad(`${ia}/rule`, 'nonzero | evenodd', rule);
      /** @type {Common} */
      const common = {
        paint: has(it, 'paint') ? paint(`${ia}/paint`, it.paint) : BLACK,
        stroke: has(it, 'stroke') ? strokeSpec(`${ia}/stroke`, it.stroke) : null,
        rule: rule === 'evenodd' ? 'evenodd' : 'nonzero',
        transform: has(it, 'transform') ? transform(`${ia}/transform`, it.transform) : IDENTITY,
      };
      if (kind === 'path') {
        const d = str(`${ia}/path`, it.path, limits.pathChars);
        pathChars += d.length;
        if (pathChars > limits.pathChars) { bad(`${ia}/path`, `at most ${limits.pathChars} characters of path data in all`, pathChars); return; }
        const p = svgPath(d);
        if (p.tag === 'Err') { bad(`${ia}/path`, `SVG path data (at ${p.error.at}: expected ${p.error.expected})`, p.error.found); return; }
        // Keep the source and its hull, not the parsed path: a spec can carry far more geometry than
        // should be held as objects at once (the renderer rebuilds each path in its band sweep).
        const h = hullBounds(p.value);
        out.push({ ...common, kind: 'path', d, hull: h ? [h[0], h[1], h[2], h[3]] : [Infinity, Infinity, -Infinity, -Infinity] });
      } else if (kind === 'polygon' || kind === 'polyline' || kind === 'circles' || kind === 'rects') {
        const k = kind === 'circles' ? 3 : kind === 'rects' ? 4 : 2;
        const args = nums(`${ia}/${kind}`, it[kind], 0, k);
        pathChars += args.length * 4; // budgeted like path data
        if (pathChars > limits.pathChars) { bad(`${ia}/${kind}`, `at most ${limits.pathChars} characters of geometry in all`, pathChars); return; }
        out.push({ ...common, kind: 'shape', shape: kind, args });
      } else if (kind === 'rect' || kind === 'circle' || kind === 'ellipse' || kind === 'line' || kind === 'star') {
        const args = nums(`${ia}/${kind}`, it[kind], SHAPE_ARITY[kind]);
        if (kind === 'rect' && has(it, 'r')) args.push(num(`${ia}/r`, it.r, 0, 1e6));
        if (kind === 'star' && args.length === 5 && !(Number.isInteger(args[2]) && args[2] >= 2 && args[2] <= 1000)) bad(`${ia}/star/2`, 'points: an integer 2..1000', args[2]);
        out.push({ ...common, kind: 'shape', shape: kind, args });
      } else if (kind === 'glyph') {
        const font = str(`${ia}/font`, it.font, 64);
        if (!fontNames.has(font)) bad(`${ia}/font`, `a font declared in /fonts`, font);
        const gid = num(`${ia}/glyph`, it.glyph, 0, 65535);
        if (!Number.isInteger(gid)) bad(`${ia}/glyph`, 'an integer glyph id', it.glyph);
        out.push({ ...common, kind: 'glyph', gid, font });
      } else if (kind === 'text') {
        const font = str(`${ia}/font`, it.font, 64);
        if (!fontNames.has(font)) bad(`${ia}/font`, 'a font declared in /fonts', font);
        const text = str(`${ia}/text`, it.text, limits.textChars);
        for (const m of text.matchAll(/\$\{([^}]*)\}/g)) if (!has(params, m[1])) bad(`${ia}/text`, `\${name} of a declared param`, m[0]);
        const align = has(it, 'align') ? it.align : 'start';
        if (align !== 'start' && align !== 'center' && align !== 'end') bad(`${ia}/align`, 'start | center | end', align);
        const at2 = has(it, 'at') ? nums(`${ia}/at`, it.at, 2) : [0, 0];
        /** @type {Extract<Item, { kind: 'text' }>['on']} */
        let on = { kind: 'none' };
        if (has(it, 'on')) {
          const v2 = it.on;
          if (isObj(v2) && has(/** @type {object} */ (v2), 'circle')) {
            const c = /** @type {Record<string, unknown>} */ (v2);
            const [cx, cy, r] = nums(`${ia}/on/circle`, c.circle, 3);
            on = { kind: 'circle', cx, cy, r, start: has(c, 'start') ? num(`${ia}/on/start`, c.start, -100, 100) : 0, fit: c.fit === true };
          } else if (isObj(v2) && has(/** @type {object} */ (v2), 'path')) {
            const c = /** @type {Record<string, unknown>} */ (v2);
            const d = str(`${ia}/on/path`, c.path, 1 << 20);
            if (svgPath(d).tag === 'Err') bad(`${ia}/on/path`, 'SVG path data', d);
            const spacing = !has(c, 'spacing') ? 1 : c.spacing === 'fit' ? 'fit' : num(`${ia}/on/spacing`, c.spacing, 0.01, 100);
            on = { kind: 'path', d, spacing, offset: has(c, 'offset') ? num(`${ia}/on/offset`, c.offset) : 0 };
          } else bad(`${ia}/on`, '{ circle: [cx, cy, r] } or { path: "M…" }', v2);
        }
        const outline = !has(it, 'outline') ? [] : Array.isArray(it.outline)
          ? it.outline.slice(0, 8).map((s, j) => (isObj(s)
            ? { width: num(`${ia}/outline/${j}/width`, /** @type {any} */ (s).width, 0, 1e4), paint: paint(`${ia}/outline/${j}/paint`, /** @type {any} */ (s).paint) }
            : (bad(`${ia}/outline/${j}`, '{ width, paint }', s), { width: 0, paint: BLACK })))
          : (bad(`${ia}/outline`, 'an array of { width, paint }', it.outline), []);
        out.push({
          ...common, kind: 'text', text, font, size: num(`${ia}/size`, it.size, 0.01, 1e5),
          fit: has(it, 'fit') ? num(`${ia}/fit`, it.fit, 0, 1e6) : 0,
          tracking: has(it, 'tracking') ? num(`${ia}/tracking`, it.tracking, -1e4, 1e4) : 0,
          at: [at2[0] ?? 0, at2[1] ?? 0], align: align === 'center' ? 'center' : align === 'end' ? 'end' : 'start', on, outline,
        });
      } else if (kind === 'math') {
        const font = str(`${ia}/font`, it.font, 64);
        if (!fontNames.has(font)) bad(`${ia}/font`, 'a font declared in /fonts', font);
        const tex = str(`${ia}/math`, it.math, limits.textChars);
        for (const m of tex.matchAll(/\$\{([^}]*)\}/g)) if (!has(params, m[1])) bad(`${ia}/math`, `\${name} of a declared param`, m[0]);
        // Without params the LaTeX is checked here, with its offset; with params, at compile.
        if (!/\$\{/.test(tex)) { const t = parseTex(tex); if (t.tag === 'Err') bad(`${ia}/math`, `TeX math (${texError(t.error)})`, tex); }
        const align = has(it, 'align') ? it.align : 'start';
        if (align !== 'start' && align !== 'center' && align !== 'end') bad(`${ia}/align`, 'start | center | end', align);
        if (has(it, 'display') && typeof it.display !== 'boolean') bad(`${ia}/display`, 'true | false', it.display);
        const at2 = has(it, 'at') ? nums(`${ia}/at`, it.at, 2) : [0, 0];
        out.push({
          ...common, kind: 'math', tex, font, size: num(`${ia}/size`, it.size, 0.01, 1e5), at: [at2[0] ?? 0, at2[1] ?? 0],
          display: it.display === true, align: align === 'center' ? 'center' : align === 'end' ? 'end' : 'start',
        });
      } else {
        out.push({ ...common, kind: 'group', items: items(`${ia}/group`, it.group, depth + 1) });
      }
    });
    return out;
  };
  const list = items('/items', o.items, 0);
  if (errors.length) return err(errors);
  return ok({ width, height, background, fonts, params, items: list, count });
}

/**
 * @typedef {object} CompileCtx
 * @property {Map<string, { font: import('../../sfnt/src/font.js').Font, key: string }>} fonts  by spec font name; key: content-derived (glyph cache key)
 * @property {number} dpr
 * @property {Record<string, string>} params   overrides of declared params
 * @property {number} [maxPixels]
 */

/**
 * Compile a parsed spec into a scene. Shaping errors and missing characters are reported, not
 * drawn as .notdef boxes; params must be declared.
 * @param {Spec} spec @param {CompileCtx} ctx @param {typeof SPEC_LIMITS} [limits]
 * @returns {import('../../otel-compact/src/adt.js').Result<import('../../render/src/scene.js').Scene, SpecError[]>}
 */
export function compile(spec, ctx, limits = SPEC_LIMITS) {
  /** @type {SpecError[]} */
  const errors = [];
  const { dpr } = ctx;
  if (!(dpr > 0 && dpr <= 4)) return err([{ at: '?dpr', expected: 'a number in (0, 4]', found: String(dpr) }]);
  const W = Math.round(spec.width * dpr), H = Math.round(spec.height * dpr);
  const maxPixels = ctx.maxPixels ?? (1 << 25);
  if (W * H > maxPixels) return err([{ at: '/size', expected: `at most ${maxPixels} pixels at this dpr`, found: `${W}×${H}` }]);
  /** @type {Record<string, string>} */
  const params = { ...spec.params };
  for (const [k, v] of Object.entries(ctx.params)) {
    if (!has(spec.params, k)) errors.push({ at: `?p.${k}`, expected: `a param declared in /params (${Object.keys(spec.params).join(', ') || 'none'})`, found: k });
    else if (v.length > limits.paramChars) errors.push({ at: `?p.${k}`, expected: `at most ${limits.paramChars} characters`, found: String(v.length) });
    else params[k] = v;
  }
  for (const f of spec.fonts) if (!ctx.fonts.has(f.name)) errors.push({ at: `/fonts/${f.name}`, expected: 'a loaded font', found: 'not loaded' });
  if (errors.length) return err(errors);

  const root = scale(dpr);
  // Gradients are in page space: scale their geometry, not their colours.
  /** @param {Paint} p @returns {Paint} */
  const page = (p) => (isSolid(p) ? p
    : p.kind === 'linear' ? linear(p.x0 * dpr, p.y0 * dpr, p.x1 * dpr, p.y1 * dpr, p.stops)
      : radial(p.cx * dpr, p.cy * dpr, p.r * dpr, p.stops));
  /** @type {SceneItem[]} */
  const out = [];
  const det = (/** @type {Affine} */ m) => Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1;
  /** Deferred geometry: the source is kept, the path is built when rendered. */
  const defer = (/** @type {() => import('../../outline/src/path.js').Path} */ force, /** @type {string} */ id, /** @type {readonly [number, number, number, number]} */ hull) =>
    ({ tag: /** @type {const} */ ('Deferred'), hull, force, describe: () => id });
  /** A stroke of a source path, deferred, with flattening matched to device pixels. */
  const strokeOf = (/** @type {() => import('../../outline/src/path.js').Path} */ src, /** @type {StrokeSpec} */ s, /** @type {Affine} */ m, /** @type {string} */ id, /** @type {readonly [number, number, number, number]} */ h) => {
    const opts = { width: s.width, join: s.join, cap: s.cap, miterLimit: s.miterLimit, tolerance: 0.02 / det(m) };
    const reach = (s.width / 2) * Math.max(1, s.join === 'miter' ? s.miterLimit : 1, s.cap === 'square' ? Math.SQRT2 : 1);
    /** @type {readonly [number, number, number, number]} */
    const hull = [h[0] - reach, h[1] - reach, h[2] + reach, h[3] + reach];
    return { tag: /** @type {const} */ ('Deferred'), hull, force: () => strokeOutline(src(), opts), describe: () => `stroke(${JSON.stringify(opts)}):${id}` };
  };
  let n = 0;
  /** @type {Map<string, import('../../render/src/scene.js').DeferredPath>} glyph outlines, shared per (font, gid, width) */
  const outlines = new Map();
  const shapePath = (/** @type {string} */ shape, /** @type {number[]} */ a) =>
    shape === 'rect' ? (a.length === 5 ? roundRect(a[0], a[1], a[2], a[3], a[4]) : rect(a[0], a[1], a[2], a[3]))
      : shape === 'circle' ? circle(a[0], a[1], a[2]) : shape === 'ellipse' ? ellipse(a[0], a[1], a[2], a[3])
        : shape === 'line' ? line(a[0], a[1], a[2], a[3]) : shape === 'star' ? star(a[0], a[1], a[2], a[3], a[4])
          : shape === 'circles' ? many(a, 3, (o) => circle(a[o], a[o + 1], a[o + 2]))
            : shape === 'rects' ? many(a, 4, (o) => rect(a[o], a[o + 1], a[o + 2], a[o + 3]))
              : (shape === 'polygon' ? polygon : polyline)(pairs(a));
  /** @param {Item[]} list @param {Affine} parent @param {string} at */
  const walk = (list, parent, at) => list.forEach((it, i) => {
    const m = chain(parent, it.transform), ia = `${at}/${i}`, paint = page(it.paint);
    const push = (/** @type {import('../../render/src/scene.js').Geometry} */ g, /** @type {Affine} */ t = m, /** @type {Paint} */ p = paint) =>
      out.push({ path: g, key: `spec:${n++}`, transform: t, fill: p, rule: it.rule });
    if (it.kind === 'group') { walk(it.items, m, `${ia}/group`); return; }
    if (it.kind === 'path' || it.kind === 'shape') {
      const id = it.kind === 'path' ? it.d : `${it.shape}(${it.args.join(',')})`;
      const make = it.kind === 'path' ? () => { const r = svgPath(it.d); return r.tag === 'Ok' ? r.value : []; } : () => shapePath(it.shape, it.args);
      const hull = it.kind === 'path' ? it.hull : hullOf(make());
      push(it.stroke ? strokeOf(make, it.stroke, m, id, hull) : defer(make, id, hull));
      return;
    }
    const f = /** @type {{ font: import('../../sfnt/src/font.js').Font, key: string }} */ (ctx.fonts.get(it.font));
    if (it.kind === 'math') {
      const tex = it.tex.replace(/\$\{([^}]*)\}/g, (_, k) => params[k]);
      const r = typeset(f.font, f.key, tex, { size: it.size, display: it.display });
      if (r.tag === 'Err') {
        const e = r.error;
        errors.push(e.tag === 'Table' ? { at: `${ia}/font`, expected: 'a font with an OpenType MATH table', found: `${it.font}: ${show(e.error)}` }
          : e.tag === 'Tex' ? { at: `${ia}/math`, expected: `TeX math (${texError(e.error)})`, found: show(tex) }
            : e.tag === 'Layout' && e.error.tag === 'MissingGlyph' ? { at: `${ia}/math`, expected: `characters in font "${it.font}"`, found: `U+${e.error.cp.toString(16).toUpperCase()} at ${e.error.at}` }
              : { at: `${ia}/math`, expected: 'math the font can lay out', found: show(e) });
        return;
      }
      const dx = it.align === 'center' ? -r.value.width / 2 : it.align === 'end' ? -r.value.width : 0;
      for (const g of placeMath(r.value, chain(m, translate(it.at[0] + dx, it.at[1])), paint)) out.push(g);
      return;
    }
    if (it.kind === 'glyph') {
      const p = f.font.path(it.gid);
      if (p.tag === 'Err') { errors.push({ at: `${ia}/glyph`, expected: 'a glyph the font can draw', found: String(it.gid) }); return; }
      out.push({ path: p.value, key: `${f.key}-${it.gid}`, transform: m, fill: paint, rule: it.rule });
      return;
    }
    // Text.
    const text = it.text.replace(/\$\{([^}]*)\}/g, (_, k) => params[k]);
    let r = run(f.font, f.key, text, it.size, { tracking: it.tracking });
    if (r.tag === 'Err') { errors.push({ at: `${ia}/text`, expected: 'text the font can shape', found: show(r.error) }); return; }
    // "fit": shrink to a maximum width (param text can be any length), tracking with it.
    if (it.fit > 0 && r.value.width > it.fit) {
      const k = it.fit / r.value.width;
      r = run(f.font, f.key, text, it.size * k, { tracking: it.tracking * k });
      if (r.tag === 'Err') { errors.push({ at: `${ia}/text`, expected: 'text the font can shape', found: show(r.error) }); return; }
    }
    const rn = r.value;
    if (rn.missing) { errors.push({ at: `${ia}/text`, expected: `characters in font "${it.font}"`, found: `${rn.missing} missing in ${show(text)}` }); return; }
    const dx = it.align === 'center' ? -rn.width / 2 : it.align === 'end' ? -rn.width : 0;
    /** @type {SceneItem[]} */
    let glyphs;
    if (it.on.kind === 'circle') glyphs = onCircle(rn, { cx: it.on.cx, cy: it.on.cy, r: it.on.r, start: it.on.start, fit: it.on.fit }, it.paint);
    else if (it.on.kind === 'path') {
      const pts = subpaths((() => { const p = svgPath(it.on.d); return p.tag === 'Ok' ? p.value : []; })(), 0.05)[0];
      const curve = polylineCurve(pts ? pts.pts : [0, 0, 1, 0]);
      glyphs = alongPath(rn, curve, it.paint, { spacing: it.on.spacing === 'fit' ? curve.length / rn.width : it.on.spacing, offset: it.on.offset });
    } else glyphs = place(rn, translate(it.at[0] + dx, it.at[1]), it.paint);
    for (const o of it.outline) {
      const op = page(o.paint);
      for (const g of glyphs) {
        const s = det(g.transform), k = `${g.key}|${o.width / s}`;
        let d = outlines.get(k);
        if (!d) {
          const src = /** @type {import('../../outline/src/path.js').Path} */ (g.path);
          d = strokeOf(() => src, { width: o.width / s, join: 'round', cap: 'butt', miterLimit: 4 }, chain(m, g.transform), `${g.key}`, hullOf(src));
          outlines.set(k, d);
        }
        push(d, chain(m, g.transform), op);
      }
    }
    for (const g of glyphs) out.push({ ...g, transform: chain(m, g.transform), fill: page(/** @type {Paint} */ (g.fill)) });
  });
  walk(spec.items, root, '/items');
  if (errors.length) return err(errors);
  return ok({ width: W, height: H, background: spec.background, items: out });
}

/** A TexError as one line: what, and where in the source. @param {import('../../math/src/tex.js').TexErrorT} e */
const texError = (e) => {
  const at = 'at' in e ? ` at ${e.at}` : '';
  switch (e.tag) {
    case 'UnknownCommand': return `unknown command ${e.name}${at}`;
    case 'UnknownEnvironment': return `unknown environment ${e.name}${at}`;
    case 'Unexpected': return `expected ${e.expected}, found ${e.found}${at}`;
    case 'DoubleScript': return `double ${e.script}${at}`;
    case 'MissingArgument': return `${e.name} needs an argument${at}`;
    case 'BadDelimiter': return `${e.found} is not a delimiter${at}`;
    case 'TooDeep': return `nested deeper than ${e.limit}${at}`;
    case 'TooLong': return `${e.length} characters, more than ${e.limit}`;
  }
};

/** @param {import('../../outline/src/path.js').Path} p @returns {readonly [number, number, number, number]} */
const hullOf = (p) => { const h = hullBounds(p); return h ? [h[0], h[1], h[2], h[3]] : [Infinity, Infinity, -Infinity, -Infinity]; };

/** Concatenate one path per `k` numbers. @param {number[]} a @param {number} k @param {(o: number) => import('../../outline/src/path.js').Path} f */
const many = (a, k, f) => { const out = []; for (let o = 0; o + k <= a.length; o += k) for (const s of f(o)) out.push(s); return out; };

/** @param {number[]} a @returns {[number, number][]} */
const pairs = (a) => { const out = /** @type {[number, number][]} */ ([]); for (let i = 0; i + 1 < a.length; i += 2) out.push([a[i], a[i + 1]]); return out; };

/** Arc-length parametrisation of a polyline (flat x, y list), as compose's arcLength expects. @param {number[]} pts */
function polylineCurve(pts) {
  const n = pts.length / 2, S = [0];
  for (let i = 1; i < n; i++) S.push(S[i - 1] + Math.hypot(pts[2 * i] - pts[2 * i - 2], pts[2 * i + 1] - pts[2 * i - 1]));
  const L = S[n - 1] || 1;
  return arcLength((u) => {
    const s = u * L;
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (S[mid] <= s) lo = mid; else hi = mid; }
    const k = S[hi] > S[lo] ? (s - S[lo]) / (S[hi] - S[lo]) : 0;
    return /** @type {[number, number]} */ ([pts[2 * lo] + (pts[2 * hi] - pts[2 * lo]) * k, pts[2 * lo + 1] + (pts[2 * hi + 1] - pts[2 * lo + 1]) * k]);
  }, Math.min(1 << 14, Math.max(256, n * 4)));
}

/**
 * @typedef {object} LoadedFont
 * @property {import('../../sfnt/src/font.js').Font} font
 * @property {string} key   content-derived (e.g. a SHA-256 prefix): glyph outlines are cached by it
 */
/**
 * @typedef {{ tag: 'Spec', errors: SpecError[] } | { tag: 'Font', name: string, url: string, error: unknown }} BuildError
 */

/**
 * Spec JSON → scene: parse, load every font (concurrently, through `loadFont`, which owns fetching,
 * caching and verification), compile. The one code path for every renderer of specs.
 * @param {unknown} json
 * @param {{ dpr: number, params: Record<string, string>, loadFont: (ref: FontRef) => Promise<import('../../otel-compact/src/adt.js').Result<LoadedFont, unknown>>, limits?: typeof SPEC_LIMITS, maxPixels?: number }} opts
 * @returns {Promise<import('../../otel-compact/src/adt.js').Result<{ spec: Spec, scene: import('../../render/src/scene.js').Scene }, BuildError>>}
 */
export async function buildScene(json, opts) {
  const limits = opts.limits ?? SPEC_LIMITS;
  const parsed = parseSpec(json, limits);
  if (parsed.tag === 'Err') return err({ tag: 'Spec', errors: parsed.error });
  const spec = parsed.value;
  const loaded = await Promise.all(spec.fonts.map(async (f) => /** @type {const} */ ([f, await opts.loadFont(f)])));
  /** @type {Map<string, LoadedFont>} */
  const fonts = new Map();
  for (const [f, r] of loaded) {
    if (r.tag === 'Err') return err({ tag: 'Font', name: f.name, url: f.url, error: r.error });
    fonts.set(f.name, r.value);
  }
  const scene = compile(spec, { fonts, dpr: opts.dpr, params: opts.params, ...(opts.maxPixels ? { maxPixels: opts.maxPixels } : {}) }, limits);
  if (scene.tag === 'Err') return err({ tag: 'Spec', errors: scene.error });
  return ok({ spec, scene: scene.value });
}
