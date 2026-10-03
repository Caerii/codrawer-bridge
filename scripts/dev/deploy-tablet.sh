#!/usr/bin/env bash
# Build a signed codrawer release and deploy it to the Paper Pro (Windows / Git Bash).
#   scripts/dev/deploy-tablet.sh                           # build, sign, upload, activate
#   CODRAWER_TABLET_UPLINK=1 scripts/dev/deploy-tablet.sh  # bridge streams to the desktop router
#
# Layout on the tablet (docs/investigations/durable-install.md): /home/root/codrawer/
# releases/<version>/ (binary + boot files + MANIFEST + MANIFEST.sig), current, previous,
# bridge.env, release.pub. Activation verifies the signature with the binary already trusted,
# health-checks for 60 s and rolls back by itself. The only rootfs write is the stub unit, which
# install.sh re-adds when an OS update removed it — so this also repairs after an update.
# Signing key: ~/.codrawer/release.key (created on first run; keep it private).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TABLET="${CODRAWER_TABLET:-192.168.50.156}"
LAN_IP="${CODRAWER_LAN_IP:-192.168.50.2}"
KEYDIR="${CODRAWER_KEYDIR:-$HOME/.codrawer}"
SSH=(ssh -o BatchMode=yes -o ConnectTimeout=5 "root@$TABLET")
NATIVE="$ROOT/bridge/remarkable/native"
VERSION="$(date -u +%Y.%m.%d-%H%M)-$(git -C "$ROOT" rev-parse --short HEAD)$(git -C "$ROOT" diff --quiet || echo -dirty)"
STAGE="$ROOT/.codrawer/releases/$VERSION"

echo "[deploy] building release $VERSION"
mkdir -p "$KEYDIR" "$STAGE/units"
(cd "$NATIVE" && GOOS=linux GOARCH=arm64 go build -o "$STAGE/codrawer_bridge_native" .)
TOOL="$ROOT/.codrawer/codrawer-release.exe"
(cd "$NATIVE" && go build -o "$TOOL" ./cmd/codrawer-release)
B="$ROOT/bridge/remarkable/boot"
cp "$B"/boot.sh "$B"/install.sh "$B"/bt-up.sh "$B"/keyboard-keeper.sh "$B"/bridge.env.example \
  "$B"/compat.conf "$B"/codrawer-boot.service "$STAGE/"
cp "$B"/units/*.service "$STAGE/units/"
if [ ! -f "$KEYDIR/release.key" ]; then
  echo "[deploy] creating signing key $KEYDIR/release.key"
  "$TOOL" keygen "$KEYDIR/release.key" "$KEYDIR/release.pub"
fi
"$TOOL" seal "$STAGE" "$VERSION" "$KEYDIR/release.key"
"$TOOL" verify "$STAGE" "$KEYDIR/release.pub" > /dev/null

echo -n "[deploy] waiting for $TABLET (wake the tablet if this hangs)"
for _ in $(seq 1 60); do
  if timeout 8 "${SSH[@]}" true 2>/dev/null; then echo " up"; break; fi
  echo -n "."
  sleep 3
done
timeout 8 "${SSH[@]}" true || { echo; echo "[deploy] tablet unreachable"; exit 1; }

# keep the tablet awake for the whole deploy (it autosleeps within seconds and drops Wi-Fi)
timeout 20 "${SSH[@]}" 'echo "codrawer-deploy 300000000000" > /sys/power/wake_lock' 2>/dev/null || true
echo "[deploy] uploading"
timeout 60 "${SSH[@]}" "mkdir -p /home/root/codrawer/releases/$VERSION/units"
timeout 180 scp -q -r "$STAGE"/* "root@$TABLET:/home/root/codrawer/releases/$VERSION/"
# Trust on first use over SSH: the key that signs every later release.
timeout 30 "${SSH[@]}" "[ -f /home/root/codrawer/release.pub ]" ||
  timeout 30 scp -q "$KEYDIR/release.pub" "root@$TABLET:/home/root/codrawer/release.pub"

# Pairing code for clients off the tablet (the router's ROUTER_TOKEN): created once, kept after.
# Alphabet without look-alikes (no O/0, I/1/L) so it is easy to type on a phone.
# (in a subshell without pipefail: tr dies of SIGPIPE once head has its 8 characters)
CODE=$(set +o pipefail; LC_ALL=C tr -dc 'ABCDEFGHJKMNPQRSTUVWXYZ23456789' < /dev/urandom 2> /dev/null | head -c 8)
CODE="${CODE:0:4}-${CODE:4:4}"
if [ "${CODRAWER_TABLET_UPLINK:-0}" = 1 ]; then
  ENV_EDIT="sed -i -e 's#^DESKTOP_WS=.*#DESKTOP_WS=ws://$LAN_IP:8577/ws/session1#' -e 's#^SERVE_ADDR=#\#SERVE_ADDR=#' bridge.env"
else
  ENV_EDIT="sed -i -e 's#^DESKTOP_WS=.*#DESKTOP_WS=ws://127.0.0.1:8577/ws/session1#' -e 's#^\#SERVE_ADDR=#SERVE_ADDR=#' bridge.env; \
    grep -q '^SERVE_ADDR=' bridge.env || echo SERVE_ADDR=:8577 >> bridge.env; \
    grep -q '^ROUTER_TOKEN=' bridge.env || echo ROUTER_TOKEN=$CODE >> bridge.env"
fi

echo "[deploy] activating"
timeout 200 "${SSH[@]}" "set -e
  cd /home/root/codrawer
  R=releases/$VERSION
  chmod +x \$R/codrawer_bridge_native \$R/*.sh   # scp from Windows drops the executable bit
  [ -f bridge.env ] || cp \$R/bridge.env.example bridge.env
  $ENV_EDIT
  # leftovers of the flat layout (before releases/): scripts at the top level
  rm -f bt-up.sh keyboard-keeper.sh install.sh codrawer-bluetooth.service codrawer-bridge.service
  if [ -e current ]; then
    sh \$R/boot.sh activate $VERSION
  else
    echo '[deploy] first install of the release layout'
    ln -sfn /home/root/codrawer/\$R current
  fi
  # (re-)add the rootfs stub if an OS update removed it, migrate the pre-stub units, start
  sh current/install.sh --if-needed"

if grep -q '^SERVE_ADDR' <(timeout 20 "${SSH[@]}" cat /home/root/codrawer/bridge.env); then
  curl -s -m 5 "http://$TABLET:8577/healthz" | grep -q '"ok":true' &&
    echo "[deploy] router healthy at ws://$TABLET:8577/ws/session1 — pairing code: $(timeout 20 "${SSH[@]}" "sed -n 's/^ROUTER_TOKEN=//p' /home/root/codrawer/bridge.env") (scripts/dev/qr.sh makes a QR that carries it)" ||
    echo "[deploy] WARN router not answering on $TABLET:8577"
fi
