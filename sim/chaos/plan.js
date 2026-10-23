// Fault plans: one format and one decision function, shared by the chaos worker (inside workerd)
// and the TCP fault proxy (Node, behind a workerd `external` service). Pure; no platform APIs.
//
//   { seed: 7, rules: [
//       { id: 'r2-get-errors', at: 'r2',  match: { method: 'get' },            when: { rate: 0.3 }, fault: { kind: 'error' } },
//       { id: 'slow-net',      at: 'net', match: { host: 'fonts.gstatic.com' }, when: { rate: 1 },   fault: { kind: 'delay', ms: { median: 40, p99: 900 } } },
//       { id: 'reset',         at: 'tcp', when: { nth: [2] },                   fault: { kind: 'reset', afterBytes: 1000 } },
//   ] }
//
// at:     'net' (HTTP, chaos worker) | 'tcp' (sockets, proxy) | 'r2' | 'wc' (Workers Cache hop)
// match:  method, host, path (prefix), key (prefix): all optional, all must hold
// when:   { rate } | { nth: [n…] } | { every: k } | { first: k }   (n counts per identity, from 1)
// fault:  delay { ms: n | { median, p99 } | { min, max } } — composes with any one terminal fault:
//   net:  error | status { status } | corrupt { flips } | drip { chunk, intervalMs } | stall
//   tcp:  refuse | reset { afterBytes } | truncate { afterBytes } | drip { chunk, intervalMs } | stall
//   r2:   error | missing (get → null) | corrupt { flips } | drop (put acknowledged, not stored)
//   wc:   error | status { status } | corrupt { flips }
//
// Determinism: a decision is a hash of (seed, rule id, identity, occurrence), where identity is
// the call itself (service, method, URL or key) and occurrence counts identical calls. It does
// not depend on interleaving, so the same plan over the same requests makes the same decisions
// at any concurrency, and a failing run replays from its seed.

/** 32-bit FNV-1a of a string, then a finaliser (murmur3 fmix) for avalanche. */
export function hash32(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
  return h >>> 0;
}
/** Uniform [0, 1) from the decision coordinates. */
export const uniform = (...parts) => hash32(parts.join('␟')) / 2 ** 32;

/** @typedef {{ method?: string, host?: string, path?: string, key?: string }} Call */
/** Identity of a call: what it is, not when it happened. @param {string} at @param {Call} c */
export const identity = (at, c) => `${at} ${c.method || ''} ${c.host || ''}${c.path || ''}${c.key ? ` ${c.key}` : ''}`;

/** @param {any} m @param {Call} c */
const matches = (m, c) => !m || ((!m.method || m.method === c.method) && (!m.host || m.host === c.host)
  && (!m.path || (c.path || '').startsWith(m.path)) && (!m.key || (c.key || '').startsWith(m.key)));

/** @param {any} w @param {number} seed @param {string} rule @param {string} id @param {number} n */
const fires = (w, seed, rule, id, n) => {
  if (!w) return true;
  if (typeof w.rate === 'number') return uniform(seed, rule, id, n) < w.rate;
  if (Array.isArray(w.nth)) return w.nth.includes(n);
  if (typeof w.every === 'number') return n % w.every === 0;
  if (typeof w.first === 'number') return n <= w.first;
  return false;
};

/**
 * Delay in ms. Lognormal from median and p99 (σ = ln(p99/median) / 2.326), so tails are real.
 * @param {any} ms @param {number} seed @param {string} rule @param {string} id @param {number} n
 */
export function sampleMs(ms, seed, rule, id, n) {
  if (typeof ms === 'number') return ms;
  const u1 = Math.max(1e-12, uniform(seed, rule, id, n, 'u1')), u2 = uniform(seed, rule, id, n, 'u2');
  if (ms && typeof ms.median === 'number') {
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    const sigma = Math.log((ms.p99 || ms.median * 4) / ms.median) / 2.326;
    return ms.median * Math.exp(sigma * z);
  }
  if (ms && typeof ms.min === 'number') return ms.min + (ms.max - ms.min) * u1;
  return 0;
}

/**
 * The faults to apply to one call: total delay, plus at most one terminal fault (the first
 * matching rule with a non-delay kind wins). Every firing is returned for the log.
 * @param {{ seed: number, rules: any[] }} plan @param {string} at @param {Call} call @param {number} n occurrence of this identity
 */
export function decide(plan, at, call, n) {
  const id = identity(at, call);
  let delayMs = 0, terminal = null;
  const fired = [];
  for (const r of plan.rules || []) {
    if (r.at !== at || !matches(r.match, call) || !fires(r.when, plan.seed, r.id, id, n)) continue;
    if (r.fault.kind === 'delay') {
      const d = sampleMs(r.fault.ms, plan.seed, r.id, id, n);
      delayMs += d;
      fired.push({ rule: r.id, kind: 'delay', ms: Math.round(d) });
    } else if (!terminal) {
      terminal = { ...r.fault, rule: r.id };
      fired.push({ rule: r.id, kind: r.fault.kind });
    }
  }
  return { id, n, delayMs, terminal, fired };
}

/** Per-component occurrence counter and injection log. */
export function recorder() {
  const seen = new Map();
  /** @type {any[]} */
  const log = [];
  return {
    /** @param {string} id */
    next: (id) => { const n = (seen.get(id) || 0) + 1; seen.set(id, n); return n; },
    /** @param {ReturnType<typeof decide>} d */
    record: (d) => { for (const f of d.fired) log.push({ id: d.id, n: d.n, ...f }); },
    log: () => log.slice(),
    reset: () => { seen.clear(); log.length = 0; },
  };
}

/** Deterministic byte flips over the first `span` bytes of a stream. @param {number} flips */
export function flipPositions(seed, rule, id, n, flips = 4, span = 4096) {
  return Array.from({ length: flips }, (_, k) => Math.floor(uniform(seed, rule, id, n, 'flip', k) * span)).sort((a, b) => a - b);
}

/** Order-independent fingerprint of a log, for replay checks. @param {any[]} log */
export const logKey = (log) => log.map((e) => `${e.rule}|${e.id}|${e.n}|${e.kind}`).sort().join('\n');
