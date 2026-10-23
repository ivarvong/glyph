// Fuzz worker: runs the target on inputs from the parent, measures precise V8 block coverage per
// input, and enforces an allocation budget (heap limits don't count ArrayBuffers, so typed-array
// constructors are wrapped before the library loads).
import { parentPort, workerData } from 'node:worker_threads';
import { Session } from 'node:inspector/promises';

const ALLOC_ONE = workerData.allocOne, ALLOC_TOTAL = workerData.allocTotal;
let allocated = 0;
class AllocBudget extends Error {}
for (const name of ['Uint8Array', 'Int8Array', 'Uint16Array', 'Int16Array', 'Uint32Array', 'Int32Array', 'Float32Array', 'Float64Array', 'Uint8ClampedArray']) {
  const Base = globalThis[name];
  const Wrapped = class extends Base {
    constructor(...a) {
      if (typeof a[0] === 'number') {
        const bytes = a[0] * Base.BYTES_PER_ELEMENT;
        allocated += bytes;
        if (bytes > ALLOC_ONE) throw new AllocBudget(`single ${name}(${a[0]}) = ${bytes} B > ${ALLOC_ONE}`);
        if (allocated > ALLOC_TOTAL) throw new AllocBudget(`cumulative ${allocated} B > ${ALLOC_TOTAL}`);
      }
      super(...a);
    }
  };
  Object.defineProperty(Wrapped, 'name', { value: name });
  globalThis[name] = Wrapped;
}

const session = new Session();
session.connect();
await session.post('Profiler.enable');
await session.post('Profiler.startPreciseCoverage', { callCount: true, detailed: true });
const { target } = await import('./target.js');
const ROOT = new URL('..', import.meta.url).href;
const bucket = (c) => (c <= 1 ? 1 : c <= 3 ? 2 : c <= 7 ? 3 : c <= 31 ? 4 : c <= 127 ? 5 : 6);

async function coverage() {
  const { result } = await session.post('Profiler.takePreciseCoverage');
  const keys = [];
  for (const s of result) {
    if (!s.url.startsWith(ROOT) || s.url.includes('/fuzz/')) continue;
    const file = s.url.slice(ROOT.length);
    for (const fn of s.functions) for (const r of fn.ranges) if (r.count > 0) keys.push(`${file}:${r.startOffset}-${r.endOffset}:${bucket(r.count)}`);
  }
  return keys;
}
await coverage(); // reset counters after module load

parentPort.on('message', async ({ id, bytes }) => {
  allocated = 0;
  const t = performance.now();
  let status = 'ok', detail = '', reached = '', diff = '', contract = '';
  try {
    const r = await target(new Uint8Array(bytes));
    reached = r.reached; diff = r.diff; contract = r.contract;
  } catch (e) {
    status = e instanceof AllocBudget ? 'alloc' : 'throw';
    const stack = String(e?.stack ?? e).split('\n');
    // Dedup key: error type + message shape + first frame inside the library.
    const frame = stack.find((l) => l.includes(ROOT) && !l.includes('/fuzz/')) ?? stack[1] ?? '';
    detail = `${e?.constructor?.name ?? 'Error'}: ${String(e?.message ?? e).replace(/\d+/g, 'N').slice(0, 160)} @ ${frame.trim().replace(ROOT, '')}`;
  }
  const keys = await coverage();
  parentPort.postMessage({ id, status, detail, reached, diff, contract, ms: performance.now() - t, keys, allocated });
});
parentPort.postMessage({ ready: true });
