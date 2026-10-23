"""HarfBuzz (uharfbuzz) as the shaping oracle. stdin: JSON lines {"path", "texts": [...]};
stdout: JSON lines {"path", "shaped": {text: [{g, cl, ax, ay, dx, dy}]}} with default features
and guessed segment properties, the same call ref/make_refs.py uses. Dev only."""
import json, sys
import uharfbuzz as hb

for line in sys.stdin:
    if not line.strip():
        continue
    job = json.loads(line)
    try:
        font = hb.Font(hb.Face(open(job['path'], 'rb').read()))
        out = {}
        for text in job['texts']:
            b = hb.Buffer(); b.add_str(text); b.guess_segment_properties()
            hb.shape(font, b, {})
            out[text] = [dict(g=i.codepoint, cl=i.cluster, ax=p.x_advance, ay=p.y_advance, dx=p.x_offset, dy=p.y_offset)
                         for i, p in zip(b.glyph_infos, b.glyph_positions)]
        r = {'path': job['path'], 'ok': True, 'shaped': out}
    except Exception as e:  # an oracle verdict, not a crash
        r = {'path': job['path'], 'ok': False, 'error': f'{type(e).__name__}: {e}'[:200]}
    sys.stdout.write(json.dumps(r) + '\n'); sys.stdout.flush()
