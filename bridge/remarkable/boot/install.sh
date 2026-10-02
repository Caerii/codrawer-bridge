#!/bin/sh
# Start the codrawer pieces at boot on a Paper Pro (run on the tablet as root):
#   codrawer-bluetooth.service  Bluetooth radio + keyboard keeper
#   codrawer-bridge.service     pen + keyboard bridge (/home/root/codrawer_bridge_native)
#
#   ssh root@<tablet> mkdir -p /home/root/codrawer
#   scp bridge/remarkable/boot/* root@<tablet>:/home/root/codrawer/
#   ssh root@<tablet> sh /home/root/codrawer/install.sh          # --remove to undo
#
# /etc is an overlay whose upper dir is tmpfs (/var/volatile/etc), so runtime edits to /etc are
# lost on reboot; the units go into the rootfs underneath it. An OS update swaps the root
# partition: re-run this script afterwards (everything in /home, and the pairing, survives).
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
DEST=/home/root/codrawer
UNITS="codrawer-bluetooth.service codrawer-bridge.service"
LOWER=/tmp/codrawer-rootfs

mount -o remount,rw /
mkdir -p "$LOWER"
mount --bind / "$LOWER"
trap 'umount "$LOWER" 2>/dev/null; mount -o remount,ro / 2>/dev/null' EXIT

if [ "${1:-}" = "--remove" ]; then
  for u in $UNITS; do
    systemctl disable --now "$u" 2>/dev/null || true
    rm -f "$LOWER/etc/systemd/system/$u" "$LOWER/etc/systemd/system/multi-user.target.wants/$u"
    rm -f "/etc/systemd/system/$u" "/etc/systemd/system/multi-user.target.wants/$u"
  done
  systemctl daemon-reload
  echo "removed: $UNITS"
  exit 0
fi

mkdir -p "$DEST"
[ "$HERE" = "$DEST" ] || cp "$HERE/bt-up.sh" "$HERE/keyboard-keeper.sh" "$HERE/bridge.env.example" "$DEST/"
[ -f "$DEST/bridge.env" ] || cp "$DEST/bridge.env.example" "$DEST/bridge.env"

# Hand-started copies (nohup) would race the services.
for p in $(ps | grep -E 'keyboard-keeper.sh|codrawer_bridge_native' | grep -v grep | awk '{print $1}'); do
  kill "$p" 2>/dev/null || true
done

for u in $UNITS; do
  cp "$HERE/$u" "$LOWER/etc/systemd/system/$u"
  ln -sf "../$u" "$LOWER/etc/systemd/system/multi-user.target.wants/$u"
done
sync
systemctl daemon-reload
for u in $UNITS; do systemctl restart "$u"; done
echo "installed: $UNITS (journalctl -u codrawer-bridge -f; config $DEST/bridge.env)"
