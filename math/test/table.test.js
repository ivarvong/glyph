// MATH table parser against fontTools: every value of Latin Modern Math and of a synthetic table
// with math kerns (which Latin Modern Math lacks). Also: the font's outlines and advances, and
// the parser's totality on malformed bytes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { loadFont } from '../../sfnt/src/font.js';
import { rootFaults, view, u16 } from '../../sfnt/src/bin.js';
import { parseMath, mathOf, CONSTANTS } from '../src/table.js';
import { canonical } from '../../sfnt/test/canon.js';
import { findUndefined } from '../../fuzz/target.js';

const root = new URL('../../', import.meta.url).pathname;
const bytes = (p) => new Uint8Array(readFileSync(root + p));
const LMM = JSON.parse(readFileSync(root + 'third_party/ref/fonttools-lmmath.json', 'utf8'));
const KERN = JSON.parse(readFileSync(root + 'ref/fonttools-math-kern.json', 'utf8'));

/** Our MathTable in the reference's JSON shape. */
function asRef(m) {
  const obj = (map, f = (x) => x) => Object.fromEntries([...map].map(([g, v]) => [String(g), f(v)]));
  const cons = (c) => ({
    variants: c.variants.map((x) => [x.gid, x.advance]),
    assembly: c.assembly && { italic: c.assembly.italic, parts: c.assembly.parts.map((p) => [p.gid, p.start, p.end, p.full, p.flags]) },
  });
  return {
    constants: m.constants, italics: obj(m.italics), topAccent: obj(m.topAccent),
    extended: [...m.extended].sort((a, b) => a - b), kerns: obj(m.kerns),
    minConnectorOverlap: m.minConnectorOverlap, vertical: obj(m.vertical, cons), horizontal: obj(m.horizontal, cons),
  };
}

const digest = (path) => createHash('sha256').update(canonical(path).map((c) => c.map((s) => `${s[0]} ${s.slice(1).map((x) => Math.round(x * 65536)).join(' ')}`).join(',')).join(';')).digest('hex').slice(0, 16);

test('Latin Modern Math loads; every outline and advance equals fontTools', async () => {
  const f = await loadFont(bytes('third_party/fonts/latinmodern-math.otf'));
  assert.equal(f.tag, 'Ok');
  const font = f.value;
  assert.equal(font.numGlyphs, LMM.numGlyphs);
  assert.equal(font.unitsPerEm, LMM.unitsPerEm);
  let same = 0;
  for (let g = 0; g < font.numGlyphs; g++) {
    assert.equal(font.advance(g), LMM.advances[g], `advance ${g}`);
    const p = font.path(g);
    assert.equal(p.tag, 'Ok', `path ${g}`);
    if (digest(p.value) === LMM.outlines[g]) same++;
  }
  assert.equal(same, LMM.numGlyphs, `${same}/${LMM.numGlyphs} outlines identical`);
  for (const [cp, g] of Object.entries(LMM.cmap)) assert.equal(font.glyphOf(Number(cp)), g, `cmap U+${Number(cp).toString(16)}`);
});

test('MATH of Latin Modern Math: every value equals fontTools', async () => {
  const font = (await loadFont(bytes('third_party/fonts/latinmodern-math.otf'))).value;
  const m = mathOf(font);
  assert.equal(m.tag, 'Ok');
  const ours = asRef(m.value), ref = LMM.math;
  assert.deepEqual(Object.keys(ours.constants), CONSTANTS);
  for (const k of Object.keys(ours)) assert.deepEqual(ours[k], ref[k], k);
  assert.equal(Object.keys(ref.constants).length, 56);
  assert.equal(Object.keys(ours.vertical).length + Object.keys(ours.horizontal).length, 180);
});

test('synthetic MATH (math kerns, null corners, format-2 coverage): every value equals fontTools', () => {
  const b = bytes('fixtures/test-math-kern.MATH');
  const m = parseMath(b);
  assert.equal(m.tag, 'Ok');
  const ours = asRef(m.value);
  for (const k of Object.keys(KERN)) assert.deepEqual(ours[k], KERN[k], k);
  // The italics coverage really is format 2 (a range), so both coverage formats are exercised.
  const v = view(b), gi = u16(v, 6), it = gi + u16(v, gi);
  assert.equal(u16(v, it + u16(v, it)), 2);
});

test('malformed MATH: every truncation and 4000 byte flips are Ok or a typed Err, never a throw or undefined', () => {
  const good = bytes('fixtures/test-math-kern.MATH');
  const faults0 = rootFaults();
  const tags = new Map();
  const check = (b) => {
    const r = parseMath(b);
    const k = r.tag === 'Ok' ? 'Ok' : r.error.tag;
    tags.set(k, (tags.get(k) ?? 0) + 1);
    assert.equal(findUndefined(r), '');
  };
  for (let n = 0; n < good.length; n++) check(good.subarray(0, n));
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32;
  for (let i = 0; i < 4000; i++) {
    const b = good.slice();
    for (let k = 0; k < 1 + (i % 4); k++) b[Math.floor(rnd() * b.length)] = Math.floor(rnd() * 256);
    check(b);
  }
  assert.equal(rootFaults(), faults0, 'no read outside a guard');
  assert.ok(tags.get('Truncated') > 0 && tags.get('Version') > 0 && tags.get('Ok') > 0, JSON.stringify([...tags]));
  assert.equal(mathOf(/** @type {any} */ ({ tables: new Map() })).error.tag, 'Missing');
});

test('hostile coverage: 65535 format-2 ranges of 65535 glyphs cost the parallel count, not 4·10⁹ steps', () => {
  // MathItalicsCorrectionInfo with count 1, its coverage 65535 ranges [0, 65535].
  const n = 65535, cov = 64, b = new Uint8Array(cov + 4 + n * 6);
  const dv = new DataView(b.buffer);
  dv.setUint16(0, 1); dv.setUint16(4, 10); dv.setUint16(6, 40); dv.setUint16(8, 50); // header; constants at 10 (all zero)
  dv.setUint16(40, 8); // MathGlyphInfo → italics at 48
  dv.setUint16(48, cov - 48); dv.setUint16(50, 1); // italics: coverage, count 1, record at 52
  dv.setInt16(52, -42);
  dv.setUint16(cov, 2); dv.setUint16(cov + 2, n);
  for (let i = 0; i < n; i++) { dv.setUint16(cov + 4 + i * 6, 0); dv.setUint16(cov + 6 + i * 6, 65535); }
  const t0 = performance.now();
  const r = parseMath(b);
  const ms = performance.now() - t0;
  assert.equal(r.tag, 'Ok');
  assert.deepEqual([...r.value.italics], [[0, -42]]);
  assert.ok(ms < 200, `${ms} ms`);
});
