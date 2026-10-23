// Shared test fixtures: two fonts × two containers each, plus independent references.
import { readFileSync } from 'node:fs';
import { brotliDecompressSync, inflateSync } from 'node:zlib';
import { loadFont } from '../src/font.js';
import { nativeBrotli, hasNativeBrotli, jsBrotli, portOf } from '../../woff2/src/brotli.js';
import { nativeInflate } from '../src/containers.js';
import { NOOP_SPAN } from '../../otel-compact/src/trace.js';

const root = new URL('../../', import.meta.url);
export const read = (p) => new Uint8Array(readFileSync(new URL(p, root)));
export const readJson = (p) => JSON.parse(readFileSync(new URL(p, root), 'utf8'));

export const FONTS = {
  inter: { ref: 'inter', files: ['third_party/fonts/inter-latin-400.woff2', 'third_party/fonts/inter-latin-400.woff'] },
  sourceSerif: { ref: 'sourceSerif', files: ['third_party/fonts/source-serif-4-regular.otf.woff2', 'third_party/fonts/source-serif-4-regular.otf'] },
};

// Decompressor ports: each WOFF2 file is loaded with each Brotli port, and the
// resulting fonts are checked against the same references.
export const PORT_SETS = [
  { name: 'js', brotli: jsBrotli, inflate: nativeInflate },
  { name: 'native', brotli: hasNativeBrotli() ? nativeBrotli : jsBrotli, inflate: nativeInflate },
  { name: 'zlib', brotli: portOf((b) => new Uint8Array(brotliDecompressSync(b))), inflate: (b, m) => portOf((x, max) => new Uint8Array(inflateSync(x, { maxOutputLength: max })))(b, NOOP_SPAN, m) },
];

const cache = new Map();
/** Every (font, container, port set) combination, loaded once. */
export async function allFonts() {
  if (cache.size) return [...cache.values()];
  for (const [key, spec] of Object.entries(FONTS)) {
    for (const [i, file] of spec.files.entries()) {
      const ports = PORT_SETS[i % 2]; // woff2 files decode with pure-JS Brotli; woff/otf use native inflate
      const r = await loadFont(read(file), ports);
      if (r.tag !== 'Ok') throw new Error(`${file}: ${JSON.stringify(r.error)}`);
      cache.set(file, { key, file, ports: ports.name, font: r.value });
    }
  }
  return [...cache.values()];
}
