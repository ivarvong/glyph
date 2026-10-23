"""Dev-only: decode our OTLP protobuf with the official opentelemetry-proto package and
compare every field against our OTLP/JSON export of the same trace.
  python3 -I verify/proto_check.py out/one.pb out/one.otlp.json"""
import json, sys
from opentelemetry.proto.collector.trace.v1 import trace_service_pb2

pb, js = sys.argv[1], sys.argv[2]
req = trace_service_pb2.ExportTraceServiceRequest()
req.ParseFromString(open(pb, 'rb').read())
j = json.load(open(js))

def any_pb(v):
    k = v.WhichOneof('value')
    if k == 'array_value': return ['array', [any_pb(x) for x in v.array_value.values]]
    if k == 'int_value': return ['int', str(v.int_value)]
    return [k, getattr(v, k)]
def any_js(v):
    (k, x), = v.items()
    if k == 'arrayValue': return ['array', [any_js(y) for y in x.get('values', [])]]
    return {'stringValue': 'string_value', 'boolValue': 'bool_value', 'doubleValue': 'double_value'}.get(k) and [{'stringValue': 'string_value', 'boolValue': 'bool_value', 'doubleValue': 'double_value'}[k], x] or ['int', str(x)]
kv_pb = lambda kvs: [[kv.key, any_pb(kv.value)] for kv in kvs]
kv_js = lambda kvs: [[kv['key'], any_js(kv['value'])] for kv in kvs]

rs_pb, rs_js = req.resource_spans[0], j['resourceSpans'][0]
assert len(req.resource_spans) == 1
assert kv_pb(rs_pb.resource.attributes) == kv_js(rs_js['resource']['attributes']), 'resource'
ss_pb, ss_js = rs_pb.scope_spans[0], rs_js['scopeSpans'][0]
assert ss_pb.scope.name == ss_js['scope']['name'] and ss_pb.scope.version == ss_js['scope']['version'], 'scope'
P, J = ss_pb.spans, ss_js['spans']
assert len(P) == len(J), (len(P), len(J))
fields = 0
for p, q in zip(P, J):
    assert p.trace_id.hex() == q['traceId'] and len(p.trace_id) == 16
    assert p.span_id.hex() == q['spanId'] and len(p.span_id) == 8
    assert p.parent_span_id.hex() == q.get('parentSpanId', '')
    assert p.name == q['name'] and p.kind == q['kind']
    assert str(p.start_time_unix_nano) == q['startTimeUnixNano'], (p.start_time_unix_nano, q['startTimeUnixNano'])
    assert str(p.end_time_unix_nano) == q['endTimeUnixNano']
    assert kv_pb(p.attributes) == kv_js(q['attributes']), (p.name, kv_pb(p.attributes), kv_js(q['attributes']))
    assert len(p.events) == len(q['events'])
    for e, f in zip(p.events, q['events']):
        assert str(e.time_unix_nano) == f['timeUnixNano'] and e.name == f['name'] and kv_pb(e.attributes) == kv_js(f['attributes'])
    assert p.status.code == q['status']['code'] and p.status.message == q['status'].get('message', '')
    fields += 9 + len(p.attributes) + len(p.events)
print(f'official decoder: {len(P)} spans, {fields} fields, all equal to the OTLP/JSON export')
