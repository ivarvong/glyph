import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseKern, applyKern } from '../src/kern.js';

/** A 'kern' table (version 0) with one format-0 subtable of the given pairs. */
const kernTable = (pairs, { coverage = 0x0001, tableLength } = {}) => {
  const n = pairs.length, sub = 14 + 6 * n;
  const b = new Uint8Array(4 + sub), dv = new DataView(b.buffer);
  dv.setUint16(0, 0); dv.setUint16(2, 1);
  dv.setUint16(4, 0); dv.setUint16(6, tableLength ?? sub); dv.setUint16(8, coverage);
  dv.setUint16(10, n);
  [...pairs].sort((a, b) => a[0] * 65536 + a[1] - (b[0] * 65536 + b[1])).forEach(([l, r, v], i) => { dv.setUint16(18 + 6 * i, l); dv.setUint16(20 + 6 * i, r); dv.setInt16(22 + 6 * i, v); });
  return b;
};
const buf = (...gids) => gids.map((gid, cluster) => ({ gid, cluster, ax: 500, ay: 0, dx: 0, dy: 0 }));

test("legacy kern: HarfBuzz's split (kern >> 1 to the first glyph, the rest to the second's advance and offset)", () => {
  const k = parseKern(kernTable([[1, 2, -5], [2, 3, 40], [9, 9, 7]]));
  assert.equal(k.tag, 'Ok'); assert.equal(k.value.length, 1);
  const b = buf(1, 2, 3);
  applyKern(k.value, b, () => false);
  // -5 >> 1 = -3 to glyph 0; -2 to glyph 1 (advance and offset); then 40: 20 to glyph 1, 20 to glyph 2.
  assert.deepEqual(b.map((g) => [g.ax, g.dx]), [[497, 0], [500 - 2 + 20, -2], [520, 20]]);
});

test('legacy kern: marks are skipped when pairing; cross-stream and vertical subtables do not kern', () => {
  const k = parseKern(kernTable([[1, 3, -10]])).value;
  const b = buf(1, 7, 3); // 7 is a mark between the pair
  applyKern(k, b, (i) => b[i].gid === 7);
  assert.deepEqual(b.map((g) => g.ax), [495, 500, 495]);
  assert.equal(parseKern(kernTable([[1, 3, -10]], { coverage: 0x0005 })).value.length, 0, 'cross-stream');
  assert.equal(parseKern(kernTable([[1, 3, -10]], { coverage: 0x0000 })).value.length, 0, 'not horizontal');
});

test('legacy kern: hostile tables are ignored, never thrown on or looped on', () => {
  const t = kernTable([[1, 2, -5]]);
  assert.deepEqual(parseKern(t.subarray(0, 12)).value, [], 'pairs cut off: the subtable is dropped');
  assert.equal(parseKern(kernTable([[1, 2, -5]], { tableLength: 0 })).tag, 'Ok', 'a zero subtable length ends the walk');
  const lying = kernTable([[1, 2, -5]]); new DataView(lying.buffer).setUint16(10, 60000); // nPairs far past the end
  assert.deepEqual(parseKern(lying).value, []);
  assert.deepEqual(parseKern(Uint8Array.of(0, 1, 0, 0)).value, [], "Apple 'kern' version 1: not supported, no kerning");
});
