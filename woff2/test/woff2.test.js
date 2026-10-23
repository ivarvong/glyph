import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { brotliDecompressSync } from 'node:zlib';
import { decodeWoff2, readContainer, splitTables, Woff2Error, KNOWN_TAGS } from '../src/woff2.js';
import { nativeBrotli, hasNativeBrotli, jsBrotli, portOf } from '../src/brotli.js';
import { err } from '../../otel-compact/src/adt.js';
import { Config, tracer, memorySink } from '../../otel-compact/src/trace.js';
import { parse } from '../../otel-compact/src/read.js';

// Two structurally different fonts, always together: TrueType outlines with
// the glyf transform (Inter) and CFF outlines with no transform (Source Serif).
const FONTS = {
  inter: new Uint8Array(readFileSync(new URL('../../third_party/fonts/inter-latin-400.woff2', import.meta.url))),
  sourceSerif: new Uint8Array(readFileSync(new URL('../../third_party/fonts/source-serif-4-regular.otf.woff2', import.meta.url))),
};

// Two Brotli implementations, always together: a mismatch is a decoder bug.
const PORTS = {
  zlib: portOf((b) => new Uint8Array(brotliDecompressSync(b))),
  js: jsBrotli,
  ...(hasNativeBrotli() ? { native: nativeBrotli } : {}),
};

test('known tag table has the 63 normative entries', () => {
  assert.equal(KNOWN_TAGS.length, 63);
  assert.equal(new Set(KNOWN_TAGS).size, 63);
});

for (const [fontName, bytes] of Object.entries(FONTS)) {
  test(`${fontName}: brotli ports agree byte-for-byte`, async () => {
    const c = readContainer(bytes);
    assert.equal(c.tag, 'Ok');
    const outs = await Promise.all(Object.values(PORTS).map((p) => p(c.value.compressed)));
    for (const o of outs.slice(1)) assert.deepEqual(o, outs[0]);
    assert.ok(outs.every((o) => o.tag === 'Ok'));
    assert.equal(outs[0].value.length, c.value.expectedStream);
  });

  for (const [portName, port] of Object.entries(PORTS)) {
    test(`${fontName} × ${portName}: decodes and passes invariants`, async () => {
      const r = await decodeWoff2(bytes, { decompress: port });
      assert.equal(r.tag, 'Ok', JSON.stringify(r.error));
      assert.ok(r.value.tables.some((t) => t.tag === 'cmap'));
    });
  }
}

test('the two fixtures really exercise different paths', async () => {
  const [i, s] = await Promise.all([FONTS.inter, FONTS.sourceSerif].map((b) => decodeWoff2(b, { decompress: PORTS.zlib })));
  assert.equal(i.value.facts.outlines, 'glyf');
  assert.equal(i.value.tables.find((t) => t.tag === 'glyf').transform.tag, 'GlyfV0');
  assert.equal(s.value.facts.outlines, 'CFF');
  assert.equal(s.value.flavor, 'OTTO');
});

test('errors are typed values', async () => {
  const bad = FONTS.inter.slice();
  bad[0] = 0x00;
  assert.equal(readContainer(bad).error.tag, 'BadSignature');
  assert.deepEqual(readContainer(FONTS.inter.subarray(0, 10)).error, Woff2Error.Truncated(8, 4, 2));
  assert.deepEqual(readContainer(FONTS.inter.subarray(0, 12)).error, Woff2Error.LengthMismatch(FONTS.inter.length, 12));
  const c = readContainer(FONTS.inter).value;
  assert.equal(splitTables(c, new Uint8Array(3)).error.tag, 'DecompressedSize');
  const r = await decodeWoff2(FONTS.inter, { decompress: async () => err('nope') });
  assert.deepEqual(r.error, Woff2Error.DecompressFailed('nope'));
});

test('base128: leading zero and overflow rejected (variable_length.cc)', () => {
  // Build a minimal header with one table whose origLength is a crafted base128.
  const mk = (b128) => {
    const dir = [0x00 /* cmap */, ...b128];
    const total = 48 + dir.length;
    const b = new Uint8Array(total);
    const dv = new DataView(b.buffer);
    dv.setUint32(0, 0x774f4632); dv.setUint32(4, 0x00010000); dv.setUint32(8, total);
    dv.setUint16(12, 1);
    b.set(dir, 48);
    return readContainer(b);
  };
  assert.deepEqual(mk([0x80, 0x01]).error, Woff2Error.BadBase128(49, 'leading zero'));
  assert.deepEqual(mk([0x90, 0x80, 0x80, 0x80, 0x00]).error, Woff2Error.BadBase128(49, 'overflow'));
  assert.deepEqual(mk([0x81, 0x81, 0x81, 0x81, 0x81]).error, Woff2Error.BadBase128(49, 'longer than 5 bytes'));
});

test('fuzz: 4000 seeded mutations per font never throw, only Ok | Err', async () => {
  let seed = 0x9e3779b9;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const counts = {};
  for (const bytes of Object.values(FONTS)) {
    for (let i = 0; i < 4000; i++) {
      let b = bytes.slice();
      const op = rnd();
      if (op < 0.4) {                                                          // truncate, and usually
        b = b.slice(0, Math.floor(rnd() * b.length));                          // patch the length field so
        if (b.length >= 12 && rnd() < 0.8) new DataView(b.buffer).setUint32(8, b.length); // we get past it
      }
      else for (let k = 0; k < 1 + rnd() * 8; k++) {                           // flip bytes in header+dir
        b[Math.floor(rnd() * Math.min(b.length, 160))] = Math.floor(rnd() * 256);
      }
      const r = await decodeWoff2(b, { decompress: PORTS.zlib });
      assert.ok(Woff2Error.is(r.error) || r.tag === 'Ok');
      const k = r.tag === 'Ok' ? 'Ok' : r.error.tag;
      counts[k] = (counts[k] ?? 0) + 1;
    }
  }
  // Each error variant reached is evidence the check is live, not dead code.
  console.log('fuzz outcome counts', counts);
});

test('tracing: decode emits the expected span tree under Record', async () => {
  const sink = memorySink();
  const t = tracer(Config.Record(sink, { service: 'woff2-test' }));
  await t.span('run', (s) => decodeWoff2(FONTS.inter, { decompress: PORTS.zlib, span: s }));
  const { spans, errors } = parse(sink.lines.join('\n'));
  assert.equal(errors.length, 0);
  const names = new Set(spans.map((s) => s.name));
  for (const n of ['run', 'woff2.decode', 'woff2.container', 'woff2.header', 'woff2.directory', 'woff2.brotli', 'woff2.split', 'woff2.invariants']) {
    assert.ok(names.has(n), `missing span ${n}`);
  }
});
