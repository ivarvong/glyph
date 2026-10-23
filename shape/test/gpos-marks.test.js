import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadFont } from '../../sfnt/src/font.js';
import { shape, graphemeClusters } from '../src/shape.js';

// Fixture fonts built with fontTools' feature compiler: mark-to-base, mark-to-mark and cursive
// attachment, with GDEF glyph classes and without (classes synthesised from Unicode). The
// expected output is HarfBuzz's, captured once (gpos-marks.hb.json records the version).
const ref = JSON.parse(readFileSync(new URL('./gpos-marks.hb.json', import.meta.url), 'utf8'));

for (const [file, cases] of Object.entries(ref.shaped)) {
  test(`GPOS mark, mark-to-mark and cursive attachment equal HarfBuzz ${ref.harfbuzz}: ${file}`, async () => {
    const f = (await loadFont(new Uint8Array(readFileSync(new URL(`../../fixtures/${file}`, import.meta.url))))).value;
    for (const [text, want] of Object.entries(cases)) {
      const got = shape(f, text);
      assert.equal(got.tag, 'Ok');
      assert.deepEqual(got.value.map((g) => [g.gid, g.cluster, g.ax, g.ay, g.dx, g.dy]), want.map((g) => [g.g, g.cl, g.ax, g.ay, g.dx, g.dy]), JSON.stringify(text));
    }
  });
}

test('grapheme clusters: marks, ZWJ sequences, emoji modifiers and regional-indicator pairs join the previous character', () => {
  const cl = (s) => graphemeClusters([...s]);
  assert.deepEqual(cl('ab'), [0, 1]);
  assert.deepEqual(cl('á̂b'), [0, 0, 0, 3]);
  assert.deepEqual(cl('́a'), [0, 1], 'a leading mark is its own cluster');
  assert.deepEqual(cl('👍🏽!'), [0, 0, 2], 'emoji modifier');
  assert.deepEqual(cl('👩‍💻x'), [0, 0, 0, 3], 'ZWJ and the pictograph after it');
  assert.deepEqual(cl('🇺🇸🇫🇷'), [0, 0, 2, 2], 'regional indicators pair up');
});
