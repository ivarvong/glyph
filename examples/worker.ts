import { loadFont, renderText, pngStream, scanline, fastZlib, flattenCache } from 'glyph';
import inter from './inter-latin-400.woff2'; // wrangler rule: { type: "Data" }

let font: any;
const outlines = flattenCache(); // flattened glyphs survive across requests

export default {
  async fetch(req) {
    const text = new URL(req.url).searchParams.get('t') ?? 'Hello, edge';
    font ??= (await loadFont(inter)).value;
    const r = await renderText([{ font, fontKey: 'inter', text, size: 96 }], { targets: [] });
    // first bytes leave before the last row is rasterized
    return new Response(pngStream(r.value.scene, scanline, fastZlib, { cache: outlines }), {
      headers: { 'content-type': 'image/png' },
    });
  },
} satisfies ExportedHandler;
