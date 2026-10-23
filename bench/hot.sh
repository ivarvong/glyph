#!/bin/sh
# Trace 30 renders and print warm p50 self time of the hottest leaf spans.
OTEL_COMPACT=jsonl:out/one.jsonl OTEL_COMPACT_DEFER=4096 ITER=${ITER:-30} node examples/trace-one.js && node verify/trace-viz-data.js out/one.jsonl | grep -E "^(hot|cold)"
