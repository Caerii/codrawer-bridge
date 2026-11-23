#!/usr/bin/env bash
# Fast 2-second QML hot-reload onto the Paper Pro (no Rust/Go/Docker rebuild).
#   scripts/dev/hot-qml.sh            # upload live.qml (effective on next Ask, no restart)
#   scripts/dev/hot-qml.sh --all      # upload live.qml + dock.qml and cycle XOVI
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TABLET="${CODRAWER_TABLET:-192.168.50.156}"
QML="$ROOT/bridge/remarkable/xovi/codrawer-layer/qml"
DEST="/home/root/xovi/exthome/codrawer-layer"

scp -q "$QML/live.qml" "root@$TABLET:$DEST/live.qml.new"
ssh -o BatchMode=yes "root@$TABLET" "chmod 755 $DEST/live.qml.new && mv -f $DEST/live.qml.new $DEST/live.qml"
echo "[hot-qml] live.qml updated (takes effect on next Ask)"

if [ "${1:-}" = --all ]; then
  scp -q "$QML/dock.qml" "root@$TABLET:$DEST/dock.qml.new"
  ssh -o BatchMode=yes "root@$TABLET" "chmod 755 $DEST/dock.qml.new && mv -f $DEST/dock.qml.new $DEST/dock.qml && sh /home/root/codrawer/current/boot.sh xovi off && sh /home/root/codrawer/current/boot.sh xovi on"
  echo "[hot-qml] dock.qml updated and XOVI restarted"
fi
