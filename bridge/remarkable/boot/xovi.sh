#!/bin/sh
# XOVI at boot, guarded: start xochitl with the codrawer-layer extension after every boot, and
# fall back to stock xochitl by itself if that ever makes xochitl unstable.
#
#   xovi.sh boot      the codrawer-xovi unit's job: gates, install, wait for xochitl, start, guard
#   xovi.sh status    one line, xovi=<state>, for boot.sh doctor
#   xovi.sh on        remove the kill switch and start under the gates (restarts the unit)
#   xovi.sh off       kill switch on, back to stock xochitl now (one xochitl restart if running)
#
# ── The problem ──────────────────────────────────────────────────────────────────────────────
#
# The codrawer-layer extension runs inside xochitl and writes the selected tool to
# /run/codrawer/tool, which is how the bridge streams toolbar-eraser strokes as erasers
# (bridge/remarkable/xovi/codrawer-layer/README.md, docs/investigations/native-erase.md §6).
# It is loaded by XOVI, an LD_PRELOAD shim, and XOVI is tethered by design: its `start` script
# mounts a tmpfs over /etc/systemd/system/xochitl.service.d, writes the LD_PRELOAD drop-in there
# and restarts xochitl. Nothing persists, so after every reboot the tablet is stock again and the
# toolbar eraser streams as ink. This script re-runs that tethered start at every boot.
#
# ── The facts it rests on ────────────────────────────────────────────────────────────────────
#
#   - xochitl.service has Restart=on-failure, WatchdogSec=60, StartLimitBurst=4 in
#     StartLimitIntervalSec=600 and OnFailure=emergency.target (read on 3.29.0.149,
#     docs/investigations/native-multiplayer-layer.md). Every start counts towards the limit,
#     ours included: boot, XOVI's restart, a crash restart and a restart back to stock are 4.
#     A fifth start inside 10 minutes would put the tablet into emergency mode. Hence the guard
#     below trips on the FIRST automatic restart, not the second, and clears the rate counter
#     (`systemctl reset-failed xochitl.service`) before each start it causes, so the stock
#     restart always has headroom. Stock xochitl crash-looping on its own still meets the
#     unchanged stock limit.
#   - There is no xochitl.service.d on the rootfs (read on 3.29.0.149), so XOVI's tmpfs shadows
#     nothing. It is a mount over the /etc overlay, in memory: no rootfs or persistent /etc write
#     (durable-install.md §6.7). We never `umount -R /etc`.
#   - An extension is mapped by xochitl, so a running .so must never be overwritten in place:
#     files are installed by copy-then-rename, and only while XOVI is not running. A new
#     extension in a release therefore takes effect at the next boot.
#   - Only the extension is shipped (qt-resource-rebuilder is not), so no per-OS hashtable is
#     needed; the OS gate is xovi-compat.conf, separate from the bridge's compat.conf because
#     injecting into xochitl is riskier than reading the pen.
#
# ── How data flows ───────────────────────────────────────────────────────────────────────────
#
# boot.sh start (run by the rootfs stub) starts the bridge first, then codrawer-xovi.service with
# --no-block; that unit runs `xovi.sh boot`, off the boot critical path, and nothing waits for
# it. `boot` checks the gates in order (any failure: stay stock, say why in state/xovi_status):
#
#   1. the active release carries the payload (xovi/xovi.so, start, stock, codrawer-layer.so);
#   2. the OS's IMG_VERSION is listed in xovi-compat.conf;
#   3. the kill switch /home/root/codrawer/XOVI_DISABLED is absent;
#   4. the previous attempt reached a verdict: state/xovi_pending is written before XOVI starts
#      and removed only when the guard decides, so finding it at boot means the last attempt
#      ended mid-check (a crash, an emergency reboot); that disables XOVI, with the reason;
#   5. xochitl has been active, with the same main PID, for 20 s.
#
# Then it installs the payload into /home/root/xovi (xovi's own layout), runs xovi's `start`,
# and guards xochitl for 60 s: on an automatic restart, a changed main PID, or xochitl not active
# for 10 s, it runs xovi's `stock` at once and writes XOVI_DISABLED (reason and time). After 60 s
# stable it writes `running` and removes the pending marker.
#
# State, all under /home/root/codrawer: XOVI_DISABLED (kill switch; first line is the reason),
# state/xovi_pending (an attempt in progress), state/xovi_status (the last verdict, one line).
set -u
ROOT=/home/root/codrawer
REL=$(cd "$(dirname "$0")" && pwd)
STATE=$ROOT/state
KILL=$ROOT/XOVI_DISABLED
PENDING=$STATE/xovi_pending
STATUS=$STATE/xovi_status
X=${CODRAWER_XOVI_HOME:-/home/root/xovi} # xovi's own directory (its scripts hard-code this path)
PAYLOAD="xovi.so start stock codrawer-layer.so"
DROPIN=/etc/systemd/system/xochitl.service.d
PROC=${CODRAWER_TEST_PROC:-/proc} # tests point this at a fake /proc
# Guard timing, in seconds: the stability wait before starting, the watch after, the poll step,
# and how long xochitl may be not-active (starting or stopping) before that counts as a failure.
SETTLE=20
WATCH=60
STEP=2
GRACE=10
SETTLE_MAX=300 # give up waiting for a settled xochitl after this long (stay stock this boot)
mkdir -p "$STATE"

now() { date -u +%Y-%m-%dT%H:%M:%SZ; }
log() { echo "xovi: $*"; }
say() { echo "$*" > "$STATUS"; log "$*"; }
os_version() { (. /etc/os-release 2> /dev/null; echo "${IMG_VERSION:-${VERSION_ID:-unknown}}"); }

# xochitl <property>: one property of xochitl.service (ActiveState, NRestarts, MainPID).
xochitl() { systemctl show -p "$1" xochitl.service 2> /dev/null | sed -n "s/^$1=//p"; }

# running: XOVI's drop-in is mounted and the live xochitl has xovi.so mapped.
running() {
  grep -q " $DROPIN " "$PROC/mounts" 2> /dev/null || return 1
  pid=$(xochitl MainPID)
  [ -n "$pid" ] && [ "$pid" != 0 ] && grep -q "$X/xovi.so" "$PROC/$pid/maps" 2> /dev/null
}

payload_ok() { for f in $PAYLOAD; do [ -f "$REL/xovi/$f" ] || return 1; done; }
os_ok() { grep -qx "$(os_version)" "$REL/xovi-compat.conf" 2> /dev/null; }

# xshell: xovi's start/stock are bash scripts; the tablet has bash (tests fall back to sh).
xshell() { if command -v bash > /dev/null; then bash "$@"; else sh "$@"; fi; }

# disable <reason>: the kill switch, with the reason and time on its first line.
disable() { echo "$1 ($(now))" > "$KILL"; rm -f "$PENDING"; say "disabled: $1"; }

# back_to_stock: unmount XOVI's drop-in and restart xochitl, with a fresh start-rate counter.
back_to_stock() {
  systemctl reset-failed xochitl.service 2> /dev/null || true
  xshell "$X/stock"
}

# ── install ─────────────────────────────────────────────────────────────────────────────────
#
# put <src> <dest>: copy by rename (a mapped file is never rewritten), only when it differs.
put() {
  cmp -s "$1" "$2" && return 0
  cp "$1" "$2.codrawer-new" && chmod 755 "$2.codrawer-new" && mv -f "$2.codrawer-new" "$2"
}

# install: xovi's layout, as its own release tarball has it, minus qt-resource-rebuilder. Other
# files a user put under /home/root/xovi are left alone.
install_payload() {
  mkdir -p "$X/extensions.d" "$X/exthome/codrawer-layer" "$X/services/xochitl.service" \
    "$X/scripts/pre-start" "$X/scripts/post-start" "$X/scripts/pre-stock" "$X/scripts/post-stock"
  [ -e "$X/services/xochitl.service/extensions.d" ] || ln -s "$X/extensions.d" "$X/services/xochitl.service/extensions.d"
  [ -e "$X/services/xochitl.service/exthome" ] || ln -s "$X/exthome" "$X/services/xochitl.service/exthome"
  put "$REL/xovi/xovi.so" "$X/xovi.so" &&
    put "$REL/xovi/start" "$X/start" &&
    put "$REL/xovi/stock" "$X/stock" &&
    put "$REL/xovi/codrawer-layer.so" "$X/extensions.d/codrawer-layer.so"
}

# ── the guard ────────────────────────────────────────────────────────────────────────────────

# settled: xochitl active with one main PID for SETTLE s; fails after SETTLE_MAX s without that.
settled() {
  waited=0 calm=0 last=
  while [ $waited -lt $SETTLE_MAX ]; do
    st=$(xochitl ActiveState) pid=$(xochitl MainPID)
    if [ "$st" = active ] && [ "$pid" = "$last" ]; then
      calm=$((calm + STEP))
      [ $calm -ge $SETTLE ] && return 0
    else
      calm=0
    fi
    last=$pid
    sleep $STEP
    waited=$((waited + STEP))
  done
  return 1
}

# guard <restarts before> <pid after start>: watch WATCH s; return 1 with $why set on a failure.
guard() {
  n0=$1 p1=$2 t=0 away=0
  while [ $t -lt $WATCH ]; do
    sleep $STEP
    t=$((t + STEP))
    st=$(xochitl ActiveState) n=$(xochitl NRestarts) pid=$(xochitl MainPID)
    if [ "${n:-0}" -gt "$n0" ]; then why="xochitl restarted by systemd ${t}s after XOVI started"; return 1; fi
    case "$st" in
      failed | inactive) why="xochitl $st ${t}s after XOVI started"; return 1 ;;
      active) away=0 ;;
      *) away=$((away + STEP)) ;;
    esac
    if [ $away -ge $GRACE ]; then why="xochitl $st for ${away}s after XOVI started"; return 1; fi
    if [ "$st" = active ] && [ -n "$pid" ] && [ "$pid" != 0 ] && [ "$pid" != "$p1" ]; then
      why="xochitl main PID changed ($p1 -> $pid) ${t}s after XOVI started"
      return 1
    fi
  done
  return 0
}

# on_term: the unit is being stopped mid-check (shutdown, `xovi on`). A check that saw nothing
# wrong so far is not a failure: forget the attempt, so the next boot tries again. If xochitl is
# already down, keep the pending marker and let the next boot disable XOVI.
on_term() {
  if [ "$(xochitl ActiveState)" = active ] && [ "$(xochitl NRestarts)" = "${n0:-x}" ]; then
    rm -f "$PENDING"
    say "interrupted during the check, xochitl fine ($(now))"
  fi
  exit 0
}

boot() {
  payload_ok || { say "payload missing (release has no xovi/)"; return 0; }
  os_ok || { say "untested OS $(os_version) (not in xovi-compat.conf)"; return 0; }
  if [ -e "$KILL" ]; then say "disabled: $(head -n 1 "$KILL")"; return 0; fi
  if [ -e "$PENDING" ]; then
    disable "previous attempt ended during its check: $(cat "$PENDING")"
    return 0
  fi
  if running; then say "running (already started, $(now))"; return 0; fi
  # stay awake through the wait and the watch (does not stop xochitl's own deep sleep, which only
  # pauses the count)
  { echo "codrawer-xovi-guard 180000000000" > /sys/power/wake_lock; } 2> /dev/null || true
  if ! settled; then say "xochitl did not settle within ${SETTLE_MAX}s; stayed stock this boot"; return 0; fi
  install_payload || { say "install into $X failed; stayed stock"; return 0; }

  systemctl reset-failed xochitl.service 2> /dev/null || true
  n0=$(xochitl NRestarts)
  n0=${n0:-0}
  echo "OS $(os_version), release $(sed -n '1s/^version //p' "$REL/MANIFEST" 2> /dev/null), $(now)" > "$PENDING"
  trap on_term TERM INT
  say "starting ($(now))"
  xshell "$X/start"
  p1=$(xochitl MainPID)
  why=
  if ! running; then
    why="xochitl is not running with xovi.so after start"
  elif guard "$n0" "$p1"; then
    trap - TERM INT
    rm -f "$PENDING"
    say "running (healthy 60 s after start, $(now))"
    { echo codrawer-xovi-guard > /sys/power/wake_unlock; } 2> /dev/null || true
    return 0
  fi
  trap - TERM INT
  back_to_stock
  disable "$why"
  { echo codrawer-xovi-guard > /sys/power/wake_unlock; } 2> /dev/null || true
  return 0
}

# status: running wins (whatever started it); otherwise the reason it is not.
status() {
  if running; then
    ext=""
    payload_ok && ! cmp -s "$REL/xovi/codrawer-layer.so" "$X/extensions.d/codrawer-layer.so" &&
      ext=", extension differs from the release (takes effect next boot)"
    echo "xovi=running$ext"
  elif [ -e "$KILL" ]; then
    echo "xovi=disabled ($(head -n 1 "$KILL"))"
  elif ! payload_ok; then
    echo "xovi=payload missing"
  elif ! os_ok; then
    echo "xovi=untested OS $(os_version)"
  else
    echo "xovi=stock ($(cat "$STATUS" 2> /dev/null || echo 'not started yet'))"
  fi
}

off() {
  echo "off by the user ($(now))" > "$KILL"
  rm -f "$PENDING"
  systemctl stop codrawer-xovi.service 2> /dev/null || true
  if running; then back_to_stock; fi
  say "disabled: off by the user"
}

on() {
  rm -f "$KILL" "$PENDING"
  say "enabled by the user; starting under the gates"
  systemctl --no-block restart codrawer-xovi.service
}

case "${1:-}" in
  boot) boot ;;
  status) status ;;
  on) on ;;
  off) off ;;
  *) echo "usage: xovi.sh boot|status|on|off" >&2; exit 2 ;;
esac
