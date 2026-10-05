#!/usr/bin/env bash
# Build the glasses app as an Even Hub package (apps/even-g2/codrawer.ehpk) for this tablet.
#
# The Even app enforces the package's network whitelist (apps/even-g2/manifest.mjs), so a package
# can only reach the routers it was built for. This builds one that starts on the tablet's router
# and may also be pointed at this PC's desktop router. The pairing code is asked for once on the
# phone and remembered (it is never baked into a package).
#   scripts/dev/pack.sh                      # CODRAWER_TABLET / CODRAWER_LAN_IP or the defaults
set -euo pipefail
TABLET="${CODRAWER_TABLET:-192.168.50.156}"   # the maintainer's tablet; set CODRAWER_TABLET for yours
LAN_IP="${CODRAWER_LAN_IP:-192.168.50.2}"     # this PC (desktop router), likewise
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE/../../apps/even-g2"
CODRAWER_WS="ws://$TABLET:8577/ws/session1" CODRAWER_WHITELIST="ws://$LAN_IP:8577" pnpm ehpk
echo "[pack] $(pwd)/codrawer.ehpk → drag into the Even Hub"
