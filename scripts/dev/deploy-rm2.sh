#!/usr/bin/env bash
# Build and run the standalone rM2 pen bridge without the Paper Pro boot/XOVI stack.
# The transient service survives SSH disconnects, but stops at reboot.
# Requires Go >=1.22, SSH key access, and openssl on the build machine.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TABLET="${CODRAWER_TABLET:?Set CODRAWER_TABLET to your reMarkable 2 address}"
GO="${CODRAWER_GO:-go}"
SSH=(ssh -o BatchMode=yes -o ConnectTimeout=8 "root@$TABLET")
arch=$("${SSH[@]}" uname -m)
model=$("${SSH[@]}" cat /sys/devices/soc0/machine)
if [[ "$arch" != armv7l || "$model" != 'reMarkable 2.0' ]]; then
  echo "Expected reMarkable 2.0 / armv7l; got $model / $arch" >&2
  exit 1
fi
mkdir -p "$ROOT/.codrawer"
(cd "$ROOT/bridge/remarkable/native" && CGO_ENABLED=0 GOOS=linux GOARCH=arm GOARM=7 "$GO" build -trimpath -ldflags='-s -w' -o "$ROOT/.codrawer/codrawer_bridge_rm2" .)
# Preserve the pairing code and any calibrated settings on subsequent deployments.
if ! "${SSH[@]}" test -f /home/root/codrawer-rm2.env; then
  envfile=$(mktemp)
  trap 'rm -f "$envfile"' EXIT
  chmod 600 "$envfile"
  code=$(openssl rand -hex 8)
  sed "s/ROUTER_TOKEN=CHANGE_ME/ROUTER_TOKEN=$code/" "$ROOT/bridge/remarkable/rm2.env.example" > "$envfile"
  scp "$envfile" "root@$TABLET:/home/root/codrawer-rm2.env"
fi
scp "$ROOT/.codrawer/codrawer_bridge_rm2" "root@$TABLET:/home/root/codrawer_bridge_rm2.new"
"${SSH[@]}" sh -s <<'REMOTE'
set -eu
chmod 600 /home/root/codrawer-rm2.env
chmod 755 /home/root/codrawer_bridge_rm2.new
systemctl stop codrawer-rm2.service 2>/dev/null || true
mv /home/root/codrawer_bridge_rm2.new /home/root/codrawer_bridge_rm2
systemctl reset-failed codrawer-rm2.service 2>/dev/null || true
if [ -f /etc/systemd/system/codrawer-rm2.service ]; then
  systemctl start codrawer-rm2.service
else
  systemd-run --unit=codrawer-rm2 --property=EnvironmentFile=/home/root/codrawer-rm2.env /home/root/codrawer_bridge_rm2
fi
REMOTE
printf 'Bridge started. Check: ssh root@%s journalctl -u codrawer-rm2 -n 20 --no-pager\n' "$TABLET"
