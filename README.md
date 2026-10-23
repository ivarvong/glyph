# glyph

Pure-JS WOFF2 text renderer. Two font formats in, two image formats out, zero runtime dependencies.

```
bytes ─ container ─ tables ─ outlines ─ shape ─ layout ─ Scene ─┬─ SVG
        WOFF2/WOFF/sfnt     glyf | CFF   GSUB/GPOS              └─ PNG
```

```
npm run fetch      # fonts, oracle references, W3C cases, fuzz inputs -> third_party/ (pinned URLs, sha256-checked)
npm test           # 169 tests, 168 pass, 1 skip (google/brotli vectors, BROTLI_TESTDATA); zero deps (node:test)
npm run typecheck  # strict checkJs over every package, plus type tests that must fail
npm run render     # Cloudflare in Inter + Source Serif -> out/*.svg, out/*.png (traced)
npm run verify     # 4-way rasterizer comparison incl. Chromium/Skia (needs headless_shell)
node verify/browser.js  # same pipeline in Chromium: outputs byte-identical to Node
```

The repo holds no fonts or other third-party data. `npm run fetch` (scripts/fetch.js, zero
dependencies) downloads every third-party input from a pinned URL, checks its sha256, and builds
what is derived from them into `third_party/` (gitignored): the two re-containered fonts, the
oracle references (fontTools, HarfBuzz, FreeType), the W3C WOFF 2.0 cases and the fuzz
regressions (stored as recipes, `fuzz/regressions/*.recipe.json`). Every built file must match the
sha256 in `scripts/manifest.js`, so a rebuild is checked bit for bit against what the tests were
written against. The Python step creates `third_party/venv` with pinned fontTools, Brotli,
uharfbuzz and freetype-py, so it needs `python3` (3.9+, with `venv`) and network access to PyPI.
The two generated runtime modules (`woff2/src/brotli-data.js`, `shape/src/ccc-data.js`) need only
Node: `node scripts/fetch.js --runtime`, which `npm run typecheck`, `npm run demo` and the Worker
build run first. What it downloads, from where, under what licence: `THIRD_PARTY_NOTICES.md`.

## Always two

Every stage has at least two implementations or inputs, checked against each other and an
independent reference. Nothing is verified by one path alone.

| stage | implementations / inputs | independent reference | result |
|---|---|---|---|
| Brotli | pure JS (RFC 7932), `DecompressionStream`, `node:zlib` | google/brotli test vectors | byte-identical; 45/45 vectors; 1,008 encoder configs |
| container | WOFF2, WOFF1, bare sfnt | fontTools | identical tables |
| glyf | WOFF2 transform decoder, raw `glyf` parser | fontTools | every record of 518 glyphs identical |
| outlines | TrueType (quadratic), CFF Type 2 (cubic) | fontTools pen | every glyph of both fonts exact (distance 0) |
| shaping | GSUB 1–8, GPOS 1/2/7/8, two fonts | HarfBuzz 0.56 (uharfbuzz) | gid, cluster, advance, offset identical on corpus |
| rasterizer | `scanline` (exact nonzero), `accumulate` (exact area) | FreeType 2.13, Skia, Green's-theorem area | see below |
| zlib | stored blocks (pure JS), `CompressionStream` | `node:zlib` inflate | pixel-exact round trip |
| output | SVG, PNG | Chromium renders the SVG | converges to the PNG as Skia supersamples |
| MATH table | Latin Modern Math, a synthetic table with math kerns | fontTools | every value identical |
| math layout | LaTeX → glyph; hand-written MathML → Chromium 156 | MathML Core, the TeXbook | see Math below |
| runtime | Node 22, Chromium 141 | — | 12/12 outputs byte-identical |

### Raster evidence (`npm run verify`, 0–255 units)

- Ink (Σ coverage) on Source Serif equals the exact analytic area within 0.3%. Workers @13px:
  exact 121.9, scanline 121.6, accumulate 121.7, FreeType 120.2, Skia 124.0.
- Skia rendering our SVG converges on our PNG as its supersampling rises: Workers @13px,
  mean |Δ| 0.95 → 0.16 and max 44 → 8 at 16×. 8 is the scanline rasterizer's own sampling
  bound (1/16).
- The two rasterizers disagree only on Inter, and only where its contours overlap (static
  instances keep overlaps; no OVERLAP flags set). There `accumulate` sums signed areas and
  over-covers. Theory says it can only ever over-cover, and the test asserts that direction.
  Skia sides with `scanline` at 23 of 29 such pixels. FreeType shares `accumulate`'s flaw.
  **`scanline` is the PNG default.**

### Bugs the differential setup caught

1. **ADT field named `tag`.** It overwrote the discriminant, so a value could impersonate another
   variant. Found by fuzz; `variants()` now rejects it at definition.
2. **GSUB/GPOS ScriptRecord offset.** Read at +4 instead of +6. It surfaced as kerning missing vs
   HarfBuzz, and only after `prepare()` stopped swallowing parse errors as "no shaping".
3. **SVG transform precision.** 13/2048 was written as 0.0063, so glyphs were 0.75% small. Found
   because Skia failed to converge on Inter while converging on Source Serif.
4. **Brotli table codegen.** Python tuples became JS comma expressions, and length-prefixed affix
   strings were read as zero-terminated. Found by Google's test vectors.

## Performance (warm, Node 22)

`node bench/render.js`: Inter WOFF2 bytes → "Cloudflare" @96px → SVG + PNG, tracing off, 80 renders after 30 warm-up.

| | p50 | p10 |
|---|---|---|
| before the warm pass | 26.0 ms | 23.2 ms |
| after | **6.6 ms** | **5.4 ms** |

Each change was measured alone and checked against `bench/golden.json`: 90 hashes of SVG bytes,
PNG bytes and decoded PNG pixels across 2 fonts × 3 texts × 3 sizes. All stayed byte-identical except
the PNG filter switch. For that one, all 36 images were proven pixel-identical first, and then the
golden file was re-baselined.

| change | span | before → after (ms) |
|---|---|---|
| background: one 32-bit `fill()` instead of `set()` per pixel | raster.clear | 7.6 → ~0 |
| compositing fast paths | raster.composite | 3.0 → 0.3 |
| scanline on typed edge arrays | scan.rows | 5.3 → 2.6 |
| active edges kept x-sorted across sub-scanlines (was O(k²) per sub-scanline) | raster.fill | 1.97 → 1.30 |
| coverage / class tables binary-searched in place | gpos.lookup | 0.19 → 0.08 |
| chained context rejects on first coverage (Inter calt #39, 69 subtables) | gsub #39 | 1.04 → 0.05 |
| glyf: index 518 glyphs, decode the 9 used | glyf.batch | 0.94 → 0.07 |
| PNG rows unfiltered (smallest output on text: −6% vs adaptive) | png.filter | 1.9 → 0.05 |
| pure-JS fixed-Huffman deflate (+23% bytes vs CompressionStream) | png.deflate | 2.5 → 1.1 |

### Many items: a 22k-item poster

The stress case for drawing was a poster of 22,318 items (strokes, discs, gradients, type) in
about 10,000 paint batches, at 3600×5400. It is not in this repo, so the table is a record, not a
rerunnable bench; `node bench/poster.js` runs the same build, render and hash check on an
`examples/posters.js` scene (`SCENE=`). Every change below was found by tracing and
CPU profiling, kept only if the PNG stayed byte-identical (the bench checks the SHA-256; the 90
text goldens are also unchanged), and timed by the median of the runs on a noisy 2-vCPU VM.

| step | render (median) | what the trace or profile showed |
|---|---|---|
| baseline | 10.3 s | `band` self time 7.2 s: every band stepped all ~10k batch generators |
| visit only the batches that ink a band | 9.0 s | generators open at a batch's first band and close after its last |
| fused flatten (`flattenLinear`) | 7.1 s | `transform` + `flatten` built a `Seg` and ran `match` per segment: 3.7 s, now 1.0 s |
| shared scanner scratch, callback-free stable sort | 5.6 s | ~14 KiB of zeroed scratch per batch drove GC; the sort comparator alone took 0.6 s |
| composite by offset; share untranslated polygons | ≈5.6 s | render GC 570 → 450 ms (no wall-time change measurable through the noise) |

Now (`N=7`): **5.8 s render** (−44%), plus about 1.2 s to build the scene. What's left is real
work: scanline rows 2.0 s, deflate 1.4 s, compositing 1.2 s (mostly per-pixel gradients) and
flattening 0.6 s. The warm text render did not move (p50 4.4–5.3 ms, against 4.5 ms before).

### Pixel format: gray / RGB / RGBA

`channelsFor(scene)` picks the narrowest lossless format. If the background is opaque and every
colour has r=g=b, it picks gray (the composite is equal in every channel). If the background is
opaque, it picks RGB. Otherwise it picks RGBA. Compositing writes the chosen format directly.

Evidence:
- All 36 golden `/pixels` hashes (decoded → RGBA) were unchanged; only PNG bytes changed.
- A test forces every format and checks that each decodes to the RGBA composite, across 3 zlibs × 2 filters.

Interleaved A/B, raster + PNG encode:

| scene | RGBA | chosen | speed | size |
|---|---|---|---|---|
| black "Cloudflare" @96 | 3.2 ms, 10.9 KB | gray 2.4 ms, 5.9 KB | 1.3× | 1.8× smaller |
| black "Cloudflare" @384 | 40 ms, 71.7 KB | gray 24 ms, 29.1 KB | 1.7× | 2.5× smaller |
| orange "Cloudflare" @384 | 32 ms, 73.0 KB | RGB 30 ms, 65.9 KB | 1.1× | 1.1× smaller |

The trace caught a regression on the way: RGB was at first 0.6× *slower*. `raster.clear` took 21 ms
in a per-byte loop. It now seeds one pixel and doubles it with `copyWithin`, which takes log₂ n
memmoves: 0.6 ms. RGBA's clear halved as well.

### Flatten cache: outlines memoised by glyph and linear transform

Every glyph is now flattened as `flatten(L·path) + t`: L is the transform's linear part and t its
translation. Under that definition the cache is a pure memo. A hit returns the same bits as a miss,
and a test checks this byte for byte, within a scene and across renders. The definition itself
changed no pixels: golden stayed 90/90 byte-identical. `rasterize(…, { cache })` and
`renderText(…, { cache })` take a long-lived `flattenCache(limit)` (FIFO) for reuse across requests.

Measured at 3×, interleaved:

| scene | glyphs | hits within render | flatten: none → per-render → shared |
|---|---|---|---|
| sheet | 136 | 35% | 3.66 → 2.45 → 0.30 ms |
| prose | 620 | 93% | 24.7 → 3.6 → 1.9 ms |

Sweep A: the flatten exponent against text length fell from 0.90 to 0.22. Outline work now grows
with the alphabet, not the text.

### Banded streaming PNG

`pngStream(scene, rasterizer, zlib, { rows, idat })` returns a pull-driven `ReadableStream` that
can be a Workers `Response` body. Each band of `rows` rows goes through four stages, and an IDAT is
emitted per ~`idat` compressed bytes:
1. coverage
2. composite
3. filter
4. deflate

How each stage streams:
- **Rasterizers.** `scanline` was refactored into a resumable `scanner(...).rows(yb, yEnd, out, base)`.
  Whole-image `fill` and native `bands` run the same code, so a pixel's coverage is the same float
  sum in the same order either way. `accumulate` streams through an adapter over its whole-image fill.
- **Zlibs.** All three stream:
  - `fast` encodes a position only once 258 bytes of lookahead are buffered, and keeps a 32 KiB window.
  - `stored` holds back a full block until more input proves it isn't the last.
  - `native` is a `CompressionStream` drained concurrently.

Evidence:
- **Zlib streams.** Fuzzed with chunk sizes from 1 byte to 1 MiB: 84/84 cases, `fast` and `stored`
  byte-identical to the whole-buffer encoders, `native` inflate-equal.
- **Banded PNG.** Tested over 2 rasterizers × 3 zlibs × 2 filters × band heights 1, 7, 32 and h+5.
  Pixels equal the whole-image path everywhere. The concatenated IDAT data is byte-identical for
  `fast` and `stored`. Adaptive filtering carries the previous row across bands.
- **Showcase.** Every showcase image is written through the stream and checked against the
  whole-image decode.

`npm run bench:stream`: peak ArrayBuffer bytes in a fresh process per variant, timing interleaved.

| scene | whole | banded 32 | first IDAT |
|---|---|---|---|
| Cloudflare @384, 1927×513 | 15.8 ms, 6.05 MiB | 15.1 ms, 1.42 MiB | 10.3 ms |
| 24 lines @48, 2477×1719, 2196 glyphs | 275 ms, 42.0 MiB | 302 ms (±10% noise), 18.8 MiB | 79 ms |

Time is neutral. Memory drops 2.2–4.3×, and the first image bytes leave up to 3.5× sooner. The
remaining ~18 MiB on prose is not pixels: it's edge arrays, O(glyphs). The next step is to admit
glyphs into the scanner per band, sorted by top y, so memory scales with the glyphs on the
current band. The whole-image `encodePng` is kept as the differential partner, and as the `Target.Png`
default so the golden PNG bytes stay comparable.

### Many colours: dirty columns and difference-array spans

The posters (`npm run posters`) have up to 61 fill colours, and each colour is its own coverage
pass. Two O(colours × pixels) costs showed up in the traces:
- **Composite.** Every pixel was composited once per colour. `bands` now reports the columns each
  band touched, and only those are re-zeroed and composited. Rings poster: composite 1018 → 44 ms,
  render 1611 → 265–311 ms. Pixels are unchanged, and `CHECK=1` diffs banded against whole.
- **Span interiors.** These were added as `+= 1/16` per pixel per sub-scanline. Full covers are now
  counted in a per-row difference array and added once per row. Code card: 768 → 416 ms. Golden
  stayed 90/90 byte-identical. Across 36M poster pixels, 10 channel bytes changed by 1/255, from
  float-addition reordering at edge pixels. That is below the rasterizer's own 8/255 sampling bound.

`render/src/compose.js` covers what the posters need beyond lines of text: an affine per glyph,
text on a circle, per-glyph colour, rings and rounded rects as plain `Seg` paths. `index.js` is the
public entry. `examples/worker.ts` is a complete Worker, and `npm run worker:check` executes that
exact file and decodes what it streams. The code-card poster renders the same file.

### Deflate: pluggable match finder × block coder

`render/src/deflate.js` is one streaming core with two ADT ports:
- **`Lz`:** the match finder. `Lz.Greedy` (one hash probe plus a distance-1 run check), or
  `Lz.Chain(chain, lazy, nice, good, insert)` (hash chains with lazy evaluation, as zlib's deflate_slow).
- **`Entropy`:** the block coder. `Entropy.Fixed`, or `Entropy.Dynamic`, which builds per-block
  length-limited Huffman codes and picks the cheaper of dynamic and fixed for each block by exact bit cost.

`zlibOf({ name, lz, entropy })` turns any pair into a `Zlib` with both `deflate` and `stream`. The
whole-buffer `deflate` is one push of the same core, so the two are identical by construction.
`npm test` then checks:
- `Greedy × Fixed` reproduces the hand-written `fast` encoder byte for byte.
- Every combination inflates in node:zlib and in `DecompressionStream`.
- Every combination streams byte-identically at random chunking, down to 1-byte pushes.
- Huffman codes are complete (Kraft sum exactly 1), even for Fibonacci frequencies.

`node bench/deflate.js`, on the unfiltered rows of all five posters (120 MiB):

| zlib | configuration | bytes | time |
|---|---|---|---|
| `fast` | Greedy × Fixed | 3434 K | 487 ms |
| `balanced` | Chain(16,16,64,8,8) × Dynamic | **2268 K (−34%)** | 1016 ms |
| `max` | Chain(16,16,64,8,258) × Dynamic | 2145 K | 1890 ms |
| node:zlib -1 / -6 | C, reference | 2832 K / 2145 K | 125 / 395 ms |

`max` matches zlib -6 to the kilobyte. `balanced` is 20% smaller than zlib -1. How the knee was found:
1. The profile showed the cost was hashing every position inside long matches; the coder adds only ~10 ms.
2. Not hashing inside matches at all cost 33% in size.
3. Hashing every 4th position inside long matches recovers most of that. A later copy, typically
   the next pixel row, finds it at most 3 bytes late.

Posters encode with `balanced` (`ZLIB=fast|balanced|max|native|stored`). `Target.Png` stays on
`fast`, because CPU time on a Worker is usually the scarcer budget.

### Text on curves, font fallback

- **`alongPath(run, arcLength(f), …)`:** sets text on any parametric curve. Each glyph sits at its
  arc length and turns to the tangent. Fed a circle, it matches `onCircle` within 1e-3 px; the two
  implementations are tested against each other.
- **Even spacing:** `offsetCurve` lets spacing be measured along the x-height centre line rather
  than the baseline, so letters don't fan out on crests or crowd in troughs.
- **Font fallback:** `runFallback(faces, text, size)` shapes each character in the first face that
  maps it, and counts what no face maps. The posters throw on any miss.
- **How fallback was found:** the squiggle label's π, λ and φ rendered as silent .notdef boxes in
  JetBrains Mono's Latin subset.

### Drawing: shapes, strokes, SVG paths, gradients (`draw`)

Glyphs were always filled paths in a `Scene`; `draw` makes the rest of vector graphics into the
same kind of item, so text and shapes share one rasteriser, one paint order and one PNG stream.

```js
import { draw, linear, radial, place, run, must, translate } from 'glyph';

const heart = draw.svgPath('M60 28a18 18 0 0 1 32 16q-6 18-32 38q-26-20-32-38a18 18 0 0 1 32-16z');
if (heart.tag === 'Err') return heart;                          // { at, expected, found }
const scene = draw.scene(800, 400, [255, 255, 255, 255], [
  draw.fill(draw.roundRect(20, 20, 300, 160, 24), linear(20, 20, 320, 180, [[243, 128, 32, 255], [43, 138, 143, 255]])),
  draw.fill(draw.stroke(draw.polyline([[40, 300], [160, 220], [280, 300]]), { width: 12, join: 'round', cap: 'round' }), [23, 21, 15, 255]),
  draw.fill(heart.value, radial(420, 90, 80, [[255, 240, 210, 255], [226, 82, 43, 255]]), { transform: translate(360, 20) }),
  draw.fill(draw.star(640, 110, 5, 80, 32), [123, 94, 167, 160], { rule: 'evenodd' }),
  ...place(must(run(font, 'inter', 'Hello', 96)), translate(360, 340), linear(360, 260, 600, 340, [[251, 173, 65, 255], [226, 82, 43, 255]])),
]);
return new Response(draw.png(scene), { headers: { 'content-type': 'image/png' } });   // streamed, banded
```

- **Geometry → `Path`:** `rect`, `roundRect`, `circle`, `ellipse`, `polygon`, `polyline`, `line`,
  `star`, and `svgPath(d)` (all of SVG 2 path data, arcs included). Bad path data is an `Err` with
  its offset; browsers draw the prefix silently.
- **Strokes are outlines:** `stroke(path, { width, join, cap, miterLimit })` returns a path to
  fill. It is a union of pieces (a quad per segment, a wedge or disc per join, a cap per end), all
  wound the same way, so nonzero filling unions them exactly with no stroker special cases.
  Overlaps and self-crossings come out right. SVG's joins, caps, miter limit and zero-length-dot
  rules are followed.
- **Paints:** an RGBA tuple, `linear(x0, y0, x1, y1, stops)` or `radial(cx, cy, r, stops)`.
  Gradient geometry is in scene pixels, whatever the item's transform, so one gradient can run
  across a whole word of separately placed glyphs. Stops are interpolated premultiplied (CSS
  Images 4), so fading to transparent keeps the colour. The SVG target emits each gradient with
  the inverse of the item's transform, and resamples alpha-changing spans, because SVG renderers
  interpolate unpremultiplied.
- **Fill rules:** `nonzero` (default) or `evenodd`. Even-odd is implemented in `scanline`; batches
  that need it are routed there even if you asked for `accumulate`.
- **Painter's model:** later items paint over earlier ones. A translucent item composites on its
  own, so overlaps stack, as in SVG and Canvas. Opaque items of one paint share a coverage pass,
  which gives the same picture with no seams where shapes abut.

Evidence:

- **Closed forms** (`draw/test/draw.test.js`):
  - shape areas: a rect exact, circles and ellipses within 0.1%;
  - stroke areas for every cap and join (the miter L is exactly 2·L·w), the miter-limit
    fallback, an X counted once, and both windings;
  - even-odd holes;
  - gradient ramps within one level, radial end colours, and the premultiplied midpoint;
  - translucent stacking.
- **Against Chromium** (`node verify/draw.js`): four scenes (shapes, strokes, gradients, alpha)
  rendered by glyph and by Chromium/Skia from glyph's SVG of the same scene. Mean difference
  0.05–0.17 levels, and no pixel off by more than 16 against Chromium's 4× rendering box-filtered
  to 1×.
- **What Chromium found:** SVG gradients interpolate unpremultiplied (red → transparent blue goes
  purple). Ours was premultiplied, so a translucent ramp's SVG and PNG differed by up to 63 levels.
  The SVG writer now resamples such spans.
- **What a 22k-item poster found:** 40 translucent bands of one colour were unioned into one
  coverage pass and painted as one band. Translucent overlaps now stack.

### Caching: content keys, eviction policies, layers

`glyph/cache` works the same in Node, browsers and Workers. Three parts:

**Content keys** (`sceneKey`): a render's key is the SHA-256 of everything that decides its bytes.
That is a version string, the render config, the canvas, and every item's *path content*, exact
transform bits and fill, in paint order. Names are not identity: two fonts can both be called
`inter`. Path digests are memoised per path object. Cost: 0.04 ms for "Cloudflare", 0.8 ms for
the 632-item code card. SHA-256 is pure JS and checked against node:crypto and `crypto.subtle`.

**Eviction policies** (`memo(Policy.X, { maxBytes })`): bounded by bytes. The four policies are
`Fifo`, `Lru`, `Sieve` (NSDI '24) and `S3Fifo(small)` (SOSP '23). Each matches a naive array-based
reference op for op on randomized traces, and a scan-resistance test pins down their behaviour.
`node bench/replay.js`:
- **Render level** (simulated: Zipf 0.9 plus 25% one-off requests): SIEVE and S3-FIFO beat LRU by
  **6–10 points** of hit ratio at 0.5–10% of the working set.
- **Glyph level** (real flatten work: repo prose and code, 3 fonts, Zipf sizes): SIEVE is
  +1.4–1.9 points over LRU from 10% of the working set up; LRU is ~3 points better at 2%.
- **Cost per operation:** FIFO 102, LRU 159, SIEVE 146, S3-FIFO 664 ns. The usual JS LRU, a `Map`
  with delete-and-reinsert, measured 788 ns: deleting from a Map's front leaves tombstones that
  every new iterator walks. FIFO and LRU therefore use the same linked queue as SIEVE.
- **Default:** SIEVE, for both `flattenCache` and the rendered-bytes memory tier.

**Layers.** `Loader = job → Promise<Result<bytes, string>>`, `Layer = Loader → Loader`, and the
tiers compose with `layered(...)(origin)`. Errors are values all the way through: an `Err` is
never cached, a failing store tier counts as a miss (`stats.errors`), and `serveCached` turns an
`Err` into a 502 with `no-store`. Bytes are verified across tiers:
- `store` frames values with a SHA-256; a corrupt one is a counted miss.
- `serveCached` sends `x-content-sha256`.
- `workersCache` checks it, and on a failed or corrupt hop falls back to rendering locally.

The chaos simulator found the need for all three. A job carries `{ key, make, meta, defer }`: `make` renders on a miss,
`meta` lets a tier across a hop recompute it, and `defer` is that request's `waitUntil`.
- **`memory(memo)`:** an in-process L1.
- **`store(kv)`:** read-through over any byte KV: `fsStore` (Node), `r2Store`, `mapStore`.
- **`singleflight()`:** collapses concurrent identical misses into one render.
- **`prefetch(predict, { defer })`:** speculative loads off the critical path.
- **`workersCache(ctx.exports.X)` + `serveCached`:** Workers Cache is read-through, not get/put.
  The caller sets `cf.cacheKey` to the content key. The cache-enabled entrypoint recomputes on a
  miss and answers with `Cache-Control: immutable` (content-addressed keys never go stale), an
  `ETag` and a `Cache-Tag` for `ctx.cache.purge({ tags })`.

Examples:
- **`examples/cache-node.js`** (memory → singleflight → disk): the second process serves every
  render from disk.
- **`examples/worker-cached.ts`** (isolate memory → Workers Cache → entrypoint [singleflight → R2]
  → render): `npm run worker:cached` executes that exact file in Node, with three module instances
  as isolates, `simulatedWorkersCache` standing in for Workers Cache (it models the documented
  behaviour, not production), and an R2-shaped bucket. The trace is cold miss, then L1 hit, then
  WC hit in a second isolate, then purge-by-tag, then an R2 hit with no render. The content key
  comes out identical to the Node run.

### Streaming on Workers: memory per isolate, and progressive paint

A Workers isolate's 128 MB is shared by every request it serves concurrently, so what counts is
renders in flight × peak, plus caches.
- **Whole-image path:** it keeps a full coverage buffer per fill colour. Peaks are 71–270 MiB at
  1× and up to 2.4 GiB at 3× on the multi-colour posters, so it does not fit.
- **Banded path, one buffer per colour:** each colour gets its own band-sized buffer, about 64× less.
- **Banded path, one shared buffer:** colours composite in turn, and each colour's dirty columns
  are re-zeroed after use, so one buffer serves them all. Peaks are **4–6 MiB at 1× and
  13–22 MiB at 3×**; squiggle @3× went 2,427 → 56 → 22 MiB.
- **Defaults:** cache budgets are sized for a shared isolate: outlines 8 MiB (the replay's whole
  outline working set was 4.5 MiB) and rendered PNGs 16 MiB in the Workers example.

**The browser paints a streamed PNG as it arrives** (`verify/progressive.js`). Chromium was given
the real `pngStream` output with delivery paused at a gate. Paused at 49% of the bytes, the top
51% of the image was already on screen; a buffered response shows nothing until it ends.

**Paint granularity is set by deflate blocks, not by bands.** `balanced` buffered 16K symbols per
dynamic-Huffman block, which made just 5 IDATs on the code card. Blocks now also end every
`blockBytes` of input. The boundary depends only on the symbol sequence, so stream = whole still
holds. Across five posters, 64 KiB costs +0.35% bytes for 8× more IDATs (26 → 202); 16 KiB costs
+4.4%. `balanced` and `max` use 64 KiB.

What streaming does not buy is CPU: it is the same work, spread out, and a render that blows its
CPU limit still fails, only after sending bytes. Pull-driven bands do stop work when the client
disconnects, and let other requests in the same isolate run between bands.

Measured and rejected: score-then-write PNG filter (slower), precomputed edge slopes (no gain).
What's left: native Brotli stream setup (~1.5 ms, once per font load), scanline crossings (~1.4 ms),
deflate (~1.1 ms).

## Rendering scene specs on Workers (`worker/`, `spec/`)

A generic renderer. It bundles **no fonts, scenes or configuration**: everything it draws arrives
in the request as a **scene spec**, JSON data whose fonts are referenced by URL (and optionally
pinned by SHA-256). Text is shaped by the renderer, and `params` let a request fill in text.

```
GET  /render?spec=<https URL>[&sha256=<hex>]&dpr=1..4&format=png|svg[&p.title=Hello…]
GET  /render?s=<URL-encoded spec JSON | base64url spec | z + base64url deflate-raw spec>&…
     e.g. /render?s=%7B%22glyph%22%3A1%2C%22size%22%3A%5B64%2C64%5D%2C%22items%22%3A%5B%5D%7D&dpr=1
GET  /render?id=<sha256 hex>&dpr=…&format=…   a stored spec (below)
POST /render?dpr=…            body: the spec
POST /specs                   body: the spec → 201 (200 if already stored) { id, bytes, render, svg }
GET  /specs/<id>              the stored spec JSON, to fork
```

**Stored specs.** Real posters are 200 KB–1.5 MB of spec: too big for a URL. `POST /specs` stores
one in the `SPECS` R2 bucket and answers with links that render it:

```sh
curl --data-binary @poster.json https://glyph.ivar.workers.dev/specs
# {"id":"<sha256>","bytes":1517326,"render":"https://glyph.ivar.workers.dev/render?id=<sha256>","svg":"…&format=svg"}
curl -o poster.png 'https://glyph.ivar.workers.dev/render?id=<sha256>&dpr=3'
```

- **Only valid specs.** The body is checked by `parseSpec`, as `/render` does, and refused with
  the same 400 problem. It is capped at `storeBytes` (4 MiB; `GLYPH_STORE_BYTES`).
- **Content-addressed.** The key is the SHA-256 of the exact bytes. An object is never rewritten,
  so identical uploads dedupe. Every load is checked against its id.
- **Same render key.** `?id=X` and the same bytes by POST or `s=` share one render key and cache.
  `?id=` renders are `immutable`, and so is `GET /specs/<id>`.
- **No auth.** Without a `SPECS` binding, `/specs` and `?id=` answer 501; everything else works.

```json
{ "glyph": 1, "size": [1200, 630], "background": "#0F1014",
  "fonts": { "display": { "url": "https://raw.githubusercontent.com/google/fonts/<sha>/ofl/…ttf", "sha256": "…" } },
  "params": { "title": "GLYPH" },
  "items": [
    { "rect": [0, 0, 1200, 630], "paint": { "radial": [960, 120, 700], "stops": [[0, "#3B82F6"], [1, "#0F1014"]] } },
    { "text": "${title}", "font": "display", "size": 190, "at": [60, 360], "fit": 1080,
      "outline": [{ "width": 14, "paint": "#0F1014" }], "paint": { "linear": [0, 200, 0, 360], "stops": [[0, "#E0F2FE"], [1, "#1D4ED8"]] } },
    { "path": "M 60 560 C 300 470 600 640 1140 520", "stroke": { "width": 3, "cap": "round" }, "paint": "#93C5FD" }
  ] }
```

**Items.**
- **Geometry:** `path` (SVG path data), `rect`, `circle`, `ellipse`, `polygon`, `polyline`, `line`
  and `star`, plus `circles` and `rects` (many in one item: halftones, grids, scanlines).
- **Text:** `glyph` (one glyph id: what the authoring tool emits) and `text`. `text` can be set on a
  circle or a path, given outlines, and shrunk to `fit`.
- **Grouping:** `group`.
- **Modifiers:** every item takes `paint`, `stroke`, `rule` and `transform`.
- **Errors:** `parseSpec` reports every problem with a JSON pointer, not just the first.

**Authoring.** `spec/src/emit.js` turns any scene built with the library into a spec:
- glyphs become font references, never outline bytes;
- deferred strokes keep their source;
- dots and grids are recognised as `circles` and `rects`.

The five posters are specs (`node examples/emit-specs.js`, fonts by pinned URL from
`examples/specs/fonts.js`): 20–126 KiB of JSON, 3–50 KiB gzipped. Rebuilt from their specs at DPR 1,
they match the direct renders to a mean of 0.000 levels, max 1. `examples/specs/` also holds a
parametric `type-card.json` and `math-card.json`.

**Caching.**
- **Specs:** by URL through Workers Cache, for 60 s, or immutably when pinned.
- **Fonts:** bytes through Workers Cache. Parsed fonts go in a per-isolate LRU sized by `fontCost`,
  a measured bound: 10 × file + 256 KiB, against 0.7–16× measured.
- **Glyph outlines:** flattened once per content and transform.
- **Renders:** keyed by SHA-256 of the version, spec bytes, dpr, format and params. Small renders
  are kept in memory; then Workers Cache, then R2 when a `RENDERS` bucket is bound. Every tier
  checks SHA-256.
- **Cold renders stream.** The response body *is* the band-by-band encoder, so the runtime pulls
  bands as the network drains. Emitted chunks are kept by reference for one framed R2 write.
- **Concurrency is the platform's.** The renderer does not queue or refuse.
- **Tracing:** `GLYPH_TRACE=jsonl` emits each request's span tree: spec, font, scene.build,
  render.stream, band, flatten, deflate.

### Memory: what it took, measured

Live heap is measured with a GC forced at every PNG chunk (`bench/memory.js`, DPR 3):

| step | 22k-item poster peak | what the profile showed |
|---|---|---|
| baseline | 438 MiB | the scene held 2.9 M path segments (278 MiB), almost all from strokes: a quad per segment and a wedge per vertex, 40–70-point polygon discs |
| ribbon strokes, cubic discs | 114 MiB | segments 2.9 M → 690 k. A smooth run is one polygon; joins only between path commands, as SVG |
| plan from hulls, materialise per band | 112 MiB | exact (every poster hash unchanged), but the scene still dominated |
| deferred strokes (`draw.stroked`) | 52 MiB | the scene keeps sources; outlines are built in the band sweep and dropped |
| on the Worker's code path (specs) | 72 MiB | 35 MiB fonts and code, 22 MiB scene, 15 MiB in flight |

**In real workerd** (`node sim/run.js spec`):
- **Correctness:** the five poster specs, `type-card` and `math-card`, at DPR 1 and 3, cold and
  warm, give PNG bytes identical to Node's (14 of 14).
- The limits, peaks and CPU below were measured on an earlier set of eleven specs led by the
  22k-item poster, which are not in this repo.
- **Under a heap limit:** with V8 limited to ~108 MB, and then to ~60 MB, every render passes,
  including a burst of 11 concurrent cold renders.
- **Peak:** heap + buffers sampled at ≤ 99 MB, garbage included. Before streaming, the burst
  sampled 126–163 MB.
- **Live set after everything:** 32 MB = 14 MB heap + 18 MB buffers (outline cache, font bytes,
  small renders).
- **CPU per render:** 0.1–1.5 s, except the 22k-item poster (3 s at DPR 1, 6 s at DPR 3). The Paid
  plan's default limit is 30 s.

## Math: LaTeX in, the OpenType MATH table, glyph's Scene out (`math/`)

```js
import { loadFont, typeset, placeMath, draw, translate } from 'glyph';
const r = typeset(font, 'lmm', 'x = \\frac{-b \\pm \\sqrt{b^2-4ac}}{2a}', { size: 48, display: true });
if (r.tag === 'Err') return r;           // TypesetError.Tex({ tag: 'UnknownCommand', name, at }) | Table | Layout | Size
const scene = draw.scene(600, 140, [255, 255, 255, 255], placeMath(r.value, translate(20, 80), [0, 0, 0, 255]));
```

Three stages, each a pure function returning `Result`:

- **`math/src/table.js`, the MATH table.** MathConstants (all 56), MathGlyphInfo (italic
  corrections, top accent attachments, extended shapes, math kerns) and MathVariants (size
  variants; vertical and horizontal glyph assemblies). Reads go through `sfnt/src/bin.js`
  under `guard`, so a bad offset is a `MathError.Truncated`, never a throw. Coverage expansion
  is bounded by the parallel count: 65,535 ranges of 65,535 glyphs cost one step each, not 4·10⁹.
  The parse runs in the fuzz target.
- **`math/src/tex.js`, a TeX subset parsed to an AST.** It covers:
  - scripts, primes, `\frac \dfrac \tfrac \cfrac \binom`, `\sqrt[n]{}`;
  - `\left \middle \right`, `\big`…`\Bigg`;
  - large operators with `\limits`/`\nolimits` (`\int` is `\nolimits` by default, as in plain.tex);
  - `\sin \lim`… and `\operatorname(*)`;
  - eleven accents plus `\widehat \widetilde \overline \underline \overbrace \underbrace`;
  - `\overset \underset \stackrel`, `\text`, Greek;
  - 125 relation, arrow and binary-operator commands, and `\not`;
  - `\mathbb \mathcal \mathfrak \mathbf \mathit \mathrm \mathsf \mathtt \boldsymbol`, mapped to
    Unicode math alphanumerics (with the Letterlike holes);
  - spacing commands and style commands;
  - `matrix pmatrix bmatrix Bmatrix vmatrix Vmatrix cases`.

  Unknown commands and environments are errors. The parser uses the Brotli decoder's sticky
  fault: the first error is kept with its source offset, and nothing throws. Limits are 4,096
  characters and a nesting depth of 64.
- **`math/src/layout.js`, the layout.** The algorithms are MathML Core's:
  - rows (§3.3.1);
  - msub/msup/msubsup (§3.4.1), munder/mover (§3.4.2), mfrac (§3.3.2), msqrt/mroot (§3.3.3);
  - stretchy operators, size variants and glyph assemblies (§3.2.4.3, §5.3).

  The atom classes, inter-atom spacing (TeXbook p. 170), the Bin→Ord rules (App. G rules 5–6),
  the styles D/T/S/SS with cramping, and `\nulldelimiterspace` are TeX's. OpenType math kerns
  apply to scripts. Accents attach at the top accent points. Ink extents are exact: cubic
  extrema are solved, not read off the control hull. The output is glyphs and rules placed in
  the existing `Scene`, so SVG, PNG, streaming and caching all work unchanged.
- **Spec item.** `{ "math": "<latex>", "font", "size", "at"?, "display"?, "align"? }`, plus
  `paint`, `transform` and `${param}`s. `parseSpec` checks the LaTeX and reports it by JSON
  pointer with the offset (`/items/0/math: TeX math (unknown command \foo at 4)`). A font
  without MATH, or a glyph the font lacks, is a pointed error at compile time.
  `examples/specs/math-card.json` pins Latin Modern Math at its CTAN URL by SHA-256.

**Evidence: the MATH table and the font.**
- Every value of Latin Modern Math's MATH table equals fontTools (`third_party/ref/fonttools-lmmath.json`, built by `npm run fetch`).
- The same holds for a synthetic, fontTools-compiled table that has math kerns, null kern
  corners and a format-2 coverage, none of which Latin Modern Math has.
- All 4,802 outlines equal fontTools' canonical pen output (a digest per glyph), and so do all
  advances and the whole cmap.
- Every truncation and 4,000 byte flips of the table are `Ok` or a typed `Err`, with no read
  outside a guard.

**Evidence: the layout.** 13 property tests (`math/test/layout.test.js`), each stated by its
source rather than re-derived from the code:
- every gap is at least its MATH minimum;
- the fraction bar sits on the axis;
- stretched delimiters cover their content symmetrically about the axis;
- assembly overlaps are at least `minConnectorOverlap`;
- the p. 170 spacing table, including spacing that vanishes in script styles;
- the italic-correction rule;
- math kerns, through an injected kern table;
- 3,000 random formulas lay out total and finite.

**Evidence: Chromium** (`npm run verify:math`).
- **Setup.** Each of 44 formulas is laid out twice: by glyph from LaTeX, and by Chromium 156
  (MathML Core, same font, 100 px) from hand-written MathML (`verify/math-corpus.js`). The
  MathML is written independently of the parser. Every `<mi> <mn> <mo> <mtext>` box is compared
  in document order (left edge, advance, ink top and bottom, relative to a baseline probe), and
  so are the pixels.
- **Headline.** At 1 px (0.01 em):

  | measure | agree |
  |---|---|
  | formulas with every token right | **5/44** |
  | tokens, all four numbers | 84/402 |
  | ink top and bottom (vertical layout, and which glyph or size variant) | **379/402** |
  | advance width | **383/402** |
  | the horizontal error each token introduces | 238/402 |
  | pixels: ink within 1 px of the other side's ink | mean 0.50; 1.000 where every token agrees |

  The low headline is horizontal spacing policy. Each spacing difference shifts everything to
  its right, so one rule fails a whole formula. Vertical layout and glyph choice agree on 94% of
  tokens.
- **Attribution.** Each of the 164 introduced horizontal errors is attributed by its exact
  signature (to 0.2 px):

  | cause | errors | whose rule |
  |---|---|---|
  | a whole number of mu | 60 (+7 with padding) | spacing. TeX classes (p. 170) against the MathML Core operator dictionary: Chromium adds 3/18 em before a large operator at the start of a row, 5/18 em around `lim`, and 0 after `sin` (U+2061) where TeX's Op–Ord gives a thin space; it gives × and ⋅ 3/18 em where TeX's Bin gives 4/18 em; it keeps operator spacing in scripts, which TeX drops (the parenthesised entries); and TeX puts a thin space between Ord and Inner (fractions) |
  | italic correction | 34 | MathML Core §3.3.1.2 adds a slanted item's italic correction before a non-slanted one, and §3.4.1.3 before a superscript. TeX adds it too (rule 17); Chromium adds neither (f's 9 px before `(` and before `′`) |
  | fraction padding | 17 | TeX's `\nulldelimiterspace` (1.2 pt = 0.12 em, rule 15e) against the 1 px mfrac padding in MathML Core's UA stylesheet: 11 px per side |
  | accent attachment | 15 | glyph attaches at the base's and the accent's top accent points (OpenType MATH; TeX's skew). Chromium centres the accent's box, and a combining mark's box is 0 wide with its ink to the left, so Chromium's hat sits left of the x (`out/math/overlay.png`) |
  | mtd padding | 8 | amsmath sets columns 2 × `\arraycolsep` = 1 em apart with no outer padding; MathML Core's UA stylesheet pads each mtd by 0.4 em |
  | previous token's width | 6 | Chromium gives a stretchy operator its widest construction's width, the §5.3.2 "preferred inline size", even unstretched: `(` is 87.5 px where its glyph is 38.9. §3.2.4.3 says the inline size is the chosen glyph's. The same holds for `msqrt` (the surd at 1056 units, not 833) |
  | large-op italic correction | 4 | §3.4.2.3–4 shift limits by ±ic/2; Chromium does not. Chromium's msub/msubsup width also omits §3.4.1.2's −LargeOpItalicCorrection |
  | negative space | 1 | `\!`: MathML Core's mspace width is the CSS `width`, which cannot be negative |
  | other | 12 | compounds of the above, all traced. Most are the first token of a fraction's second row or of a limit's second script, whose offset is half the width difference of the rows: for example `1/(2πi)`'s 2 at −1.2 px is half of π's 2.5 px italic correction. The other two are the overbrace (below) |

- **The 23 vertical and 19 width disagreements**, each with its cause:
  - **Widths.** Chromium's preferred width for stretchy boxes. Also, Chromium did not stretch
    U+0302, U+0303 or U+23DE as overscripts (it draws `\widehat` and `\overbrace` unstretched),
    even with `stretchy="true"`.
  - **`2^{2^{2^2}}`.** At depth 3 TeX stays at scriptscript (50%); MathML Core §4.5 shrinks a
    further 0.71.
  - **`\lim` limits, 4.7 px.** TeX's Op limits use the limit constants. MathML's `lim` is not
    `largeop`, so it uses UnderbarVerticalGap.
  - **Matrix and cases rows.** amsmath's struts against mtd padding.
  - **The `\sqrt[3]` index, 3.2 px: unexplained.** glyph follows §3.3.3.3 exactly (index bottom
    at 60% of B's height above B's bottom; B's box is identical in both). Chromium's index sits
    3.0–3.5 px lower, growing slightly with B's height. Its rule is not identified.
- **What the oracle found in Chromium.** An auto-italic `<mi>x</mi>` is painted and advanced as
  𝑥, but reports (and partly lays out with) the upright x's ink box. Written as `<mi>x</mi>`,
  ink top/bottom agreement drops from 379/402 to 318/402. The corpus therefore uses explicit
  math-italic code points (`AUTO_ITALIC=1` reproduces this).
- **What the oracle found in glyph: the glyph assembly overlap.** MathML Core §5.3.1 bounds the
  overlap by the start connectors "excluding the last" part and the end connectors "excluding
  the first". Read literally, the first part's start (0: it joins nothing) forces the minimum
  overlap, and an overbrace came out 5,914 units wide for 5,096. The joints are end-to-start,
  so glyph excludes the first part's start and the last part's end. It now covers 5,096. The
  same misreading in the validity rule had made every real assembly invalid.
- **No TeX oracle.** No `lualatex` or `xelatex` is installed, so there is no second oracle yet.

**Showcase.** `node examples/math-showcase.js` writes `out/math/showcase.png`, which has
quadratic, Euler, Gaussian, Cauchy, Maxwell, binomial, continued fraction, matrix, cases,
limits, accents and alphabets. Every glyph comes from Latin Modern Math, labels included
(`\text`).

**In workerd.** `npm run sim:quick` passes all 84 checks. The math card renders byte-identical
to Node, cold and warm, with an isolate peak of 5.1 MB. On a machine without
`conform/.ext/gfonts`, the other specs are reported as skipped. On macOS, CPU is not measured
(no `/proc`; reported as NaN, not 0).

**Known limits.**
- **Not done:** `\phantom`, `\color`, `align` and other multi-line environments, `\substack`,
  `\pmod`, `\not` on arbitrary symbols, the `ssty` and `flac` alternates, device tables
  (values are unhinted design units, as HarfBuzz uses them), line breaking, right-to-left math.
- **Subscripts on descenders.** A subscript sits at least SubscriptBaselineDropMin below the
  base's ink bottom (MathML Core §3.4.1.2, as Chromium does), so `μ_0` drops lower than `ε_0`.
  TeX's rule 18a ignores the descent for a single-character base.
- **Font coverage.** Latin Modern Math has no lowercase script alphabet: `\mathcal{a}` is a
  `MissingGlyph` error with its offset. Math kerns are implemented and tested, but this font has
  none.
- **Operator names.** `\operatorname{…}` takes letters only (`\operatorname*{arg\,max}` is an
  error).

## Untrusted fonts: fetchFont, limits, fuzzing, errors as values

The contract for user-supplied fonts: **for any bytes, every stage returns `Ok` or a typed `Err`
within fixed time and memory budgets.** No stage may throw, hang, allocate without bound, or hand
back an `undefined`. Fuzzing enforces this, along with a lint and a differential.

**`fetchFont(url, opts)`** (`net/src/fetch.js`) bounds everything around the bytes:
- **URL policy.** The default `publicHttps` allows https only: no credentials, no IP literals
  (including `2130706433` and `[::1]`), no `localhost` / `.local` / `.internal`, and the default
  port only. `allowHosts(['fonts.gstatic.com', '*.example.com'])` narrows that to an allowlist.
- **Redirects.** Each hop is re-checked against the policy, so a redirect to `http:` is refused
  before it is fetched. At most `maxRedirects` (3) hops.
- **One deadline** (`timeoutMs`, 10 s) covers every hop and the body. A server that stalls
  mid-body ends as `Timeout`; this is tested against a real socket.
- **Size cap** (`LIMITS.fileBytes`, 16 MiB). A Content-Length over the cap is refused unread. A
  lying or missing header is cut off while reading, after cap + one chunk.
- **Parse once per content.** Fonts are memoised by SHA-256 of the bytes, so two URLs serving
  one file parse once. `via:` routes the bytes through any cache stack (memory → R2) keyed by URL.
- **Errors.** `FontFetchError.Fetch(FetchError.BadUrl | Disallowed | Network | Status | TooLarge |
  Timeout | TooManyRedirects)` or `FontFetchError.Load(<parser error>)`.

The policy blocks SSRF by URL. It cannot see what a name resolves to. Workers' `fetch` cannot
reach private networks anyway; on a server, put the fetcher behind an egress proxy.

**Limits** (`sfnt/src/limits.js`). Each one is checked where it applies and becomes an `Err`, a
skipped glyph or a skipped lookup:

| limit | value | stops |
|---|---|---|
| `fileBytes` | 16 MiB | download / input size |
| `decompressedBytes` | 64 MiB | Brotli and zlib bombs (declared sizes checked before decoding) |
| `canvasPixels` | 2²⁵ (per render: `maxPixels`) | hostile metrics making a huge canvas |
| `curvePieces`, `glyphFlatPoints` | 256, 2²⁰ | flattening amplification (the glyph is skipped) |
| glyf `MAX_POINTS`, `MAX_VISITS` | 65535, 4096 | composite fan-out and recursion |
| shaping ops / buffer / nesting | max(16384, 64·len), max(8192, 32·len), 8 | GSUB/GPOS loops (HarfBuzz-style) |
| `READ_BUDGET` | 2²⁴ reads per guarded parse | table parse amplification |

A real fuzz input shows why `maxPixels` is per render. A `unitsPerEm` of 127 with huge advances
makes 24 px text a 40,340 × 485 canvas: 19.6 Mpx, legal under the global cap, about 0.6 s of
linear work. With `maxPixels: 4 << 20` it is a `CanvasTooLarge` in under 1 ms. When the fonts are
untrusted, set `maxPixels` to what the product needs.

**How the parser stays total.**
- **Reader** (`sfnt/src/bin.js`). An out-of-range read returns 0 and records a fault in the
  innermost `guard(f, onFault)` scope, which then returns `Err`.
- **Allocation.** `fits(v, o, n)` must hold before any allocation sized by a file value. That
  makes a cmap claiming 2³¹ groups a bounds `Err`, not a 48 GB allocation.
- **Shaping.** Lookups are transactional: a lookup that faults is rolled back and recorded as
  skipped work.
- **WOFF2 cursor and Brotli decoder** use a sticky fault, like a C decoder's result code: the
  first malformation is kept as a value, every later read returns 0, and every loop also checks
  the fault. There are no exceptions on any input.
- **Evidence for the decoder conversion.** Old (throwing) and new (value) decoders were compared
  on 100,427 inputs: 427 real streams (fixtures, the fuzz corpus, node:zlib output at five
  qualities × three windows) plus 100k mutations; 43,908 decoded Ok. There were zero
  differences in outputs or first errors. It costs 2–7% in decode speed (~0.4 ms on Inter's
  stream, paid once per font).

**Fuzzer** (`fuzz/`, zero dependencies). It is coverage-guided via `node:inspector` precise block
coverage with AFL-style count buckets.
- **Isolation.** It runs in worker_threads with a timeout, heap limits and a typed-array
  allocation budget.
- **Mutators** are structure-aware: havoc; WOFF2 stream decompress → mutate → recompress;
  table-level repack into sfnt/WOFF/WOFF2; splice.
- **Oracles:** throw, hang, oom, alloc, slow, a Brotli differential against node:zlib, and
  **contract**. Contract means an `undefined` anywhere in a returned value (Err payloads, paths,
  shaped glyphs, scenes), or a bounds fault recorded outside any guard scope.

```
node fuzz/fuzz.js --seconds 600            # campaign; findings → fuzz/findings/
node fuzz/fuzz.js --replay fuzz/regressions/*.bin third_party/fuzz/*.bin
node fuzz/recipe.js encode fuzz/findings/<name>.bin     # promote a finding: a recipe, not the bytes
node fuzz/fingerprint.js --compare fuzz/baseline.json   # refactor differential over the corpus
```

Findings fixed, each now replayed by `npm test`. Most are mutated copies of the fetched fonts, so
`fuzz/regressions/` stores each as a recipe of byte edits against them (at most 330 literal bytes
each); `npm run fetch` rebuilds them into `third_party/fuzz/` and checks each sha256:
- **Lazy shaping lookups.** `OutOfBounds` escaped them → guarded, transactional lookups.
- **glyf `endPts`.** Non-monotonic `endPts` hung → `BadContours`.
- **CFF.** `callsubr` with an empty stack crashed on `undefined` → checked. Stack underflow
  produced NaN coordinates in an `Ok` outline → "stack underflow" `Err`. That accounts for all 22
  fingerprint changes in the refactor differential; the other 491 corpus outputs are identical.
- **`locaAt`.** A raw DataView read threw `RangeError` → the total reader.
- **cmap format 4, found by the contract oracle.** An odd `segCountX2` made the segment count
  fractional, so the binary search landed one past the arrays, read `undefined`, and computed a
  `NaN` offset. The count is now an integer.
- **Read budget at the root scope.** It counted unguarded reads for the life of the isolate: 28
  per render, all cmap lookups at shape time. After 2²⁴ of them (about 600k renders on a warm
  Worker), every unguarded read would have returned 0, so text would render as `.notdef`. The
  budget now applies only to guarded parses.

- **LangSys fan-out, from the latest campaign** (20 min, one worker, 32,314 execs, 224 new corpus
  entries, 3,877 coverage keys). It found zero throws, hangs, OOMs, Brotli diffs or contract
  violations, and 18 slow inputs. 17 were one structure: up to 65,535 ScriptRecords pointing at
  one 65,535-feature LangSys, about 4·10⁹ in-range reads that only the read budget stopped (~2 s).
  Each LangSys is now parsed once per offset, and those inputs take 10–203 ms. The 18th was the
  hostile-metrics canvas above.

**Errors as values, and no `undefined`.**
- **Results.** Every public boundary returns `Result`. The cache stack, `tracerFromEnv`, the
  stores and fetch all return values instead of throwing.
- **Option.** Absence is `Option` (`some(v)` / `NONE`, one frozen branded value) from `option()`,
  the single place a nullable JS value is touched. Batch columns use `''` and a frozen
  `NO_EVENTS` instead of sparse arrays.
- **`scripts/lint-values.js`** runs first in `npm run typecheck` over all library source. It
  fails on `?.` (it manufactures `undefined`), on `undefined` in code or JSDoc types outside
  `option()`, and on any `throw` not marked `// bug:` (a programming error such as a
  non-exhaustive `match`) or `// rethrow:` (the tracer passing a callback's own exception through).
- **Allowed.** `??` is allowed: it removes `undefined` at an input edge rather than producing it.

## Conformance (`conform/`, `npm run conform`)

Two kinds of evidence, using oracles at pinned commits (see `conform/README.md`).

**W3C WOFF 2.0 suites.**
- **UserAgent 298/298:** display exactly what must display, and decode it to the reference
  outlines, cmap and advances.
- **Decoder 164/164:** round-trips equal their original `.ttf`.
- **Format 296/296:** no valid file rejected. We are lenient only on metadata, which must not
  affect rendering.
- **Google's reference decoder** agrees with the UserAgent expectations on 298/298.

**Corpus differential.** 300 Google Fonts families (seeded sample, 90 of them variable), each
compressed with Google's encoder and decoded by glyph. They are compared exactly with fontTools
on the original, Google's decoder, and fontkit; shaping is compared with HarfBuzz.

Bugs found and fixed, each now with a test:
1. **WOFF2 hmtx transform not reconstructed.** Google's encoder emits it; such fonts were
   rejected or got wrong advances.
2. **Block layout not enforced.** Extraneous or overlapping blocks were displayed.
3. **Transformed loca with a wrong declared length** was accepted.
4. **Collections misreported** as `DuplicateTable`.
5. **TrueType outlines not placed at the hmtx side bearing.** FreeType, HarfBuzz and fontTools
   shift by `lsb − xMin`; glyph drew raw coordinates, so whole glyphs were 1–7 units off in
   fonts where the two disagree.
6. **Legacy `kern` table ignored.** Fonts with no GPOS kerning were not kerned.
7. **GSUB FeatureVariations ignored** at the default instance of variable fonts.
8. **GPOS mark and cursive attachment** (types 3–6) were counted as skipped. They are now ported
   from HarfBuzz, with the three pieces around them: grapheme clusters, synthesised mark classes,
   and canonical mark ordering (a generated combining-class table, `tools/gen_ccc.js`). Accent
   stacking and the Playwrite family now match HarfBuzz exactly.

The differential also measured fontkit, as a third opinion:
- It disagrees with fontTools and Google on 59 of the 300 fonts.
- **Placement:** it does not apply the side-bearing placement.
- **Contours starting off-curve:** it inserts a spurious straight segment.
- In both cases glyph, fontTools and Google agree with each other.
- fontTools in turn skips the side-bearing placement for *composite* glyphs; FreeType and
  HarfBuzz both apply it, and so does glyph. The oracle applies the renderers' placement and
  says why.

## Local Workers simulator (`sim/`)

The examples run unchanged in real workerd, pinned, with models of R2, Workers Cache and the
internet. The driver measures each isolate from outside: heap and buffers through the inspector,
CPU per request from `/proc` in ns, latency and status. It then gates the results: byte parity
with Node, a live set under 32 MB, the fault contracts, and colo cache behaviour. `chaos` runs
seeded fault plans inside workerd: R2, the Workers Cache hop and HTTP through a chaos worker, and
sockets through a TCP fault proxy. Each plan has a contract, and failing runs replay exactly.
`npm run sim`; details, results and findings are in `sim/README.md`. Dev-only: it installs
`workerd` and `esbuild` into `sim/`; the library still has zero dependencies.

## Tracing: columnar recorder, OTLP protobuf

`otel-compact` keeps finished spans in typed columns: int32 ID words, interned names, and CSR
attributes. It exports every `defer` spans either as JSONL or as an OTLP
`ExportTraceServiceRequest`, written back to front, so there's one pass and no size computation.
Chunks concatenate into a valid request. `OTEL_COMPACT=otlp:out/run.pb` writes it, and
`otc proto file.jsonl` converts.

`node --expose-gc bench/recorders.js` (record + export, GC included):

| recorder | ns/span | bytes/span |
|---|---|---|
| object per span → JSONL (before) | 1,950 | 172 |
| columns → JSONL | 1,150 | 171 |
| columns → OTLP protobuf | **810** | **97** |

Typed-array allocation per span (1.9 µs) and retained `[k, v]` tuples (44% GC) were the traps.
Correctness has three independent checks:
- **Official encoder:** `ref/otlp-vector.json` is serialised by Python `opentelemetry-proto`, and both
  JS encoders reproduce it byte for byte.
- **Forward vs reverse:** the two JS encoders agree on the real trace.
- **Official decoder:** `verify/proto_check.py` decodes 7,647 traced spans and matches the
  OTLP/JSON export field by field.

## Playground

`npm run demo` bundles `demo/app.js` (the library, unmodified) into `out/demo/index.html`. The site
hosts no fonts: the page fetches Inter, Source Serif 4 and JetBrains Mono from their pinned
releases on jsDelivr, with subresource `integrity` (sha256) so the browser accepts only those bytes. Everything runs in the page: WOFF2 decoding, shaping, flattening, scan conversion,
deflate, the tracer and the SIEVE memory cache. The browser's text engine is never used.

What it shows:
- **Layouts:** lines, circle, sine and spiral, rendered at the device pixel ratio.
- **Outputs:** PNG and SVG; both rasterizers; all five deflate presets.
- **Shaping inspector:** ligatures, kerning and fallback glyphs, marked per glyph.
- **Per-stage trace:** recorded by otel-compact for each render.
- **Cache:** the content key and L1 hit/miss, plus time to first IDAT and a pixel loupe.

Checked in headless Chromium at DPR 2 across every preset, with no console errors. esbuild is the
only build tool, and it is used at build time only.

## Layout

| path | what |
|---|---|
| `otel-compact/` | tracer (`Config.Noop \| Record`), JSONL reader, `otc` CLI, `variants()` ADTs (`adt.js` + `adt.d.ts`) |
| `woff2/` | container, glyf transform → Glyph IR, pure-JS Brotli (`brotli-js.js`, `brotli-data.js` generated by `npm run fetch`) |
| `sfnt/` | bounds-checked reads, WOFF1/sfnt containers, head/hhea/maxp/hmtx/cmap(4,12), glyf, CFF, `Font` |
| `outline/` | `Seg` ADT path IR, affine transforms, flattening, TrueType contour → path |
| `shape/` | OpenType layout parsing, GSUB/GPOS application, HarfBuzz default feature sets |
| `render/` | `Scene`, paints (`paint.js`: solid, linear, radial), SVG writer, two rasterizers, PNG (filters, CRC, two zlibs), `Target` ADT, `renderText` |
| `draw/` | shapes, SVG path data, strokes (eager and deferred), `fill` → scene items, `bounds`, `png(scene)` |
| `spec/` | scene specs: `parseSpec`, `compile`, `buildScene`; `emit.js` turns any scene into a spec |
| `math/` | the MATH table, a TeX math parser, the layout engine on MathML Core + TeX rules, `typeset`/`placeMath` |
| `worker/` | the generic spec renderer for Workers (`app.js` pure, `index.js` the entry) |
| `cache/` | content keys, eviction policies, cache tiers as composable layers (`glyph/cache`) |
| `net/` | `fetchFont` / `fetchBytes`: URL policy, deadline, size cap, redirect checks |
| `conform/` | W3C WOFF2 suites and the corpus differential: fontTools, Google's woff2, fontkit, HarfBuzz as oracles (dev only) |
| `sim/` | local Workers simulator: real workerd + models of R2, Workers Cache, the network; chaos fault plans (dev only) |
| `fuzz/` | coverage-guided fuzzer, corpus, regressions, fingerprint differential |
| `scripts/` | `fetch.js` + `manifest.js`: every third-party input, pinned and sha256-checked; `lint-values.js`: no `?.`, no stray `undefined`, every `throw` justified |
| `verify/` | Chromium/FreeType/area comparisons, browser byte-identity check (dev only) |
| `ref/` | `make_refs.py`, `make_math_ref.py`, `make_derived_fonts.py` (run by `npm run fetch`, outputs in `third_party/`); `make_math_kern_fixture.py`, `make_otlp_vector.py` and their committed outputs over this repo's own data. Dev only |
| `tools/` | generators run by `npm run fetch`: `gen_brotli_data.js` (from google/brotli sources), `gen_ccc.js` (combining classes, HarfBuzz's remapping parsed from its source) |
| `fixtures/` | this repo's own synthetic test fonts and MATH table |
| `third_party/` | gitignored; filled by `npm run fetch` |

## Use

```js
import { loadFont, renderText } from './render/src/text.js';
import { autoBrotli } from './woff2/src/brotli.js';

const font = await loadFont(woff2Bytes, { brotli: autoBrotli });        // Result<Font>
const r = await renderText([{ fontKey: 'inter', font: font.value, text: 'Cloudflare', size: 96 }]);
// r.value.outputs: [{ mime: 'image/svg+xml', bytes }, { mime: 'image/png', bytes }]
```

Every boundary returns `Result`; failures are typed variants (`Woff2Error`, `GlyfError`,
`CffError`, `BrotliError`, …). Throws are reserved for programmer bugs, and a lint enforces it.

From a URL, with a canvas cap for untrusted fonts:

```js
import { fetchFont, renderText, allowHosts } from 'glyph';
const f = await fetchFont(url, { policy: allowHosts(['fonts.gstatic.com']), fonts });  // Result
if (f.tag === 'Err') return new Response(JSON.stringify(f.error), { status: 422 });
const r = await renderText([{ font: f.value.font, fontKey: f.value.key, text, size: 96 }], { maxPixels: 4 << 20 });
```

## Known limits

- **Shaping:** the default (Latin-class) shaper. GSUB 1–8; GPOS 1–8, including cursive (3) and
  mark-to-base/ligature/mark attachment (4–6). Also, as HarfBuzz does: legacy `kern`, GSUB/GPOS
  FeatureVariations at the default instance, grapheme clusters, glyph classes synthesised from
  Unicode when GDEF has none, and canonical mark ordering.
- **Not done:** decomposition and composition (normalisation beyond mark ordering), fallback mark
  positioning for fonts without GPOS, complex-script shapers (Arabic joining, Indic, USE), bidi
  and line breaking. A mark on a ligature attaches to its last component (no ligature-component
  tracking).
- **Variable fonts** render their default instance (outlines from glyf, no gvar/HVAR; default
  FeatureVariations). Choosing another instance is not supported.
- **Fonts:** CID-keyed CFF, CFF2 and collections return typed `Unsupported` errors.
- **Math:** see the Math section's known limits.
- **Native APIs:** WOFF1 and PNG still use the platform's Compression Streams (`deflate`), which
  every current browser, Node, Deno, Bun and Workers ship. Brotli is pure JS because Chromium 141
  lacks `DecompressionStream('brotli')`.
- **Speed:** pure-JS Brotli runs ~9 ms for Inter's 61 KiB stream (node:zlib: 0.5 ms). `scanline`
  is 4–6× slower than `accumulate`, ~4 ms for Cloudflare @96px.
- **Hinting:** none. This is unhinted outline rendering, like macOS.

## License

Code: MIT (see `LICENSE`). The repo contains no third-party fonts or data; what `npm run fetch`
downloads keeps its own licence (see `THIRD_PARTY_NOTICES.md`).
