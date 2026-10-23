// @ts-check
// Reader for otel-compact JSONL: parse, rebuild the span forest, summarise,
// and convert to OTLP/JSON. Tolerant by design: a killed process leaves a
// torn last line, and the reader must still give you everything before it.

import { variants } from './adt.js';
import { FORMAT_VERSION, Status } from './trace.js';

export const ParseError = variants('ParseError', {
  BadJson: ['line', 'message'],
  UnknownKind: ['line', 'kind'],
  BadField: ['line', 'field'],
  Version: ['line', 'version'],
});

/**
 * @typedef {object} SpanRec
 * @property {string} traceId
 * @property {string} id
 * @property {string | null} parent
 * @property {string} name
 * @property {number} start   epoch µs
 * @property {number} dur     µs
 * @property {Record<string, any>} attrs
 * @property {import('./trace.js').StatusT} status
 * @property {Array<[number, string, Record<string, any>?]>} events
 */

/** @typedef {{ service: string, attrs: Record<string, any>, t0: number }} ResourceRec */

/**
 * @param {string} text
 * @returns {{ resource: ResourceRec | null, spans: SpanRec[], errors: any[] }}
 */
export function parse(text) {
  /** @type {SpanRec[]} */
  const spans = [];
  /** @type {any[]} */
  const errors = [];
  /** @type {ResourceRec | null} */
  let resource = null;

  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (raw.trim() === '') continue;
    const n = i + 1;
    let o;
    try {
      o = JSON.parse(raw);
    } catch (e) {
      errors.push(ParseError.BadJson(n, /** @type {Error} */ (e).message));
      continue;
    }
    if (o === null || typeof o !== 'object') {
      errors.push(ParseError.UnknownKind(n, typeof o));
      continue;
    }
    if (o.k === 'r') {
      if (o.v !== FORMAT_VERSION) { errors.push(ParseError.Version(n, o.v)); continue; }
      resource = { service: String(o.svc ?? 'unknown'), attrs: o.a ?? {}, t0: Number(o.t0) };
    } else if (o.k === 's') {
      const bad = checkSpan(o);
      if (bad) { errors.push(ParseError.BadField(n, bad)); continue; }
      spans.push({
        traceId: o.tr,
        id: o.id,
        parent: o.pa ?? null,
        name: o.n,
        start: o.ts,
        dur: o.du,
        attrs: o.a ?? {},
        status: o.st === 2 ? Status.Error(String(o.msg ?? '')) : Status.Unset,
        events: Array.isArray(o.ev) ? o.ev : [],
      });
    } else {
      errors.push(ParseError.UnknownKind(n, String(o.k)));
    }
  }
  return { resource, spans, errors };
}

/** @param {any} o @returns {string | null} first invalid field */
function checkSpan(o) {
  if (typeof o.tr !== 'string') return 'tr';
  if (typeof o.id !== 'string') return 'id';
  if ('pa' in o && o.pa !== null && typeof o.pa !== 'string') return 'pa'; // absent, null or a span id
  if (typeof o.n !== 'string') return 'n';
  if (!Number.isFinite(o.ts)) return 'ts';
  if (!Number.isFinite(o.du) || o.du < 0) return 'du';
  return null;
}

// ---------------------------------------------------------------------------

/** @typedef {{ span: SpanRec, children: Node[], self: number }} Node */

/**
 * Rebuild trees. Spans whose parent never ended (crash, torn file) become
 * roots and are reported in `orphans` rather than silently dropped.
 * @param {SpanRec[]} spans
 */
export function forest(spans) {
  /** @type {Map<string, Node>} */
  const byId = new Map();
  for (const s of spans) byId.set(s.id, { span: s, children: [], self: s.dur });
  /** @type {Node[]} */
  const roots = [];
  /** @type {Node[]} */
  const orphans = [];
  for (const node of byId.values()) {
    const p = node.span.parent;
    if (p === null) roots.push(node);
    else {
      const parent = byId.get(p);
      if (parent) parent.children.push(node);
      else { roots.push(node); orphans.push(node); }
    }
  }
  for (const node of byId.values()) {
    node.children.sort((a, b) => a.span.start - b.span.start);
    let childSum = 0;
    for (const c of node.children) childSum += c.span.dur;
    // Concurrent async children can sum past the parent; clamp, don't lie.
    node.self = Math.max(0, node.span.dur - childSum);
  }
  roots.sort((a, b) => a.span.start - b.span.start);
  return { roots, orphans };
}

/** @param {number[]} sorted @param {number} q */
const quantile = (sorted, q) => {
  if (sorted.length === 0) return NaN;
  const idx = (sorted.length - 1) * q;
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
};

/**
 * Per-name aggregates, sorted by total self time (where the time actually went).
 * @param {SpanRec[]} spans
 */
export function summarize(spans) {
  const { roots } = forest(spans);
  /** @type {Map<string, { durs: number[], self: number, errors: number }>} */
  const acc = new Map();
  /** @param {Node} node */
  const visit = (node) => {
    let a = acc.get(node.span.name);
    if (!a) acc.set(node.span.name, (a = { durs: [], self: 0, errors: 0 }));
    a.durs.push(node.span.dur);
    a.self += node.self;
    if (node.span.status.tag === 'Error') a.errors++;
    node.children.forEach(visit);
  };
  roots.forEach(visit);
  return [...acc.entries()]
    .map(([name, a]) => {
      const d = a.durs.sort((x, y) => x - y);
      return {
        name,
        count: d.length,
        total: d.reduce((s, x) => s + x, 0),
        self: a.self,
        p50: quantile(d, 0.5),
        p95: quantile(d, 0.95),
        max: d[d.length - 1],
        errors: a.errors,
      };
    })
    .sort((x, y) => y.self - x.self);
}

/**
 * Coverage check: spans whose self time (duration not covered by children)
 * exceeds `thresholdUs`. A leaf marked `atomic` (one native call or one tight
 * loop whose per-item cost is reported via `items`) is listed separately.
 * @param {SpanRec[]} spans @param {number} thresholdUs
 */
export function gaps(spans, thresholdUs, rootIndex = -1) {
  // GC pauses are recorded as separate root spans; they explain self time, they don't own any.
  const gc = spans.filter((s) => s.name === 'v8.gc').map((s) => [s.start, s.start + s.dur]);
  // Tracer bookkeeping per child span, measured in-process by an 'otel.calibrate' root
  // (k empty children); billed to the parent, so subtract children × perChild.
  const cals = forest(spans.filter((s) => s.name === 'otel.calibrate' || s.name === 'otel.calibrate.child')).roots.filter((r) => r.children.length);
  const perChild = cals.length ? Math.min(...cals.map((c) => c.span.dur / c.children.length)) : 0;
  const work = spans.filter((s) => s.name !== 'v8.gc' && !s.name.startsWith('otel.calibrate'));
  const all_ = forest(work).roots;
  const roots = rootIndex >= 0 ? all_.slice(rootIndex, rootIndex + 1) : all_;
  /** GC time overlapping [a, b). @param {number} a @param {number} b */
  const gcIn = (a, b) => gc.reduce((t, [x, y]) => t + Math.max(0, Math.min(b, y) - Math.max(a, x)), 0);
  /** @param {Node} n */
  const selfGc = (n) => gcIn(n.span.start, n.span.start + n.span.dur) - n.children.reduce((t, c) => t + gcIn(c.span.start, c.span.start + c.span.dur), 0);
  /** @type {{ node: Node, path: string }[]} */
  const all = [];
  /** @param {Node} n @param {string} p */
  const walk = (n, p) => { const path = p ? `${p} > ${n.span.name}` : n.span.name; all.push({ node: n, path }); n.children.forEach((c) => walk(c, path)); };
  roots.forEach((r) => walk(r, ''));
  const net = (/** @type {Node} */ n) => n.self - Math.max(0, selfGc(n)) - n.children.length * perChild;
  const over = all.filter(({ node }) => net(node) > thresholdUs).sort((a, b) => net(b.node) - net(a.node));
  const isAtomic = (/** @type {Node} */ n) => n.children.length === 0 && n.span.attrs.atomic === true;
  const total = roots.reduce((t, r) => t + r.span.dur, 0);
  const untraced = all.filter(({ node }) => !isAtomic(node) && node.children.length > 0).reduce((t, { node }) => t + node.self, 0);
  return {
    total,
    spans: all.length,
    open: over.filter(({ node }) => !isAtomic(node)).map(({ node, path }) => ({ path, self: net(node), gc: Math.max(0, selfGc(node)), leaf: node.children.length === 0 })),
    atomic: over.filter(({ node }) => isAtomic(node)).map(({ node, path }) => ({ path, self: node.self, items: node.span.attrs.items })),
    untracedInParents: untraced,
    gcTotal: roots.reduce((t, r) => t + gcIn(r.span.start, r.span.start + r.span.dur), 0),
    perChild,
    tracerOverhead: all.reduce((t, { node }) => t + node.children.length, 0) * perChild,
  };
}

// ---------------------------------------------------------------------------
// Rendering

/** @param {number} us */
export const fmtUs = (us) =>
  us >= 1e6 ? `${(us / 1e6).toFixed(2)}s` : us >= 1e3 ? `${(us / 1e3).toFixed(2)}ms` : `${us.toFixed(1)}µs`;

/** @param {Record<string, any>} a */
const fmtAttrs = (a) => {
  const ks = Object.keys(a);
  return ks.length ? ' ' + ks.map((k) => `${k}=${JSON.stringify(a[k])}`).join(' ') : '';
};

/** @param {SpanRec[]} spans @returns {string} */
export function renderTree(spans) {
  const { roots, orphans } = forest(spans);
  const orphanSet = new Set(orphans);
  /** @type {string[]} */
  const out = [];
  /** @param {Node} node @param {string} prefix @param {boolean} last @param {boolean} top */
  const walk = (node, prefix, last, top) => {
    const s = node.span;
    const mark = s.status.tag === 'Error' ? ` ✗ ${/** @type {any} */ (s.status).message}` : '';
    const orphan = orphanSet.has(node) ? ' (orphan)' : '';
    const branch = top ? '' : last ? '└─ ' : '├─ ';
    out.push(`${prefix}${branch}${s.name}  ${fmtUs(s.dur)} (self ${fmtUs(node.self)})${fmtAttrs(s.attrs)}${mark}${orphan}`);
    const next = top ? prefix : prefix + (last ? '   ' : '│  ');
    node.children.forEach((c, i) => walk(c, next, i === node.children.length - 1, false));
  };
  roots.forEach((r) => walk(r, '', true, true));
  return out.join('\n');
}

/** @param {ReturnType<typeof summarize>} rows @returns {string} */
export function renderSummary(rows) {
  const head = ['span', 'n', 'total', 'self', 'p50', 'p95', 'max', 'err'];
  const body = rows.map((r) => [r.name, String(r.count), fmtUs(r.total), fmtUs(r.self), fmtUs(r.p50), fmtUs(r.p95), fmtUs(r.max), String(r.errors)]);
  const all = [head, ...body];
  const w = head.map((_, c) => Math.max(...all.map((row) => row[c].length)));
  return all.map((row) => row.map((cell, c) => (c === 0 ? cell.padEnd(w[c]) : cell.padStart(w[c]))).join('  ')).join('\n');
}

// ---------------------------------------------------------------------------
// OTLP/JSON (opentelemetry-proto JSON encoding): ids stay hex, times are
// decimal-string nanoseconds. Epoch ns exceeds 2^53, hence BigInt.

/** @param {unknown} v @returns {any} */
function anyValue(v) {
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'boolean') return { boolValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(anyValue) } };
  return { stringValue: String(v) };
}

/** @param {Record<string, unknown>} a */
const kvs = (a) => Object.entries(a).map(([key, value]) => ({ key, value: anyValue(value) }));

/** @param {number} us */
const nanos = (us) => {
  const whole = Math.floor(us);
  return (BigInt(whole) * 1000n + BigInt(Math.round((us - whole) * 1000))).toString();
};

/** @param {ReturnType<typeof parse>} parsed */
export function toOtlp({ resource, spans }) {
  return {
    resourceSpans: [{
      resource: {
        attributes: kvs(resource ? { 'service.name': resource.service, ...resource.attrs } : { 'service.name': 'unknown' }),
      },
      scopeSpans: [{
        scope: { name: 'otel-compact', version: String(FORMAT_VERSION) },
        spans: spans.map((s) => ({
          traceId: s.traceId,
          spanId: s.id,
          ...(s.parent ? { parentSpanId: s.parent } : {}),
          name: s.name,
          kind: 1, // SPAN_KIND_INTERNAL
          startTimeUnixNano: nanos(s.start),
          endTimeUnixNano: nanos(s.start + s.dur),
          attributes: kvs(s.attrs),
          events: s.events.map(([off, name, a]) => ({ timeUnixNano: nanos(s.start + off), name, attributes: kvs(a ?? {}) })),
          status: Status.match(s.status, {
            Unset: () => ({ code: 0 }),
            Error: (/** @type {{message: string}} */ e) => ({ code: 2, message: e.message }),
          }),
        })),
      }],
    }],
  };
}
