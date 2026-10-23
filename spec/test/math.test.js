// The "math" spec item: validation with JSON pointers (LaTeX errors carry their offset), compile
// through typeset, and the authoring round trip (a scene with math → toSpec → the same pixels).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseSpec, compile, buildScene } from '../src/spec.js';
import { toSpec } from '../src/emit.js';
import { loadFont } from '../../sfnt/src/font.js';
import { typeset, placeMath } from '../../math/src/typeset.js';
import { translate } from '../../render/src/compose.js';
import { rasterize, scanline } from '../../render/src/raster.js';

const root = new URL('../../', import.meta.url).pathname;
const LMM = new Uint8Array(readFileSync(root + 'third_party/fonts/latinmodern-math.otf'));
const font = (await loadFont(LMM)).value;
const inter = (await loadFont(new Uint8Array(readFileSync(root + 'third_party/fonts/source-serif-4-regular.otf')))).value;
const URL_ = 'https://mirrors.ctan.org/fonts/lm-math/opentype/latinmodern-math.otf';
const spec = (items, extra = {}) => ({ glyph: 1, size: [400, 120], fonts: { lm: { url: URL_, sha256: '6075562b771f8b82f0c179e363389684f2dd09de30038269e2628e504bd7be0f' }, serif: 'https://example.com/s.otf' }, items, ...extra });
const fonts = new Map([['lm', { font, key: 'lm' }], ['serif', { font: inter, key: 'serif' }]]);

test('parseSpec: a math item validates; every problem is reported with a JSON pointer, LaTeX errors with their offset', () => {
  const ok = parseSpec(spec([{ math: 'x^2', font: 'lm', size: 40, at: [10, 80], display: true, align: 'center', paint: '#c2410c', transform: [1, 0, 0, 1, 5, 0] }]));
  assert.equal(ok.tag, 'Ok');
  assert.deepEqual({ ...ok.value.items[0], paint: [...ok.value.items[0].paint] }, {
    paint: [0xc2, 0x41, 0x0c, 255], stroke: null, rule: 'nonzero', transform: [1, 0, 0, 1, 5, 0],
    kind: 'math', tex: 'x^2', font: 'lm', size: 40, at: [10, 80], display: true, align: 'center',
  });
  const bad = parseSpec(spec([
    { math: 'x + \\foo', font: 'lm', size: 40 },
    { math: 'x', font: 'nope', size: 40 },
    { math: 'x', font: 'lm', size: -1, display: 'yes', align: 'middle' },
    { math: 'x^{${n}}', font: 'lm', size: 40 },
    { math: 42, font: 'lm', size: 40 },
  ]));
  assert.equal(bad.tag, 'Err');
  assert.deepEqual(bad.error.map((e) => [e.at, e.expected]), [
    ['/items/0/math', 'TeX math (unknown command \\foo at 4)'],
    ['/items/1/font', 'a font declared in /fonts'],
    ['/items/2/align', 'start | center | end'],
    ['/items/2/display', 'true | false'],
    ['/items/2/size', 'a number in [0.01, 100000]'],
    ['/items/3/math', '${name} of a declared param'],
    ['/items/4/math', 'a string of at most 4096 characters'],
  ]);
});

test('compile: math becomes glyph and rule items at "at"; params fill in; a font without MATH and a missing glyph are pointed errors', () => {
  const p = parseSpec(spec([{ math: '\\frac{${a}}{2}', font: 'lm', size: 40, at: [10, 80], display: true }], { params: { a: '1' } })).value;
  const s = compile(p, { fonts, dpr: 2, params: { a: 'x+y' } });
  assert.equal(s.tag, 'Ok');
  const r = typeset(font, 'lm', '\\frac{x+y}{2}', { size: 40, display: true }).value;
  assert.equal(s.value.items.length, r.glyphs.length + r.rules.length);
  // dpr 2 scales the whole scene: the first glyph's transform is the direct placement, doubled.
  const direct = placeMath(r, translate(10, 80), [0, 0, 0, 255])[0].transform;
  assert.deepEqual(s.value.items[0].transform.map((v) => +v.toFixed(9)), direct.map((v) => +(v * 2).toFixed(9)));
  const e1 = compile(parseSpec(spec([{ math: 'x', font: 'serif', size: 40 }])).value, { fonts, dpr: 1, params: {} });
  assert.equal(e1.error[0].at, '/items/0/font');
  assert.equal(e1.error[0].expected, 'a font with an OpenType MATH table');
  const e2 = compile(parseSpec(spec([{ group: [{ math: 'a+\\mathcal{b}', font: 'lm', size: 40 }] }])).value, { fonts, dpr: 1, params: {} });
  assert.deepEqual(e2.error, [{ at: '/items/0/group/0/math', expected: 'characters in font "lm"', found: 'U+1D4B7 at 11' }]); // the offset of the b
  const e3 = compile(parseSpec(spec([{ math: '${t}', font: 'lm', size: 40 }], { params: { t: 'x' } })).value, { fonts, dpr: 1, params: { t: '\\frac{' } });
  assert.equal(e3.error[0].at, '/items/0/math');
  assert.match(e3.error[0].expected, /^TeX math \(expected '\}', found end of input at 6\)$/);
});

test('authoring: a scene with math → toSpec → buildScene renders the same pixels', async () => {
  const r = typeset(font, 'lm', '\\int_0^1 \\sqrt{x}\\,dx = \\frac{2}{3}', { size: 36, display: true }).value;
  const items = placeMath(r, translate(12, 70), [20, 20, 20, 255]);
  const scene = { width: 360, height: 120, background: /** @type {const} */ ([255, 255, 255, 255]), items };
  const json = toSpec(scene, new Map([['lm', { url: URL_, sha256: '' }]]));
  assert.equal(json.tag, 'Ok');
  const kinds = new Set(json.value.items.map((i) => Object.keys(i).find((k) => k !== 'paint' && k !== 'transform')));
  assert.deepEqual([...kinds].sort(), ['glyph', 'rects']);
  const built = await buildScene(JSON.parse(JSON.stringify(json.value)), { dpr: 1, params: {}, loadFont: async () => ({ tag: 'Ok', value: { font, key: 'lm' } }) });
  assert.equal(built.tag, 'Ok');
  const a = rasterize(scene, scanline).rgba, b = rasterize(built.value.scene, scanline).rgba;
  assert.equal(a.length, b.length);
  let diff = 0, ink = 0;
  for (let i = 0; i < a.length; i++) { diff = Math.max(diff, Math.abs(a[i] - b[i])); if (a[i] < 128) ink++; }
  assert.ok(ink > 500, `${ink} ink samples`);
  assert.ok(diff <= 1, `max channel difference ${diff}`);
});
