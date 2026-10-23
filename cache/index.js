// @ts-check
// glyph/cache: eviction policies, content keys, and cache tiers as composable layers.
// Runtime-agnostic; Node-only stores live in glyph/cache/node.
export { memo, Policy } from './src/policy.js';
export { sha256, hex, sceneKey, pathDigest } from './src/key.js';
export { layered, origin, memory, store, singleflight, prefetch, mapStore, r2Store, workersCache, serveCached, simulatedWorkersCache } from './src/layers.js';
export { pngJob, svgJob } from './src/render.js';
