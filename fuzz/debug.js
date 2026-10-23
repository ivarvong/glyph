// Run one input in-process with full diagnostics: stack for throws, CPU profile hot frames for hangs.
//   node fuzz/debug.js <file> [--profile]
import { readFileSync } from 'node:fs';
import { Session } from 'node:inspector/promises';
const { target } = await import('./target.js');
const bytes = new Uint8Array(readFileSync(process.argv[2]));
const profile = process.argv.includes('--profile');
const s = new Session(); s.connect();
if (profile) { await s.post('Profiler.enable'); await s.post('Profiler.start'); }
const t = performance.now();
const stop = profile ? setTimeout(async () => {}, 0) : null;
try {
  const r = await Promise.race([target(bytes), new Promise((res) => setTimeout(() => res({ reached: 'TIMEOUT (async)' }), 6000))]);
  console.log('result', r, `${(performance.now() - t).toFixed(0)} ms`);
} catch (e) { console.log('THROW', e.stack.split('\n').slice(0, 14).join('\n')); }
if (profile) {
  const { profile: p } = await s.post('Profiler.stop');
  const self = new Map(); const byId = new Map(p.nodes.map((n) => [n.id, n]));
  p.samples.forEach((id, i) => { const n = byId.get(id); const k = `${n.callFrame.functionName || '(anon)'} ${n.callFrame.url.split('/glyph/')[1] ?? n.callFrame.url}:${n.callFrame.lineNumber + 1}`; self.set(k, (self.get(k) ?? 0) + (p.timeDeltas[i] ?? 0)); });
  console.log([...self].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${(v / 1000).toFixed(0).padStart(6)} ms  ${k}`).join('\n'));
}
