import { test } from 'node:test';
import assert from 'node:assert/strict';

// Allocation churn per render is what decides an isolate's peak memory (garbage between
// collections): the simulator measured a live set of ~19 MB but peaks of 100–150 MB at
// ~17 cold renders/s. This counts every typed array and ArrayBuffer a 512 px render allocates
// (constructors and slices) and holds it under a budget.
test('a cold 512 px render allocates under 4.5 MB of typed arrays (was 7.9 MB before row-buffer reuse)', async () => {
  let bytes = 0, on = false;
  const wrap = (C) => new Proxy(C, { construct(t, a, nt) { const o = Reflect.construct(t, a, nt); if (on) bytes += o.byteLength; return o; } });
  for (const k of ['Uint8Array', 'Int8Array', 'Uint16Array', 'Int16Array', 'Uint32Array', 'Int32Array', 'Float32Array', 'Float64Array', 'ArrayBuffer']) globalThis[k] = wrap(globalThis[k]);
  const TA = Object.getPrototypeOf(Uint8Array.prototype), slice = TA.slice;
  TA.slice = function (...a) { const o = slice.apply(this, a); if (on) bytes += o.byteLength; return o; };
  const { readFileSync } = await import('node:fs');
  const { loadFont, renderText, flattenCache } = await import('../../index.js');
  const { pngJob } = await import('../../cache/index.js');
  const font = (await loadFont(readFileSync(new URL('../../third_party/fonts/inter-latin-400.woff2', import.meta.url)))).value;
  const outlines = flattenCache({ maxBytes: 8 << 20 });
  const N = 10;
  on = true;
  for (let i = 0; i < N; i++) {
    const r = await renderText([{ font, fontKey: 'inter', text: `edge cache ${i} render glyph waffle`, size: 512 }], { targets: [] });
    assert.equal((await pngJob(r.value.scene, { outlines }).make()).tag, 'Ok');
  }
  on = false;
  TA.slice = slice;
  const perRender = bytes / N / 2 ** 20;
  assert.ok(perRender < 4.5, `${perRender.toFixed(2)} MB per render`);
});
