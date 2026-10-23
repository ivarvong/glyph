import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { encodeForward, encodeReverse, batchFromRecords } from '../src/otlp.js';
import { tracer, Config, counterIds, stepClock, memorySink } from '../src/trace.js';
import { parse } from '../src/read.js';

const V = JSON.parse(readFileSync(new URL('../../ref/otlp-vector.json', import.meta.url), 'utf8'));

/** The vector's spans as reader records (the shape batchFromRecords takes). */
const records = V.spans.map((s) => ({
  traceId: s.traceId, id: s.spanId, parent: s.parent, name: s.name, start: s.start, dur: s.dur,
  attrs: Object.fromEntries(s.attrs), events: s.events.map(([o, n, a]) => (a.length ? [o, n, Object.fromEntries(a)] : [o, n])),
  status: s.error ? { tag: 'Error', message: s.error } : { tag: 'Unset' },
}));
const RES = { service: V.resource.service, attrs: V.resource.attrs, scope: 'otel-compact', version: '1' };
const hex = (b) => Buffer.from(b).toString('hex');

test('both encoders reproduce the official protobuf encoder byte for byte', () => {
  // Covers: parent ids, fractional µs -> ns, negative and > 2^31 ints, doubles, bools,
  // unicode strings, arrays, events with and without attributes, error status.
  const b = batchFromRecords(records);
  assert.equal(hex(encodeForward(b, RES)), V.hex);
  assert.equal(hex(encodeReverse(b, RES)), V.hex);
});

test('reverse encoder grows its buffer from the back without corrupting earlier bytes', () => {
  const many = Array.from({ length: 3000 }, (_, i) => ({ ...records[i % 2], name: `span-${i % 37}`, attrs: { i, s: 'x'.repeat(i % 200) } }));
  const b = batchFromRecords(many);
  assert.deepEqual(encodeReverse(b, RES), encodeForward(b, RES));
});

test("tracer format 'otlp' == JSONL path re-encoded (same spans, same bytes)", () => {
  const run = (format) => {
    const sink = memorySink();
    const t = tracer(Config.Record(sink, { service: 'glyph', clock: stepClock(1_760_000_000_000_000, 7), ids: counterIds(), defer: 1 << 20, format }));
    t.span('root', { file: 'inter', n: 3 }, (s) => {
      s.span('child', (c) => { c.set('ok', true); c.event('mark', { at: 1 }); });
      try { s.span('bad', () => { throw new RangeError('nope'); }); } catch {}
    });
    t.flush();
    return sink.lines;
  };
  const proto = run('otlp');
  assert.equal(proto.length, 1);
  const parsed = parse(run('jsonl').join('\n'));
  const res = { service: 'glyph', attrs: [], scope: 'otel-compact', version: '1' };
  assert.equal(hex(proto[0]), hex(encodeReverse(batchFromRecords(parsed.spans), res)));
});

test('small batches: chunks concatenate into one valid request (repeated fields merge)', () => {
  const sink = memorySink();
  const t = tracer(Config.Record(sink, { service: 'glyph', clock: stepClock(), ids: counterIds(), defer: 2, format: 'otlp' }));
  t.span('a', (s) => { s.span('b', () => {}); s.span('c', () => {}); });
  t.flush();
  assert.equal(sink.lines.length, 2); // 2 spans, then 1
  // Each chunk starts with tag 0x0a (field 1, length-delimited): ExportTraceServiceRequest.resource_spans.
  assert.ok(sink.lines.every((c) => c[0] === 0x0a));
});
