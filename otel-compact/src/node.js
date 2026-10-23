// @ts-check
// Node/Bun adapters. Kept out of trace.js so the core stays runtime-agnostic.

import { appendFileSync, writeFileSync } from 'node:fs';
import { PerformanceObserver, constants as perfConstants } from 'node:perf_hooks';
import { variants, ok, err } from './adt.js';
import { Config, batchSink, tracer } from './trace.js';

/** Truncates `path`, then appends each OTLP chunk (concatenated chunks are one valid request). @param {string} path */
export function binaryFileSink(path) {
  writeFileSync(path, new Uint8Array(0));
  return { write: (/** @type {Uint8Array} */ chunk) => appendFileSync(path, chunk) };
}

/** Truncates `path`, then appends batched JSONL synchronously. */
export function fileSink(path, { maxLines = 512 } = {}) {
  writeFileSync(path, '');
  return batchSink((chunk) => appendFileSync(path, chunk), { maxLines });
}

// Elixir-style: behaviour is decided by configuration read once at boot,
// not by `if (enabled)` checks scattered through the code.
//
//   OTEL_COMPACT unset | off | 0 | noop  -> Mode.Off
//   OTEL_COMPACT=jsonl                   -> Mode.Jsonl('trace.jsonl')
//   OTEL_COMPACT=jsonl:out/run.jsonl     -> Mode.Jsonl('out/run.jsonl')
//   OTEL_COMPACT=otlp:out/run.pb         -> Mode.Otlp('out/run.pb')   OTLP/protobuf, POSTable to /v1/traces
//   OTEL_COMPACT_DEFER=4096              -> spans per exported batch (default 512)
export const Mode = variants('Mode', { Off: [], Jsonl: ['path'], Otlp: ['path'], Invalid: ['raw'] });

/** Pure: env -> Mode. @param {Record<string, string | undefined>} env */
export function modeFromEnv(env) {
  const raw = (env.OTEL_COMPACT || '').trim();
  if (raw === '' || raw === 'off' || raw === '0' || raw === 'noop') return Mode.Off;
  if (raw === 'jsonl' || raw === '1' || raw === 'on') return Mode.Jsonl('trace.jsonl');
  if (raw.startsWith('jsonl:') && raw.length > 6) return Mode.Jsonl(raw.slice(6));
  if (raw === 'otlp') return Mode.Otlp('trace.pb');
  if (raw.startsWith('otlp:') && raw.length > 5) return Mode.Otlp(raw.slice(5));
  return Mode.Invalid(raw);
}

/**
 * Effectful edge: Mode -> Result<Tracer, string>. An invalid config is an Err at boot, not mid-run;
 * the caller decides (exit with the message, or fall back to Noop).
 */
export function tracerFromEnv(env = process.env, opts = {}) {
  const defer = Number(env.OTEL_COMPACT_DEFER || 512);
  return Mode.match(modeFromEnv(env), {
    Off: () => ok(tracer(Config.Noop)),
    Jsonl: ({ path }) => ok(tracer(Config.Record(fileSink(path), { defer, ...opts }))),
    Otlp: ({ path }) => ok(tracer(Config.Record(binaryFileSink(path), { defer, format: 'otlp', ...opts }))),
    Invalid: ({ raw }) => err(`OTEL_COMPACT: unrecognised value ${JSON.stringify(raw)} (want off | jsonl[:<path>] | otlp[:<path>])`),
  });
}

const GC_KIND = {
  [perfConstants.NODE_PERFORMANCE_GC_MAJOR]: 'major',
  [perfConstants.NODE_PERFORMANCE_GC_MINOR]: 'minor',
  [perfConstants.NODE_PERFORMANCE_GC_INCREMENTAL]: 'incremental',
  [perfConstants.NODE_PERFORMANCE_GC_WEAKCB]: 'weakcb',
};

/**
 * Record every V8 GC pause as a root span `v8.gc`, on the tracer's timeline.
 * Returns a stop function. No-op for a non-recording tracer.
 * @param {import('./trace.js').Tracer} t
 */
export function observeGc(t) {
  if (!t.recording || !t.clock || !t.clock.fromPerfMs) return () => {};
  const toUs = t.clock.fromPerfMs;
  const obs = new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      const detail = /** @type {any} */ (e).detail;
      const kind = (detail && GC_KIND[detail.kind]) || 'other';
      t.record('v8.gc', { kind }, toUs(e.startTime), e.duration * 1000);
    }
  });
  obs.observe({ entryTypes: ['gc'] });
  return () => obs.disconnect();
}
