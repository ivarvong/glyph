#!/usr/bin/env node
// otc <summary|tree|otlp|check> <file.jsonl>
import { readFileSync } from 'node:fs';
import { parse, renderSummary, renderTree, summarize, toOtlp, gaps, fmtUs } from '../src/read.js';
import { batchFromRecords, encodeForward, encodeReverse } from '../src/otlp.js';

const [cmd = 'summary', file, arg, arg2] = process.argv.slice(2);
if (!file) {
  console.error('usage: otc <summary|tree|otlp|proto|check|gaps> <file.jsonl> [gaps: threshold µs (100)] [gaps: root index]');
  process.exit(64);
}

const parsed = parse(readFileSync(file, 'utf8'));
for (const e of parsed.errors) console.error(`warn: ${JSON.stringify(e)}`);

const commands = {
  summary: () => console.log(renderSummary(summarize(parsed.spans))),
  tree: () => console.log(renderTree(parsed.spans)),
  otlp: () => console.log(JSON.stringify(toOtlp(parsed))),
  // OTLP/protobuf ExportTraceServiceRequest to stdout (POST it to /v1/traces with content-type application/x-protobuf).
  proto: () => {
    const res = { service: parsed.resource?.service ?? 'unknown', attrs: Object.entries(parsed.resource?.attrs ?? {}), scope: 'otel-compact', version: '1' };
    const bytes = (arg === 'forward' ? encodeForward : encodeReverse)(batchFromRecords(parsed.spans), res);
    process.stdout.write(bytes);
  },
  gaps: () => {
    const g = gaps(parsed.spans, Number(arg ?? 100), arg2 === undefined ? -1 : Number(arg2));
    console.log(`${g.spans} spans, ${fmtUs(g.total)} total; self time > ${fmtUs(Number(arg ?? 100))}:`);
    for (const x of g.open) console.log(`  OPEN    ${fmtUs(x.self).padStart(9)}  ${x.path}${x.leaf ? '' : '  (parent)'}${x.gc > 0 ? `  (+${fmtUs(x.gc)} GC excluded)` : ''}`);
    for (const x of g.atomic) console.log(`  atomic  ${fmtUs(x.self).padStart(9)}  ${x.path}${x.items ? `  items=${x.items} (${fmtUs(x.self / x.items)}/item)` : ''}`);
    console.log(`untraced time inside parents: ${fmtUs(g.untracedInParents)} (${(100 * g.untracedInParents / g.total).toFixed(2)}%); GC inside these roots: ${fmtUs(g.gcTotal)}; tracer overhead ${fmtUs(g.tracerOverhead)} (${fmtUs(g.perChild)}/span)`);
    process.exit(g.open.length ? 1 : 0);
  },
  check: () => {
    console.log(`${parsed.spans.length} spans, ${parsed.errors.length} parse errors`);
    process.exit(parsed.errors.length ? 1 : 0);
  },
};

const run = commands[cmd];
if (!run) {
  console.error(`unknown command ${cmd}`);
  process.exit(64);
}
run();
