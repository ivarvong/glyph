import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memo, Policy } from '../src/policy.js';

// Reference implementations: plain arrays, O(n) everything, written from the papers'
// pseudocode independently of the linked-list versions. Same trace in, same hits out.
const sum = (a) => a.reduce((s, e) => s + e.b, 0);

function refFifoLru(touch, max) {
  const q = []; // oldest first
  return {
    get(k) { const i = q.findIndex((e) => e.k === k); if (i < 0) return false; if (touch) q.push(...q.splice(i, 1)); return true; },
    set(k, b) {
      const i = q.findIndex((e) => e.k === k); if (i >= 0) q.splice(i, 1);
      if (b > max) return;
      q.push({ k, b }); while (sum(q) > max) q.shift();
    },
    keys: () => q.map((e) => e.k).sort(),
  };
}

function refSieve(max) {
  const q = []; let hand = null; // q oldest first; hand is an index or null
  const evict = () => {
    let i = hand ?? 0;
    while (q[i].bit) { q[i].bit = 0; i = i + 1 < q.length ? i + 1 : 0; }
    q.splice(i, 1);
    hand = i < q.length ? i : null;
  };
  return {
    get(k) { const e = q.find((x) => x.k === k); if (!e) return false; e.bit = 1; return true; },
    set(k, b) {
      const i = q.findIndex((e) => e.k === k);
      if (i >= 0) { q.splice(i, 1); if (hand !== null) { if (hand > i) hand--; else if (hand === i && hand >= q.length) hand = null; } }
      if (b > max) return;
      while (sum(q) + b > max && q.length) evict();
      q.push({ k, b, bit: 0 });
    },
    keys: () => q.map((e) => e.k).sort(),
  };
}

function refS3(small, max) {
  const S = [], M = [], G = []; // oldest first
  const total = () => sum(S) + sum(M);
  const ghost = (k) => { G.push(k); while (G.length > Math.max(1, M.length)) G.shift(); };
  const evictM = () => { for (;;) { const t = M.shift(); if (t.f > 0) { t.f--; M.push(t); continue; } return; } };
  const evictS = () => { for (;;) { const t = S.shift(); if (t.f > 1) { M.push(t); if (!S.length) return; continue; } ghost(t.k); return; } };
  return {
    get(k) { const e = [...S, ...M].find((x) => x.k === k); if (!e) return false; e.f = Math.min(3, e.f + 1); return true; },
    set(k, b) {
      for (const Q of [S, M]) { const i = Q.findIndex((e) => e.k === k); if (i >= 0) Q.splice(i, 1); }
      if (b > max) return;
      while (total() + b > max && total() > 0) { if (S.length && (sum(S) >= small * max || !M.length)) evictS(); else evictM(); }
      const gi = G.indexOf(k);
      if (gi >= 0) { G.splice(gi, 1); M.push({ k, b, f: 0 }); } else S.push({ k, b, f: 0 });
    },
    keys: () => [...S, ...M].map((e) => e.k).sort(),
  };
}

/** Zipf-ish trace with variable sizes: get, and set on miss (the read-through pattern). */
function trace(seed, n, universe) {
  let s = seed >>> 0;
  const rnd = () => ((s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0) / 2 ** 32);
  return Array.from({ length: n }, () => {
    const r = Math.floor(universe * rnd() ** 2.2); // skewed toward small ids
    return { k: `k${r}`, b: 1 + (r % 7) * 3 };
  });
}

test('every policy matches its reference implementation on hit/miss sequence and final contents', () => {
  const cases = [
    ['fifo', Policy.Fifo, (m) => refFifoLru(false, m)],
    ['lru', Policy.Lru, (m) => refFifoLru(true, m)],
    ['sieve', Policy.Sieve, (m) => refSieve(m)],
    ['s3fifo', Policy.S3Fifo(0.1), (m) => refS3(0.1, m)],
  ];
  for (const [name, policy, ref] of cases) for (const [seed, maxBytes] of [[1, 40], [2, 120], [3, 400], [4, 15]]) {
    const a = memo(policy, { maxBytes }), r = ref(maxBytes);
    for (const [i, { k, b }] of trace(seed, 4000, 300).entries()) {
      const hit = a.get(k).tag === 'Some', rhit = r.get(k);
      assert.equal(hit, rhit, `${name} max=${maxBytes} op ${i} ${k}`);
      if (!hit) { a.set(k, k, b); r.set(k, b); }
      assert.ok(a.stats.bytes <= maxBytes, `${name}: ${a.stats.bytes} > ${maxBytes}`);
    }
    const keys = r.keys().filter((k) => a.has(k));
    assert.deepEqual(keys, r.keys(), `${name} max=${maxBytes}: final contents`);
    assert.equal(a.stats.entries, r.keys().length);
  }
});

test('scan resistance: a burst of one-hit keys larger than the cache flushes LRU, not SIEVE or S3-FIFO', () => {
  // Each round: 10 hot keys used 3× each, then a scan of 50 keys never seen again. Cache: 40.
  const run = (policy) => {
    const m = memo(policy, { maxBytes: 40 });
    let hot = 0, n = 0;
    for (let round = 0; round < 200; round++) {
      for (let r = 0; r < 3; r++) for (let h = 0; h < 10; h++) { const k = `hot${h}`; if (m.get(k).tag === 'None') m.set(k, 1); else hot++; }
      for (let i = 0; i < 50; i++) { const k = `scan${n++}`; if (m.get(k).tag === 'None') m.set(k, 1); }
    }
    return hot / (200 * 30);
  };
  const lru = run(Policy.Lru), fifo = run(Policy.Fifo), s3 = run(Policy.S3Fifo(0.1)), sieve = run(Policy.Sieve);
  // LRU and FIFO miss every hot key once per round (2/3 hit); the scan-resistant policies keep them (~1).
  assert.ok(lru < 0.7 && fifo < 0.7, `lru ${lru}, fifo ${fifo}`);
  assert.ok(sieve > 0.95 && s3 > 0.95, `sieve ${sieve}, s3fifo ${s3}`);
});
