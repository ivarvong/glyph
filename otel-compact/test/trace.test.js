import { test } from 'node:test';
import assert from 'node:assert/strict';
import { variants, ok, err, andThen } from '../src/adt.js';
import { Config, NOOP_SPAN, tracer, memorySink, counterIds, stepClock, batchSink } from '../src/trace.js';
import { parse, forest, summarize, toOtlp, ParseError } from '../src/read.js';
import { modeFromEnv, Mode } from '../src/node.js';

const recorder = () => {
  const sink = memorySink();
  const t = tracer(Config.Record(sink, { service: 'test', clock: stepClock(1_000_000, 10), ids: counterIds() }));
  return { sink, t };
};

// --- ADT -------------------------------------------------------------------

test('adt: constructors check arity and freeze', () => {
  const Shape = variants('Shape', { Dot: [], Circle: ['r'] });
  assert.throws(() => Shape.Circle(), /expected 1/);
  assert.ok(Object.isFrozen(Shape.Circle(1)));
  assert.equal(Shape.Dot, Shape.Dot);
});

test('adt: match is exhaustive on every call, even for a covered value', () => {
  const Shape = variants('Shape', { Dot: [], Circle: ['r'] });
  assert.throws(() => Shape.match(Shape.Dot, { Dot: () => 0 }), /missing case Circle/);
  assert.throws(() => Shape.match(Shape.Dot, { Dot: () => 0, Circle: () => 1, Sqare: () => 2 }), /unknown case Sqare/);
  assert.equal(Shape.match(Shape.Circle(2), { Dot: () => 0, Circle: ({ r }) => r * 2 }), 4);
  assert.equal(Shape.match(Shape.Dot, { _: () => 'any' }), 'any');
});

test('adt: reserved and duplicate field names rejected at definition', () => {
  assert.throws(() => variants('E', { Bad: ['tag', 'reason'] }), /reserved/);
  assert.throws(() => variants('E', { Bad: ['a', 'a'] }), /duplicate/);
});

test('adt: Result chains', () => {
  assert.deepEqual(andThen(ok(2), (x) => ok(x + 1)), ok(3));
  assert.deepEqual(andThen(err('no'), () => ok(1)), err('no'));
});

// --- Noop ----------------------------------------------------------------------

test('noop: returns callback value, passes NOOP_SPAN, children are noop too', () => {
  const t = tracer(Config.Noop);
  assert.equal(t.recording, false);
  const v = t.span('a', { x: 1 }, (s) => {
    assert.equal(s, NOOP_SPAN);
    return s.span('b', (c) => (c.set('k', 1), c.event('e'), 42));
  });
  assert.equal(v, 42);
});

test('noop: exceptions and promises pass through untouched', async () => {
  const t = tracer(Config.Noop);
  assert.throws(() => t.span('a', () => { throw new Error('boom'); }), /boom/);
  const p = Promise.resolve(7);
  assert.equal(t.span('a', () => p), p, 'same promise object, no wrapping');
});

// --- Record ----------------------------------------------------------------------

test('record: golden output with deterministic clock and ids', () => {
  const { sink, t } = recorder();
  t.span('root', { file: 'inter' }, (s) => {
    s.span('child', (c) => c.set('n', 3));
    s.event('mark', { at: 1 });
  });
  assert.deepEqual(sink.lines.map((l) => JSON.parse(l)), [
    { k: 'r', v: 1, svc: 'test', a: {}, t0: 1000000 },
    { k: 's', tr: '00000000000000000000000000000001', id: '0000000000000002', pa: '0000000000000001', n: 'child', ts: 1000020, du: 10, a: { n: 3 } },
    { k: 's', tr: '00000000000000000000000000000001', id: '0000000000000001', pa: null, n: 'root', ts: 1000010, du: 40, a: { file: 'inter' }, ev: [[30, 'mark', { at: 1 }]] },
  ]);
});

test('record: thrown error marks status, rethrows, still writes the span', () => {
  const { sink, t } = recorder();
  assert.throws(() => t.span('bad', () => { throw new RangeError('nope'); }), /nope/);
  const s = JSON.parse(sink.lines.at(-1));
  assert.equal(s.st, 2);
  assert.equal(s.msg, 'RangeError: nope');
});

test('record: async spans end on settle and keep their parent', async () => {
  const { sink, t } = recorder();
  const v = await t.span('outer', async (s) => {
    const a = s.span('inner', async () => 5);
    await assert.rejects(s.span('rej', async () => { throw new Error('x'); }));
    return (await a) + 1;
  });
  assert.equal(v, 6);
  const { spans, errors } = parse(sink.lines.join('\n'));
  assert.equal(errors.length, 0);
  const { roots, orphans } = forest(spans);
  assert.equal(orphans.length, 0);
  assert.deepEqual(roots[0].children.map((c) => c.span.name), ['inner', 'rej']);
  assert.equal(roots[0].children[1].span.status.tag, 'Error');
});

test('record: non-JSON attribute values are sanitised, not thrown', () => {
  const { sink, t } = recorder();
  t.span('s', { inf: Infinity, big: 10n, fn: () => 1, nil: null, arr: [1, 'a'] }, () => {});
  const s = JSON.parse(sink.lines.at(-1));
  assert.deepEqual(s.a, { inf: 'Infinity', big: '10', arr: [1, 'a'] });
});

test('batchSink: flushes at maxLines and on flush()', () => {
  const chunks = [];
  const sink = batchSink((c) => chunks.push(c), { maxLines: 2 });
  sink.write('a'); sink.write('b'); sink.write('c');
  assert.deepEqual(chunks, ['a\nb\n']);
  sink.flush();
  assert.deepEqual(chunks, ['a\nb\n', 'c\n']);
});

// --- Reader --------------------------------------------------------------------------

test('read: torn last line is reported, earlier spans survive', () => {
  const { sink, t } = recorder();
  t.span('a', () => {});
  const text = sink.lines.join('\n') + '\n{"k":"s","tr":"x';
  const { spans, errors } = parse(text);
  assert.equal(spans.length, 1);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].tag, 'BadJson');
  assert.equal(errors[0].line, 3);
});

test('read: invalid fields are typed errors', () => {
  const { errors } = parse('{"k":"s","tr":"t","id":"i","n":"x","ts":1,"du":-1}\n{"k":"q"}');
  assert.deepEqual(errors, [ParseError.BadField(1, 'du'), ParseError.UnknownKind(2, 'q')]);
});

test('read: missing parent becomes a flagged orphan root', () => {
  const { spans } = parse('{"k":"s","tr":"t","id":"c","pa":"gone","n":"x","ts":1,"du":1}');
  const { roots, orphans } = forest(spans);
  assert.equal(roots.length, 1);
  assert.equal(orphans.length, 1);
});

test('summarize: self time = duration minus children', () => {
  const { sink, t } = recorder();
  t.span('p', (s) => { s.span('c', () => {}); s.span('c', () => {}); });
  const rows = Object.fromEntries(summarize(parse(sink.lines.join('\n')).spans).map((r) => [r.name, r]));
  assert.equal(rows.c.count, 2);
  assert.equal(rows.p.total, 50); // t0, p, c, c, c, c, p: 7 reads, p spans the last 6
  assert.equal(rows.p.self, rows.p.total - rows.c.total);
});

test('otlp: hex ids, string nanos beyond 2^53, error status', () => {
  const sink = memorySink();
  const t = tracer(Config.Record(sink, { clock: stepClock(1_760_000_000_000_000, 1.5), ids: counterIds() }));
  try { t.span('x', { i: 1, f: 0.5 }, () => { throw new Error('e'); }); } catch {}
  const o = toOtlp(parse(sink.lines.join('\n')));
  const s = o.resourceSpans[0].scopeSpans[0].spans[0];
  // ts is whole µs (…001.5 rounds to …002); du keeps the fraction.
  assert.equal(s.startTimeUnixNano, '1760000000000002000');
  assert.equal(s.endTimeUnixNano, '1760000000000003500');
  assert.deepEqual(s.status, { code: 2, message: 'Error: e' });
  assert.deepEqual(s.attributes, [{ key: 'i', value: { intValue: '1' } }, { key: 'f', value: { doubleValue: 0.5 } }]);
});

// --- Config ------------------------------------------------------------------------

test('modeFromEnv: pure mapping, invalid values are a variant not a guess', () => {
  assert.equal(modeFromEnv({}), Mode.Off);
  assert.equal(modeFromEnv({ OTEL_COMPACT: 'off' }), Mode.Off);
  assert.deepEqual(modeFromEnv({ OTEL_COMPACT: 'jsonl' }), Mode.Jsonl('trace.jsonl'));
  assert.deepEqual(modeFromEnv({ OTEL_COMPACT: 'jsonl:a/b.jsonl' }), Mode.Jsonl('a/b.jsonl'));
  assert.deepEqual(modeFromEnv({ OTEL_COMPACT: 'otlp:x.pb' }), Mode.Otlp('x.pb'));
  assert.deepEqual(modeFromEnv({ OTEL_COMPACT: 'yes' }), Mode.Invalid('yes'));
});

test('JSONL writer: identical to JSON.stringify for awkward values and repeated keys', () => {
  const sink = memorySink();
  const t = tracer(Config.Record(sink, { service: 'test', clock: stepClock(1_000_000, 0.0001), ids: counterIds() }));
  const tricky = 'q"uote\\back\nline\t\u0000 Ångström → 日本  ';
  t.span(tricky, { s: tricky, neg: -0, inf: Infinity, nan: NaN, big: 2 ** 53 + 2, tiny: 1e-9, arr: [1, 'a"b', true], ok: false }, (s) => {
    s.set('s', 'replaced');           // repeated key: first position, last value
    s.set('late', 3.25);
    s.event('e"v', { k: 'v\n' });
    s.fail(new TypeError('bad "thing"'));
  });
  const line = sink.lines.at(-1);
  const expected = {
    k: 's', tr: '00000000000000000000000000000001', id: '0000000000000001', pa: null, n: tricky,
    ts: 1000000, du: JSON.parse(line).du,
    a: { s: 'replaced', neg: 0, inf: 'Infinity', nan: 'NaN', big: 2 ** 53 + 2, tiny: 1e-9, arr: [1, 'a"b', true], ok: false, late: 3.25 },
    st: 2, msg: 'TypeError: bad "thing"', ev: JSON.parse(line).ev,
  };
  assert.equal(line, JSON.stringify(expected));
  assert.deepEqual(JSON.parse(line).ev, [[JSON.parse(line).ev[0][0], 'e"v', { k: 'v\n' }]]);
});

test('tracerFromEnv: an invalid value is an Err, not a throw', async () => {
  const { tracerFromEnv } = await import('../src/node.js');
  const bad = tracerFromEnv({ OTEL_COMPACT: 'yes' });
  assert.equal(bad.tag, 'Err');
  assert.match(bad.error, /unrecognised value "yes"/);
  assert.equal(tracerFromEnv({}).tag, 'Ok');
});
