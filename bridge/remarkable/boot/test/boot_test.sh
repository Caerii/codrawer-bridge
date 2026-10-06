#!/bin/sh
# Tests boot.sh's release logic in a container (alpine) with a fake systemctl. Run:
#   bridge/remarkable/boot/test/run.sh
# Needs: /work/bridge (linux/amd64 bridge binary), /work/tool (linux codrawer-release), /work/boot.
set -eu
fail() { echo "FAIL: $*"; exit 1; }
pass() { echo "ok - $*"; }

# fake systemctl: unit state lives in /tmp/units/<name>; a release whose binary prints "bad"
# never becomes active (simulates a crash loop).
# codrawer-xovi.service runs its ExecStart synchronously (a oneshot: `start` is a no-op once it
# ran). xochitl.service is modelled in /tmp/x: state, pid, nrestarts (systemd's automatic
# restarts); /tmp/fproc stands in for /proc (mounts, <pid>/maps). A restart with XOVI's drop-in
# mounted maps xovi.so into the new pid; with /tmp/crashy present it also "crashes" once:
# systemd restarts it by itself (nrestarts+1, a new pid).
mkdir -p /usr/local/bin /tmp/units /run/systemd/system
cat > /usr/local/bin/systemctl <<'EOF'
#!/bin/sh
while [ "${1#-}" != "$1" ]; do shift; done # drop flags like --no-block, -q
cmd=$1; shift
xochitl_restart() {
  pid=$(($(cat /tmp/x/pid) + 1))
  if grep -q ' /etc/systemd/system/xochitl.service.d ' /tmp/fproc/mounts 2>/dev/null && [ -e /tmp/crashy ]; then
    echo $(($(cat /tmp/x/nrestarts) + 1)) > /tmp/x/nrestarts
    pid=$((pid + 1))
  fi
  echo $pid > /tmp/x/pid
  mkdir -p /tmp/fproc/$pid
  if grep -q ' /etc/systemd/system/xochitl.service.d ' /tmp/fproc/mounts 2>/dev/null; then
    echo "7f00 r-xp /home/root/xovi/xovi.so" > /tmp/fproc/$pid/maps
  else
    echo "7f00 r-xp /usr/lib/libc.so.6" > /tmp/fproc/$pid/maps
  fi
  echo active > /tmp/x/state
  echo $(($(cat /tmp/x/starts) + 1)) > /tmp/x/starts
}
case "$cmd" in
  daemon-reload|reset-failed) ;;
  show)
    [ "$1" = -p ] && shift
    prop=$1
    case "$prop" in
      ActiveState) echo "ActiveState=$(cat /tmp/x/state)" ;;
      NRestarts) echo "NRestarts=$(cat /tmp/x/nrestarts)" ;;
      MainPID) echo "MainPID=$(cat /tmp/x/pid)" ;;
    esac ;;
  restart|start)
    for u in "$@"; do
      if [ "$u" = xochitl.service ]; then
        xochitl_restart
      elif [ "$u" = codrawer-xovi.service ]; then
        [ "$cmd" = start ] && [ "$(cat /tmp/units/$u 2>/dev/null)" = active ] && continue
        echo active > "/tmp/units/$u"
        run=$(sed -n 's/^ExecStart=//p' /run/systemd/system/$u)
        sh -c "$run" >> /tmp/xovi.log 2>&1
      elif [ "$u" = codrawer-bridge.service ] && grep -q CODRAWER_TEST_BROKEN /home/root/codrawer/current/codrawer_bridge_native 2>/dev/null; then
        echo failed > "/tmp/units/$u"
      else
        echo active > "/tmp/units/$u"
      fi
    done ;;
  stop) for u in "$@"; do echo inactive > "/tmp/units/$u"; done ;;
  is-active)
    quiet=0
    for u in "$@"; do [ "$u" = -q ] && quiet=1; done
    for u in "$@"; do
      [ "$u" = -q ] && continue
      s=$(cat "/tmp/units/$u" 2>/dev/null || echo inactive)
      [ $quiet = 1 ] || echo "$s"
      [ "$s" = active ]
    done ;;
esac
EOF
chmod +x /usr/local/bin/systemctl
# no sleeping in tests
cat > /usr/local/bin/sleep <<'EOF'
#!/bin/sh
exit 0
EOF
chmod +x /usr/local/bin/sleep

R=/home/root/codrawer
mkdir -p $R/releases
printf 'VERSION_ID=6.0.105\nIMG_VERSION="3.29.0.149"\n' > /etc/os-release
/work/tool keygen /tmp/key /tmp/pub
cp /tmp/pub $R/release.pub
printf 'SERVE_ADDR=\n' > $R/bridge.env

# xochitl at "boot": active, pid 100, no automatic restarts, stock (no drop-in mounted)
xochitl_boot() {
  rm -rf /tmp/x /tmp/fproc
  mkdir -p /tmp/x /tmp/fproc/100
  echo active > /tmp/x/state; echo 100 > /tmp/x/pid; echo 0 > /tmp/x/nrestarts; echo 0 > /tmp/x/starts
  : > /tmp/fproc/mounts
  echo "7f00 r-xp /usr/lib/libc.so.6" > /tmp/fproc/100/maps
}
xochitl_boot
export CODRAWER_TEST_PROC=/tmp/fproc

mkrel() { # mkrel <version> [bad|xovi]
  d=$R/releases/$1
  mkdir -p "$d/units"
  cp /work/boot/boot.sh /work/boot/install.sh /work/boot/bt-up.sh /work/boot/keyboard-keeper.sh /work/boot/run-bridge.sh \
    /work/boot/xovi.sh /work/boot/xovi-compat.conf \
    /work/boot/bridge.env.example /work/boot/compat.conf /work/boot/codrawer-boot.service "$d/"
  cp /work/boot/units/*.service "$d/units/"
  cp /work/bridge "$d/codrawer_bridge_native"
  if [ "${2:-}" = bad ]; then
    # a "bad" release: a script that is not the bridge (it still verifies: it is signed)
    printf '#!/bin/sh\necho CODRAWER_TEST_BROKEN\n' > "$d/codrawer_bridge_native"
  fi
  if [ "${2:-}" = xovi ]; then
    # the XOVI payload: stand-ins for xovi.so and the extension; start/stock do what xovi's do
    # (mount or unmount the drop-in, restart xochitl), against the fake /proc and systemctl
    mkdir -p "$d/xovi"
    echo "xovi.so stand-in" > "$d/xovi/xovi.so"
    echo "codrawer-layer.so stand-in" > "$d/xovi/codrawer-layer.so"
    printf '#!/bin/sh\necho "tmpfs /etc/systemd/system/xochitl.service.d tmpfs rw 0 0" >> /tmp/fproc/mounts\nsystemctl restart xochitl.service\n' > "$d/xovi/start"
    printf '#!/bin/sh\nsed -i "/xochitl.service.d/d" /tmp/fproc/mounts\nsystemctl restart xochitl.service\n' > "$d/xovi/stock"
  fi
  # as on the tablet after scp from Windows: no executable bits anywhere
  chmod -x "$d/codrawer_bridge_native" "$d"/*.sh
  /work/tool seal "$d" "$1" /tmp/key
}

# 1. first release: no current yet → activate verifies with the new binary and starts it
mkrel v1
sh $R/releases/v1/boot.sh activate v1 > /tmp/out 2>&1 || { cat /tmp/out; fail "activate v1"; }
[ "$(readlink $R/current)" = $R/releases/v1 ] || fail "current is v1"
grep -q 'CODRAWER_OS_TESTED=1' /run/codrawer/env || fail "3.29.0.149 is tested"
[ -f /run/systemd/system/codrawer-bridge.service ] || fail "units copied into /run"
pass "first activation"

# 2. upgrade to v2 → previous is v1
mkrel v2
sh $R/releases/v2/boot.sh activate v2 > /tmp/out 2>&1 || { cat /tmp/out; fail "activate v2"; }
[ "$(readlink $R/current)" = $R/releases/v2 ] && [ "$(readlink $R/previous)" = $R/releases/v1 ] || fail "v2 current, v1 previous"
pass "upgrade keeps the previous release"

# 3. a tampered release is refused and nothing changes
mkrel v3
echo "rm -rf /" >> $R/releases/v3/boot.sh
if sh $R/releases/v2/boot.sh activate v3 > /tmp/out 2>&1; then fail "tampered v3 activated"; fi
grep -q 'failed verification' /tmp/out || { cat /tmp/out; fail "verification message"; }
[ "$(readlink $R/current)" = $R/releases/v2 ] || fail "still on v2"
pass "tampered release refused"

# 4. a signed but broken release rolls back by itself
mkrel v4 bad
if sh $R/releases/v4/boot.sh activate v4 > /tmp/out 2>&1; then cat /tmp/out; fail "broken v4 reported healthy"; fi
grep -q 'rolling back' /tmp/out || { cat /tmp/out; fail "rollback message"; }
[ "$(readlink $R/current)" = $R/releases/v2 ] || fail "rolled back to v2 (current=$(readlink $R/current))"
[ "$(cat /tmp/units/codrawer-bridge.service)" = active ] || fail "v2 running again"
pass "unhealthy release rolls back"

# 5. an OS update is detected at the next start, and gates fragile features
printf 'VERSION_ID=6.1.0\nIMG_VERSION="3.30.0.10"\n' > /etc/os-release
sh $R/current/boot.sh start > /dev/null
grep -q '^3.29.0.149 3.30.0.10 ' $R/state/os_changed || fail "os_changed recorded"
grep -q 'CODRAWER_OS_TESTED=0' /run/codrawer/env || fail "untested OS gated"
grep -q 'CODRAWER_OS_CHANGED=3.29.0.149' /run/codrawer/env || fail "previous OS exported"
sh $R/current/boot.sh ack-os
[ ! -f $R/state/os_changed ] || fail "ack-os clears it"
pass "OS update detected and gated"

# 6. kill switch
touch $R/DISABLED
echo inactive > /tmp/units/codrawer-bridge.service
sh $R/current/boot.sh start | grep -q disabled || fail "kill switch message"
[ "$(cat /tmp/units/codrawer-bridge.service)" = inactive ] || fail "kill switch keeps it stopped"
rm $R/DISABLED
pass "kill switch"

# 7. prune keeps current, previous and the three newest
for v in v5 v6 v7 v8; do mkrel $v; sh $R/releases/$v/boot.sh activate $v > /dev/null; done
n=$(ls $R/releases | wc -l)
[ "$n" -le 5 ] || fail "pruned to at most 5 (have $n: $(ls $R/releases | tr '\n' ' '))"
[ -d $R/releases/v8 ] && [ -d $R/releases/v7 ] || fail "kept current and previous"
pass "old releases pruned"

# 8. rollback to a release that was only ever installed by the first-install path (never activated)
mkrel v9
chmod -x $R/releases/v9/codrawer_bridge_native
ln -sfn $R/releases/v9 $R/previous
sh $R/current/boot.sh rollback > /tmp/out 2>&1 || { cat /tmp/out; fail "rollback to a never-activated release"; }
[ -x $R/releases/v9/codrawer_bridge_native ] || fail "start made the binary executable"
sh $R/current/boot.sh rollback > /dev/null 2>&1 || fail "roll forward again"
pass "rollback works without executable bits"

# 9. engine switch: run-bridge.sh starts the chosen binary, falls back to go
d=$R/current
printf '#!/bin/sh
echo GO "$@"
' > /tmp/go.sh
cp $d/codrawer_bridge_native /tmp/real_go
cp /tmp/go.sh $d/codrawer_bridge_native; chmod +x $d/codrawer_bridge_native
out=$(ENGINE= sh $d/run-bridge.sh -x)
echo "$out" | grep -q '^GO -x$' || fail "default engine is go ($out)"
out=$(ENGINE=rust sh $d/run-bridge.sh)
echo "$out" | grep -q 'missing; using go' || fail "rust without its binary falls back ($out)"
printf '#!/bin/sh
echo RUST "$@"
' > $d/codrawer_bridge_rs; chmod +x $d/codrawer_bridge_rs
out=$(ENGINE=rust sh $d/run-bridge.sh -x)
echo "$out" | grep -q '^RUST -x$' || fail "ENGINE=rust runs the rust binary ($out)"
rm $d/codrawer_bridge_rs; cp /tmp/real_go $d/codrawer_bridge_native
pass "engine switch"

# 10. doctor reports
sh $R/current/boot.sh doctor > /tmp/out
grep -q '^release=v8$' /tmp/out && grep -q '^previous=v9$' /tmp/out && grep -q '^healthy=1$' /tmp/out || { cat /tmp/out; fail "doctor"; }
pass "doctor"

# ── XOVI at boot (xovi.sh) ──────────────────────────────────────────────────────────────────
# boot_now: a fresh boot as far as codrawer can tell: xochitl stock at pid 100, codrawer's units
# down, the codrawer-xovi oneshot not yet run; then the stub's `boot.sh start`.
boot_now() {
  xochitl_boot
  for u in codrawer-bridge.service codrawer-bluetooth.service codrawer-xovi.service; do echo inactive > /tmp/units/$u; done
  : > /tmp/xovi.log
  sh $R/current/boot.sh start > /tmp/out 2>&1 || { cat /tmp/out; fail "boot.sh start"; }
  [ "$(cat /tmp/units/codrawer-bridge.service)" = active ] || fail "the bridge starts regardless of XOVI ($1)"
}
xovi_running() { grep -q 'xochitl.service.d' /tmp/fproc/mounts && grep -q xovi.so /tmp/fproc/$(cat /tmp/x/pid)/maps; }
X=/home/root/xovi
printf 'VERSION_ID=6.0.105\nIMG_VERSION="3.29.0.149"\n' > /etc/os-release
mkrel vx xovi
sh $R/releases/vx/boot.sh activate vx > /tmp/out 2>&1 || { cat /tmp/out; fail "activate vx (with the xovi payload)"; }

# 11. tested OS: installed in xovi's layout, started once, healthy after the watch
boot_now "tested OS"
xovi_running || { cat /tmp/xovi.log; fail "XOVI started on a tested OS"; }
[ "$(cat /tmp/x/starts)" = 1 ] || fail "exactly one xochitl restart (starts=$(cat /tmp/x/starts))"
[ -f $X/xovi.so ] && [ -f $X/extensions.d/codrawer-layer.so ] && [ -L $X/services/xochitl.service/extensions.d ] &&
  [ -d $X/scripts/pre-start ] || fail "payload installed in xovi's layout"
[ ! -e $R/state/xovi_pending ] || fail "pending marker cleared after a healthy watch"
grep -q '^running (healthy' $R/state/xovi_status || fail "status says healthy ($(cat $R/state/xovi_status))"
sh $R/current/boot.sh doctor | grep -q '^xovi=running$' || { sh $R/current/boot.sh doctor; fail "doctor: xovi=running"; }
pass "XOVI starts on a tested OS"

# 12. a later start in the same boot (activate, rollback) never restarts xochitl again
sh $R/current/boot.sh start > /dev/null
echo inactive > /tmp/units/codrawer-xovi.service # and even if the unit runs again: adopts it
sh $R/current/boot.sh start > /dev/null
[ "$(cat /tmp/x/starts)" = 1 ] && xovi_running || fail "no second xochitl restart (starts=$(cat /tmp/x/starts))"
pass "XOVI is started once per boot"

# 13. untested OS: stays stock
printf 'VERSION_ID=6.1.0\nIMG_VERSION="3.30.0.10"\n' > /etc/os-release
boot_now "untested OS"
! xovi_running && [ "$(cat /tmp/x/starts)" = 0 ] || fail "untested OS skipped"
sh $R/current/boot.sh doctor | grep -q '^xovi=untested OS 3.30.0.10$' || fail "doctor: untested OS"
printf 'VERSION_ID=6.0.105\nIMG_VERSION="3.29.0.149"\n' > /etc/os-release
pass "XOVI skipped on an untested OS"

# 14. kill switch: stays stock
echo "test" > $R/XOVI_DISABLED
boot_now "kill switch"
! xovi_running && [ "$(cat /tmp/x/starts)" = 0 ] || fail "kill switch skipped"
sh $R/current/boot.sh doctor | grep -q '^xovi=disabled (test)$' || fail "doctor: disabled with reason"
rm $R/XOVI_DISABLED
pass "XOVI kill switch"

# 15. xochitl crashes after the start: back to stock at once, disabled with the reason
touch /tmp/crashy
boot_now "crash"
rm /tmp/crashy
! xovi_running || fail "back to stock after the crash"
grep -q 'restarted by systemd' $R/XOVI_DISABLED || fail "kill switch written with the reason ($(cat $R/XOVI_DISABLED 2>&1))"
[ ! -e $R/state/xovi_pending ] || fail "a verdict clears the pending marker"
[ "$(cat /tmp/x/state)" = active ] || fail "xochitl active (stock)"
# starts: XOVI's restart, the stock restart (the crash restart is systemd's own)
[ "$(cat /tmp/x/starts)" = 2 ] || fail "one restart to stock (starts=$(cat /tmp/x/starts))"
sh $R/current/boot.sh doctor | grep -q '^xovi=disabled (xochitl restarted by systemd' || fail "doctor: disabled after a crash"
boot_now "after a crash" # and the next boot stays stock
! xovi_running && [ "$(cat /tmp/x/starts)" = 0 ] || fail "stays stock at the next boot"
rm $R/XOVI_DISABLED
pass "crash after start: stock + disabled"

# 16. the previous boot's attempt never reached a verdict: skipped and disabled
echo "OS 3.29.0.149, release vx, earlier" > $R/state/xovi_pending
boot_now "previous boot unhealthy"
! xovi_running && [ "$(cat /tmp/x/starts)" = 0 ] || fail "previous unfinished attempt skipped"
grep -q 'previous attempt ended during its check' $R/XOVI_DISABLED || fail "disabled with the reason"
rm $R/XOVI_DISABLED
pass "previous boot unhealthy: skipped"

# 17. a release without the payload: stays stock
mv $R/current/xovi /tmp/xovi-payload
boot_now "payload missing"
! xovi_running && [ "$(cat /tmp/x/starts)" = 0 ] || fail "payload missing skipped"
sh $R/current/boot.sh doctor | grep -q '^xovi=payload missing$' || fail "doctor: payload missing"
mv /tmp/xovi-payload $R/current/xovi
pass "payload missing: skipped"

# 18. xovi off / on
boot_now "before off/on"
xovi_running || fail "running before off"
sh $R/current/boot.sh xovi off > /dev/null
! xovi_running && grep -q 'off by the user' $R/XOVI_DISABLED || fail "xovi off: stock + kill switch"
sh $R/current/boot.sh xovi on > /dev/null
[ ! -e $R/XOVI_DISABLED ] && xovi_running || { cat /tmp/xovi.log; fail "xovi on: kill switch gone, started"; }
pass "boot.sh xovi off|on"

# 19. the release with the payload still verifies (MANIFEST covers xovi/)
/work/tool verify $R/releases/vx /tmp/pub > /dev/null || fail "payload is covered by the signed manifest"
grep -q '  xovi/codrawer-layer.so$' $R/releases/vx/MANIFEST || fail "MANIFEST lists xovi/codrawer-layer.so"
pass "payload signed"
echo "all boot.sh tests passed"
