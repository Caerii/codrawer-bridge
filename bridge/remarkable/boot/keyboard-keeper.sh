#!/bin/sh
# Keep bonded Bluetooth keyboards connected. Run by codrawer-bluetooth.service (exec'd by
# bt-up.sh); with no argument it keeps every paired device connected, or pass one address.
#
# What reconnects a keyboard (measured with btmon and dbus-monitor on the Paper Pro, BlueZ 5.86;
# docs/investigations/keyboard-latency.md):
#   - While the radio is up, the kernel itself: BlueZ puts a bonded HID keyboard on the kernel's
#     auto-connect list, so the controller scans passively (30 ms in every 60) and connects the
#     moment the keyboard advertises, i.e. when a keypress wakes it. Nothing here is on that path.
#   - After the radio comes back (the tablet's suspend powers Bluetooth off; on resume the chip
#     reloads its firmware and hci0 powers up again ~5 s after wake), a connect attempt right
#     then catches a keyboard still advertising from the dropped link; the polling keeper could
#     be asleep for up to 32 s at that moment.
#
# So the keeper is event-driven: dbus-monitor reports BlueZ property changes as they happen, and
#   adapter Powered → true   sweep now (connect every keyboard that is not connected)
#   device Connected → false the link dropped: sweep now
#   device Connected → true  log it, apply the fast link (below) and reset the backoff
# Between events it still sweeps on a timer, backing off from KEEPER_WAIT (8 s) doubling to
# KEEPER_WAIT_MAX (32 s) while a keyboard stays away (a connect attempt pages the radio at full
# duty for up to 15 s here, and BlueZ keeps it going ~40 s). That timer is all there is when
# dbus-monitor is missing: the keeper then behaves exactly as the polling keeper did.
#
# KEYBOARD_FAST_LINK=1 (bridge.env, default off) asks the controller for a 7.5–15 ms connection
# interval on every connect, instead of the 20–25 ms the K380s asks for. A key report waits for
# the next connection event, so this halves the radio's share of key latency (mean ~12 ms → ~4–8 ms; btmon saw 25 ms).
# The peripheral latency rises from the keyboard's 20 to 30 so an idle keyboard still wakes its
# radio about as rarely (every 31 × 15 ms ≈ 0.47 s vs 21 × 25 ms ≈ 0.5 s); while typing it
# exchanges up to 3× more packets, so expect somewhat shorter battery life. The keyboard may ask
# for its own parameters back; the next connect applies these again.
#
# BusyBox-safe (no pkill; `read -t`, `mktemp`, `mkfifo`, awk `fflush`). The event reader dies with
# the keeper: with the unit's control group, or by the EXIT trap.
WAIT_MIN=${KEEPER_WAIT:-8}
WAIT_MAX=${KEEPER_WAIT_MAX:-32}
# KEYBOARD_FAST_LINK parameters, in controller units: interval 1.25 ms, timeout 10 ms.
FAST_MIN=6 FAST_MAX=12 FAST_LATENCY=30 FAST_TIMEOUT=210

log() { echo "[keeper] $*"; }

keyboards() {
  if [ -n "$ONE" ]; then echo "$ONE"; else bluetoothctl devices Paired 2>/dev/null | awk '{print $2}'; fi
}

is_connected() { bluetoothctl info "$1" 2>/dev/null | grep -q 'Connected: yes'; }

# fast_link ADDR: ask for the short connection interval (KEYBOARD_FAST_LINK=1 only).
fast_link() {
  [ "${KEYBOARD_FAST_LINK:-0}" = 1 ] || return 0
  h=$(hcitool con 2>/dev/null | awk -v a="$1" 'toupper($3) == toupper(a) { print $5; exit }')
  [ -n "$h" ] || return 0
  if hcitool lecup "$h" $FAST_MIN $FAST_MAX $FAST_LATENCY $FAST_TIMEOUT >/dev/null 2>&1; then
    log "$1 fast link requested (interval 7.5-15 ms, latency $FAST_LATENCY)"
  else
    log "$1 fast link refused by the controller"
  fi
}

# sweep: power the adapter on if needed and try once to connect every keyboard that is not
# connected. Sets missing=1 if any stayed away.
sweep() {
  bluetoothctl show 2>/dev/null | grep -q 'Powered: yes' || bluetoothctl power on >/dev/null 2>&1
  missing=0
  for K in $(keyboards); do
    is_connected "$K" && continue
    if timeout 15 bluetoothctl connect "$K" >/dev/null 2>&1; then
      log "$K connected (keeper)"
      [ -n "$MON" ] || fast_link "$K" # with events, the Connected event applies it
    else
      missing=1
    fi
  done
}

# The event reader, in two processes so both pids are known: dbus-monitor writes BlueZ's
# PropertiesChanged signals into one pipe, and awk turns each change we care about into a line
# "<Property> <value> <object path>" (e.g. "Connected true /org/bluez/hci0/dev_DC_D8_…") on the
# keeper's event pipe. Both pipes are FIFOs the keeper holds open read-write, so opening them
# never blocks, and a dead dbus-monitor only means reads time out (and the timer sweeps).
RULE="type='signal',sender='org.bluez',interface='org.freedesktop.DBus.Properties',member='PropertiesChanged'"
start_monitor() {
  dbus-monitor --system "$RULE" >&4 2>/dev/null &
  MON=$!
}

ONE=$1
D=$(mktemp -d /tmp/codrawer-keeper.XXXXXX) || exit 1
mkfifo "$D/raw" "$D/events" || exit 1
exec 3<>"$D/events" 4<>"$D/raw"
rm -rf "$D"
MON='' AWK=''
if command -v dbus-monitor >/dev/null 2>&1; then
  awk '
    /^signal / { path = ""; if (match($0, /path=[^;]*/)) path = substr($0, RSTART + 5, RLENGTH - 5); prop = ""; next }
    /string "(Connected|Powered)"/ { prop = $0; sub(/.*string "/, "", prop); sub(/".*/, "", prop); next }
    prop != "" && /variant/ { print prop, $NF, path; fflush(); prop = "" }
  ' <&4 >&3 &
  AWK=$!
  start_monitor
  log "listening for BlueZ events"
else
  log "dbus-monitor missing: polling every ${WAIT_MIN}-${WAIT_MAX} s"
fi
trap 'kill $MON $AWK 2>/dev/null' EXIT
trap 'exit 0' TERM INT

wait=$WAIT_MIN
sweep
while true; do
  if [ "$missing" = 1 ]; then
    wait=$((wait * 2)); [ "$wait" -gt "$WAIT_MAX" ] && wait=$WAIT_MAX
  else
    wait=$WAIT_MIN
  fi
  # Wait for an event or the timer. An event that needs no sweep goes back to waiting, with a
  # fresh timer (simpler than tracking what was left, and harmless).
  while read -t "$wait" prop value path <&3; do
    case "$prop $value" in
      "Connected true")
        log "${path##*/} connected"
        for K in $(keyboards); do
          case "$path" in *"$(echo "$K" | tr : _)") fast_link "$K" ;; esac
        done
        missing=0 wait=$WAIT_MIN
        ;;
      "Connected false") log "${path##*/} disconnected"; break ;;
      "Powered true") log "adapter powered on"; break ;;
      "Powered false") log "adapter powered off" ;;
    esac
  done
  # dbus-monitor died (the bus restarted): listen again
  if [ -n "$MON" ] && ! kill -0 "$MON" 2>/dev/null; then start_monitor; fi
  sweep
done
