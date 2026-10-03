#!/usr/bin/env bash
# Keep codrawer installed on the tablet across reMarkable OS updates (run on the desktop).
#   scripts/dev/tablet-guard.sh          # check every 60 s, repair when needed (Ctrl+C to stop)
#   scripts/dev/tablet-guard.sh --once   # one check
# An OS update swaps the tablet's root partition and drops codrawer's boot stub; everything else
# lives in /home and survives. When the tablet is reachable and the stub is missing, this re-adds
# it with install.sh (the same repair as `vellum reenable` or the phone repair key) and logs it.
set -uo pipefail
TABLET="${CODRAWER_TABLET:-192.168.50.156}"
SSH=(ssh -o BatchMode=yes -o ConnectTimeout=5 "root@$TABLET")
check() {
  local status
  status=$(timeout 20 "${SSH[@]}" "sh /home/root/codrawer/current/install.sh --status" 2>/dev/null) && return 0
  [ -z "$status" ] && return 0 # unreachable (asleep) or no release yet: nothing to do now
  echo "[guard] $(date '+%F %T') tablet needs repair:"
  echo "$status" | sed 's/^/[guard]   /'
  timeout 120 "${SSH[@]}" "sh /home/root/codrawer/current/install.sh --if-needed" | sed 's/^/[guard]   /'
}
if [ "${1:-}" = --once ]; then check; exit; fi
echo "[guard] watching $TABLET every 60 s"
while true; do
  check
  sleep 60
done
