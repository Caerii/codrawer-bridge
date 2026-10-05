#!/usr/bin/env bash
# Runs boot_test.sh in an alpine container (Docker) against freshly built linux/amd64 binaries.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../../.." && pwd)"
W="$(mktemp -d)"
(cd "$ROOT/bridge/remarkable/native" && GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -o "$W/bridge" . &&
  GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -o "$W/tool" ./cmd/codrawer-release)
cp -r "$ROOT/bridge/remarkable/boot" "$W/boot"
MSYS_NO_PATHCONV=1 docker run --rm -v "$(cygpath -w "$W" 2>/dev/null || echo "$W"):/work" alpine:3.20 sh /work/boot/test/boot_test.sh
