# sim: a local Workers simulator

The example workers run unchanged in **real workerd**, pinned to `workerd@1.20261004.1`.
Models stand in for what workerd doesn't do locally, and the driver measures everything from
outside the process. Nothing is deployed and no account is needed.

```
npm run sim          # all scenarios, then the gate (exit 1 on any failed check)
npm run sim:quick    # fewer requests
node sim/run.js colo faults --check     # some scenarios
```

```
client ──▶ main (example + shim) ─globalOutbound─▶ net     fake internet, fault injection
             │ env.R2 ──RPC──▶ r2                 R2 model (get/put, failures, latency)
             │ ctx.exports.Renders ──▶ wcache     Workers Cache model ──▶ main#Renders
           admin ──RPC──▶ r2 / wcache / net       stats, purge, faults
           inspector ◀── driver                   per-isolate heap + ArrayBuffer bytes
```

## Chaos: seeded fault plans (`node sim/run.js chaos --check`)

Faults are injected inside workerd, by config, so the app code is unchanged:

```
main ─outbound─▶ chaos ─▶ tcpnet (external ▶ Node TCP proxy) ─▶ netsock ─▶ net
main ─R2───────▶ chaos#R2    ─▶ r2
main ─WCACHE───▶ chaos#Cache ─▶ wcache ─▶ main#Renders
```

- **`workers/chaos.js`** sits between the app and each dependency.
  - Network: `error` (fetch rejects), `status`, `corrupt`, `drip`, `stall`.
  - R2: `error`, `missing`, `corrupt`, `drop` (a put that is acknowledged but not stored).
  - Workers Cache hop: `error`, `status`, `corrupt`.
  - `delay` composes with any of them, as a number, a uniform range or a lognormal
    `{ median, p99 }`.
- **`chaos/tcp.js`** is a Node proxy that workerd reaches as an `external` service, so the
  runtime's real HTTP client meets real socket faults: `refuse`, `reset` (RST mid-body),
  `truncate` (a clean FIN short of Content-Length), `drip`, `stall`.
- **`chaos/plan.js`** holds one plan format for both: `{ seed, rules: [{ id, at, match, when, fault }] }`.
  - A decision is a hash of (seed, rule, call identity, occurrence). It doesn't depend on
    interleaving, so a plan replays exactly at any concurrency. This is checked: the injection
    log at concurrency 3 equals the one at 8.
  - Every injection is logged (`/chaos/log`).

Each plan states a contract, which the driver checks on every response:
- **Statuses:** only the allowed ones (a failing tier is a miss; an upstream failure is
  502/504; never a 500).
- **Deadline:** every response finishes within it.
- **Bytes:** every 200 is a valid PNG, and for the cached app it is byte-identical to the Node
  render of the same request.
- **Recovery:** a URL works again once the faults clear (nothing poisoned).

| plan | faults | result |
|---|---|---|
| r2-flaky | get errors 30%, put errors 20%, lognormal delay | all 200 |
| r2-lost | puts dropped 50%, gets missing 20% | all 200 |
| r2-corrupt | 30% of R2 reads corrupted. Warm through one isolate, purge WC, read through others | all 200, 0 wrong bytes (57 R2 reads returned data) |
| wc-down | WC hop rejects 30%, 503 10% | all 200 |
| wc-corrupt | WC bodies corrupted 20% | all 200, 0 wrong bytes |
| slow-tiers | R2 p99 1.5 s, WC p99 0.8 s | all 200, within 8 s |
| net-flaky | network errors 15%, 503 10%, lognormal latency | 200/502; replay identical |
| tcp-chaos | refuse 5%, reset 10%, truncate 10%, drip 10% | 200/502 |
| net-corrupt | font bytes corrupted 30% | 200/422; all URLs recover |
| stall | 10% of origins stall after headers | 200/504 at the 10 s deadline |

The first chaos run found three bugs, now fixed, each with a unit test:
1. **Workers Cache down → 502.** 37 of 120 requests failed when the cache hop failed. The
   `workersCache` layer had no fallback; it now degrades to rendering locally (`stats.fallbacks`).
2. **Corrupt bytes served as 200s.** 10 corruptions on the WC hop became 23 broken PNGs, because
   memory re-served them. `serveCached` now sends `x-content-sha256`, and `workersCache` checks
   it, falling back on a mismatch. `store` frames values with a SHA-256 (`GLY1` + digest +
   payload) and treats a bad one as a counted miss that the fresh render overwrites. Both use
   native `crypto.subtle` where available.
   - **Control:** with verification off, the same plans serve 32 and 23 broken PNGs.
3. **Font cache poisoning.** Fonts corrupted in transit failed to load (422, correct), but their
   bytes were already cached in R2 under the URL, so 37 URLs stayed broken after the faults
   cleared. `fontJob` now parses before returning `Ok` (the parse is reused), so only fonts that
   load are cached.

Also: workerd's HTTP client reports a body cut short of its Content-Length as "Network connection
lost", which the app classifies as upstream (502).

## Real vs modelled

| real (workerd) | modelled here | not modelled |
|---|---|---|
| V8 isolates, Web APIs, streams, `fetch`, RPC, `ctx.exports`, `WorkerEntrypoint`, hang detection, compression formats | R2 (`workers/r2.js`), Workers Cache in front of an entrypoint (`workers/wcache.js`), the internet (`workers/net.js`), the 128 MB and CPU limits (checked by the driver, not enforced by workerd) | production's clock; parallel isolates; tiered cache; eviction under pressure; isolate kills |

The "not modelled" items:
- **Clock.** In production, `Date.now` and `performance.now` advance only across I/O; locally
  they advance during CPU work. A span covering only CPU reads 0 ms on Workers.
- **Parallel isolates.** workerd runs every isolate in a process on one thread, so the colo
  model is valid for hit ratios and per-isolate memory, not for throughput.
- **Isolate kills.** Production kills isolates over the limit; here they are only detected.

## How it measures

- **Isolate memory.** Read inside workerd over its inspector (`Runtime.getHeapUsage`): JS heap
  used plus ArrayBuffer backing stores, sampled every ~10 ms per isolate.
  - *Peak* includes garbage. Samples land between tasks, never inside one synchronous stretch,
    so peaks are lower bounds.
  - *Live* is read after two in-request `gc()` calls (the shim's `/__sim/gc`, with
    `--expose-gc`) and pauses, because V8 frees backing stores on a background sweeper.
- **Why not RSS.** Process RSS overstates memory: 5 isolates share the process, and the allocator
  keeps freed pages. The first version reported "+150 MB, over 128 MB" from RSS, while the
  isolate's live set was 7–16 MB.
- **CPU per request.** The ns sum of `/proc/<pid>/task/*/schedstat` around each request, at
  concurrency 1. This is a distribution, compared with the Free plan's 10 ms.

## Results

Full run (`npm run sim`) on a 2-CPU container; all 82 checks pass (including chaos):

| scenario | what | throughput | p50 / p99 | CPU per request | isolate live / peak* |
|---|---|---|---|---|---|
| cached c=1 | Zipf, 300 phrases × 3 sizes | 324 rps | 1.5 / 17 ms | p50 0.7, p99 15.7 ms (5% over 10 ms) | 8 / 21 MB |
| cached c=32 | same, concurrent | 538 rps | 49 / 274 ms | 1.9 ms avg | 8 / 27 MB |
| colo ×1 / ×4 / ×8 | isolates sharing WC + R2 | 578 / 494 / 481 rps | | | 8 / 5 / 4 MB live |
| cold c=1 | every request unique, 512 px | 17 rps | 58 / 108 ms | p50 57, p99 109 ms (all over 10 ms) | 19 / 104 MB |
| cold c=64 | same, queued | 17 rps | 3.7 / 4.2 s | 58 ms avg | 19 / 98 MB |
| fetch c=16 | user fonts, 20% hostile, 5% 503s | 140 rps | 66 / 369 ms | 8.6 ms avg | 5 / 121 MB |
| r2-fail | R2 fails 50% (+30 ms) | 459 rps | | | all 500 → 200 |
| net-fail | network fails 30% | 260 rps | | | only 200 / 502 |
| cold start | fresh process, first request | | 55 ms | ~95 ms CPU (+ ~85 ms boot) | |

\* Peak includes garbage between collections. Local V8 runs with no heap limit and collects
later than production does under its 128 MB limit, so the peak is reported, not gated, and
swings between runs (88–160 MB for the same cold load). The live set is gated (< 32 MB).

- **Colo.** Each distinct key renders exactly once (390 of 1500 requests) whatever the isolate
  count. Workers Cache hits rise 0 → 291 → 466 as isolates go 1 → 4 → 8, because each
  isolate's memory tier misses separately.
- **CPU limits.** Cold renders (57 ms p50) and cold starts (~95 ms) exceed the Free plan's
  10 ms CPU. The cached steady state is mostly under it: p50 0.7 ms, but 5% of requests are over.
  On Paid (30 s default) none of this matters.

## Findings so far

- **No Brotli** in workerd's `DecompressionStream` (gzip and deflate only). On Workers the
  pure-JS decoder is the path, not a fallback.
- **Hang detection.** A response stream with nothing pending is cancelled within milliseconds
  ("your Worker's code had hung"). A simulated stalled origin must hold a timer. The app's own
  10 s deadline then fires: `Timeout` at 10.004 s.
- **Error classes.** Upstream failures (network, timeout, 5xx) were answered as 422. They are now
  502/504, which is retryable; a bad or refused URL stays 422.
- **Parity.** PNG bytes from workerd equal the PNG bytes from Node for the same request.
- **Memory.** The isolate's live set stays small. Garbage between collections dominates the
  peaks.
- **CPU.** Cold renders and cold starts are well over the Free plan's 10 ms CPU; the steady state
  mostly isn't.
- **Allocation churn.** A cold 512 px render allocated 7.9 MB of typed arrays, mostly a fresh
  row buffer per band. It now reuses one, and the `ZlibStream` contract says `push` must not
  retain its input. That brings it to 3.3 MB, gated by `render/test/alloc.test.js` (< 4.5 MB;
  it fails at 8.26 MB without the reuse). Golden renders are byte-identical.
- **Client keep-alive race.** Under sustained c=64 load, reusing connections raced workerd
  closing them: 56 of 400 requests got ECONNRESET 17–42 ms after sending. With
  `connection: close` there were 0 failures. In production the edge, not a client, talks to the
  isolate, so the driver uses `connection: close`.
