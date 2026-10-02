#!/bin/sh
# Tests boot.sh's release logic in a container (alpine) with a fake systemctl. Run:
#   bridge/remarkable/boot/test/run.sh
# Needs: /work/bridge (linux/amd64 bridge binary), /work/tool (linux codrawer-release), /work/boot.
set -eu
fail() { echo "FAIL: $*"; exit 1; }
pass() { echo "ok - $*"; }

# fake systemctl: unit state lives in /tmp/units/<name>; a release whose binary prints "bad"
# never becomes active (simulates a crash loop)
mkdir -p /usr/local/bin /tmp/units /run/systemd/system
cat > /usr/local/bin/systemctl <<'EOF'
#!/bin/sh
while [ "${1#-}" != "$1" ]; do shift; done # drop flags like --no-block, -q
cmd=$1; shift
case "$cmd" in
  daemon-reload) ;;
  restart|start)
    for u in "$@"; do
      if [ "$u" = codrawer-bridge.service ] && grep -q CODRAWER_TEST_BROKEN /home/root/codrawer/current/codrawer_bridge_native 2>/dev/null; then
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

mkrel() { # mkrel <version> <bad?>
  d=$R/releases/$1
  mkdir -p "$d/units"
  cp /work/boot/boot.sh /work/boot/install.sh /work/boot/bt-up.sh /work/boot/keyboard-keeper.sh \
    /work/boot/bridge.env.example /work/boot/compat.conf /work/boot/codrawer-boot.service "$d/"
  cp /work/boot/units/*.service "$d/units/"
  cp /work/bridge "$d/codrawer_bridge_native"
  if [ "${2:-}" = bad ]; then
    # a "bad" release: a script that is not the bridge (it still verifies: it is signed)
    printf '#!/bin/sh\necho CODRAWER_TEST_BROKEN\n' > "$d/codrawer_bridge_native"
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

# 9. doctor reports
sh $R/current/boot.sh doctor > /tmp/out
grep -q '^release=v8$' /tmp/out && grep -q '^previous=v9$' /tmp/out && grep -q '^healthy=1$' /tmp/out || { cat /tmp/out; fail "doctor"; }
pass "doctor"
echo "all boot.sh tests passed"
