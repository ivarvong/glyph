# Fixtures

Only this project's own synthetic test data lives here. Every third-party font, and everything
derived from one, is fetched by `npm run fetch` into `third_party/` (gitignored); see
`THIRD_PARTY_NOTICES.md` for what comes from where.

| file | what | provenance |
|---|---|---|
| `test-gpos-marks.ttf`, `test-gpos-marks-nogdef.ttf` | 9 glyphs: mark-to-base, mark-to-mark and cursive attachment, with and without GDEF classes | built with fontTools' feature compiler for this repo; every glyph is the same 280×500 rectangle; `name` table "GlyphTestMarks", no copyright string |
| `test-lsb-shift.ttf` | 3 glyphs whose hmtx side bearing differs from `xMin` | built with fontTools for this repo; rectangles only; `name` "GlyphTestLsb" |
| `test-math-kern.MATH` | raw MATH table bytes: math kerns, null kern corners, a format-2 coverage, a glyph assembly | `python3 -I ref/make_math_kern_fixture.py` (fontTools 4.62.1); synthetic values, no font |

The generator of the three `.ttf` files is not in the repo. Their outlines were checked with
`ttx`: rectangles only (4 on-curve points per glyph), no third-party glyph data.

## Fetched fonts (`third_party/fonts/`)

| file | provenance | role |
|---|---|---|
| `inter-latin-400.woff2` | `@fontsource/inter@5.3.0` `files/inter-latin-400-normal.woff2` | TrueType outlines, WOFF2 glyf/loca transform |
| `inter-latin-400.woff` | built: fontTools 4.66.1 `TTFont(woff2); flavor='woff'; save()` (`ref/make_derived_fonts.py`) | same font via an independent WOFF2 decoder, zlib WOFF1, raw `glyf` |
| `source-serif-4-regular.otf.woff2` | `adobe-fonts/source-serif@2823e99` `WOFF2/OTF/SourceSerif4-Regular.otf.woff2` | CFF outlines, no transforms |
| `source-serif-4-regular.otf` | built: fontTools 4.66.1 `TTFont(woff2); flavor=None; save()` (`ref/make_derived_fonts.py`) | same font as a bare sfnt |
| `jetbrains-mono-latin-400.woff2` | `@fontsource/jetbrains-mono@5.1.0` `files/jetbrains-mono-latin-400-normal.woff2` | monospace face for the demo and posters |
| `latinmodern-math.otf` | GUST e-foundry `latinmodern-math-1959.zip`, `latinmodern-math-1959/otf/latinmodern-math.otf` (version 1.959); CTAN's copy is identical | OTF/CFF, 4802 glyphs, the OpenType MATH table |

The two built files make each font reachable through two containers, so container decoders are
checked against each other. `ref/make_derived_fonts.py` pins `SOURCE_DATE_EPOCH` (fontTools
stamps `head.modified`), and `npm run fetch` checks both outputs' sha256, so they are the exact
bytes the tests were written against.

## Fuzz regressions

`fuzz/regressions/diff-8f7f…bin` is ours: a 165-byte WOFF2 whose Brotli stream decodes to
nothing (no font data). The other seven findings are mutated copies of the fetched fonts
(Inter, Source Serif 4, and a GSUB spliced in from JetBrains Mono), so each is stored as a
`*.recipe.json`: copy runs of the fetched fonts plus the mutated bytes, the Brotli/zlib
re-compression, and the result's sha256 (`fuzz/recipe.js`). `npm run fetch` rebuilds them into
`third_party/fuzz/`.
