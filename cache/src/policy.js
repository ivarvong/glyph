// @ts-check
// In-process memo with pluggable eviction, bounded by bytes (not entries: a 112 px glyph mask
// and a 9 px one should not count the same). One port, four policies:
//
//   Policy.Fifo        insertion order; hits change nothing
//   Policy.Lru         recency: a hit moves the entry to the front (Map delete + set)
//   Policy.Sieve       FIFO + a visited bit and a moving hand (Zhang et al., NSDI '24):
//                      hits only set a bit, so they are cheaper than LRU's reorder
//   Policy.S3Fifo(f)   small FIFO (fraction f of bytes) + main FIFO + ghost keys
//                      (Yang et al., SOSP '23): one-hit wonders leave quickly
//
// All synchronous; values are whatever the caller stores (outlines, masks, bytes).
import { variants, some, NONE } from '../../otel-compact/src/adt.js';

export const Policy = variants('Policy', { Fifo: [], Lru: [], Sieve: [], S3Fifo: ['small'] });
/** @typedef {import('../../otel-compact/src/adt.js').Of<typeof Policy>} PolicyT */

/**
 * @template V
 * @typedef {object} Memo
 * @property {string} name
 * @property {(key: string) => import('../../otel-compact/src/adt.js').Option<V>} get   Some(value) on a hit, NONE on a miss
 * @property {(key: string, value: V, bytes?: number) => void} set
 * @property {(key: string) => boolean} has      no effect on eviction state
 * @property {{ hits: number, misses: number, evictions: number, bytes: number, entries: number }} stats
 */

/**
 * @template V
 * @param {PolicyT} policy
 * @param {{ maxBytes: number, sizeOf?: (v: V) => number }} opts  sizeOf: default 1 per entry
 * @returns {Memo<V>}
 */
export function memo(policy, { maxBytes, sizeOf = () => 1 }) {
  return Policy.match(policy, {
    Fifo: () => mapMemo('fifo', false, maxBytes, sizeOf),
    Lru: () => mapMemo('lru', true, maxBytes, sizeOf),
    Sieve: () => sieveMemo(maxBytes, sizeOf),
    S3Fifo: ({ small }) => s3fifoMemo(small, maxBytes, sizeOf),
  });
}

const newStats = () => ({ hits: 0, misses: 0, evictions: 0, bytes: 0, entries: 0 });

/**
 * FIFO and LRU on the same linked queue as SIEVE, plus a Map index. (The idiomatic JS
 * version, a Map's insertion order with delete + re-set, measured 7–9× slower per op than
 * SIEVE in bench/replay.js: deleting from a Map's front leaves tombstones that every new
 * keys() iterator walks again until V8 rehashes.)
 * @template V @param {string} name @param {boolean} touch @param {number} maxBytes @param {(v: V) => number} sizeOf
 * @returns {Memo<V>}
 */
function mapMemo(name, touch, maxBytes, sizeOf) {
  /** @type {Map<string, Node<V>>} */
  const idx = new Map();
  const q = new Queue();
  const stats = newStats();
  const sync = () => { stats.bytes = q.bytes; stats.entries = q.n; };
  return {
    name, stats,
    get(k) {
      const e = idx.get(k);
      if (!e) { stats.misses++; return NONE; }
      stats.hits++;
      if (touch && q.head !== e) { q.remove(e); q.push(e); }
      return some(e.v);
    },
    has: (k) => idx.has(k),
    set(k, v, b = sizeOf(v)) {
      const old = idx.get(k);
      if (old) { q.remove(old); idx.delete(k); }
      if (b <= maxBytes) {
        while (q.bytes + b > maxBytes && q.n) { const t = q.tail; q.remove(t); idx.delete(t.k); stats.evictions++; }
        /** @type {Node<V>} */
        const n = { k, v, b, bit: 0, newer: null, older: null, q: 0 };
        q.push(n); idx.set(k, n);
      }
      sync();
    },
  };
}

/**
 * @template V
 * @typedef {{ k: string, v: V, b: number, bit: number, newer: Node<V> | null, older: Node<V> | null, q: number }} Node
 */

/** Doubly linked queue: push at head (newest), tail is oldest. */
class Queue {
  constructor() { /** @type {any} */ this.head = null; /** @type {any} */ this.tail = null; this.bytes = 0; this.n = 0; }
  /** @param {any} x */
  push(x) { x.newer = null; x.older = this.head; if (this.head) this.head.newer = x; else this.tail = x; this.head = x; this.bytes += x.b; this.n++; }
  /** @param {any} x */
  remove(x) {
    if (x.newer) x.newer.older = x.older; else this.head = x.older;
    if (x.older) x.older.newer = x.newer; else this.tail = x.newer;
    x.newer = x.older = null; this.bytes -= x.b; this.n--;
  }
}

/**
 * SIEVE: new entries at the head; the hand sweeps from the tail toward the head, clearing
 * visited bits, and evicts the first unvisited entry. The hand keeps its place between evictions.
 * @template V @param {number} maxBytes @param {(v: V) => number} sizeOf @returns {Memo<V>}
 */
function sieveMemo(maxBytes, sizeOf) {
  /** @type {Map<string, Node<V>>} */
  const idx = new Map();
  const q = new Queue();
  /** @type {Node<V> | null} */
  let hand = null;
  const stats = newStats();
  const evict = () => {
    let h = hand ?? q.tail;
    while (h.bit) { h.bit = 0; h = h.newer ?? q.tail; }
    hand = h.newer;
    q.remove(h); idx.delete(h.k); stats.evictions++;
  };
  return {
    name: 'sieve', stats,
    get(k) {
      const e = idx.get(k);
      if (!e) { stats.misses++; return NONE; }
      stats.hits++; e.bit = 1;
      return some(e.v);
    },
    has: (k) => idx.has(k),
    set(k, v, b = sizeOf(v)) {
      const old = idx.get(k);
      if (old) { if (hand === old) hand = old.newer; q.remove(old); idx.delete(k); }
      if (b > maxBytes) { sync(); return; }
      /** @type {Node<V>} */
      const n = { k, v, b, bit: 0, newer: null, older: null, q: 0 };
      while (q.bytes + b > maxBytes && q.n) evict();
      q.push(n); idx.set(k, n);
      sync();
    },
  };
  function sync() { stats.bytes = q.bytes; stats.entries = q.n; }
}

/**
 * S3-FIFO: entries enter the small queue S (or the main queue M if their key is in the
 * ghost list G). Hits bump a 2-bit frequency. Evicting from S promotes entries hit more
 * than once to M and records the rest in G; evicting from M reinserts entries with
 * freq > 0 (decrementing it) and removes the first with freq 0.
 * @template V @param {number} small @param {number} maxBytes @param {(v: V) => number} sizeOf @returns {Memo<V>}
 */
function s3fifoMemo(small, maxBytes, sizeOf) {
  /** @type {Map<string, Node<V>>} */
  const idx = new Map();
  const S = new Queue(), M = new Queue();
  /** Ghost keys, insertion-ordered, bounded by the entry count of M (at least 1). */
  /** @type {Map<string, true>} */
  const G = new Map();
  const stats = newStats();
  const total = () => S.bytes + M.bytes;
  const ghost = (/** @type {string} */ k) => {
    G.set(k, true);
    while (G.size > Math.max(1, M.n)) G.delete(/** @type {string} */ (G.keys().next().value));
  };
  const evictM = () => {
    for (;;) {
      const t = M.tail;
      M.remove(t);
      if (t.bit > 0) { t.bit--; M.push(t); continue; }
      idx.delete(t.k); stats.evictions++;
      return;
    }
  };
  const evictS = () => {
    for (;;) {
      const t = S.tail;
      S.remove(t);
      if (t.bit > 1) { t.q = 1; M.push(t); if (S.n === 0) return; continue; }
      idx.delete(t.k); ghost(t.k); stats.evictions++;
      return;
    }
  };
  const evict = () => { if (S.n && (S.bytes >= small * maxBytes || M.n === 0)) evictS(); else evictM(); };
  return {
    name: 's3fifo', stats,
    get(k) {
      const e = idx.get(k);
      if (!e) { stats.misses++; return NONE; }
      stats.hits++; if (e.bit < 3) e.bit++;
      return some(e.v);
    },
    has: (k) => idx.has(k),
    set(k, v, b = sizeOf(v)) {
      const old = idx.get(k);
      if (old) { (old.q ? M : S).remove(old); idx.delete(k); }
      if (b <= maxBytes) {
        while (total() + b > maxBytes && total() > 0) evict();
        /** @type {Node<V>} */
        const n = { k, v, b, bit: 0, newer: null, older: null, q: 0 };
        if (G.has(k)) { G.delete(k); n.q = 1; M.push(n); } else S.push(n);
        idx.set(k, n);
      }
      stats.bytes = total(); stats.entries = S.n + M.n;
    },
  };
}
