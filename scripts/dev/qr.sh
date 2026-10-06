#!/usr/bin/env bash
# Open a QR code for the phone that loads the glasses app pointed at the tablet's router, with the
# tablet's pairing code included (scan from Even app → Even Hub → developer → Scan QR).
#   scripts/dev/qr.sh            # dev server on this PC (live reload)
#   scripts/dev/qr.sh --probe    # same, running the one-shot link probe
#   scripts/dev/qr.sh --tailnet  # over Tailscale: the router at the tablet's tailnet address and
#                                # the dev server at this PC's, so it works away from the home Wi-Fi
#                                # (both phone and PC on the same tailnet; boot.sh doctor shows the
#                                # tablet's tailscale= line)
set -euo pipefail
# CODRAWER_TABLET: the tablet's Wi-Fi address. The default is the maintainer's LAN; set yours.
TABLET="${CODRAWER_TABLET:-192.168.50.156}"
# CODRAWER_LAN_IP: this PC's LAN address (the phone loads the app from it). Maintainer's default.
LAN_IP="${CODRAWER_LAN_IP:-192.168.50.2}"
APP_PORT="${CODRAWER_APP_PORT:-5188}"
SSH_HOST="$TABLET" # the pairing code is read over the LAN: SSH is not reachable over the tailnet
PROBE=0
for a in "$@"; do
  case "$a" in
    --probe) PROBE=1 ;;
    --tailnet)
      # the tablet's tailnet address (maintainer's default) and this PC's, from its Tailscale CLI
      TABLET="${CODRAWER_TAILNET:-100.98.14.46}"
      TS_CLI=$(command -v tailscale || echo "/c/Program Files/Tailscale/tailscale.exe")
      LAN_IP=$("$TS_CLI" ip -4 2> /dev/null | tr -d '\r' | head -n 1) ||
        { echo "this PC is not on a tailnet (tailscale ip -4 failed)"; exit 1; }
      [ -n "$LAN_IP" ] || { echo "this PC is not on a tailnet (tailscale ip -4 failed)"; exit 1; }
      ;;
    *) echo "usage: qr.sh [--probe] [--tailnet]" >&2; exit 2 ;;
  esac
done
# the pairing code; when the tablet is not reachable on the LAN the URL has none, and the app asks
# for it once (and remembers it)
TOKEN=$(timeout 20 ssh -o BatchMode=yes -o ConnectTimeout=5 "root@$SSH_HOST" "sed -n 's/^ROUTER_TOKEN=//p' /home/root/codrawer/bridge.env" 2>/dev/null || true)
URL="http://$LAN_IP:$APP_PORT/?ws=ws://$TABLET:8577/ws/session1&view=canvas"
[ -n "$TOKEN" ] && URL="$URL&token=$TOKEN"
[ "$PROBE" = 1 ] && URL="$URL&probe=1"
OUT="$(mktemp -d)/codrawer-qr.png"
uv run --quiet --with "qrcode[pil]" python -c "import qrcode,sys; qrcode.make(sys.argv[1], box_size=12, border=4).save(sys.argv[2])" "$URL" "$(cygpath -w "$OUT" 2>/dev/null || echo "$OUT")"
echo "$URL" | sed -E 's/token=[^&]+/token=…/'
echo "QR: $OUT"
command -v cmd.exe > /dev/null && cmd.exe //c start "" "$(cygpath -w "$OUT")" || true
