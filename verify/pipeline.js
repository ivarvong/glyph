// The runtime-neutral pipeline used by verify/browser.js in both Node and Chromium.
// Only Web-platform APIs; the caller supplies `read(path) -> Uint8Array`.
import { loadFont, renderText } from '../render/src/text.js';
import { autoBrotli } from '../woff2/src/brotli.js';
import { Target } from '../render/src/targets.js';
import { accumulate, scanline } from '../render/src/raster.js';
import { storedZlib } from '../render/src/png.js';

const FILES = {
  'inter.woff2': 'third_party/fonts/inter-latin-400.woff2',
  'inter.woff': 'third_party/fonts/inter-latin-400.woff',
  'sourceSerif.woff2': 'third_party/fonts/source-serif-4-regular.otf.woff2',
  'sourceSerif.otf': 'third_party/fonts/source-serif-4-regular.otf',
};
// Stored zlib only for PNG: CompressionStream output is valid but not guaranteed
// byte-identical across zlib builds, so it would test the platform, not us.
const TARGETS = [Target.Svg, Target.Png(scanline, storedZlib), Target.Png(accumulate, storedZlib)];

/** @param {(p: string) => Promise<Uint8Array>} read */
export async function pipeline(read) {
  const out = {};
  for (const [name, path] of Object.entries(FILES)) {
    const f = await loadFont(await read(path), { brotli: autoBrotli });
    if (f.tag !== 'Ok') throw new Error(`${name}: ${JSON.stringify(f.error)}`);
    const key = name.split('.')[0];
    const r = await renderText([{ fontKey: key, font: f.value, text: 'Cloudflare', size: 96 }], { targets: TARGETS });
    if (r.tag !== 'Ok') throw new Error(`${name}: ${JSON.stringify(r.error)}`);
    for (const o of r.value.outputs) out[`${name}/${o.target}`] = o.bytes;
  }
  return out;
}
