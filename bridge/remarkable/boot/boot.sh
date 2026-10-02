#!/bin/sh
# codrawer operations on the tablet, run from a release directory
# (/home/root/codrawer/current/boot.sh, or a new release's own copy for `activate`).
#
#   start             start the release: kill switch, OS bookkeeping, units into /run, start
#   stop              stop codrawer's services
#   doctor            one-line-per-key status (release, OS, update detection, services, health)
#   activate <ver>    verify releases/<ver>, switch to it, health-check 60 s, roll back on failure
#   rollback          switch current and previous, restart
#   ack-os            forget the "OS changed" notice (after the app showed it)
#
# Layout (docs/investigations/durable-install.md §4):
#   /home/root/codrawer/{bridge.env,release.pub,DISABLED?,state/,current,previous,releases/<ver>/}
# Nothing here writes to the root partition; only install.sh does (the stub unit).
set -u
ROOT=/home/root/codrawer
REL=$(cd "$(dirname "$0")" && pwd)
STATE=$ROOT/state
UNITS="codrawer-bluetooth.service codrawer-bridge.service"
mkdir -p "$STATE"

os_version() { (. /etc/os-release 2>/dev/null; echo "${IMG_VERSION:-${VERSION_ID:-unknown}}"); }
version_of() { sed -n '1s/^version //p' "$1/MANIFEST" 2>/dev/null; }

start() {
  if [ -e "$ROOT/DISABLED" ]; then
    echo "codrawer: disabled (remove $ROOT/DISABLED to enable)"
    return 0
  fi
  # OS update detection: the version this boot vs the one recorded last boot.
  os=$(os_version)
  last=$(cat "$STATE/os_version" 2>/dev/null || true)
  if [ -n "$last" ] && [ "$last" != "$os" ]; then
    echo "$last $os $(date +%s)" > "$STATE/os_changed"
  fi
  echo "$os" > "$STATE/os_version"
  tested=0
  grep -qx "$os" "$REL/compat.conf" 2>/dev/null && tested=1
  mkdir -p /run/codrawer
  {
    echo "CODRAWER_OS=$os"
    echo "CODRAWER_OS_TESTED=$tested"
    echo "CODRAWER_VERSION=$(version_of "$REL")"
    [ -f "$STATE/os_changed" ] && echo "CODRAWER_OS_CHANGED=$(cut -d' ' -f1 "$STATE/os_changed")"
  } > /run/codrawer/env
  for u in $UNITS; do
    cp "$REL/units/$u" "/run/systemd/system/$u"
  done
  systemctl daemon-reload
  # --no-block: this runs inside the stub unit's start at boot; never wait on boot ordering
  systemctl --no-block restart $UNITS
  echo "codrawer $(version_of "$REL") started (OS $os, tested=$tested)"
}

stop() {
  systemctl stop $UNITS 2>/dev/null || true
}

# healthy: the bridge is up and, when it hosts the router, the router answers.
healthy() {
  systemctl is-active -q codrawer-bridge.service || return 1
  addr=$(sed -n 's/^SERVE_ADDR=//p' "$ROOT/bridge.env" 2>/dev/null | tail -n 1)
  [ -z "$addr" ] && return 0
  wget -q -T 3 -O - "http://127.0.0.1:${addr##*:}/healthz" 2>/dev/null | grep -q '"ok":true'
}

# wait_healthy: healthy twice, 5 s apart (a crash loop can look active for a moment), within 60 s.
wait_healthy() {
  i=0
  while [ $i -lt 12 ]; do
    if healthy; then
      sleep 5
      healthy && return 0
    fi
    sleep 5
    i=$((i + 1))
  done
  return 1
}

doctor() {
  echo "release=$(version_of "$ROOT/current")"
  echo "previous=$(version_of "$ROOT/previous")"
  echo "os=$(os_version)"
  echo "os_tested=$(grep -qx "$(os_version)" "$ROOT/current/compat.conf" 2>/dev/null && echo 1 || echo 0)"
  echo "os_changed=$(cat "$STATE/os_changed" 2>/dev/null)"
  echo "stub=$([ -f /etc/systemd/system/codrawer-boot.service ] && echo installed || echo missing)"
  echo "disabled=$([ -e "$ROOT/DISABLED" ] && echo 1 || echo 0)"
  for u in $UNITS; do echo "${u%.service}=$(systemctl is-active "$u" 2>/dev/null)"; done
  echo "healthy=$(healthy && echo 1 || echo 0)"
}

rollback() {
  prev=$(readlink "$ROOT/previous" 2>/dev/null) || { echo "no previous release"; return 1; }
  cur=$(readlink "$ROOT/current" 2>/dev/null || true)
  stop
  ln -sfn "$prev" "$ROOT/current"
  [ -n "$cur" ] && ln -sfn "$cur" "$ROOT/previous"
  sh "$ROOT/current/boot.sh" start
  echo "rolled back to $(version_of "$ROOT/current")"
}

# prune: keep current, previous and the three newest releases.
prune() {
  keep="$(readlink "$ROOT/current" 2>/dev/null) $(readlink "$ROOT/previous" 2>/dev/null) $(ls -dt "$ROOT"/releases/*/ 2>/dev/null | head -n 3 | sed 's#/$##')"
  for d in "$ROOT"/releases/*; do
    [ -d "$d" ] || continue
    case " $keep " in *" $d "*) ;; *) rm -rf "$d" ;; esac
  done
}

activate() {
  new="$ROOT/releases/$1"
  [ -d "$new" ] || { echo "no release $1"; return 1; }
  if [ -f "$ROOT/release.pub" ]; then
    # verify with the binary already trusted (current), or the new one on a first install
    verifier="$ROOT/current/codrawer_bridge_native"
    [ -x "$verifier" ] || verifier="$new/codrawer_bridge_native"
    chmod +x "$verifier"
    if ! "$verifier" release verify "$new" "$ROOT/release.pub" > /dev/null; then
      echo "release $1 failed verification; not activated"
      return 1
    fi
  fi
  chmod +x "$new/codrawer_bridge_native" "$new"/*.sh
  # stay awake through the switch and the health check (autosleep would stall it)
  { echo "codrawer-activate 120000000000" > /sys/power/wake_lock; } 2> /dev/null || true
  old=$(readlink "$ROOT/current" 2>/dev/null || true)
  stop
  [ -n "$old" ] && [ "$old" != "$new" ] && ln -sfn "$old" "$ROOT/previous"
  ln -sfn "$new" "$ROOT/current"
  sh "$ROOT/current/boot.sh" start
  if wait_healthy; then
    echo "activated $1"
    prune
    return 0
  fi
  echo "release $1 is not healthy after 60 s; rolling back"
  [ -n "$old" ] && [ "$old" != "$new" ] && rollback
  return 1
}

case "${1:-}" in
  start) start ;;
  stop) stop ;;
  doctor) doctor ;;
  activate) activate "${2:?version}" ;;
  rollback) rollback ;;
  ack-os) rm -f "$STATE/os_changed" ;;
  *) echo "usage: boot.sh start|stop|doctor|activate <version>|rollback|ack-os" >&2; exit 2 ;;
esac
