"""Dev-only reference exporter for the OpenType MATH table. Not a runtime dependency.

Writes third_party/ref/fonttools-lmmath.json (gitignored; run by `npm run fetch`, which checks its
sha256) from fontTools, for third_party/fonts/latinmodern-math.otf:
  advances, a digest of every glyph's canonical outline, and every MATH value: constants,
  italics corrections, top accent attachments, extended shapes, math kerns, and vertical and
  horizontal constructions (size variants and glyph assemblies).
Compared value for value by sfnt/test/math.test.js.

Outline digests: the Canon pen of make_refs.py, every coordinate written as round(v * 65536)
(both sides then format identical integers), SHA-256, first 16 hex digits.

Run: python3 -I ref/make_math_ref.py   (needs fonttools)
"""
import hashlib, json, os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HERE = os.path.join(ROOT, 'third_party', 'ref')  # output directory
from fontTools.ttLib import TTFont
from fontTools.pens.basePen import BasePen

FONT = 'third_party/fonts/latinmodern-math.otf'


# Copied from make_refs.py (which also needs uharfbuzz and freetype-py); mirrored by sfnt/test/canon.js.
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


CONSTANTS = [
    'ScriptPercentScaleDown', 'ScriptScriptPercentScaleDown', 'DelimitedSubFormulaMinHeight', 'DisplayOperatorMinHeight',
    'MathLeading', 'AxisHeight', 'AccentBaseHeight', 'FlattenedAccentBaseHeight', 'SubscriptShiftDown', 'SubscriptTopMax',
    'SubscriptBaselineDropMin', 'SuperscriptShiftUp', 'SuperscriptShiftUpCramped', 'SuperscriptBottomMin',
    'SuperscriptBaselineDropMax', 'SubSuperscriptGapMin', 'SuperscriptBottomMaxWithSubscript', 'SpaceAfterScript',
    'UpperLimitGapMin', 'UpperLimitBaselineRiseMin', 'LowerLimitGapMin', 'LowerLimitBaselineDropMin', 'StackTopShiftUp',
    'StackTopDisplayStyleShiftUp', 'StackBottomShiftDown', 'StackBottomDisplayStyleShiftDown', 'StackGapMin',
    'StackDisplayStyleGapMin', 'StretchStackTopShiftUp', 'StretchStackBottomShiftDown', 'StretchStackGapAboveMin',
    'StretchStackGapBelowMin', 'FractionNumeratorShiftUp', 'FractionNumeratorDisplayStyleShiftUp',
    'FractionDenominatorShiftDown', 'FractionDenominatorDisplayStyleShiftDown', 'FractionNumeratorGapMin',
    'FractionNumDisplayStyleGapMin', 'FractionRuleThickness', 'FractionDenominatorGapMin',
    'FractionDenomDisplayStyleGapMin', 'SkewedFractionHorizontalGap', 'SkewedFractionVerticalGap', 'OverbarVerticalGap',
    'OverbarRuleThickness', 'OverbarExtraAscender', 'UnderbarVerticalGap', 'UnderbarRuleThickness',
    'UnderbarExtraDescender', 'RadicalVerticalGap', 'RadicalDisplayStyleVerticalGap', 'RadicalRuleThickness',
    'RadicalExtraAscender', 'RadicalKernBeforeDegree', 'RadicalKernAfterDegree', 'RadicalDegreeBottomRaisePercent',
]


def val(v):
    """A MathValueRecord's value, or the bare int16/uint16 of the first four constants."""
    return v.Value if hasattr(v, 'Value') else v


def digest(contours):
    s = ';'.join(','.join(seg[0] + ' ' + ' '.join(str(round(x * 65536)) for x in seg[1:]) for seg in c) for c in contours)
    return hashlib.sha256(s.encode()).hexdigest()[:16]


def main():
    t = TTFont(os.path.join(ROOT, FONT))
    order = t.getGlyphOrder()
    gid = {n: i for i, n in enumerate(order)}
    gs = t.getGlyphSet()
    m = t['MATH'].table
    c = m.MathConstants
    gi = m.MathGlyphInfo
    mv = m.MathVariants

    def cov_values(cov, recs):
        return {str(gid[g]): val(r) for g, r in zip(cov.glyphs, recs)}

    def kern(k):
        return None if k is None else {'heights': [val(h) for h in k.CorrectionHeight], 'kerns': [val(v) for v in k.KernValue]}

    def constructions(cov, recs):
        out = {}
        for g, con in zip(cov.glyphs, recs):
            a = con.GlyphAssembly
            out[str(gid[g])] = {
                'variants': [[gid[r.VariantGlyph], r.AdvanceMeasurement] for r in con.MathGlyphVariantRecord],
                'assembly': None if a is None else {
                    'italic': val(a.ItalicsCorrection),
                    'parts': [[gid[p.glyph], p.StartConnectorLength, p.EndConnectorLength, p.FullAdvance, p.PartFlags] for p in a.PartRecords],
                },
            }
        return out

    ki = gi.MathKernInfo
    math = {
        'version': m.Version,
        'constants': {n: val(getattr(c, n)) for n in CONSTANTS},
        'italics': cov_values(gi.MathItalicsCorrectionInfo.Coverage, gi.MathItalicsCorrectionInfo.ItalicsCorrection),
        'topAccent': cov_values(gi.MathTopAccentAttachment.TopAccentCoverage, gi.MathTopAccentAttachment.TopAccentAttachment),
        'extended': sorted(gid[g] for g in gi.ExtendedShapeCoverage.glyphs) if gi.ExtendedShapeCoverage else [],
        'kerns': {str(gid[g]): {k: kern(getattr(r, k + 'MathKern')) for k in ('TopRight', 'TopLeft', 'BottomRight', 'BottomLeft')}
                  for g, r in zip(ki.MathKernCoverage.glyphs, ki.MathKernInfoRecords)} if ki else {},
        'minConnectorOverlap': mv.MinConnectorOverlap,
        'vertical': constructions(mv.VertGlyphCoverage, mv.VertGlyphConstruction),
        'horizontal': constructions(mv.HorizGlyphCoverage, mv.HorizGlyphConstruction),
    }
    outlines = []
    for n in order:
        pen = Canon(gs); gs[n].draw(pen); pen._flush()
        outlines.append(digest(pen.contours))
    out = {
        'font': FONT, 'numGlyphs': len(order), 'unitsPerEm': t['head'].unitsPerEm,
        'advances': [t['hmtx'][n][0] for n in order],
        'cmap': {str(cp): gid[n] for cp, n in sorted(t.getBestCmap().items())},
        'outlines': outlines,
        'math': math,
    }
    os.makedirs(HERE, exist_ok=True)
    json.dump(out, open(os.path.join(HERE, 'fonttools-lmmath.json'), 'w'), separators=(',', ':'))
    print(f"glyphs {len(order)}, constants {len(math['constants'])}, italics {len(math['italics'])}, topAccent {len(math['topAccent'])}, "
          f"extended {len(math['extended'])}, kerns {len(math['kerns'])}, vertical {len(math['vertical'])}, horizontal {len(math['horizontal'])}")


main()
