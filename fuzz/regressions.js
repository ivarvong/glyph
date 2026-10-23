// The saved fuzz findings: our own inputs in fuzz/regressions/*.bin, and the ones that are mutated
// third-party fonts, stored as fuzz/regressions/*.recipe.json and rebuilt by `npm run fetch` into
// third_party/fuzz/. A recipe without its rebuilt file is an error, never a silent skip.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const OWN = new URL('./regressions/', import.meta.url);
const BUILT = new URL('../third_party/fuzz/', import.meta.url);

/** @returns {{ name: string, url: URL }[]} every regression input, sorted by name */
export function regressionFiles() {
  const own = readdirSync(OWN).filter((f) => f.endsWith('.bin')).map((f) => ({ name: f, url: new URL(f, OWN) }));
  const built = readdirSync(OWN).filter((f) => f.endsWith('.recipe.json')).map((f) => {
    const r = JSON.parse(readFileSync(new URL(f, OWN), 'utf8'));
    const url = new URL(r.file, BUILT);
    if (!existsSync(url) || createHash('sha256').update(readFileSync(url)).digest('hex') !== r.sha256) {
      throw new Error(`fuzz regression ${r.file} is missing or changed in third_party/fuzz/; run \`npm run fetch\``);
    }
    return { name: r.file, url };
  });
  return [...own, ...built].sort((a, b) => (a.name < b.name ? -1 : 1));
}

/** One regression input by file name. */
export const regression = (name) => {
  const f = regressionFiles().find((x) => x.name === name);
  if (!f) throw new Error(`no fuzz regression ${name}`);
  return new Uint8Array(readFileSync(f.url));
};
