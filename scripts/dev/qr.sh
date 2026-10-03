#!/usr/bin/env bash
# Open a QR code for the phone that loads the glasses app pointed at the tablet's router, with the
# tablet's pairing code included (scan from Even app → Even Hub → developer → Scan QR).
#   scripts/dev/qr.sh            # dev server on this PC (live reload)
#   scripts/dev/qr.sh --probe    # same, running the one-shot link probe
set -euo pipefail
TABLET="${CODRAWER_TABLET:-192.168.50.156}"
LAN_IP="${CODRAWER_LAN_IP:-192.168.50.2}"
APP_PORT="${CODRAWER_APP_PORT:-5188}"
TOKEN=$(timeout 20 ssh -o BatchMode=yes -o ConnectTimeout=5 "root@$TABLET" "sed -n 's/^ROUTER_TOKEN=//p' /home/root/codrawer/bridge.env" 2>/dev/null || true)
URL="http://$LAN_IP:$APP_PORT/?ws=ws://$TABLET:8577/ws/session1&view=canvas"
[ -n "$TOKEN" ] && URL="$URL&token=$TOKEN"
[ "${1:-}" = --probe ] && URL="$URL&probe=1"
OUT="$(mktemp -d)/codrawer-qr.png"
uv run --quiet --with "qrcode[pil]" python -c "import qrcode,sys; qrcode.make(sys.argv[1], box_size=12, border=4).save(sys.argv[2])" "$URL" "$(cygpath -w "$OUT" 2>/dev/null || echo "$OUT")"
echo "$URL" | sed -E 's/token=[^&]+/token=…/'
echo "QR: $OUT"
command -v cmd.exe > /dev/null && cmd.exe //c start "" "$(cygpath -w "$OUT")" || true
