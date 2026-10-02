#!/bin/sh
# codrawer's only write to the reMarkable's root partition: the stub unit codrawer-boot.service,
# which starts /home/root/codrawer/current at boot. Everything else lives in /home and survives
# OS updates; an OS update swaps the root partition and drops the stub, so this re-adds it.
#
#   install.sh [--if-needed]   install the stub if missing or changed, start codrawer (default)
#   install.sh --status        report: stub, release, OS, last OS change; exit 1 if repair needed
#   install.sh --remove        remove the stub (and the pre-stub units), stop codrawer
#
# Run from a release directory (/home/root/codrawer/current/install.sh). Safe to run any time,
# from the desktop (scripts/dev/deploy-tablet.sh, the repair watcher), from a restricted SSH key,
# or from Vellum's post-OS-upgrade hook (VELLUM_REENABLE=1: / is already writable and Vellum
# restores it, so we leave the mount state alone). Never `umount -R /etc` (it drops the
# /etc/dropbear bind and can break SSH); we reach the rootfs's own /etc through a bind of /.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=/home/root/codrawer
STUB=codrawer-boot.service
LEGACY="codrawer-bluetooth.service codrawer-bridge.service" # rootfs units before the stub
LOWER=/tmp/codrawer-rootfs
MODE=${1:---if-needed}

stub_installed() {
  cmp -s "$HERE/$STUB" "/etc/systemd/system/$STUB" && [ -L "/etc/systemd/system/multi-user.target.wants/$STUB" ]
}

status() {
  echo "stub=$(stub_installed && echo ok || echo missing)"
  echo "release=$(sed -n '1s/^version //p' "$ROOT/current/MANIFEST" 2>/dev/null)"
  echo "os=$( (. /etc/os-release; echo "${IMG_VERSION:-${VERSION_ID:-unknown}}") )"
  echo "os_changed=$(cat "$ROOT/state/os_changed" 2>/dev/null)"
  stub_installed
}

# with_rootfs <command…>: run with the rootfs's own /etc reachable at $LOWER/etc, writable.
with_rootfs() {
  if [ "${VELLUM_REENABLE:-0}" = 1 ]; then
    LOWER="" # Vellum already made / writable with the /etc overlay out of the way
    "$@"
    return
  fi
  mount -o remount,rw /
  mkdir -p "$LOWER"
  mount --bind / "$LOWER"
  trap 'umount "$LOWER" 2>/dev/null; mount -o remount,ro / 2>/dev/null' EXIT
  "$@"
}

put_stub() {
  cp "$HERE/$STUB" "$LOWER/etc/systemd/system/$STUB"
  ln -sf "../$STUB" "$LOWER/etc/systemd/system/multi-user.target.wants/$STUB"
  for u in $LEGACY; do
    rm -f "$LOWER/etc/systemd/system/$u" "$LOWER/etc/systemd/system/multi-user.target.wants/$u"
  done
  sync
}

drop_stub() {
  for u in $STUB $LEGACY; do
    rm -f "$LOWER/etc/systemd/system/$u" "$LOWER/etc/systemd/system/multi-user.target.wants/$u"
  done
  sync
}

case "$MODE" in
  --status)
    status
    ;;
  --remove)
    systemctl stop "$STUB" codrawer-bluetooth.service codrawer-bridge.service 2>/dev/null || true
    with_rootfs drop_stub
    rm -f "/run/systemd/system/codrawer-bluetooth.service" "/run/systemd/system/codrawer-bridge.service"
    systemctl daemon-reload
    echo "codrawer stub removed (files in $ROOT kept)"
    ;;
  --if-needed | --stub)
    # first install from a release directory: make it current
    if [ ! -e "$ROOT/current" ]; then
      ln -sfn "$HERE" "$ROOT/current"
    fi
    [ -f "$ROOT/bridge.env" ] || cp "$HERE/bridge.env.example" "$ROOT/bridge.env"
    if stub_installed && [ -z "$(for u in $LEGACY; do [ -e "/etc/systemd/system/$u" ] && echo x; done)" ]; then
      echo "codrawer stub already installed"
    else
      for u in $LEGACY; do systemctl stop "$u" 2>/dev/null || true; done
      with_rootfs put_stub
      echo "codrawer stub installed"
    fi
    systemctl daemon-reload
    systemctl restart "$STUB"
    sh "$ROOT/current/boot.sh" doctor
    ;;
  *)
    echo "usage: install.sh [--if-needed|--status|--remove]" >&2
    exit 2
    ;;
esac
