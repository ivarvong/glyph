// @ts-check
// OTLP/protobuf, hand-encoded. No schema compiler, no dependency.
//
//   SpanBatch (pure data)  --encodeForward-->  ExportTraceServiceRequest bytes
//                          --encodeReverse-->  (byte-identical)
//
// Field numbers: opentelemetry-proto @ 09769935 (trace.proto, common.proto,
// resource.proto, collector/trace/v1/trace_service.proto).
//
// Forward: size every message first, then write front to back (the textbook way).
// Reverse: write back to front, so a nested message's length is known the moment
// its body is done; one pass, no sizes, no backpatching (the upb technique).
// Writing fields in exactly reversed order makes the two produce identical bytes.

/** The shared, frozen 'no events' value in a SpanBatch. @type {ReadonlyArray<never>} */
export const NO_EVENTS = Object.freeze(/** @type {never[]} */ ([]));

/** @typedef {string | number | boolean | string[] | number[] | boolean[]} AttrValue */
/** @typedef {readonly [string, AttrValue]} Attr  a pure-data key/value tuple */

/**
 * Columnar batch of finished spans. Everything per-span is a typed array or a
 * plain array of tuples; names are indices into an interned string table.
 * @typedef {object} SpanBatch
 * @property {number} n
 * @property {Uint8Array} traceId    16·n bytes
 * @property {Uint8Array} spanId     8·n bytes
 * @property {Uint8Array} parentId   8·n bytes (all zero = root)
 * @property {Uint8Array} hasParent  n
 * @property {Uint32Array} name      n, index into strings
 * @property {Float64Array} start    n, epoch µs
 * @property {Float64Array} dur      n, µs
 * @property {Uint8Array} status     n, 0 unset · 2 error
 * @property {string[]} message   status message per span ('' = none)
 * @property {Uint32Array} attrStart  n+1 CSR offsets: span i owns attributes [attrStart[i], attrStart[i+1])
 * @property {Uint32Array} attrKey    key, index into strings
 * @property {AttrValue[]} attrVal    value
 * @property {ReadonlyArray<readonly [number, string, Attr[]]>[]} events  [offset µs, name, attrs] per span (empty = none)
 * @property {string[]} strings
 */

/** @typedef {{ service: string, attrs: Attr[], scope: string, version: string }} Resource */

// --- wire primitives ------------------------------------------------------------

const VARINT = 0, I64 = 1, LEN = 2;
/** @param {number} field @param {number} wire */
const tag = (field, wire) => (field << 3) | wire;

/** Bytes in the varint of a uint32. @param {number} v */
const vlen32 = (v) => (v < 0x80 ? 1 : v < 0x4000 ? 2 : v < 0x200000 ? 3 : v < 0x10000000 ? 4 : 5);

const enc = new TextEncoder();
/** UTF-8 cache: names, keys and many values repeat across spans. */
const utf8Cache = new Map();
/** @param {string} s @returns {Uint8Array} */
const utf8 = (s) => {
  let b = utf8Cache.get(s);
  if (!b) {
    b = enc.encode(s);
    if (utf8Cache.size > 4096) utf8Cache.clear();
    utf8Cache.set(s, b);
  }
  return b;
};


/**
 * Write µs as fixed64 unix nanos at b[p..p+8), little-endian, exactly (no BigInt, no arrays).
 * @param {Uint8Array} b @param {number} p @param {number} us
 */
const putNanos = (b, p, us) => {
  const whole = Math.floor(us);
  const frac = Math.round((us - whole) * 1000);
  const hiU = Math.floor(whole / 4294967296), loU = whole - hiU * 4294967296;
  const low = loU * 1000 + frac;
  const carry = Math.floor(low / 4294967296);
  const lo = low - carry * 4294967296, hi = hiU * 1000 + carry;
  b[p] = lo; b[p + 1] = lo >>> 8; b[p + 2] = lo >>> 16; b[p + 3] = lo >>> 24;
  b[p + 4] = hi; b[p + 5] = hi >>> 8; b[p + 6] = hi >>> 16; b[p + 7] = hi >>> 24;
};

// --- AnyValue: sizes shared by both encoders ------------------------------------

const f64 = new Float64Array(1), f64b = new Uint8Array(f64.buffer);

/** @param {AttrValue} v @returns {number} body size of AnyValue */
function anySize(v) {
  if (typeof v === 'string') { const b = utf8(v).length; return 1 + vlen32(b) + b; }
  if (typeof v === 'boolean') return 2;
  if (typeof v === 'number') return Number.isInteger(v) ? 1 + int64Len(v) : 9;
  // array: ArrayValue { repeated AnyValue values = 1 }
  let inner = 0;
  for (const x of /** @type {any[]} */ (v)) { const s = anySize(x); inner += 1 + vlen32(s) + s; }
  return 1 + vlen32(inner) + inner;
}
/** Two's-complement varint length of an int64-valued integer. @param {number} v */
const int64Len = (v) => {
  if (v < 0) return 10;
  let n = 1;
  while (v >= 128) { v = Math.floor(v / 128); n++; }
  return n;
};
/** KeyValue body size. @param {Uint8Array} kb @param {AttrValue} v */
const kvSize2 = (kb, v) => { const a = anySize(v); return 1 + vlen32(kb.length) + kb.length + 1 + vlen32(a) + a; };
/** @param {Attr} kv */
const kvSize = ([k, v]) => kvSize2(utf8(k), v);

// --- forward encoder -------------------------------------------------------------

class Fwd {
  /** @param {number} size */
  constructor(size) { this.b = new Uint8Array(size); this.p = 0; }
  /** @param {number} v */
  v32(v) { const b = this.b; while (v >= 0x80) { b[this.p++] = (v & 0x7f) | 0x80; v >>>= 7; } b[this.p++] = v; }
  /** @param {number} v */
  i64(v) {
    if (v >= 0 && v < 2147483648) { this.v32(v); return; }
    // Non-negative: plain base-128. Negative: 10-byte two's complement.
    if (v >= 0) { while (v >= 128) { this.b[this.p++] = (v % 128) | 0x80; v = Math.floor(v / 128); } this.b[this.p++] = v; return; }
    let lo = v >>> 0, hi = Math.floor(v / 4294967296) >>> 0;
    for (let i = 0; i < 9; i++) { this.b[this.p++] = (lo & 0x7f) | 0x80; lo = ((lo >>> 7) | (hi << 25)) >>> 0; hi >>>= 7; }
    this.b[this.p++] = lo & 1;
  }
  /** @param {Uint8Array} x */
  raw(x) {
    const n = x.length, b = this.b;
    if (n < 32) { let p = this.p; for (let i = 0; i < n; i++) b[p++] = x[i]; this.p = p; }
    else { b.set(x, this.p); this.p += n; }
  }
  /** Length-delimited bytes copied from src[off..off+n). @param {number} field @param {Uint8Array} src @param {number} off @param {number} n */
  bytesAt(field, src, off, n) {
    const b = this.b;
    let p = this.p;
    b[p++] = tag(field, LEN); b[p++] = n;
    for (let i = 0; i < n; i++) b[p++] = src[off + i];
    this.p = p;
  }
  /** @param {number} field @param {number} us */
  nanos(field, us) { this.b[this.p++] = tag(field, I64); putNanos(this.b, this.p, us); this.p += 8; }
  /** @param {number} lo @param {number} hi */
  fixed64(lo, hi) {
    const b = this.b, p = this.p;
    b[p] = lo; b[p + 1] = lo >>> 8; b[p + 2] = lo >>> 16; b[p + 3] = lo >>> 24;
    b[p + 4] = hi; b[p + 5] = hi >>> 8; b[p + 6] = hi >>> 16; b[p + 7] = hi >>> 24;
    this.p += 8;
  }
  /** @param {number} field @param {Uint8Array} x */
  bytes(field, x) { this.v32(tag(field, LEN)); this.v32(x.length); this.raw(x); }
  /** @param {AttrValue} v */
  any(v) {
    if (typeof v === 'string') return this.bytes(1, utf8(v));
    if (typeof v === 'boolean') { this.v32(tag(2, VARINT)); this.v32(v ? 1 : 0); return; }
    if (typeof v === 'number') {
      if (Number.isInteger(v)) { this.v32(tag(3, VARINT)); this.i64(v); return; }
      this.v32(tag(4, I64)); f64[0] = v; this.raw(f64b); return;
    }
    let inner = 0;
    for (const x of /** @type {any[]} */ (v)) { const s = anySize(x); inner += 1 + vlen32(s) + s; }
    this.v32(tag(5, LEN)); this.v32(inner);
    for (const x of /** @type {any[]} */ (v)) { this.v32(tag(1, LEN)); this.v32(anySize(x)); this.any(x); }
  }
  /** @param {number} field @param {Attr} kv */
  kv(field, kv) { this.kv2(field, utf8(kv[0]), kv[1]); }
  /** @param {number} field @param {Uint8Array} kb @param {AttrValue} v */
  kv2(field, kb, v) {
    this.v32(tag(field, LEN)); this.v32(kvSize2(kb, v));
    this.bytes(1, kb);
    this.v32(tag(2, LEN)); this.v32(anySize(v)); this.any(v);
  }
}

/** Span body size (and its parts, reused by the writer). @param {SpanBatch} b @param {number} i */
function spanSize(b, i, names = b.strings.map(utf8)) {
  const nm = names[b.name[i]].length;
  let s = 2 + 16 + 2 + 8 + (b.hasParent[i] ? 2 + 8 : 0) + 1 + vlen32(nm) + nm + 2 + 9 + 9; // ids, name, kind, start, end
  for (let a = b.attrStart[i], e = b.attrStart[i + 1]; a < e; a++) { const k = kvSize2(names[b.attrKey[a]], b.attrVal[a]); s += 1 + vlen32(k) + k; }
  const ev = b.events[i];
  if (ev) for (const e of ev) { const k = eventSize(e); s += 1 + vlen32(k) + k; }
  if (b.status[i]) { const st = statusSize(b, i); s += 1 + vlen32(st) + st; }
  return s;
}
/** @param {readonly [number, string, Attr[]]} e */
function eventSize(e) {
  const nb = utf8(e[1]).length;
  let s = 9 + 1 + vlen32(nb) + nb;
  if (e[2]) for (const kv of e[2]) { const k = kvSize(kv); s += 1 + vlen32(k) + k; }
  return s;
}
/** @param {SpanBatch} b @param {number} i */
function statusSize(b, i) {
  const m = b.message[i];
  const mb = m ? utf8(m).length : 0;
  return (m ? 1 + vlen32(mb) + mb : 0) + 2;
}

/** @param {Resource} r */
function resourceSize(r) {
  let s = 0;
  for (const kv of r.attrs) { const k = kvSize(kv); s += 1 + vlen32(k) + k; }
  return s;
}
/** @param {Resource} r */
function scopeSize(r) {
  const a = utf8(r.scope).length, b = utf8(r.version).length;
  return 1 + vlen32(a) + a + 1 + vlen32(b) + b;
}
/** @param {Resource} r @returns {Resource} */
const withService = (r) => ({ ...r, attrs: [['service.name', r.service], ...r.attrs] });

/**
 * Forward encoder: sizes first, then one exact-size allocation.
 * @param {SpanBatch} b @param {Resource} resource
 */
export function encodeForward(b, resource) {
  const r = withService(resource);
  const names = b.strings.map(utf8);
  const sizes = new Uint32Array(b.n);
  let spans = 0;
  for (let i = 0; i < b.n; i++) { sizes[i] = spanSize(b, i, names); spans += 1 + vlen32(sizes[i]) + sizes[i]; }
  const res = resourceSize(r), sc = scopeSize(r);
  const scopeSpans = 1 + vlen32(sc) + sc + spans;
  const resourceSpans = 1 + vlen32(res) + res + 1 + vlen32(scopeSpans) + scopeSpans;
  const total = 1 + vlen32(resourceSpans) + resourceSpans;
  const w = new Fwd(total);
  w.v32(tag(1, LEN)); w.v32(resourceSpans);           // ExportTraceServiceRequest.resource_spans
  w.v32(tag(1, LEN)); w.v32(res);                     // ResourceSpans.resource
  for (const kv of r.attrs) w.kv(1, kv);              //   Resource.attributes
  w.v32(tag(2, LEN)); w.v32(scopeSpans);              // ResourceSpans.scope_spans
  w.v32(tag(1, LEN)); w.v32(sc);                      //   ScopeSpans.scope
  w.bytes(1, utf8(r.scope)); w.bytes(2, utf8(r.version));
  for (let i = 0; i < b.n; i++) {
    w.v32(tag(2, LEN)); w.v32(sizes[i]);              //   ScopeSpans.spans
    w.bytesAt(1, b.traceId, 16 * i, 16);
    w.bytesAt(2, b.spanId, 8 * i, 8);
    if (b.hasParent[i]) w.bytesAt(4, b.parentId, 8 * i, 8);
    w.bytes(5, names[b.name[i]]);
    w.v32(tag(6, VARINT)); w.v32(1);                  // SPAN_KIND_INTERNAL
    w.nanos(7, b.start[i]);
    w.nanos(8, b.start[i] + b.dur[i]);
    for (let a = b.attrStart[i], e = b.attrStart[i + 1]; a < e; a++) w.kv2(9, names[b.attrKey[a]], b.attrVal[a]);
    const ev = b.events[i];
    if (ev) for (const e of ev) {
      w.v32(tag(11, LEN)); w.v32(eventSize(e));
      w.nanos(1, b.start[i] + e[0]);
      w.bytes(2, utf8(e[1]));
      if (e[2]) for (const kv of e[2]) w.kv(3, kv);
    }
    if (b.status[i]) {
      w.v32(tag(15, LEN)); w.v32(statusSize(b, i));
      const m = b.message[i];
      if (m) w.bytes(2, utf8(m));
      w.v32(tag(3, VARINT)); w.v32(b.status[i]);
    }
  }
  if (w.p !== total) throw new Error(`forward encoder size drift: wrote ${w.p}, sized ${total}`); // bug: sizing and writing disagree
  return w.b;
}

// --- reverse encoder -------------------------------------------------------------

const scratch = new Fwd(10);

class Rev {
  /** @param {number} hint */
  constructor(hint) { this.b = new Uint8Array(Math.max(256, hint)); this.p = this.b.length; }
  /** Bytes written so far. Marks are taken in this unit because growth moves the data but preserves it. */
  get w() { return this.b.length - this.p; }
  /** @param {number} n */
  need(n) {
    if (this.p >= n) return;
    const old = this.b, used = old.length - this.p;
    let size = old.length * 2;
    while (size - used < n) size *= 2;
    const b = new Uint8Array(size);
    b.set(old.subarray(this.p), size - used);
    this.b = b; this.p = size - used;
  }
  /** @param {number} v */
  v32(v) {
    if (v < 0x80) { this.need(1); this.b[--this.p] = v; return; }
    const n = vlen32(v);
    this.need(n);
    let p = (this.p -= n);
    const b = this.b;
    while (v >= 0x80) { b[p++] = (v & 0x7f) | 0x80; v >>>= 7; }
    b[p] = v;
  }
  /** @param {number} v */
  i64(v) {
    if (v >= 0 && v < 2147483648) { this.v32(v); return; }
    scratch.p = 0; scratch.i64(v); this.raw(scratch.b.subarray(0, scratch.p));
  }
  /** @param {Uint8Array} x */
  raw(x) {
    const n = x.length;
    this.need(n);
    const p = (this.p -= n), b = this.b;
    if (n < 32) for (let i = 0; i < n; i++) b[p + i] = x[i];
    else b.set(x, p);
  }
  /** Length-delimited bytes copied from src[off..off+n), n < 128. @param {number} field @param {Uint8Array} src @param {number} off @param {number} n */
  bytesAt(field, src, off, n) {
    this.need(n + 2);
    const b = this.b, p = (this.p -= n + 2);
    b[p] = tag(field, LEN); b[p + 1] = n;
    for (let i = 0; i < n; i++) b[p + 2 + i] = src[off + i];
  }
  /** @param {number} field @param {number} us */
  nanos(field, us) { this.need(9); this.p -= 9; this.b[this.p] = tag(field, I64); putNanos(this.b, this.p + 1, us); }
  /** @param {number} lo @param {number} hi */
  fixed64(lo, hi) {
    this.need(8);
    const b = this.b, p = (this.p -= 8);
    b[p] = lo; b[p + 1] = lo >>> 8; b[p + 2] = lo >>> 16; b[p + 3] = lo >>> 24;
    b[p + 4] = hi; b[p + 5] = hi >>> 8; b[p + 6] = hi >>> 16; b[p + 7] = hi >>> 24;
  }
  /** Close a length-delimited field around everything written since `mark`. @param {number} field @param {number} mark */
  close(field, mark) { this.v32(this.w - mark); this.v32(tag(field, LEN)); }
  /** @param {number} field @param {Uint8Array} x */
  bytes(field, x) { this.raw(x); this.v32(x.length); this.v32(tag(field, LEN)); }
  /** @param {AttrValue} v */
  any(v) {
    if (typeof v === 'string') return this.bytes(1, utf8(v));
    if (typeof v === 'boolean') { this.v32(v ? 1 : 0); this.v32(tag(2, VARINT)); return; }
    if (typeof v === 'number') {
      if (Number.isInteger(v)) { this.i64(v); this.v32(tag(3, VARINT)); return; }
      f64[0] = v; this.raw(f64b); this.v32(tag(4, I64)); return;
    }
    const m = this.w;
    const arr = /** @type {any[]} */ (v);
    for (let k = arr.length - 1; k >= 0; k--) { const e = this.w; this.any(arr[k]); this.close(1, e); }
    this.close(5, m);
  }
  /** @param {number} field @param {Attr} kv */
  kv(field, kv) { this.kv2(field, utf8(kv[0]), kv[1]); }
  /** @param {number} field @param {Uint8Array} kb @param {AttrValue} v */
  kv2(field, kb, v) {
    const m = this.w;
    this.any(v); this.close(2, m);
    this.bytes(1, kb);
    this.close(field, m);
  }
}

/**
 * Reverse encoder: one pass back to front, fields in exactly reversed order.
 * @param {SpanBatch} b @param {Resource} resource
 */
export function encodeReverse(b, resource) {
  const r = withService(resource);
  const names = b.strings.map(utf8);
  const w = new Rev(b.n * 128 + 256);
  // ExportTraceServiceRequest { resource_spans(1) { resource(1), scope_spans(2) { scope(1), spans(2)* } } }
  const mRS = w.w, mSS = w.w;
  for (let i = b.n - 1; i >= 0; i--) {
    const m = w.w;
    if (b.status[i]) {
      const e = w.w;
      w.v32(b.status[i]); w.v32(tag(3, VARINT));
      const msg = b.message[i];
      if (msg) w.bytes(2, utf8(msg));
      w.close(15, e);
    }
    const ev = b.events[i];
    if (ev) for (let k = ev.length - 1; k >= 0; k--) {
      const e = w.w, x = ev[k];
      if (x[2]) for (let a = x[2].length - 1; a >= 0; a--) w.kv(3, x[2][a]);
      w.bytes(2, utf8(x[1]));
      w.nanos(1, b.start[i] + x[0]);
      w.close(11, e);
    }
    for (let a = b.attrStart[i + 1] - 1, e = b.attrStart[i]; a >= e; a--) w.kv2(9, names[b.attrKey[a]], b.attrVal[a]);
    w.nanos(8, b.start[i] + b.dur[i]);
    w.nanos(7, b.start[i]);
    w.v32(1); w.v32(tag(6, VARINT));
    w.bytes(5, names[b.name[i]]);
    if (b.hasParent[i]) w.bytesAt(4, b.parentId, 8 * i, 8);
    w.bytesAt(2, b.spanId, 8 * i, 8);
    w.bytesAt(1, b.traceId, 16 * i, 16);
    w.close(2, m);
  }
  { const e = w.w; w.bytes(2, utf8(r.version)); w.bytes(1, utf8(r.scope)); w.close(1, e); }
  w.close(2, mSS);
  { const e = w.w; for (let a = r.attrs.length - 1; a >= 0; a--) w.kv(1, r.attrs[a]); w.close(1, e); }
  w.close(1, mRS);
  return w.b.subarray(w.p);
}

// --- building batches ------------------------------------------------------------

/** @param {string} hex @param {Uint8Array} out @param {number} at */
const hexInto = (hex, out, at) => { for (let i = 0; i < hex.length; i += 2) out[at + i / 2] = parseInt(hex.slice(i, i + 2), 16); };

/**
 * From parsed JSONL span records (read.js) to a SpanBatch: the bridge used by
 * `otc proto` and by the differential tests.
 * @param {import('./read.js').SpanRec[]} spans
 * @returns {SpanBatch}
 */
export function batchFromRecords(spans) {
  const n = spans.length;
  /** @type {Map<string, number>} */
  const intern = new Map();
  /** @type {string[]} */
  const strings = [];
  const b = {
    n,
    traceId: new Uint8Array(16 * n), spanId: new Uint8Array(8 * n), parentId: new Uint8Array(8 * n), hasParent: new Uint8Array(n),
    name: new Uint32Array(n), start: new Float64Array(n), dur: new Float64Array(n), status: new Uint8Array(n),
    message: /** @type {string[]} */ (new Array(n).fill('')),
    attrStart: new Uint32Array(n + 1), attrKey: new Uint32Array(spans.reduce((t, s) => t + Object.keys(s.attrs).length, 0)), attrVal: /** @type {AttrValue[]} */ ([]),
    events: /** @type {ReadonlyArray<readonly [number, string, Attr[]]>[]} */ (new Array(n).fill(NO_EVENTS)), strings,
  };
  const idx = (/** @type {string} */ str) => {
    const known = intern.get(str);
    if (typeof known === 'number') return known;
    const k = strings.length; strings.push(str); intern.set(str, k);
    return k;
  };
  let na = 0;
  spans.forEach((s, i) => {
    hexInto(s.traceId, b.traceId, 16 * i);
    hexInto(s.id, b.spanId, 8 * i);
    if (s.parent) { hexInto(s.parent, b.parentId, 8 * i); b.hasParent[i] = 1; }
    b.name[i] = idx(s.name);
    b.start[i] = s.start; b.dur[i] = s.dur;
    if (s.status.tag === 'Error') { b.status[i] = 2; b.message[i] = /** @type {any} */ (s.status).message; }
    b.attrStart[i] = na;
    for (const k in s.attrs) { b.attrKey[na] = idx(k); b.attrVal[na++] = s.attrs[k]; }
    b.attrStart[i + 1] = na;
    if (s.events.length) b.events[i] = s.events.map(([o, nm, a]) => /** @type {const} */ ([o, nm, a ? Object.entries(a) : []]));
  });
  return b;
}
