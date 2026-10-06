#!/usr/bin/env bash
# Runs boot_test.sh and keeper_test.sh in alpine containers (Docker) against freshly built linux/amd64 binaries.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../../.." && pwd)"
W="$(mktemp -d)"
(cd "$ROOT/bridge/remarkable/native" && GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -o "$W/bridge" . &&
  GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -o "$W/tool" ./cmd/codrawer-release)
cp -r "$ROOT/bridge/remarkable/boot" "$W/boot"
VOL="$(cygpath -w "$W" 2>/dev/null || echo "$W"):/work"
MSYS_NO_PATHCONV=1 docker run --rm -v "$VOL" alpine:3.20 sh /work/boot/test/boot_test.sh
# its own container: boot_test.sh replaces `sleep`, and the keeper needs real time
MSYS_NO_PATHCONV=1 docker run --rm -v "$VOL" alpine:3.20 sh /work/boot/test/keeper_test.sh
