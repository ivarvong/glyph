// @ts-check
// Pure, offset-addressed big-endian reads. No cursor state: every read names its offset, so
// table parsers are plain functions of (bytes, offset).
//
// Errors are values. Reads are total: an out-of-range read returns 0 (or an empty view, or
// '\0\0\0\0') and records a Fault in the innermost active `guard` scope. `guard(f, onFault)`
// runs `f` in a fresh scope and returns Ok(f()) if no read inside faulted, else Err(onFault(fault)).
// Scopes are a dynamic extent (guard is synchronous), like a Reader: callers pass no state.
// Reads outside any guard (lazy lookups at shape time) record into the root scope. `rootFaults()`
// exposes it, and the fuzzer's contract oracle requires it to stay 0: a lazy accessor must either
// guard its call or be in range by construction. The root scope has no read budget.

/** @typedef {{ at: number, need: number, len: number, count: number, reads: number, why: string }} Fault  at = -1: no fault */
/** @typedef {{ readonly bytes: Uint8Array, readonly dv: DataView }} View */

const freshFault = () => ({ at: -1, need: 0, len: 0, count: 0, reads: 0, why: '' });
/**
 * Reads one guard scope may make. Total reads remove the implicit bound a throwing reader had
 * (it stopped at the first bad read), and some hostile structures amplify without any bad read
 * (65535 mark sets sharing one 65535-entry coverage). Past this many reads the scope faults.
 */
export const READ_BUDGET = 1 << 24;
const ROOT = freshFault();
/** @type {Fault} */
let scope = ROOT;

/** @param {Uint8Array} bytes @returns {View} */
export const view = (bytes) => ({ bytes, dv: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength) });
const EMPTY = view(new Uint8Array(0));

/** In range? If not, record the first fault of this scope. @param {View} v @param {number} o @param {number} n */
const inRange = (v, o, n) => {
  // The budget bounds one guarded parse. The root scope (lazy lookups at shape time, outside any
  // guard) is exempt: it lives as long as the isolate, and a lifetime budget would start failing
  // every unguarded read after 2^24 of them (about 600k renders).
  if (++scope.reads > READ_BUDGET && scope !== ROOT) {
    if (scope.at < 0) { scope.at = o; scope.need = n; scope.len = v.bytes.length; scope.why = 'read budget'; }
    scope.count++;
    return false;
  }
  if (o >= 0 && o + n <= v.bytes.length && Number.isInteger(o)) return true;
  if (scope.at < 0) { scope.at = o; scope.need = n; scope.len = v.bytes.length; scope.why = 'out of range'; }
  scope.count++;
  return false;
};

/** @param {View} v @param {number} o */
export const u8 = (v, o) => (inRange(v, o, 1) ? v.bytes[o] : 0);
/** @param {View} v @param {number} o */
export const i8 = (v, o) => (inRange(v, o, 1) ? v.dv.getInt8(o) : 0);
/** @param {View} v @param {number} o */
export const u16 = (v, o) => (inRange(v, o, 2) ? v.dv.getUint16(o) : 0);
/** @param {View} v @param {number} o */
export const i16 = (v, o) => (inRange(v, o, 2) ? v.dv.getInt16(o) : 0);
/** @param {View} v @param {number} o */
export const u24 = (v, o) => (inRange(v, o, 3) ? (v.bytes[o] << 16) | (v.bytes[o + 1] << 8) | v.bytes[o + 2] : 0);
/** @param {View} v @param {number} o */
export const u32 = (v, o) => (inRange(v, o, 4) ? v.dv.getUint32(o) : 0);
/** @param {View} v @param {number} o */
export const i32 = (v, o) => (inRange(v, o, 4) ? v.dv.getInt32(o) : 0);
/** 2.14 fixed. @param {View} v @param {number} o */
export const f2dot14 = (v, o) => i16(v, o) / 16384;
/** 16.16 fixed. @param {View} v @param {number} o */
export const fixed = (v, o) => i32(v, o) / 65536;
/** @param {View} v @param {number} o */
export const tag = (v, o) => (inRange(v, o, 4) ? String.fromCharCode(v.bytes[o], v.bytes[o + 1], v.bytes[o + 2], v.bytes[o + 3]) : '\0\0\0\0');
/** Sub-view, bounds-checked (out of range: an empty view, and a fault). @param {View} v @param {number} o @param {number} n */
export const slice = (v, o, n) => (inRange(v, o, n) ? view(v.bytes.subarray(o, o + n)) : EMPTY);
/**
 * Does [o, o + n) fit in v? If not, the fault is recorded like any bad read. Use it before an
 * allocation sized by a value from the file: total reads alone would record the fault and then
 * let the allocation happen.
 * @param {View} v @param {number} o @param {number} n
 */
export const fits = (v, o, n) => inRange(v, o, n);

/** Has the current scope faulted? Count-driven loops stop on it. */
export const faulted = () => scope.at >= 0;

/**
 * Array.from({ length: n }, (_, i) => f(i)), but it stops at the first fault: a count read from
 * the file can no longer drive work past the point where the data ran out.
 * @template T @param {number} n @param {(i: number) => T} f @returns {T[]}
 */
export const times = (n, f) => {
  /** @type {T[]} */
  const out = [];
  for (let i = 0; i < n && scope.at < 0; i++) out.push(f(i));
  return out;
};

/**
 * Run a parser in a fresh fault scope: Ok(value) if every read was in range, else Err(onFault(fault)).
 * The scope is restored even if `f` has a bug and throws (the only throws left are bugs).
 * @template T, E
 * @param {() => T} f
 * @param {(fault: Fault) => E} onFault
 * @returns {import('../../otel-compact/src/adt.js').Result<T, E>}
 */
export const guard = (f, onFault) => {
  const outer = scope, mine = freshFault();
  scope = mine;
  let value;
  try { value = f(); } finally { scope = outer; }
  return mine.at >= 0 ? { tag: 'Err', error: onFault(mine) } : { tag: 'Ok', value };
};

/** Faults recorded outside any guard since start: should stay 0 (see fuzz oracle). */
export const rootFaults = () => ROOT.count;
