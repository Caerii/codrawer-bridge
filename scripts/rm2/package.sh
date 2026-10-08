#!/usr/bin/env bash
# Run from any directory, after pnpm install. Docker needs ARMv7 emulation.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="$ROOT/.codrawer/rm2-build"
mkdir -p "$OUT"
cd "$ROOT"
docker build --platform linux/arm/v7 -t codrawer-rm2-runtime -f scripts/rm2/Dockerfile scripts/rm2
container=$(docker create codrawer-rm2-runtime /bin/true)
trap 'docker rm "$container" >/dev/null' EXIT
mkdir -p "$OUT/runtime"
docker cp "$container:/." "$OUT/runtime/"
# Bundle TypeScript ahead of time: no package manager or compiler needed on the tablet.
ESBUILD=$(find node_modules/.pnpm -path '*/esbuild/bin/esbuild' -type f | head -n 1)
"$ESBUILD" packages/hand/scripts/layouts.ts --bundle --platform=node --target=node22 --format=cjs --outfile="$OUT/layouts.cjs"
(cd apps/even-g2 && node node_modules/vite/bin/vite.js build)
python3 scripts/rm2/package.py
