#!/usr/bin/env bash
# Build the bridge and deploy it, with the boot files, to the Paper Pro (Windows / Git Bash).
#   scripts/dev/deploy-tablet.sh            # build + copy + restart + health check
#   CODRAWER_TABLET_UPLINK=1 scripts/dev/deploy-tablet.sh   # bridge streams to the desktop router
# Waits for the tablet to wake (it drops off Wi-Fi when it autosleeps). Re-installs the systemd
# units into the rootfs only when they changed (or after an OS update removed them).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TABLET="${CODRAWER_TABLET:-192.168.50.156}"
LAN_IP="${CODRAWER_LAN_IP:-192.168.50.2}"
SSH=(ssh -o BatchMode=yes -o ConnectTimeout=5 "root@$TABLET")

echo "[deploy] building bridge (linux/arm64)"
(cd "$ROOT/bridge/remarkable/native" && GOOS=linux GOARCH=arm64 go build -o codrawer_bridge_native .)

echo -n "[deploy] waiting for $TABLET (wake the tablet if this hangs)"
for _ in $(seq 1 60); do
  if timeout 8 "${SSH[@]}" true 2>/dev/null; then echo " up"; break; fi
  echo -n "."
  sleep 3
done
timeout 8 "${SSH[@]}" true || { echo; echo "[deploy] tablet unreachable"; exit 1; }

echo "[deploy] copying binary and boot files"
timeout 60 "${SSH[@]}" "mkdir -p /home/root/codrawer"
timeout 120 scp -q "$ROOT/bridge/remarkable/native/codrawer_bridge_native" "root@$TABLET:/home/root/codrawer_bridge_native.new"
timeout 60 scp -q "$ROOT"/bridge/remarkable/boot/* "root@$TABLET:/home/root/codrawer/"

if [ "${CODRAWER_TABLET_UPLINK:-0}" = 1 ]; then
  ENV_EDIT="sed -i -e 's#^DESKTOP_WS=.*#DESKTOP_WS=ws://$LAN_IP:8577/ws/session1#' -e 's#^SERVE_ADDR=#\#SERVE_ADDR=#' /home/root/codrawer/bridge.env"
else
  ENV_EDIT="sed -i -e 's#^DESKTOP_WS=.*#DESKTOP_WS=ws://127.0.0.1:8577/ws/session1#' -e 's#^\#SERVE_ADDR=#SERVE_ADDR=#' /home/root/codrawer/bridge.env; \
    grep -q '^SERVE_ADDR=' /home/root/codrawer/bridge.env || echo SERVE_ADDR=:8577 >> /home/root/codrawer/bridge.env"
fi

timeout 120 "${SSH[@]}" "set -e
  cd /home/root
  cp -f codrawer_bridge_native codrawer_bridge_native.prev 2>/dev/null || true
  chmod +x codrawer_bridge_native.new && mv -f codrawer_bridge_native.new codrawer_bridge_native
  [ -f codrawer/bridge.env ] || cp codrawer/bridge.env.example codrawer/bridge.env
  $ENV_EDIT
  changed=0
  for u in codrawer-bluetooth.service codrawer-bridge.service; do
    cmp -s codrawer/\$u /etc/systemd/system/\$u || changed=1
  done
  if [ \$changed = 1 ]; then echo '[deploy] units changed or missing: installing into rootfs'; sh codrawer/install.sh; fi
  systemctl restart codrawer-bluetooth codrawer-bridge
  sleep 4
  systemctl is-active codrawer-bluetooth codrawer-bridge
  journalctl -u codrawer-bridge -n 6 --no-pager"

if grep -q '^SERVE_ADDR' <(timeout 20 "${SSH[@]}" cat /home/root/codrawer/bridge.env); then
  curl -s -m 5 "http://$TABLET:8577/healthz" | grep -q '"ok":true' \
    && echo "[deploy] router healthy at ws://$TABLET:8577/ws/session1" \
    || echo "[deploy] WARN router not answering on $TABLET:8577 (firewall?)"
fi
echo "[deploy] previous binary kept as /home/root/codrawer_bridge_native.prev"
