import { test } from 'node:test';
import assert from 'node:assert/strict';
import { view, u16, guard, rootFaults, READ_BUDGET } from '../src/bin.js';
import { cmapLookup, CmapFormat } from '../src/tables.js';

test('the read budget bounds a guarded parse, not the isolate: unguarded reads never start failing', () => {
  const v = view(Uint8Array.of(0x12, 0x34));
  // A guarded scope over budget faults...
  const r = guard(() => { let s = 0; for (let i = 0; i <= READ_BUDGET; i++) s += u16(v, 0); return s; }, (f) => f.why);
  assert.deepEqual(r, { tag: 'Err', error: 'read budget' });
  // ...but more than a budget's worth of root reads (a long-lived Worker's lazy lookups) still work.
  const before = rootFaults();
  for (let i = 0; i <= READ_BUDGET; i++) u16(v, 0);
  assert.equal(u16(v, 0), 0x1234);
  assert.equal(rootFaults(), before);
});

test('cmap format 4 with an odd segCountX2 looks up without faulting outside a guard', () => {
  // Format 4, segCountX2 = 3 (odd: malformed). One real segment 0x41..0x5A → delta +3, plus 0xFFFF.
  const seg = 2;
  const b = new Uint8Array(14 + 2 + 8 * seg + 4);
  const dv = new DataView(b.buffer);
  dv.setUint16(0, 4); dv.setUint16(2, b.length); dv.setUint16(6, 3);
  const ends = 14, starts = ends + 3 + 2, deltas = starts + 3, ranges = deltas + 3;
  dv.setUint16(ends, 0x5a); dv.setUint16(ends + 2, 0xffff);
  dv.setUint16(starts, 0x41); dv.setUint16(starts + 2, 0xffff);
  dv.setInt16(deltas, 3); dv.setInt16(deltas + 2, 1);
  dv.setUint16(ranges, 0); dv.setUint16(ranges + 2, 0);
  const r = cmapLookup(b, CmapFormat.F4(0));
  assert.equal(r.tag, 'Ok');
  const before = rootFaults();
  for (const cp of [0x20, 0x41, 0x5a, 0x7a, 0xfffe, 0x1f600]) {
    const g = r.value(cp);
    assert.ok(Number.isInteger(g) && g >= 0, `cp ${cp.toString(16)} → ${g}`);
  }
  assert.equal(rootFaults(), before, 'no bounds fault escaped');
});
