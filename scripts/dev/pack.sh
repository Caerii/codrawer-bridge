#!/usr/bin/env bash
# Build the glasses app as an Even Hub package (apps/even-g2/codrawer.ehpk) for this tablet.
#
# The Even app enforces the package's network whitelist (apps/even-g2/manifest.mjs), so a package
# can only reach the routers it was built for. This builds one that starts on the tablet's router
# and may also be pointed at this PC's desktop router, and at the tablet over Tailscale (its
# tailnet address and MagicDNS name: the router is reachable there from anywhere, see
# docs/what-codrawer-changes.md "Tailscale"). The pairing code is asked for once on the phone and
# remembered (it is never baked into a package).
#   scripts/dev/pack.sh                      # CODRAWER_TABLET / CODRAWER_LAN_IP / CODRAWER_TAILNET*
#   CODRAWER_TAILNET= CODRAWER_TAILNET_NAME= scripts/dev/pack.sh   # without the tailnet origins
set -euo pipefail
TABLET="${CODRAWER_TABLET:-192.168.50.156}"   # the maintainer's tablet; set CODRAWER_TABLET for yours
LAN_IP="${CODRAWER_LAN_IP:-192.168.50.2}"     # this PC (desktop router), likewise
# The tablet on the maintainer's tailnet (boot.sh doctor prints tailscale=up <ip> <name>); set yours.
TAILNET="${CODRAWER_TAILNET-100.98.14.46}"
TAILNET_NAME="${CODRAWER_TAILNET_NAME-remarkable.tailf05963.ts.net}"
WHITELIST="ws://$LAN_IP:8577"
[ -n "$TAILNET" ] && WHITELIST="$WHITELIST,ws://$TAILNET:8577"
[ -n "$TAILNET_NAME" ] && WHITELIST="$WHITELIST,ws://$TAILNET_NAME:8577"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE/../../apps/even-g2"
CODRAWER_WS="ws://$TABLET:8577/ws/session1" CODRAWER_WHITELIST="$WHITELIST" pnpm ehpk
echo "[pack] $(pwd)/codrawer.ehpk → drag into the Even Hub"
