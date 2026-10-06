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
#   xovi on|off       XOVI at boot (xovi.sh): off = stock xochitl now + kill switch XOVI_DISABLED;
#                     on = remove the kill switch and start XOVI under xovi.sh's gates
#   tailscale on|off  Tailscale at boot (tailscale.sh): off = stop it + kill switch
#                     TAILSCALE_DISABLED (the login is kept); on = remove the kill switch, start
#
# Layout (docs/investigations/durable-install.md §6.1):
#   /home/root/codrawer/{bridge.env,release.pub,DISABLED?,state/,current,previous,releases/<ver>/}
# Nothing here writes to the root partition; only install.sh does (the stub unit).
#
# Why it is shaped this way:
#   - An OS update replaces the whole root partition and leaves only /home (durable-install.md
#     §2), and /etc is an overlay on tmpfs. So every codrawer file lives in /home, and the units
#     are copied into the volatile /run/systemd/system at each start: a release can change its
#     units freely, and nothing has to survive in /etc.
#   - Releases are switched with the current/previous symlinks and verified before a switch
#     (package release, the bridge's `release verify`); a release that is not healthy within
#     60 s is rolled back by itself.
#   - The bridge gates fragile features (the page watcher) on the OS version being one this
#     release was tested on (compat.conf), which start exports as CODRAWER_OS_TESTED (§6.6).
#   - XOVI (the codrawer-layer extension inside xochitl) is optional and never in the boot path:
#     start brings the bridge up first, then only asks systemd, without waiting, to run the
#     codrawer-xovi unit, whose xovi.sh has its own gates and crash guard.
#   - Tailscale (remote access to the router over the user's own tailnet) is optional in the same
#     way: started after the bridge, without waiting, only when its binaries are installed in
#     /home/root/codrawer/tailscale and TAILSCALE_DISABLED is absent (tailscale.sh gate). It is
#     never stopped or restarted by stop, activate or rollback, so a deploy over the tailnet keeps
#     its connection.
set -u
ROOT=/home/root/codrawer
REL=$(cd "$(dirname "$0")" && pwd)
STATE=$ROOT/state
UNITS="codrawer-bluetooth.service codrawer-bridge.service"
XOVI_UNIT=codrawer-xovi.service # not in UNITS: stop and restart must never touch xochitl
TS_UNIT=codrawer-tailscale.service # not in UNITS either: a release switch keeps the tailnet up
mkdir -p "$STATE"

# os_version: the reMarkable release (IMG_VERSION, e.g. 3.29.0.149), else the Codex base version.
os_version() { (. /etc/os-release 2>/dev/null; echo "${IMG_VERSION:-${VERSION_ID:-unknown}}"); }
# version_of <release dir>: the version line of its MANIFEST (empty if none).
version_of() { sed -n '1s/^version //p' "$1/MANIFEST" 2>/dev/null; }

# start: honour the kill switch, record OS changes, write /run/codrawer/env (read by
# codrawer-bridge.service as a second EnvironmentFile), install the units into /run, start them.
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
  # files copied from Windows (scp) arrive without the executable bit; every path through start
  # (first install, activate, rollback, boot) must be able to run them
  chmod +x "$REL/codrawer_bridge_native" "$REL/codrawer_bridge_rs" "$REL"/*.sh 2> /dev/null || true
  for u in $UNITS $XOVI_UNIT $TS_UNIT; do
    [ -f "$REL/units/$u" ] && cp "$REL/units/$u" "/run/systemd/system/$u"
  done
  systemctl daemon-reload
  # A deliberate start (boot, activate, rollback) clears systemd's crash-loop limit, which would
  # otherwise keep refusing a unit that crash-looped earlier ("Start request repeated too quickly").
  systemctl reset-failed $UNITS 2> /dev/null || true
  # --no-block: this runs inside the stub unit's start at boot; never wait on boot ordering
  systemctl --no-block restart $UNITS
  # XOVI after the bridge, once per boot: `start` on a oneshot that already ran is a no-op, so an
  # activate or rollback does not restart xochitl. xovi.sh decides whether XOVI runs at all.
  [ -f "$REL/units/$XOVI_UNIT" ] && systemctl --no-block start "$XOVI_UNIT"
  # Tailscale likewise, under its gates; `start` leaves a running tailscaled alone.
  if [ -f "$REL/units/$TS_UNIT" ] && sh "$REL/tailscale.sh" gate; then
    systemctl --no-block start "$TS_UNIT"
  fi
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

# doctor: one key=value line per fact, for humans and scripts (install.sh ends with it).
doctor() {
  echo "release=$(version_of "$ROOT/current")"
  echo "previous=$(version_of "$ROOT/previous")"
  echo "os=$(os_version)"
  echo "os_tested=$(grep -qx "$(os_version)" "$ROOT/current/compat.conf" 2>/dev/null && echo 1 || echo 0)"
  echo "os_changed=$(cat "$STATE/os_changed" 2>/dev/null)"
  echo "stub=$([ -f /etc/systemd/system/codrawer-boot.service ] && echo installed || echo missing)"
  echo "disabled=$([ -e "$ROOT/DISABLED" ] && echo 1 || echo 0)"
  echo "engine=$(sed -n 's/^ENGINE=//p' "$ROOT/bridge.env" 2>/dev/null | tail -n 1 | grep . || echo go) (rust binary $([ -e "$ROOT/current/codrawer_bridge_rs" ] && echo present || echo absent))"
  for u in $UNITS; do echo "${u%.service}=$(systemctl is-active "$u" 2>/dev/null)"; done
  echo "healthy=$(healthy && echo 1 || echo 0)"
  if [ -f "$ROOT/current/xovi.sh" ]; then sh "$ROOT/current/xovi.sh" status; else echo "xovi=payload missing"; fi
  if [ -f "$ROOT/current/tailscale.sh" ]; then sh "$ROOT/current/tailscale.sh" status; else echo "tailscale=not in this release"; fi
}

# rollback [--no-check]: swap current and previous, restart, and (unless --no-check, as when
# activate is already failing) health-check the result.
rollback() {
  prev=$(readlink "$ROOT/previous" 2>/dev/null) || { echo "no previous release"; return 1; }
  cur=$(readlink "$ROOT/current" 2>/dev/null || true)
  stop
  ln -sfn "$prev" "$ROOT/current"
  [ -n "$cur" ] && ln -sfn "$cur" "$ROOT/previous"
  sh "$ROOT/current/boot.sh" start
  echo "rolled back to $(version_of "$ROOT/current")"
  if [ "${1:-}" != --no-check ] && ! wait_healthy; then
    echo "warning: $(version_of "$ROOT/current") is not healthy after 60 s (boot.sh rollback to go back)"
    return 1
  fi
}

# prune: keep current, previous and the three newest releases.
prune() {
  keep="$(readlink "$ROOT/current" 2>/dev/null) $(readlink "$ROOT/previous" 2>/dev/null) $(ls -dt "$ROOT"/releases/*/ 2>/dev/null | head -n 3 | sed 's#/$##')"
  for d in "$ROOT"/releases/*; do
    [ -d "$d" ] || continue
    case " $keep " in *" $d "*) ;; *) rm -rf "$d" ;; esac
  done
}

# activate <ver>: verify releases/<ver> (when release.pub exists), make it current with the old
# current as previous, start it, and keep it only if it is healthy within 60 s.
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
  [ -e "$new/codrawer_bridge_rs" ] && chmod +x "$new/codrawer_bridge_rs"
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
  [ -n "$old" ] && [ "$old" != "$new" ] && rollback --no-check
  return 1
}

case "${1:-}" in
  start) start ;;
  stop) stop ;;
  doctor) doctor ;;
  activate) activate "${2:?version}" ;;
  rollback) rollback ;;
  ack-os) rm -f "$STATE/os_changed" ;;
  xovi)
    case "${2:-}" in
      on | off) sh "$REL/xovi.sh" "$2" ;;
      *) echo "usage: boot.sh xovi on|off" >&2; exit 2 ;;
    esac
    ;;
  tailscale)
    case "${2:-}" in
      on | off) sh "$REL/tailscale.sh" "$2" ;;
      *) echo "usage: boot.sh tailscale on|off" >&2; exit 2 ;;
    esac
    ;;
  *) echo "usage: boot.sh start|stop|doctor|activate <version>|rollback|ack-os|xovi on|off|tailscale on|off" >&2; exit 2 ;;
esac
