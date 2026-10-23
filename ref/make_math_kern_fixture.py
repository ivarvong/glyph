"""Dev-only: a synthetic MATH table that exercises what Latin Modern Math lacks.

Latin Modern Math has no MathKernInfo, so its parse never reads a math kern. This builds a MATH
table with fontTools (math kerns on three glyphs with null corners, italics on a contiguous gid
range so the coverage compiles as format 2, a glyph assembly with an extender), compiles it to
fixtures/test-math-kern.MATH (raw table bytes), then decompiles those bytes with fontTools into
ref/fonttools-math-kern.json. sfnt-style parsers read the same bytes; math/test compares.

Run: python3 -I ref/make_math_kern_fixture.py   (needs fonttools)
"""
import json, os
from fontTools.ttLib import TTFont, newTable

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
ORDER = ['.notdef'] + [f'g{i}' for i in range(1, 40)]

def main():
    # The constant names, from the main exporter (one list, not two).
    src = open(os.path.join(HERE, 'make_math_ref.py')).read()
    ns = {}
    exec(src[src.index('CONSTANTS = ['):src.index(']', src.index('CONSTANTS = [')) + 1], ns)
    CONSTANTS = ns['CONSTANTS']
    consts = ''.join(
        f'    <{n} value="{(i * 37) % 900 - 100}"/>\n' if i in (0, 1, 55) else
        f'    <{n} value="{(i * 37) % 900}"/>\n' if i in (2, 3) else
        f'    <{n}><Value value="{(i * 37) % 900 - 100}"/></{n}>\n'
        for i, n in enumerate(CONSTANTS))

    def kern(name, heights, kerns):
        return (f'      <{name}>\n' + ''.join(f'        <CorrectionHeight index="{i}"><Value value="{h}"/></CorrectionHeight>\n' for i, h in enumerate(heights))
                + ''.join(f'        <KernValue index="{i}"><Value value="{k}"/></KernValue>\n' for i, k in enumerate(kerns)) + f'      </{name}>\n')

    xml = f"""<MATH>
  <Version value="0x00010000"/>
  <MathConstants>
{consts}  </MathConstants>
  <MathGlyphInfo>
    <MathItalicsCorrectionInfo>
      <Coverage>
""" + ''.join(f'        <Glyph value="g{g}"/>\n' for g in range(10, 20)) + """      </Coverage>
""" + ''.join(f'      <ItalicsCorrection index="{i}"><Value value="{-50 + 13 * i}"/></ItalicsCorrection>\n' for i in range(10)) + """    </MathItalicsCorrectionInfo>
    <MathTopAccentAttachment>
      <TopAccentCoverage>
        <Glyph value="g3"/>
        <Glyph value="g7"/>
      </TopAccentCoverage>
      <TopAccentAttachment index="0"><Value value="210"/></TopAccentAttachment>
      <TopAccentAttachment index="1"><Value value="-15"/></TopAccentAttachment>
    </MathTopAccentAttachment>
    <ExtendedShapeCoverage>
      <Glyph value="g21"/>
      <Glyph value="g22"/>
    </ExtendedShapeCoverage>
    <MathKernInfo>
      <MathKernCoverage>
        <Glyph value="g4"/>
        <Glyph value="g5"/>
        <Glyph value="g6"/>
      </MathKernCoverage>
      <MathKernInfoRecords index="0">
""" + kern('TopRightMathKern', [100, 300], [20, -10, -60]) + kern('BottomLeftMathKern', [], [35]) + """      </MathKernInfoRecords>
      <MathKernInfoRecords index="1">
""" + kern('TopLeftMathKern', [250], [-5, 40]) + kern('BottomRightMathKern', [-100, 0, 200], [1, 2, 3, 4]) + """      </MathKernInfoRecords>
      <MathKernInfoRecords index="2">
""" + kern('TopRightMathKern', [400], [-80, -120]) + kern('TopLeftMathKern', [], [0]) + kern('BottomRightMathKern', [50], [12, 0]) + kern('BottomLeftMathKern', [10, 20], [-1, -2, -3]) + """      </MathKernInfoRecords>
    </MathKernInfo>
  </MathGlyphInfo>
  <MathVariants>
    <MinConnectorOverlap value="20"/>
    <VertGlyphCoverage>
      <Glyph value="g30"/>
    </VertGlyphCoverage>
    <HorizGlyphCoverage>
      <Glyph value="g31"/>
    </HorizGlyphCoverage>
    <VertGlyphConstruction index="0">
      <GlyphAssembly>
        <ItalicsCorrection><Value value="7"/></ItalicsCorrection>
        <PartRecords index="0"><glyph value="g32"/><StartConnectorLength value="0"/><EndConnectorLength value="150"/><FullAdvance value="600"/><PartFlags value="0"/></PartRecords>
        <PartRecords index="1"><glyph value="g33"/><StartConnectorLength value="150"/><EndConnectorLength value="150"/><FullAdvance value="300"/><PartFlags value="1"/></PartRecords>
        <PartRecords index="2"><glyph value="g34"/><StartConnectorLength value="150"/><EndConnectorLength value="0"/><FullAdvance value="600"/><PartFlags value="0"/></PartRecords>
      </GlyphAssembly>
      <MathGlyphVariantRecord index="0"><VariantGlyph value="g30"/><AdvanceMeasurement value="1000"/></MathGlyphVariantRecord>
      <MathGlyphVariantRecord index="1"><VariantGlyph value="g35"/><AdvanceMeasurement value="1500"/></MathGlyphVariantRecord>
    </VertGlyphConstruction>
    <HorizGlyphConstruction index="0">
      <MathGlyphVariantRecord index="0"><VariantGlyph value="g31"/><AdvanceMeasurement value="500"/></MathGlyphVariantRecord>
    </HorizGlyphConstruction>
  </MathVariants>
</MATH>
"""
    t = TTFont()
    t.setGlyphOrder(ORDER)
    from fontTools.misc import xmlReader
    tmp = os.path.join(HERE, '.math-kern.ttx')
    open(tmp, 'w').write(f'<?xml version="1.0" encoding="UTF-8"?>\n<ttFont sfntVersion="OTTO">\n{xml}</ttFont>\n')
    xmlReader.XMLReader(tmp, t).read()
    os.remove(tmp)
    data = t['MATH'].compile(t)
    open(os.path.join(ROOT, 'fixtures/test-math-kern.MATH'), 'wb').write(data)

    # Read the compiled bytes back with fontTools: the reference is its decompile, not our XML.
    t2 = TTFont(); t2.setGlyphOrder(ORDER)
    m = newTable('MATH'); m.decompile(data, t2)
    tab = m.table
    gid = {n: i for i, n in enumerate(ORDER)}
    val = lambda v: v.Value if hasattr(v, 'Value') else v  # noqa: E731
    gi, mv = tab.MathGlyphInfo, tab.MathVariants

    def kernj(k):
        return None if k is None else {'heights': [val(h) for h in k.CorrectionHeight], 'kerns': [val(x) for x in k.KernValue]}

    def cons(cov, recs):
        out = {}
        for g, c in zip(cov.glyphs, recs):
            a = c.GlyphAssembly
            out[str(gid[g])] = {'variants': [[gid[r.VariantGlyph], r.AdvanceMeasurement] for r in c.MathGlyphVariantRecord],
                                'assembly': None if a is None else {'italic': val(a.ItalicsCorrection), 'parts': [
                                    [gid[p.glyph], p.StartConnectorLength, p.EndConnectorLength, p.FullAdvance, p.PartFlags] for p in a.PartRecords]}}
        return out

    ref = {
        'constants': {n: val(getattr(tab.MathConstants, n)) for n in CONSTANTS},
        'italics': {str(gid[g]): val(r) for g, r in zip(gi.MathItalicsCorrectionInfo.Coverage.glyphs, gi.MathItalicsCorrectionInfo.ItalicsCorrection)},
        'topAccent': {str(gid[g]): val(r) for g, r in zip(gi.MathTopAccentAttachment.TopAccentCoverage.glyphs, gi.MathTopAccentAttachment.TopAccentAttachment)},
        'extended': sorted(gid[g] for g in gi.ExtendedShapeCoverage.glyphs),
        'kerns': {str(gid[g]): {k: kernj(getattr(r, k + 'MathKern')) for k in ('TopRight', 'TopLeft', 'BottomRight', 'BottomLeft')}
                  for g, r in zip(gi.MathKernInfo.MathKernCoverage.glyphs, gi.MathKernInfo.MathKernInfoRecords)},
        'minConnectorOverlap': mv.MinConnectorOverlap,
        'vertical': cons(mv.VertGlyphCoverage, mv.VertGlyphConstruction),
        'horizontal': cons(mv.HorizGlyphCoverage, mv.HorizGlyphConstruction),
    }
    json.dump(ref, open(os.path.join(HERE, 'fonttools-math-kern.json'), 'w'), indent=0)
    print(f'{len(data)} bytes; kerns {len(ref["kerns"])}, italics {len(ref["italics"])}, vertical {len(ref["vertical"])}')


main()
