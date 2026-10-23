"""Dev-only reference exporter. Not a runtime dependency.

Writes ground truth from independent implementations into third_party/ref/ (gitignored; the
fonts are third-party, so is everything derived from them). Run by `npm run fetch`, which checks
every output's sha256 (scripts/manifest.js):
  fonttools-<font>.json  glyph order, cmap, advances, raw glyf records, canonical outlines (fontTools)
  hb-shape.json          shaping of a corpus (HarfBuzz via uharfbuzz)
  ft-<font>-<case>.pgm   grayscale coverage of the same layout (FreeType, unhinted)

Run: npm run fetch   (or, with fonttools, brotli, uharfbuzz, freetype-py: python3 -I ref/make_refs.py)
"""
import io, json, math, os, sys
from fontTools.ttLib import TTFont
from fontTools.pens.basePen import BasePen
import uharfbuzz as hb
import freetype

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(ROOT, 'third_party')
HERE = os.path.join(CACHE, 'ref')  # output directory
FONTS = {
    'inter': 'third_party/fonts/inter-latin-400.woff2',
    'sourceSerif': 'third_party/fonts/source-serif-4-regular.otf.woff2',
}
CORPUS = ['Cloudflare', 'Workers', 'AVAToWaYo', 'office fluff', 'Type Pairs, Kerning.', 'Hello, World!',
          'The quick brown fox jumps over the lazy dog', '12:30 → 1/2', 'ff fi fl ffi ffl', 'Ångström café']
# Raster cases: (text, px per em). Layout rule mirrored exactly in render/src/scene.js.
RASTER = [('Cloudflare', 96), ('Cloudflare', 24), ('Workers', 13), ('AVAToWaYo', 40)]
PADDING = 8


class Canon(BasePen):
    """Canonical outline: contours of explicit segments, closing lines made explicit,
    degenerate lines dropped, each contour rotated to its lexicographically least segment.
    Mirrored by canonical() in sfnt/test/canon.js."""

    def __init__(self, glyphset):
        super().__init__(glyphset)
        self.contours, self.cur, self.start, self.segs = [], None, None, None

    def _moveTo(self, p):
        self._flush()
        self.segs, self.start, self.cur = [], p, p

    def _lineTo(self, p):
        self.segs.append(['L', *self.cur, *p]); self.cur = p

    def _qCurveToOne(self, c, p):
        self.segs.append(['Q', *self.cur, *c, *p]); self.cur = p

    def _curveToOne(self, c1, c2, p):
        self.segs.append(['C', *self.cur, *c1, *c2, *p]); self.cur = p

    def _closePath(self):
        self._flush()

    _endPath = _closePath

    def _flush(self):
        if self.segs is None:
            return
        if self.cur != self.start:
            self.segs.append(['L', *self.cur, *self.start])
        segs = [s for s in self.segs if not (s[0] == 'L' and s[1:3] == s[3:5])]
        if segs:
            k = min(range(len(segs)), key=lambda i: [str(segs[i][0])] + [float(v) for v in segs[i][1:]])
            self.contours.append([[s[0]] + [float(v) for v in s[1:]] for s in segs[k:] + segs[:k]])
        self.segs = None


def sfnt_bytes(path):
    t = TTFont(os.path.join(ROOT, path)); t.flavor = None
    b = io.BytesIO(); t.save(b); return b.getvalue()


def export_fonttools(key, path):
    t = TTFont(os.path.join(ROOT, path))
    order = t.getGlyphOrder()
    gid = {n: i for i, n in enumerate(order)}
    gs = t.getGlyphSet()
    out = {
        'numGlyphs': len(order),
        'unitsPerEm': t['head'].unitsPerEm,
        'ascender': t['hhea'].ascent, 'descender': t['hhea'].descent,
        'cmap': {str(cp): gid[n] for cp, n in sorted(t.getBestCmap().items())},
        'advances': [t['hmtx'][n][0] for n in order],
        'outlines': [],
    }
    for n in order:
        pen = Canon(gs); gs[n].draw(pen); pen._flush()
        out['outlines'].append(pen.contours)
    if 'glyf' in t:
        glyf, recs = t['glyf'], []
        for n in order:
            g = glyf[n]
            if g.numberOfContours == 0:
                recs.append({'kind': 'Empty'})
            elif g.isComposite():
                recs.append({'kind': 'Composite', 'bbox': [g.xMin, g.yMin, g.xMax, g.yMax], 'components': [
                    {'glyph': gid[c.glyphName], 'flags': c.flags, 'x': getattr(c, 'x', None), 'y': getattr(c, 'y', None),
                     'transform': [list(r) for r in c.transform] if hasattr(c, 'transform') else None}
                    for c in g.components]})
            else:
                recs.append({'kind': 'Simple', 'bbox': [g.xMin, g.yMin, g.xMax, g.yMax],
                             'endPts': list(g.endPtsOfContours),
                             'coords': [list(p) for p in g.coordinates],
                             'on': [f & 1 for f in g.flags],
                             'instructions': len(g.program.getBytecode()) if hasattr(g, 'program') else 0})
        out['glyf'] = recs
    json.dump(out, open(os.path.join(HERE, f'fonttools-{key}.json'), 'w'), separators=(',', ':'))
    return t


def export_hb():
    res = {}
    for key, path in FONTS.items():
        order = TTFont(os.path.join(ROOT, path)).getGlyphOrder()
        font = hb.Font(hb.Face(sfnt_bytes(path)))
        res[key] = {}
        for text in CORPUS:
            b = hb.Buffer(); b.add_str(text); b.guess_segment_properties()
            hb.shape(font, b, {})
            res[key][text] = [dict(g=i.codepoint, name=order[i.codepoint], cl=i.cluster,
                                   ax=p.x_advance, ay=p.y_advance, dx=p.x_offset, dy=p.y_offset)
                              for i, p in zip(b.glyph_infos, b.glyph_positions)]
    json.dump(res, open(os.path.join(HERE, 'hb-shape.json'), 'w'), indent=1)
    return res


def export_ft(shaped):
    """FreeType coverage for each raster case, using HarfBuzz positions and the scene.js layout rule."""
    for key, path in FONTS.items():
        tmp = os.path.join(HERE, f'.{key}.sfnt')
        open(tmp, 'wb').write(sfnt_bytes(path))
        t = TTFont(tmp)
        upem, asc, desc = t['head'].unitsPerEm, t['hhea'].ascent, t['hhea'].descent
        face = freetype.Face(tmp)
        for text, px in RASTER:
            b = hb.Buffer(); b.add_str(text); b.guess_segment_properties()
            hb.shape(hb.Font(hb.Face(open(tmp, 'rb').read())), b, {})
            s = px / upem
            total = sum(p.x_advance for p in b.glyph_positions)
            w = math.ceil(2 * PADDING + total * s)
            h = math.ceil(2 * PADDING + (asc - desc) * s)
            base = PADDING + asc * s
            canvas = [0.0] * (w * h)
            face.set_char_size(px * 64)
            pen = 0
            for info, pos in zip(b.glyph_infos, b.glyph_positions):
                x = PADDING + (pen + pos.x_offset) * s
                y = base - pos.y_offset * s
                ix, iy = math.floor(x), math.floor(y)
                # Sub-pixel origin via the 26.6 delta; y up in FreeType.
                face.set_transform(freetype.Matrix(0x10000, 0, 0, 0x10000),
                                   freetype.Vector(round((x - ix) * 64), round(-(y - iy) * 64)))
                face.load_glyph(info.codepoint, freetype.FT_LOAD_NO_HINTING | freetype.FT_LOAD_NO_BITMAP | freetype.FT_LOAD_RENDER)
                bm, g = face.glyph.bitmap, face.glyph
                for r in range(bm.rows):
                    for c in range(bm.width):
                        X, Y = ix + g.bitmap_left + c, iy - g.bitmap_top + r
                        if 0 <= X < w and 0 <= Y < h:
                            canvas[Y * w + X] = min(1.0, canvas[Y * w + X] + bm.buffer[r * bm.pitch + c] / 255)
                pen += pos.x_advance
            name = f'ft-{key}-{text}-{px}.pgm'.replace(' ', '_')
            with open(os.path.join(HERE, name), 'wb') as f:
                f.write(f'P5 {w} {h} 255\n'.encode())
                f.write(bytes(round(v * 255) for v in canvas))
        os.remove(tmp)


if __name__ == '__main__':
    os.makedirs(HERE, exist_ok=True)
    for k, p in FONTS.items():
        export_fonttools(k, p)
    shaped = export_hb()
    export_ft(shaped)
    print('refs written:', sorted(os.listdir(HERE)))
