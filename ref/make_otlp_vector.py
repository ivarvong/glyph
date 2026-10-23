"""Dev-only: a byte-exact OTLP protobuf vector from the official encoder.
python3 -I ref/make_otlp_vector.py  ->  ref/otlp-vector.json"""
import json, os
from opentelemetry.proto.collector.trace.v1 import trace_service_pb2 as ts
from opentelemetry.proto.trace.v1 import trace_pb2 as tr
from opentelemetry.proto.common.v1 import common_pb2 as co

def any_value(v):
    a = co.AnyValue()
    if isinstance(v, bool): a.bool_value = v
    elif isinstance(v, int): a.int_value = v
    elif isinstance(v, float): a.double_value = v
    elif isinstance(v, str): a.string_value = v
    else: a.array_value.values.extend(any_value(x) for x in v)
    return a
kv = lambda k, v: co.KeyValue(key=k, value=any_value(v))

spec = {
  'resource': {'service': 'glyph', 'attrs': [['node', 'v22.22.0'], ['pid', 4242]]},
  'spans': [
    {'traceId': '0102030405060708090a0b0c0d0e0f10', 'spanId': '1112131415161718', 'parent': None, 'name': 'render.one',
     'start': 1760000000000001.5, 'dur': 135940.25, 'attrs': [['text', 'Cloudflare'], ['size', 96], ['ok', True], ['ratio', 0.046875]],
     'events': [], 'error': None},
    {'traceId': '0102030405060708090a0b0c0d0e0f10', 'spanId': '2122232425262728', 'parent': '1112131415161718', 'name': 'woff2.brotli',
     'start': 1760000000000100, 'dur': 55020, 'attrs': [['neg', -7], ['big', 4294967296123], ['unicode', 'Ångström → 日本'], ['list', [1, 'a', False, 2.5]]],
     'events': [[12.5, 'mark', [['at', 1]]], [20, 'plain', []]], 'error': 'RangeError: nope'},
  ],
}
def nanos(us):
    whole = int(us // 1); frac = round((us - whole) * 1000)
    return whole * 1000 + frac

req = ts.ExportTraceServiceRequest()
rs = req.resource_spans.add()
rs.resource.attributes.extend([kv('service.name', spec['resource']['service'])] + [kv(k, v) for k, v in spec['resource']['attrs']])
ss = rs.scope_spans.add()
ss.scope.name = 'otel-compact'; ss.scope.version = '1'
for s in spec['spans']:
    sp = ss.spans.add()
    sp.trace_id = bytes.fromhex(s['traceId']); sp.span_id = bytes.fromhex(s['spanId'])
    if s['parent']: sp.parent_span_id = bytes.fromhex(s['parent'])
    sp.name = s['name']; sp.kind = tr.Span.SPAN_KIND_INTERNAL
    sp.start_time_unix_nano = nanos(s['start']); sp.end_time_unix_nano = nanos(s['start'] + s['dur'])
    sp.attributes.extend(kv(k, v) for k, v in s['attrs'])
    for off, name, attrs in s['events']:
        e = sp.events.add(); e.time_unix_nano = nanos(s['start'] + off); e.name = name; e.attributes.extend(kv(k, v) for k, v in attrs)
    if s['error']: sp.status.code = tr.Status.STATUS_CODE_ERROR; sp.status.message = s['error']
spec['hex'] = req.SerializeToString().hex()
json.dump(spec, open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'otlp-vector.json'), 'w'), indent=1, ensure_ascii=False)
print(len(spec['hex']) // 2, 'bytes')
