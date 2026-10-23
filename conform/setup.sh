#!/usr/bin/env bash
# Fetch and build the conformance oracles at pinned commits, into conform/.ext (dev only).
#   w3c/woff2-tests   generated suites + per-case expectations (captured from the generators)
#   google/woff2      the reference decoder, woff2_decompress / woff2_compress
# Needs git, python3 with fontTools + brotli, cmake and a C++ compiler.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; EXT="$HERE/.ext"; mkdir -p "$EXT"
W3C=dd31222b7fde98552efa3b2d56fb3f4bd2554e4a
GOOGLE=fb9c3379f2605b10f3e8f1d9636664ab5576775c
fetch() { # repo dir commit
  if [ ! -d "$EXT/$2/.git" ]; then git clone --quiet "https://github.com/$1.git" "$EXT/$2"; fi
  git -C "$EXT/$2" fetch --quiet --depth 1 origin "$3" 2>/dev/null || true
  git -C "$EXT/$2" checkout --quiet "$3"
}
fetch w3c/woff2-tests woff2-tests "$W3C"
if [ ! -f "$EXT/UserAgentTestCaseGenerator.json" ]; then
  G="$EXT/woff2-tests/generators"
  for g in DecoderTestCaseGenerator FormatTestCaseGenerator UserAgentTestCaseGenerator; do
    (cd "$G" && python3 -I "$HERE/expect.py" "$G" "$g" "$EXT/$g.json")
  done
fi
fetch google/woff2 woff2 "$GOOGLE"
git -C "$EXT/woff2" submodule --quiet update --init --recursive
if [ ! -x "$EXT/woff2/out/woff2_decompress" ]; then
  cmake -S "$EXT/woff2" -B "$EXT/woff2/out" -DCMAKE_BUILD_TYPE=Release > /dev/null
  make -C "$EXT/woff2/out" -j"$(nproc)" woff2_decompress woff2_compress > /dev/null
fi
echo "conform: oracles ready in $EXT"
