// @ts-check
// otel-compact: a tracer whose disabled form is a plain function call.
//
//   const t = tracer(Config.Noop)                       // fn(NOOP_SPAN), nothing else
//   const t = tracer(Config.Record(sink, { service }))  // JSONL lines (default) or OTLP protobuf chunks
//
// Recording keeps finished spans in typed columns (ids as int32 words, names
// interned, attributes in CSR layout) and exports a batch every `defer` spans.
// See bench/recorders.js for why: ~2.4× cheaper per span than an object per span.
//
// Context is passed explicitly: a span's callback receives its handle, and
// children hang off that handle. No AsyncLocalStorage, so the same code runs
// in Workers, browsers, Node, Bun and Deno with identical semantics.

import { variants, NONE } from './adt.js';
import { encodeReverse, NO_EVENTS } from './otlp.js';

export const FORMAT_VERSION = 1;

/** @typedef {string | number | boolean | string[] | number[] | boolean[]} AttrValue */
/** @typedef {Record<string, AttrValue>} Attrs */

/** @typedef {{ write(chunk: any): void, flush?(): void | Promise<void> }} Sink  JSONL: one string per line; OTLP: one Uint8Array per batch */
/**
 * @typedef {{ now(): number, fromPerfMs?: (ms: number) => number }} Clock
 * epoch microseconds, monotonic within a tracer. fromPerfMs maps a performance.now()
 * timestamp (e.g. a PerformanceEntry) onto the same timeline.
 */
/**
 * @typedef {{ trace(): readonly [number, number, number, number], next(): number }} Ids
 * int32 words: a trace id is 4, a span id is 2 (hi, lo). Bytes on the wire are
 * the words' little-endian memory, so JSONL hex and protobuf bytes always agree.
 */
/**
 * @typedef {{ service?: string, resource?: Attrs, clock?: Clock, ids?: Ids, defer?: number, format?: 'jsonl' | 'otlp' }} RecordOpts
 * defer: spans per exported batch (default 1: export as each span ends). Larger
 * batches keep serialisation out of the measured code and cost less per span.
 * format: 'jsonl' (default) writes one line per span; 'otlp' writes one OTLP
 * ExportTraceServiceRequest per batch (concatenated chunks are a valid request).
 */

export const Config = variants('Config', { Noop: [], Record: ['sink', 'opts'] });
/** @typedef {import('./adt.js').Of<typeof Config>} ConfigT */

export const Status = variants('Status', { Unset: [], Error: ['message'] });
/** @typedef {import('./adt.js').Of<typeof Status>} StatusT */

/**
 * @typedef {object} Span
 * @property {boolean} recording   false under Noop: guard expensive attribute work with it
 * @property {<T>(name: string, attrsOrFn: Attrs | ((s: Span) => T), fn?: (s: Span) => T) => T} span
 * @property {(key: string, value: AttrValue) => void} set
 * @property {(name: string, attrs?: Attrs) => void} event
 * @property {(e: unknown) => void} fail   mark Error without throwing
 */

/**
 * @typedef {object} Tracer
 * @property {boolean} recording
 * @property {<T>(name: string, attrsOrFn: Attrs | ((s: Span) => T), fn?: (s: Span) => T) => T} span
 * @property {() => void | Promise<void>} flush
 * @property {(name: string, attrs: Attrs, startUs: number, durUs: number) => void} record
 *   an already-finished interval observed elsewhere (e.g. a GC pause), as its own root span
 * @property {Clock | null} clock
 */

const noop = () => {};

/** @type {Span} */
export const NOOP_SPAN = Object.freeze({
  recording: false,
  span: (_name, a, f) => /** @type {any} */ (typeof a === 'function' ? a : f)(NOOP_SPAN),
  set: noop,
  event: noop,
  fail: noop,
});

/** @type {Tracer} */
export const NOOP_TRACER = Object.freeze({
  recording: false,
  span: NOOP_SPAN.span,
  flush: noop,
  record: noop,
  clock: null,
});

/** @param {ConfigT} config @returns {Tracer} */
export function tracer(config) {
  return Config.match(config, {
    Noop: () => NOOP_TRACER,
    Record: ({ sink, opts }) => recordingTracer(sink, opts ?? {}),
  });
}

// ---------------------------------------------------------------------------
// Default ports. Both are replaceable for deterministic tests.

/** @returns {Clock} */
export function systemClock() {
  const perf = globalThis.performance;
  if (!perf) return { now: () => Date.now() * 1000 };
  // Anchor the monotonic clock to wall time once; never re-read Date.now().
  const base = Date.now() * 1000 - perf.now() * 1000;
  return { now: () => base + perf.now() * 1000, fromPerfMs: (ms) => base + ms * 1000 };
}

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));

/**
 * CSPRNG int32 words from a pooled buffer (one getRandomValues per 4096 words).
 * @returns {Ids}
 */
export function pooledRandomIds(words = 4096) {
  const pool = new Int32Array(words);
  let p = words;
  const next = () => { if (p === words) { globalThis.crypto.getRandomValues(pool); p = 0; } return pool[p++]; };
  return { next, trace: () => [next(), next(), next(), next()] };
}

/** @type {Ids} */
export const randomIds = Object.freeze(pooledRandomIds());

/** Byte-swap so a counter reads big-endian in hex: bswap(1) is stored as bytes 00 00 00 01. @param {number} x */
const bswap = (x) => ((x & 0xff) << 24) | ((x & 0xff00) << 8) | ((x >>> 8) & 0xff00) | (x >>> 24);

/** Deterministic ids for golden tests: span k is 000…0k, trace t is 000…0t. @returns {Ids} */
export function counterIds() {
  let t = 0, s = 0, half = 0;
  return {
    trace: () => [0, 0, 0, bswap(++t)],
    next: () => ((half ^= 1) ? 0 : bswap(++s)),
  };
}

/** Deterministic clock: each read advances by `step` µs. @returns {Clock} */
export function stepClock(start = 1_700_000_000_000_000, step = 10) {
  let t = start - step;
  return { now: () => (t += step) };
}

// ---------------------------------------------------------------------------

/**
 * To an attribute value, or NONE for values OpenTelemetry cannot carry (null, functions, symbols).
 * NONE is the single branded 'absent' value; no allocation on this hot path.
 * @param {unknown} v @returns {AttrValue | typeof NONE}
 */
function sanitize(v) {
  switch (typeof v) {
    case 'string':
    case 'boolean':
      return v;
    case 'number':
      return Number.isFinite(v) ? v : String(v);
    case 'bigint':
      return v.toString();
    case 'object':
      if (Array.isArray(v)) return /** @type {any} */ (v.map((x) => { const y = sanitize(x); return y === NONE ? null : y; }));
      return v === null ? NONE : String(v);
    default:
      return NONE;
  }
}

/** @param {unknown} e */
const messageOf = (e) => (e instanceof Error ? `${e.name}: ${e.message}` : String(e));

/** @param {number} us */
const round3 = (us) => Math.round(us * 1000) / 1000;

/**
 * @param {Sink} sink
 * @param {RecordOpts} opts
 * @returns {Tracer}
 */
function recordingTracer(sink, opts) {
  const clock = opts.clock ?? systemClock();
  const ids = opts.ids ?? randomIds;
  const format = opts.format ?? 'jsonl';
  const cap = Math.max(1, opts.defer ?? 1);
  const t0 = Math.round(clock.now()); // tracer creation, so t0 <= every span's ts
  const resource = { service: opts.service ?? 'unknown', attrs: /** @type {[string, AttrValue][]} */ (Object.entries(opts.resource ?? {})), scope: 'otel-compact', version: String(FORMAT_VERSION) };
  let wroteResource = false;

  // ---- columns: one row per ended span --------------------------------------
  let size = Math.min(cap, 4096), n = 0, na = 0, asize = size * 2;
  let ids32 = new Int32Array(2 * size), pids32 = new Int32Array(2 * size), tids32 = new Int32Array(4 * size), hasParent = new Uint8Array(size);
  let name = new Uint32Array(size), start = new Float64Array(size), dur = new Float64Array(size), status = new Uint8Array(size);
  let attrStart = new Uint32Array(size + 1), attrKey = new Uint32Array(asize);
  /** @type {AttrValue[]} */
  let attrVal = new Array(asize).fill(0);
  /** Status message per buffered span, '' when none. @type {string[]} */
  const message = [];
  /** Events per buffered span, NO_EVENTS when none. @type {ReadonlyArray<readonly [number, string, Attrs?]>[]} */
  const events = [];
  /** @type {string[]} */
  const strings = [];
  /** @type {Map<string, number>} */
  const intern = new Map();
  /** JSON-escaped form of each interned string, filled lazily at export. @type {string[]} */
  const jsonStr = [];
  /** @param {string} s */
  const idx = (s) => { const known = intern.get(s); if (typeof known === 'number') return known; const k = strings.length; strings.push(s); intern.set(s, k); return k; };

  const grow = () => {
    size *= 2;
    /** @template {Int32Array | Uint32Array | Uint8Array | Float64Array} T @param {T} a @param {number} k @param {number} [extra] @returns {T} */
    const g = (a, k, extra = 0) => { const b = /** @type {T} */ (new /** @type {any} */ (a.constructor)(size * k + extra)); b.set(/** @type {any} */ (a)); return b; };
    ids32 = g(ids32, 2); pids32 = g(pids32, 2); tids32 = g(tids32, 4); hasParent = g(hasParent, 1);
    name = g(name, 1); start = g(start, 1); dur = g(dur, 1); status = g(status, 1); attrStart = g(attrStart, 1, 1);
  };
  /** @param {number} need */
  const growAttrs = (need) => {
    while (asize < need) asize *= 2;
    const k = new Uint32Array(asize); k.set(attrKey); attrKey = k;
    // New packed array: setting .length on a big array can drop V8 into dictionary elements.
    const v = new Array(asize).fill(0); for (let i = 0; i < na; i++) v[i] = attrVal[i]; attrVal = v;
  };

  /** Export the batch and reset. Open spans live in their handles, so nothing is lost. */
  const emit = () => {
    if (n === 0) return;
    attrStart[n] = na;
    if (format === 'otlp') {
      // Events keep attributes as objects (the JSONL shape); the encoder takes [key, value] tuples.
      const ev = events.slice(0, n).map((e) => (e.length ? e.map(([o, nm, a]) => /** @type {const} */ ([o, nm, a ? Object.entries(a) : []])) : NO_EVENTS));
      const batch = { n, traceId: new Uint8Array(tids32.buffer), spanId: new Uint8Array(ids32.buffer), parentId: new Uint8Array(pids32.buffer),
        hasParent, name, start, dur, status, message, attrStart, attrKey, attrVal, events: ev, strings };
      sink.write(encodeReverse(batch, resource).slice());
    } else {
      if (!wroteResource) {
        wroteResource = true;
        sink.write(JSON.stringify({ k: 'r', v: FORMAT_VERSION, svc: resource.service, a: opts.resource ?? {}, t0 }));
      }
      const tb = new Uint8Array(tids32.buffer), sb = new Uint8Array(ids32.buffer), pb = new Uint8Array(pids32.buffer);
      // Fixed schema, written directly: same string JSON.stringify would produce for
      // { k, tr, id, pa, n, ts, du, a?, st?, msg?, ev? } (golden tests hold it to that).
      for (let j = jsonStr.length; j < strings.length; j++) jsonStr.push(JSON.stringify(strings[j]));
      for (let i = 0; i < n; i++) {
        let line = `{"k":"s","tr":"${hex(tb, 16 * i, 16)}","id":"${hex(sb, 8 * i, 8)}","pa":${hasParent[i] ? `"${hex(pb, 8 * i, 8)}"` : 'null'},"n":${jsonStr[name[i]]},"ts":${Math.round(start[i])},"du":${round3(dur[i])}`;
        const a0 = attrStart[i], a1 = attrStart[i + 1];
        if (a1 > a0) {
          // Object semantics: a repeated key keeps its first position and its last value.
          line += ',"a":{';
          for (let j = a0; j < a1; j++) {
            const v = attrVal[j];
            line += `${j > a0 ? ',' : ''}${jsonStr[attrKey[j]]}:${typeof v === 'string' || typeof v === 'object' ? JSON.stringify(v) : v}`;
          }
          line += '}';
        }
        if (status[i] === 2) line += `,"st":2,"msg":${JSON.stringify(message[i])}`;
        if (events[i].length) line += `,"ev":${JSON.stringify(events[i])}`;
        sink.write(line + '}');
      }
    }
    for (let i = 0; i < n; i++) { message[i] = ''; events[i] = NO_EVENTS; } // drop references
    n = 0; na = 0;
  };

  /**
   * Append one finished span. Attributes come as up to 3 inline pairs plus an overflow list.
   * @param {Rec | null} r  null for a recorded interval (attrs passed in `extra`)
   */
  const push = (r, t0w = 0, t1w = 0, t2w = 0, t3w = 0, hi = 0, lo = 0, nm = 0, st = 0, du = 0, /** @type {Attrs | null} */ extra = null) => {
    if (n === size) grow();
    const i = n++;
    if (r) { t0w = r.t0; t1w = r.t1; t2w = r.t2; t3w = r.t3; hi = r.hi; lo = r.lo; nm = r.nm; st = r.start; du = r.dur; }
    tids32[4 * i] = t0w; tids32[4 * i + 1] = t1w; tids32[4 * i + 2] = t2w; tids32[4 * i + 3] = t3w;
    ids32[2 * i] = hi; ids32[2 * i + 1] = lo;
    if (r && r.hp) { pids32[2 * i] = r.ph; pids32[2 * i + 1] = r.pl; hasParent[i] = 1; } else { pids32[2 * i] = 0; pids32[2 * i + 1] = 0; hasParent[i] = 0; }
    name[i] = nm; start[i] = st; dur[i] = du;
    attrStart[i] = na;
    if (r) {
      const k = r.na;
      if (na + k > asize) growAttrs(na + k);
      if (k > 0) { attrKey[na] = r.k0; attrVal[na++] = r.v0; }
      if (k > 1) { attrKey[na] = r.k1; attrVal[na++] = r.v1; }
      if (k > 2) { attrKey[na] = r.k2; attrVal[na++] = r.v2; }
      if (r.more) for (let j = 0; j < r.more.length; j += 2) { attrKey[na] = r.more[j]; attrVal[na++] = r.more[j + 1]; }
      status[i] = r.error === null ? 0 : 2;
      message[i] = r.error === null ? '' : r.error;
      events[i] = r.events === null ? NO_EVENTS : r.events;
    } else {
      status[i] = 0; message[i] = ''; events[i] = NO_EVENTS;
      if (extra) for (const key in extra) {
        const v = sanitize(extra[key]);
        if (v === NONE) continue;
        if (na === asize) growAttrs(na + 1);
        attrKey[na] = idx(key); attrVal[na++] = /** @type {AttrValue} */ (v);
      }
    }
    if (n === cap) emit();
  };

  // ---- open spans ------------------------------------------------------------
  // One object of numbers per open span: ids are int32 words (unboxed small
  // integers in V8), up to three attributes live in inline fields.
  class Rec {
    /**
     * @param {number} t0 @param {number} t1 @param {number} t2 @param {number} t3
     * @param {number} ph @param {number} pl @param {boolean} hp @param {string} nm
     */
    constructor(t0, t1, t2, t3, ph, pl, hp, nm) {
      this.t0 = t0; this.t1 = t1; this.t2 = t2; this.t3 = t3;
      this.hi = ids.next(); this.lo = ids.next();
      this.ph = ph; this.pl = pl; this.hp = hp;
      this.nm = idx(nm);
      this.na = 0;
      this.k0 = 0; this.k1 = 0; this.k2 = 0;
      /** @type {AttrValue} */
      this.v0 = 0;
      /** @type {AttrValue} */
      this.v1 = 0;
      /** @type {AttrValue} */
      this.v2 = 0;
      /** @type {any[] | null} */ this.more = null;
      /** @type {Array<[number, string, Attrs?]> | null} */ this.events = null;
      /** @type {string | null} */ this.error = null;
      this.ended = false;
      this.dur = 0;
      this.start = clock.now();
    }
    get recording() { return true; }
    /** @type {Span['span']} */
    span(n2, a, f) { return run(this.t0, this.t1, this.t2, this.t3, this.hi, this.lo, true, n2, a, f); }
    /** @param {string} k @param {AttrValue} v */
    set(k, v) {
      const y = sanitize(v);
      if (y === NONE) return;
      const x = /** @type {AttrValue} */ (y);
      const key = idx(k);
      // Overwrite an existing key, as an object would.
      if (this.na > 0 && this.k0 === key) { this.v0 = x; return; }
      if (this.na > 1 && this.k1 === key) { this.v1 = x; return; }
      if (this.na > 2 && this.k2 === key) { this.v2 = x; return; }
      if (this.more) for (let j = 0; j < this.more.length; j += 2) if (this.more[j] === key) { this.more[j + 1] = x; return; }
      if (this.na === 0) { this.k0 = key; this.v0 = x; }
      else if (this.na === 1) { this.k1 = key; this.v1 = x; }
      else if (this.na === 2) { this.k2 = key; this.v2 = x; }
      else (this.more ??= []).push(key, x);
      this.na++;
    }
    /** @param {string} n2 @param {Attrs} [a] */
    event(n2, a) {
      const at = round3(clock.now() - this.start);
      (this.events ??= []).push(a ? [at, n2, a] : [at, n2]);
    }
    /** @param {unknown} e */
    fail(e) { this.error = messageOf(e); }
    end() {
      if (this.ended) return;
      this.ended = true;
      this.dur = clock.now() - this.start;
      push(this);
    }
  }

  /**
   * @param {number} t0 @param {number} t1 @param {number} t2 @param {number} t3
   * @param {number} ph @param {number} pl @param {boolean} hp
   * @param {string} nm
   * @param {Attrs | ((s: Span) => any)} attrsOrFn
   * @param {unknown} maybeFn  the callback when attributes were given (JS overload: span(name, fn) | span(name, attrs, fn))
   */
  const run = (t0, t1, t2, t3, ph, pl, hp, nm, attrsOrFn, maybeFn) => {
    const fn = typeof attrsOrFn === 'function' ? attrsOrFn : maybeFn;
    if (typeof fn !== 'function') throw new TypeError(`span ${nm}: missing callback`); // bug: caller passed no function
    const rec = new Rec(t0, t1, t2, t3, ph, pl, hp, nm);
    if (typeof attrsOrFn === 'object' && attrsOrFn !== null) for (const k in attrsOrFn) rec.set(k, attrsOrFn[k]);
    let result;
    try {
      result = fn(/** @type {Span} */ (/** @type {unknown} */ (rec)));
    } catch (e) {
      rec.fail(e);
      rec.end();
      throw e; // rethrow: the tracer is transparent; the callback's own exception is not ours to swallow
    }
    if (result !== null && typeof result === 'object' && typeof result.then === 'function') {
      return result.then(
        (/** @type {unknown} */ v) => { rec.end(); return v; },
        (/** @type {unknown} */ e) => { rec.fail(e); rec.end(); throw e; }, // rethrow: transparent, as above
      );
    }
    rec.end();
    return result;
  };

  return {
    recording: true,
    span: (nm, a, f) => { const [a0, a1, a2, a3] = ids.trace(); return run(a0, a1, a2, a3, 0, 0, false, nm, a, f); },
    flush: () => { emit(); if (sink.flush) return sink.flush(); },
    record: (nm, attrs, startUs, durUs) => {
      const [a0, a1, a2, a3] = ids.trace();
      push(null, a0, a1, a2, a3, ids.next(), ids.next(), idx(nm), startUs, durUs, attrs);
    },
    clock,
  };
}

/** Lowercase hex of b[at..at+n). @param {Uint8Array} b @param {number} at @param {number} n */
function hex(b, at, n) {
  let s = '';
  for (let i = 0; i < n; i++) s += HEX[b[at + i]];
  return s;
}

// ---------------------------------------------------------------------------
// Sinks (portable). File sinks live in ./node.js.

/** @returns {Sink & { lines: string[] }} */
export function memorySink() {
  /** @type {string[]} */
  const lines = [];
  return { lines, write: (l) => { lines.push(l); } };
}

/**
 * Buffer lines and hand them to `writeChunk` as one newline-terminated string.
 * @param {(chunk: string) => void | Promise<void>} writeChunk
 * @param {{ maxLines?: number }} [o]
 * @returns {Sink}
 */
export function batchSink(writeChunk, { maxLines = 512 } = {}) {
  /** @type {string[]} */
  let buf = [];
  const flush = () => {
    if (buf.length === 0) return;
    const chunk = buf.join('\n') + '\n';
    buf = [];
    return writeChunk(chunk);
  };
  return {
    write: (l) => {
      buf.push(l);
      if (buf.length >= maxLines) flush();
    },
    flush,
  };
}
