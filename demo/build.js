// Build the playground: bundle demo/app.js (the real library, unmodified) into one inline
// module. The page fetches its fonts from their pinned upstream URLs at runtime, so the site
// hosts none. esbuild is a dev-time tool here; the runtime has zero dependencies.
// Needs the generated runtime modules: run after `node scripts/fetch.js --runtime`.
//   node demo/build.js [outdir]      (default out/demo)
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';

const root = new URL('../', import.meta.url).pathname;
const out = process.argv[2] ?? `${root}out/demo`;
mkdirSync(out, { recursive: true });
rmSync(`${out}/fonts`, { recursive: true, force: true }); // older builds copied fonts here
execFileSync('npx', ['--yes', 'esbuild@0.24.0', `${root}demo/app.js`, '--bundle', '--format=esm', '--minify', '--target=es2022', `--outfile=${out}/app.bundle.js`], { stdio: 'inherit' });
const js = readFileSync(`${out}/app.bundle.js`, 'utf8').replaceAll('</script', '<\\/script');
writeFileSync(`${out}/index.html`, readFileSync(`${root}demo/index.html`, 'utf8').replace('/*APP*/', () => js));
console.log(`${out}/index.html  ${(js.length / 1024).toFixed(0)} KiB of inline JS`);
