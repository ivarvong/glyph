// @ts-check
// Node-only Store: content-addressed files under a directory, sharded by key prefix,
// written atomically (temp file + rename) so a crash never leaves a torn entry.
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { some, NONE, ok, err } from '../../otel-compact/src/adt.js';

/** @param {string} dir @returns {import('./layers.js').Store} */
export function fsStore(dir) {
  const path = (/** @type {string} */ k) => join(dir, k.slice(0, 2), k.slice(2));
  return {
    name: 'fs',
    // Platform edge: node:fs rejects; here that becomes values. A missing file is absence (Ok(NONE)).
    async get(k) {
      try { return ok(some(new Uint8Array(await readFile(path(k))))); }
      catch (e) { return /** @type {any} */ (e).code === 'ENOENT' ? ok(NONE) : err(`fs get: ${/** @type {any} */ (e).message}`); }
    },
    async put(k, b) {
      const p = path(k), tmp = `${p}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
      try {
        await mkdir(join(dir, k.slice(0, 2)), { recursive: true });
        await writeFile(tmp, b);
        await rename(tmp, p);
        return ok(/** @type {const} */ (true));
      } catch (e) { return err(`fs put: ${/** @type {any} */ (e).message}`); }
    },
  };
}
