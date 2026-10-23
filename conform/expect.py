"""Run a w3c/woff2-tests generator and record each case's expectation, as the generator states it
(`valid=` or `shouldDisplaySFNT=`), by watching its write* calls. The generators stay unmodified.
    python3 -I conform/expect.py <generators dir> <GeneratorName> <out.json>
"""
import sys, runpy, json
G, gen, out = sys.argv[1], sys.argv[2], sys.argv[3]
sys.path.insert(0, G)
rec = {}
def prof(frame, event, arg):
    if event == 'call' and frame.f_code.co_name.startswith('write'):
        l = frame.f_locals
        if 'identifier' in l and isinstance(l['identifier'], str):
            v = l['valid'] if 'valid' in l else l.get('shouldDisplaySFNT', None)
            if v is not None or 'roundTrip' in l:
                rec[l['identifier']] = {'valid': True if v is None else bool(v), 'title': l.get('title') or '', 'fn': frame.f_code.co_name, 'roundTrip': bool(l.get('roundTrip', False))}
sys.setprofile(prof)
sys.argv = [gen + '.py']
runpy.run_path(f'{G}/{gen}.py', run_name='__main__')
sys.setprofile(None)
json.dump(rec, open(out, 'w'), indent=1)
print(gen, len(rec), 'cases,', sum(v['valid'] for v in rec.values()), 'valid')
