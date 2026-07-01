#!/usr/bin/env bash
# Build build/icon.icns from build/icon.svg.
# Renders a 1024px PNG via Electron, then slices sizes with sips + iconutil.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "rendering 1024px PNG from icon.svg (via Electron)…"
./node_modules/.bin/electron scripts/make-icon.js

ICONSET="build/icon.iconset"
rm -rf "$ICONSET"
mkdir -p "$ICONSET"

gen() { sips -z "$1" "$1" build/icon.png --out "$ICONSET/$2" >/dev/null; }
gen 16   icon_16x16.png
gen 32   icon_16x16@2x.png
gen 32   icon_32x32.png
gen 64   icon_32x32@2x.png
gen 128  icon_128x128.png
gen 256  icon_128x128@2x.png
gen 256  icon_256x256.png
gen 512  icon_256x256@2x.png
gen 512  icon_512x512.png
gen 1024 icon_512x512@2x.png

iconutil -c icns "$ICONSET" -o build/icon.icns
echo "wrote build/icon.icns"
