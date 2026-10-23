"""Re-container two fetched fonts with fontTools, so each font is reachable through two containers
and the container decoders are checked against each other (run by `npm run fetch`, which checks
both outputs' sha256 against scripts/manifest.js):

  third_party/fonts/inter-latin-400.woff        TTFont(woff2); flavor='woff'; save()
  third_party/fonts/source-serif-4-regular.otf  TTFont(woff2); flavor=None; save()

fontTools stamps head.modified with the current time unless SOURCE_DATE_EPOCH is set; it is pinned
to the moment the original files were made (2026-10-21 11:53:10 UTC) so the bytes reproduce.
Needs fontTools 4.66.1 and brotli (the zlib inside Python is used for WOFF).
"""
import os
os.environ['SOURCE_DATE_EPOCH'] = '1792583590'
from fontTools.ttLib import TTFont

FONTS = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'third_party', 'fonts')

for src, dst, flavor in [('inter-latin-400.woff2', 'inter-latin-400.woff', 'woff'),
                         ('source-serif-4-regular.otf.woff2', 'source-serif-4-regular.otf', None)]:
    t = TTFont(os.path.join(FONTS, src))
    t.flavor = flavor
    t.save(os.path.join(FONTS, dst))
