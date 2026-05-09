#!/usr/bin/env bash
# Build the static drop-in deployment bundle.
#
# `<model-viewer>` is loaded from CDN in index.html
# (@google/model-viewer@4.2.0 via unpkg) — no local copy is needed.
# The plugin `@k1pp0/model-viewer-webxr-capture` is the only file that carries
# forked behavior — it self-installs at runtime, so the host element stays
# vanilla.
#
# Outputs:
#   - example/model-viewer-webxr-capture-bundled.min.js (+ .map)
#
# Usage:
#   ./scripts/build-and-package.sh

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "$ROOT"
npm run build

# Copy the bundled script and sourcemap into the example/ folder
# so that the example/ folder itself can be manually uploaded to Netlify.
cp "$ROOT/dist/model-viewer-webxr-capture-bundled.min.js" \
   "$ROOT/example/model-viewer-webxr-capture-bundled.min.js"
cp "$ROOT/dist/model-viewer-webxr-capture-bundled.min.js.map" \
   "$ROOT/example/model-viewer-webxr-capture-bundled.min.js.map"

echo "Static build is ready in $ROOT/example/"
