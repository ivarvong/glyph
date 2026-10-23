// Fonts the example specs reference, by pinned upstream URL, and the fixture holding the same bytes
// (the same bytes `npm run fetch` puts in third_party/fonts/, pinned by SHA-256 in scripts/manifest.js).
// Tests and the simulator serve these URLs from third_party/fonts/ instead of the network.
export const FIXTURE_FONTS = Object.freeze({
  'https://mirrors.ctan.org/fonts/lm-math/opentype/latinmodern-math.otf': 'third_party/fonts/latinmodern-math.otf',
  'https://cdn.jsdelivr.net/npm/@fontsource/inter@5.3.0/files/inter-latin-400-normal.woff2': 'third_party/fonts/inter-latin-400.woff2',
  'https://raw.githubusercontent.com/adobe-fonts/source-serif/2823e993c53fca27c5c8749f529b56a5a7c77b6b/WOFF2/OTF/SourceSerif4-Regular.otf.woff2': 'third_party/fonts/source-serif-4-regular.otf.woff2',
  'https://cdn.jsdelivr.net/npm/@fontsource/jetbrains-mono@5.1.0/files/jetbrains-mono-latin-400-normal.woff2': 'third_party/fonts/jetbrains-mono-latin-400.woff2',
});
/** examples/posters.js face keys → their URL. */
export const POSTER_FONTS = Object.freeze({
  inter: 'https://cdn.jsdelivr.net/npm/@fontsource/inter@5.3.0/files/inter-latin-400-normal.woff2',
  serif: 'https://raw.githubusercontent.com/adobe-fonts/source-serif/2823e993c53fca27c5c8749f529b56a5a7c77b6b/WOFF2/OTF/SourceSerif4-Regular.otf.woff2',
  mono: 'https://cdn.jsdelivr.net/npm/@fontsource/jetbrains-mono@5.1.0/files/jetbrains-mono-latin-400-normal.woff2',
});
