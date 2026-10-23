---
name: render-math
description: Render a TeX equation to a PNG with glyph (glyph.ivar.workers.dev) and show it. Use when the user asks to render, show, draw or typeset an equation or formula.
---

# Render math with glyph

One `curl`. The spec is fixed; the TeX goes in `p.tex`. `curl -G --data-urlencode` does all the escaping.

```sh
curl -sSfG https://glyph.ivar.workers.dev/render \
  --data-urlencode 's={"glyph":1,"size":[1000,200],"background":"#FFFFFF","fonts":{"m":{"url":"https://mirrors.ctan.org/fonts/lm-math/opentype/latinmodern-math.otf"}},"params":{"tex":"x"},"items":[{"math":"${tex}","font":"m","size":56,"at":[500,115],"display":true,"align":"center"}]}' \
  --data-urlencode 'p.tex=\int_0^1 x^2\,dx = \frac{1}{3}' \
  -d dpr=2 -o /tmp/eq.png
```

Then `Read /tmp/eq.png` to check it, and `open /tmp/eq.png` to show the user. Add `-w '%{url_effective}\n'`
to also print a shareable link.

- Single-quote the TeX so the shell leaves the backslashes alone.
- Cut off at the sides? Widen `size` to `[1600,200]` and `at` to `[800,115]`. Taller (matrices,
  stacked fractions)? Raise the height and the `at` y together.
- `dpr` is 1–4 (4 is sharpest). Add `-d format=svg` for a vector image.
- A big spec (a poster, past the 12,000-character `s=` cap): `curl --data-binary @spec.json https://glyph.ivar.workers.dev/specs`, then GET its `render` URL (`/render?id=<sha256>`, plus `&dpr=…`).
- Bad TeX gives HTTP 400 with JSON naming the error and its offset (drop `-f` to see it).
- Supported: a TeX math subset: fractions, roots, scripts, big operators with limits, `\binom`,
  `\overbrace`/`\underbrace`, matrices (`pmatrix`…), `\text`, Greek, `\mathbb`/`\mathcal` and friends, accents, delimiters.
