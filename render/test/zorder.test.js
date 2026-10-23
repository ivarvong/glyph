import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rasterize, scanline, accumulate, scenePolygons } from '../src/raster.js';
import { Seg } from '../../outline/src/path.js';
import { NOOP_SPAN } from '../../otel-compact/src/trace.js';

// Painter's order: an item drawn later covers an item drawn earlier, even when an earlier item
// had the same colour as the later one. (The rasteriser batches items by colour; a batch must
// never move an item under something that was drawn after it.) Found by the range posters:
// captions in a colour first used by a heading vanished under the cards drawn after the heading.
const square = (x, y, s) => [Seg.MoveTo(x, y), Seg.LineTo(x + s, y), Seg.LineTo(x + s, y + s), Seg.LineTo(x, y + s), Seg.Close];
const RED = [220, 40, 40, 255], BLUE = [40, 40, 220, 255];
const item = (path, fill, key) => ({ path, key, transform: [1, 0, 0, 1, 0, 0], fill });
const pixel = (img, x, y) => Array.from(img.data.subarray((y * img.width + x) * img.channels, (y * img.width + x) * img.channels + 3));

test("painter's order holds when a colour reappears after another colour that covers it", () => {
  const scene = { width: 40, height: 40, background: [255, 255, 255, 255], items: [
    item(square(0, 0, 10), RED, 'heading'),       // red first: the 'heading'
    item(square(10, 10, 20), BLUE, 'card'),       // a blue card
    item(square(15, 15, 5), RED, 'caption'),      // red again, on top of the card
  ] };
  for (const r of [scanline, accumulate]) {
    const img = rasterize(scene, r, NOOP_SPAN);
    assert.deepEqual(pixel(img, 17, 17), RED.slice(0, 3), `${r.name}: the caption is on top of the card`);
    assert.deepEqual(pixel(img, 25, 25), BLUE.slice(0, 3), `${r.name}: the card elsewhere`);
    assert.deepEqual(pixel(img, 5, 5), RED.slice(0, 3), `${r.name}: the heading`);
  }
});

test('items of one colour that nothing later overlaps still share one batch', () => {
  const scene = { width: 100, height: 20, background: [255, 255, 255, 255], items: [
    item(square(0, 0, 10), RED, 'a'), item(square(20, 0, 10), BLUE, 'b'),
    item(square(40, 0, 10), RED, 'c'), item(square(60, 0, 10), BLUE, 'd'),
  ] };
  assert.equal(scenePolygons(scene).length, 2, 'interleaved but disjoint: two batches, not four');
});

// The scanner's edge order: a callback-free stable sort that must give exactly the order of
// Array.prototype.sort with (i, j) => key[i] - key[j] (stable since ES2019), ties and all.
import { stableOrder } from '../src/raster.js';
test('stableOrder = stable comparator sort, including ties', () => {
  let seed = 7;
  const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  for (const m of [0, 1, 2, 15, 16, 17, 33, 100, 1000, 4097]) {
    for (const levels of [3, 50, 1e9]) {
      const key = Float64Array.from({ length: m }, () => Math.floor(rand() * levels) / 7);
      const want = Array.from({ length: m }, (_, i) => i).sort((i, j) => key[i] - key[j]);
      assert.deepEqual([...stableOrder(key, m)], want, `m=${m} levels=${levels}`);
    }
  }
});
