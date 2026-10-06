#!/bin/sh
# Tests keyboard-keeper.sh in a container (alpine, BusyBox like the tablet) with fake bluetoothctl,
# dbus-monitor and hcitool. Run by run.sh, in its own container (boot_test.sh stubs out `sleep`).
#
# The fakes: one keyboard, AA:BB:CC:DD:EE:FF. `bluetoothctl connect` succeeds only while
# /tmp/awake exists (the keyboard is advertising) and then marks it connected; every call is
# logged with a timestamp. The fake dbus-monitor turns lines written to /tmp/bus into signals
# shaped like the real ones (captured on the Paper Pro, BlueZ 5.86).
set -eu
fail() { echo "FAIL: $*"; cat /tmp/keeper.log 2>/dev/null; exit 1; }
pass() { echo "ok - $*"; }

mkdir -p /fake /nodbus
cat > /fake/bluetoothctl <<'EOF'
#!/bin/sh
echo "$(date +%s) $*" >> /tmp/btctl.calls
case "$1" in
  show) echo "	Powered: yes" ;;
  devices) echo "Device AA:BB:CC:DD:EE:FF Pebble K380s" ;;
  info) [ -e /tmp/connected ] && echo "	Connected: yes" || echo "	Connected: no" ;;
  connect) [ -e /tmp/awake ] && touch /tmp/connected && exit 0; sleep 2; exit 1 ;;
esac
EOF
cat > /fake/dbus-monitor <<'EOF'
#!/bin/sh
# Prints one PropertiesChanged signal per "<Interface> <Property> <bool>" line written to /tmp/bus.
echo $$ > /tmp/mon.pid
tail -n 0 -f /tmp/bus | while read -r iface prop val; do
  path=/org/bluez/hci0; [ "$iface" = Device1 ] && path=/org/bluez/hci0/dev_AA_BB_CC_DD_EE_FF
  printf 'signal time=1.0 sender=:1.4 -> destination=(null destination) serial=9 path=%s; interface=org.freedesktop.DBus.Properties; member=PropertiesChanged\n' "$path"
  printf '   string "org.bluez.%s"\n   array [\n      dict entry(\n         string "%s"\n         variant             boolean %s\n      )\n   ]\n   array [\n   ]\n' "$iface" "$prop" "$val"
done
EOF
cat > /fake/hcitool <<'EOF'
#!/bin/sh
case "$1" in
  con) printf 'Connections:\n\t< LE AA:BB:CC:DD:EE:FF handle 128 state 1 lm CENTRAL AUTH ENCRYPT \n' ;;
  lecup) echo "$*" >> /tmp/lecup.calls ;;
esac
EOF
chmod +x /fake/*
for t in sh timeout awk mkfifo mktemp tr date sleep grep kill cat rm touch tail; do ln -sf "$(command -v $t)" /nodbus/$t; done
ln -sf /fake/bluetoothctl /nodbus/bluetoothctl
ln -sf /fake/hcitool /nodbus/hcitool

KEEPER=/work/boot/keyboard-keeper.sh
reset() { kill $KP 2>/dev/null || true; sleep 0.3; rm -f /tmp/btctl.calls /tmp/lecup.calls /tmp/connected /tmp/awake /tmp/keeper.log; : > /tmp/bus; }
start() { sh $KEEPER > /tmp/keeper.log 2>&1 & KP=$!; sleep 1; }
connects() { grep -c ' connect ' /tmp/btctl.calls 2>/dev/null || true; }
KP=''

# 1. the keyboard wakes while the keeper waits: the adapter's Powered event connects it at once,
#    long before the 8 s timer
reset
PATH=/fake:$PATH start
grep -q 'listening for BlueZ events' /tmp/keeper.log || fail "event reader started"
n=$(connects)
touch /tmp/awake
echo "Adapter1 Powered true" >> /tmp/bus
sleep 3 # the start-up sweep (a failing 2 s connect) finishes first
[ -e /tmp/connected ] || fail "connected within ~2 s of the event, not the 16 s timer"
[ "$(connects)" -gt "$n" ] || fail "a connect followed the event"
grep -q 'adapter powered on' /tmp/keeper.log || fail "event logged"
pass "Powered event: reconnect at once"

# 2. a dropped link sweeps at once; the Connected event resets the backoff and is logged
rm /tmp/connected
n=$(connects)
echo "Device1 Connected false" >> /tmp/bus
sleep 2 # the fake bus (tail -f) polls once a second
[ "$(connects)" -gt "$n" ] || fail "a connect followed the disconnect"
echo "Device1 Connected true" >> /tmp/bus
sleep 2
grep -q 'dev_AA_BB_CC_DD_EE_FF connected' /tmp/keeper.log || fail "Connected event logged"
[ ! -e /tmp/lecup.calls ] || fail "no fast link unless asked"
pass "Connected events: sweep on drop, log on connect"

# 3. KEYBOARD_FAST_LINK=1: every connect asks for the short interval, by the connection's handle
reset
KEYBOARD_FAST_LINK=1 PATH=/fake:$PATH start
echo "Device1 Connected true" >> /tmp/bus
sleep 3 # after the start-up sweep
grep -qx 'lecup 128 6 12 30 210' /tmp/lecup.calls || fail "lecup with handle 128, 7.5-15 ms, latency 30, 2.1 s"
pass "fast link on connect (opt-in)"

# 4. no dbus-monitor: polls with the old backoff, and still reconnects
reset
KEEPER_WAIT=1 KEEPER_WAIT_MAX=2 PATH=/nodbus start
grep -q 'dbus-monitor missing' /tmp/keeper.log || fail "fallback announced"
sleep 5
[ "$(connects)" -ge 2 ] || fail "polled again on the timer"
touch /tmp/awake
sleep 6
[ -e /tmp/connected ] || fail "polling reconnects"
pass "fallback: polling with backoff"

# 5. the event reader dies with the keeper (on the tablet systemd also kills the whole unit)
reset
KEEPER_WAIT=1 KEEPER_WAIT_MAX=1 PATH=/fake:$PATH start
kill $KP
sleep 4 # BusyBox `read -t` runs the TERM trap when it returns (the timer: 1 s here)
! kill -0 "$(cat /tmp/mon.pid)" 2>/dev/null || fail "dbus-monitor left behind"
KP=''
pass "event reader cleaned up"
echo "all keeper tests passed"
