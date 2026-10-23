import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { sha256, hex, sceneKey } from '../src/key.js';
import { Seg } from '../../outline/src/path.js';

test('sha256 matches node:crypto and crypto.subtle on FIPS vectors and every length 0..300', async () => {
  const enc = new TextEncoder();
  assert.equal(hex(sha256(enc.encode(''))), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(hex(sha256(enc.encode('abc'))), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  let s = 5;
  for (let n = 0; n <= 300; n++) {
    const b = Uint8Array.from({ length: n }, () => (s = (s * 1103515245 + 12345) >>> 0) >>> 24);
    assert.equal(hex(sha256(b)), createHash('sha256').update(b).digest('hex'), `n=${n}`);
  }
  const big = new Uint8Array(1 << 20).map((_, i) => (i * 31) & 255);
  assert.equal(hex(sha256(big)), hex(new Uint8Array(await crypto.subtle.digest('SHA-256', big))));
});

test('sceneKey: identity is content, not names; order, transforms, fills and config all matter', () => {
  const box = [Seg.MoveTo(0, 0), Seg.LineTo(10, 0), Seg.LineTo(10, 10), Seg.Close];
  const tri = [Seg.MoveTo(0, 0), Seg.LineTo(10, 0), Seg.LineTo(0, 10), Seg.Close];
  const item = (path, key, t = [1, 0, 0, 1, 0, 0], fill = [0, 0, 0, 255]) => ({ path, key, transform: t, fill });
  const scene = (items) => ({ width: 20, height: 20, background: [255, 255, 255, 255], items });
  const cfg = { format: 'png', zlib: 'fast' };
  const base = sceneKey(scene([item(box, 'a'), item(tri, 'b')]), cfg);
  // Same content under different names and different object identities: same key.
  assert.equal(sceneKey(scene([item([...box], 'x'), item([...tri], 'y')]), cfg), base);
  // Same name, different content: different key (the 'two fonts called inter' case).
  assert.notEqual(sceneKey(scene([item(tri, 'a'), item(tri, 'b')]), cfg), base);
  assert.notEqual(sceneKey(scene([item(tri, 'b'), item(box, 'a')]), cfg), base, 'paint order');
  assert.notEqual(sceneKey(scene([item(box, 'a', [1, 0, 0, 1, 0.1 + 0.2, 0]), item(tri, 'b')]), cfg),
    sceneKey(scene([item(box, 'a', [1, 0, 0, 1, 0.3, 0]), item(tri, 'b')]), cfg), 'exact float bits');
  assert.notEqual(sceneKey(scene([item(box, 'a', [1, 0, 0, 1, 0, 0], [1, 0, 0, 255]), item(tri, 'b')]), cfg), base, 'fill');
  assert.notEqual(sceneKey(scene([item(box, 'a'), item(tri, 'b')]), { ...cfg, zlib: 'max' }), base, 'config');
  assert.equal(sceneKey(scene([item(box, 'a'), item(tri, 'b')]), { zlib: 'fast', format: 'png' }), base, 'config order is irrelevant');
  assert.match(base, /^[0-9a-f]{64}$/);
});
