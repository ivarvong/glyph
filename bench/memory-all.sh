#!/bin/sh
# Peak live memory and CPU for every poster scene (bench/memory.js). DPR from env (default 3).
cd "$(dirname "$0")/.."
for scene in hero rings code waterfall squiggle; do
  set -- examples/posters.js "$scene"
  ONLY=none node --expose-gc bench/memory.js "$1" "$2" | node -e "
    let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const r=JSON.parse(s);
    console.log(['$2'.padEnd(18), String(r.segs).padStart(8)+' segs', r.heap.scene.padStart(10)+' scene', r.heap.renderPeakLive.padStart(10)+' peak', String(r.render.cpuMs).padStart(6)+' ms cpu', r.png.sha256].join('  '))})"
done
