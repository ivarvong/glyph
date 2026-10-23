"""fontTools as an oracle: for each font path on stdin (one per line), one JSON line out with
what fontTools decodes. The outlines use the same canonical form as sfnt/test/canon.js (the
Canon pen from ref/make_refs.py), so the Node side compares structure and coordinates exactly.

    printf '%s\n' a.woff2 b.ttf | python3 -I conform/oracle.py [--outlines N] > out.jsonl

{"path", "ok": true, "flavor", "numGlyphs", "unitsPerEm", "cmap": {cp: gid}, "advances", "lsbs",
 "outlines": [...first N glyphs...]}  or  {"path", "ok": false, "error"}.
Dev only (needs fontTools and brotli); the library never runs it.
"""
import io, json, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', 'ref'))
from fontTools.ttLib import TTFont  # noqa: E402
from make_refs import Canon  # noqa: E402

limit = 10 ** 9
if '--outlines' in sys.argv:
    limit = int(sys.argv[sys.argv.index('--outlines') + 1])


def decode(path):
    data = open(path, 'rb').read()
    t = TTFont(io.BytesIO(data), lazy=False)
    order = t.getGlyphOrder()
    gid = {n: i for i, n in enumerate(order)}
    gs = t.getGlyphSet()
    cmap = t.getBestCmap() or {}
    hm = t['hmtx'].metrics
    out = {
        'ok': True, 'flavor': t.flavor or 'sfnt', 'numGlyphs': len(order),
        'unitsPerEm': t['head'].unitsPerEm,
        'cmap': {str(cp): gid[n] for cp, n in sorted(cmap.items()) if n in gid},
        'advances': [hm[n][0] for n in order], 'lsbs': [hm[n][1] for n in order],
        'outlines': [],
    }
    glyf = t['glyf'] if 'glyf' in t else None
    for n in order[:limit]:
        pen = Canon(gs)
        gs[n].draw(pen)
        pen._flush()
        contours = pen.contours
        # Placement as renderers do it: FreeType and HarfBuzz shift every top-level TrueType glyph
        # by lsb - xMin (phantom point pp1). fontTools' glyph set applies that offset to simple
        # glyphs only; its Glyph.draw ignores it for composites. Checked against FreeType
        # (FT_LOAD_NO_SCALE) and HarfBuzz extents on Quando, DellaRespira, Atma: they agree with
        # the shifted placement. So apply it to composites here too.
        if glyf is not None and glyf[n].isComposite() and hasattr(glyf[n], 'xMin'):
            dx = hm[n][1] - glyf[n].xMin
            if dx:
                contours = [[[s[0]] + [v + dx if i % 2 == 0 else v for i, v in enumerate(s[1:])] for s in c] for c in contours]
        out['outlines'].append(contours)
    return out


for line in sys.stdin:
    p = line.strip()
    if not p:
        continue
    try:
        r = decode(p)
    except Exception as e:  # an oracle verdict, not a crash: fontTools rejected the file
        r = {'ok': False, 'error': f'{type(e).__name__}: {e}'[:300]}
    r['path'] = p
    sys.stdout.write(json.dumps(r) + '\n')
    sys.stdout.flush()
