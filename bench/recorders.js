// What should a recording tracer keep finished spans in?
//   node --expose-gc bench/recorders.js
// Same API and render-shaped workload for each; wall time includes GC.
//
// Earlier rounds (Node 22, same workload), kept for the record:
//   tuples [trace, id, parent, name, start, dur, attrs]    ~1.3 µs/span, 690 B retained
//   columnar with a Uint8Array(24) of ids per open span   ~1.9 µs/span (typed-array allocation dominates)
//   columnar with int32 ids, attrs as [k, v] tuples        ~0.8 µs/span, 44% of it GC from retained tuples
//   object per span (the tracer before this bench), JSONL at end   ~1.95 µs/span; JSONL every 2048 ~1.38 µs/span
import { tracer, Config, NOOP_TRACER } from '../otel-compact/src/trace.js';
import { encodeReverse } from '../otel-compact/src/otlp.js';

const RES = { service: 'bench', attrs: [], scope: 'otel-compact', version: '1' };
const now = () => performance.now() * 1000;

/**
 * Columnar recorder. Open span = one object of numbers (ids as int32 pairs,
 * up to 3 attributes in inline fields). End = write into typed columns + CSR
 * attributes. When `cap` spans have ended, encode to OTLP protobuf and reset,
 * so finished spans never live long enough to be promoted.
 */
function columnar(cap) {
  const RND = new Int32Array(4096);
  let rp = RND.length;
  const rnd = () => { if (rp === RND.length) { crypto.getRandomValues(RND); rp = 0; } return RND[rp++]; };
  let size = Number.isFinite(cap) ? cap : 1024, n = 0, na = 0, asize = size * 4;
  let ids = new Int32Array(2 * size), pids = new Int32Array(2 * size), tids = new Int32Array(4 * size), hasParent = new Uint8Array(size);
  let name = new Uint32Array(size), start = new Float64Array(size), dur = new Float64Array(size), status = new Uint8Array(size);
  let attrStart = new Uint32Array(size + 1), attrKey = new Uint32Array(asize);
  let attrVal = new Array(asize).fill(0);
  const message = [], events = [], strings = [], intern = new Map(), chunks = [];
  const idx = (s) => { let k = intern.get(s); if (k === undefined) { k = strings.length; strings.push(s); intern.set(s, k); } return k; };
  const grow = () => {
    size *= 2;
    const g = (a, k = 1, extra = 0) => { const b = new a.constructor(size * k + extra); b.set(a); return b; };
    ids = g(ids, 2); pids = g(pids, 2); tids = g(tids, 4); hasParent = g(hasParent);
    name = g(name); start = g(start); dur = g(dur); status = g(status); attrStart = g(attrStart, 1, 1);
  };
  const growAttrs = () => {
    asize *= 2;
    const k = new Uint32Array(asize); k.set(attrKey); attrKey = k;
    const v = new Array(asize).fill(0); for (let i = 0; i < na; i++) v[i] = attrVal[i]; attrVal = v;
  };
  const emit = () => {
    attrStart[n] = na;
    chunks.push(encodeReverse({ n, traceId: new Uint8Array(tids.buffer), spanId: new Uint8Array(ids.buffer), parentId: new Uint8Array(pids.buffer),
      hasParent, name, start, dur, status, message, attrStart, attrKey, attrVal, events, strings }, RES).slice());
    n = 0; na = 0; message.length = 0;
  };
  class H {
    constructor(t0, t1, t2, t3, ph, pl, hp, nm) {
      this.t0 = t0; this.t1 = t1; this.t2 = t2; this.t3 = t3; this.hi = rnd(); this.lo = rnd();
      this.ph = ph; this.pl = pl; this.hp = hp; this.nm = idx(nm);
      this.na = 0; this.k0 = 0; this.v0 = 0; this.k1 = 0; this.v1 = 0; this.k2 = 0; this.v2 = 0;
      this.more = null; this.err = null;
      this.start = now();
    }
    get recording() { return true; }
    span(n2, a, f) { return run(this.t0, this.t1, this.t2, this.t3, this.hi, this.lo, true, n2, a, f); }
    set(k, v) {
      const key = idx(k);
      if (this.na === 0) { this.k0 = key; this.v0 = v; } else if (this.na === 1) { this.k1 = key; this.v1 = v; } else if (this.na === 2) { this.k2 = key; this.v2 = v; } else (this.more ??= []).push(key, v);
      this.na++;
    }
    event() {}
    fail(e) { this.err = String(e); }
    end() {
      if (n === size) grow();
      const i = n++;
      ids[2 * i] = this.hi; ids[2 * i + 1] = this.lo;
      pids[2 * i] = this.ph; pids[2 * i + 1] = this.pl; hasParent[i] = this.hp ? 1 : 0;
      tids[4 * i] = this.t0; tids[4 * i + 1] = this.t1; tids[4 * i + 2] = this.t2; tids[4 * i + 3] = this.t3;
      name[i] = this.nm; start[i] = this.start; dur[i] = now() - this.start;
      status[i] = this.err ? 2 : 0; if (this.err) message[i] = this.err;
      attrStart[i] = na;
      if (na + this.na > asize) growAttrs();
      if (this.na > 0) { attrKey[na] = this.k0; attrVal[na++] = this.v0; }
      if (this.na > 1) { attrKey[na] = this.k1; attrVal[na++] = this.v1; }
      if (this.na > 2) { attrKey[na] = this.k2; attrVal[na++] = this.v2; }
      if (this.more) for (let j = 0; j < this.more.length; j += 2) { if (na === asize) growAttrs(); attrKey[na] = this.more[j]; attrVal[na++] = this.more[j + 1]; }
      if (n === cap) emit();
    }
  }
  const run = (t0, t1, t2, t3, ph, pl, hp, nm, a, f) => {
    const fn = typeof a === 'function' ? a : f;
    const h = new H(t0, t1, t2, t3, ph, pl, hp, nm);
    if (typeof a === 'object' && a) for (const k in a) h.set(k, a[k]);
    try { return fn(h); } finally { h.end(); }
  };
  return {
    span: (nm, a, f) => run(rnd(), rnd(), rnd(), rnd(), 0, 0, false, nm, a, f),
    flush: () => { if (n) emit(); const t = chunks.reduce((s, c) => s + c.length, 0); chunks.length = 0; return t; },
  };
}

/** The shipped tracer (columnar since this bench), in either export format. */
function shipped(defer, format) {
  let bytes = 0;
  const t = tracer(Config.Record({ write: (c) => { bytes += c.length + (format === 'jsonl' ? 1 : 0); } }, { service: 'bench', defer, format }));
  return { span: t.span, flush: () => { t.flush(); const x = bytes; bytes = 0; return x; } };
}

// One "render": 1 root, 12 stages, 8 leaves each, 2 attrs per leaf (+1 on odd leaves).
const render = (t) => t.span('render', { iter: 1 }, (r) => {
  for (let s = 0; s < 12; s++) r.span('stage', (st) => {
    for (let k = 0; k < 8; k++) st.span('leaf', { atomic: true, items: k }, (l) => { if (k & 1) l.set('applied', k); });
  });
});
const SPANS = 1 + 12 + 96;

const gc = globalThis.gc ?? (() => {});
const arms = [
  ['noop (workload only)', () => ({ span: NOOP_TRACER.span, flush: () => 0 })],
  ['prototype columnar, proto /2048', () => columnar(2048)],
  ['tracer, format jsonl /2048', () => shipped(2048, 'jsonl')],
  ['tracer, format otlp /2048', () => shipped(2048, 'otlp')],
];
const rows = [];
for (const [label, make] of arms) {
  { const t = make(); for (let i = 0; i < 1000; i++) render(t); t.flush(); } // warm
  const reps = [];
  for (let rep = 0; rep < 7; rep++) {
    gc();
    const t = make();
    const R = 3000;
    const a = performance.now();
    for (let i = 0; i < R; i++) render(t);
    const bytes = t.flush();
    reps.push({ ns: ((performance.now() - a) * 1e6) / (R * SPANS), bytes: bytes / (R * SPANS) });
  }
  reps.sort((x, y) => x.ns - y.ns);
  rows.push([label, reps[3].ns, reps[1].ns, reps[5].ns, reps[3].bytes]);
}
const base = rows[0][1];
console.log('recorder (record + flush)   ns/span p50 [p25-p75]   tracer cost   out B/span');
for (const [l, p50, lo, hi, b] of rows) console.log(`${l.padEnd(32)} ${p50.toFixed(0).padStart(6)} [${lo.toFixed(0)}-${hi.toFixed(0)}]`.padEnd(50) + `${(p50 - base).toFixed(0).padStart(8)}   ${b.toFixed(0).padStart(8)}`);
