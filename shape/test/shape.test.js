import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allFonts, readJson } from '../../sfnt/test/fixtures.js';
import { shape, prepare } from '../src/shape.js';

const HB = readJson('third_party/ref/hb-shape.json');

test('shaping equals HarfBuzz on the corpus, for every font file', async () => {
  const mismatches = [];
  let glyphs = 0;
  for (const { key, file, font } of await allFonts()) {
    for (const [text, want] of Object.entries(HB[key])) {
      const got = shape(font, text).value;
      const g = got.map((x) => [x.gid, x.cluster, x.ax, x.ay, x.dx, x.dy]);
      const w = want.map((x) => [x.g, x.cl, x.ax, x.ay, x.dx, x.dy]);
      glyphs += w.length;
      if (JSON.stringify(g) !== JSON.stringify(w)) mismatches.push({ file, text, got: g, want: w });
    }
  }
  assert.deepEqual(mismatches, [], JSON.stringify(mismatches.slice(0, 2)));
  assert.ok(glyphs > 300);
});

test('Cloudflare: kerning applied in Inter, f_l ligature formed in Source Serif', async () => {
  const fonts = await allFonts();
  const inter = fonts.find((f) => f.key === 'inter').font;
  const ss = fonts.find((f) => f.key === 'sourceSerif').font;
  const i = shape(inter, 'Cloudflare').value;
  assert.equal(i.length, 10);
  assert.ok(i.some((g) => g.ax !== inter.advance(g.gid)), 'some pair is kerned');
  const s = shape(ss, 'Cloudflare').value;
  assert.equal(s.length, 9, 'f + l -> f_l');
  assert.deepEqual(s.map((g) => g.cluster), [0, 1, 2, 3, 4, 5, 7, 8, 9]);
});

test('disabling kern and liga turns each effect off', async () => {
  const fonts = await allFonts();
  const inter = fonts.find((f) => f.key === 'inter').font;
  const ss = fonts.find((f) => f.key === 'sourceSerif').font;
  assert.ok(shape(inter, 'Cloudflare', { gposFeatures: new Set() }).value.every((g) => g.ax === inter.advance(g.gid)));
  assert.equal(shape(ss, 'Cloudflare', { gsubFeatures: new Set(['ccmp']) }).value.length, 10);
  assert.equal(prepare(inter).tag, 'Ok');
  assert.equal(prepare(ss).tag, 'Ok');
});
