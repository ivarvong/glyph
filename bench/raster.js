// Rasterizer cost on the Cloudflare scenes: median of 9 runs, ms.
import { allFonts } from '../sfnt/test/fixtures.js';
import { shape } from '../shape/src/shape.js';
import { layout } from '../render/src/scene.js';
import { scenePolygons, accumulate, scanline } from '../render/src/raster.js';

const fonts = await allFonts();
for (const key of ['inter', 'sourceSerif']) {
  const { font } = fonts.find((f) => f.key === key);
  for (const size of [24, 96, 256]) {
    const sc = layout([{ font, fontKey: key, glyphs: shape(font, 'Cloudflare').value, size }]).value;
    const t0 = performance.now(); const polys = scenePolygons(sc)[0].polys; const tf = performance.now() - t0;
    const row = [`${key} @${size}`.padEnd(18), `${sc.width}×${sc.height}`.padEnd(10), `flatten ${tf.toFixed(2)}ms`];
    for (const r of [accumulate, scanline]) {
      const ts = [];
      for (let i = 0; i < 9; i++) { const a = performance.now(); r.fill(polys, sc.width, sc.height); ts.push(performance.now() - a); }
      ts.sort((a, b) => a - b);
      row.push(`${r.name} ${ts[4].toFixed(2)}ms`);
    }
    console.log(row.join('  '));
  }
}
