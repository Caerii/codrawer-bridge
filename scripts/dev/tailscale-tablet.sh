#!/usr/bin/env bash
# Install or update Tailscale on the Paper Pro, start it, and print the login link if it needs one.
#   scripts/dev/tailscale-tablet.sh              # latest stable arm64 build
#   scripts/dev/tailscale-tablet.sh 1.102.5      # a given version
#   CODRAWER_TS_HOSTNAME=codrawer-tablet scripts/dev/tailscale-tablet.sh   # another node name
#
# What it does, in order:
#   1. downloads Tailscale's official static arm64 tarball from pkgs.tailscale.com/stable and
#      checks it against the .sha256 Tailscale publishes next to it (cached in ~/.codrawer/tailscale);
#   2. uploads tailscale and tailscaled to /home/root/codrawer/tailscale/bin on the tablet (outside
#      releases/: about 70 MB, kept once, and /home survives OS updates), writes VERSION there;
#   3. starts codrawer-tailscale through the current release (`boot.sh tailscale on`), which runs
#      tailscaled in userspace-networking mode (bridge/remarkable/boot/tailscale.sh);
#   4. if the node is not logged in yet, runs `tailscale up --hostname=… --accept-dns=false` in the
#      background on the tablet (output in /tmp/codrawer-tailscale-up.log) and prints the login
#      link: open it and sign in to your own tailnet. The login is kept in the state directory.
# Not enabled: Tailscale SSH, exit node, subnet routes; MagicDNS on the tablet (it needs none).
# The release on the tablet must carry tailscale.sh (scripts/dev/deploy-tablet.sh after 2026-10-06).
set -euo pipefail
TABLET="${CODRAWER_TABLET:-192.168.50.156}"
NAME="${CODRAWER_TS_HOSTNAME:-remarkable}"
CACHE="${CODRAWER_KEYDIR:-$HOME/.codrawer}/tailscale"
SSH=(ssh -o BatchMode=yes -o ConnectTimeout=8 "root@$TABLET")
T=/home/root/codrawer/tailscale
SOCK=/run/codrawer/tailscaled.sock

VER="${1:-}"
if [ -z "$VER" ]; then
  VER=$(curl -fsSL "https://pkgs.tailscale.com/stable/?mode=json" | sed -n 's/.*"TarballsVersion": *"\([^"]*\)".*/\1/p' | head -n 1)
  [ -n "$VER" ] || { echo "[tailscale] could not read the latest version from pkgs.tailscale.com"; exit 1; }
fi
TGZ="tailscale_${VER}_arm64.tgz"
mkdir -p "$CACHE"
cd "$CACHE"
if [ ! -d "tailscale_${VER}_arm64" ]; then
  echo "[tailscale] downloading $TGZ"
  curl -fsSLO "https://pkgs.tailscale.com/stable/$TGZ"
  curl -fsSL "https://pkgs.tailscale.com/stable/$TGZ.sha256" -o "$TGZ.sha256"
  want=$(tr -d ' \r\n' < "$TGZ.sha256")
  have=$(sha256sum "$TGZ" | cut -d' ' -f1)
  [ "$want" = "$have" ] || { echo "[tailscale] sha256 mismatch: published $want, got $have"; rm -f "$TGZ"; exit 1; }
  echo "[tailscale] sha256 ok ($have)"
  tar xzf "$TGZ"
fi
D="$CACHE/tailscale_${VER}_arm64"

echo -n "[tailscale] waiting for $TABLET (wake the tablet if this hangs)"
for _ in $(seq 1 40); do
  if timeout 10 "${SSH[@]}" true 2> /dev/null; then echo " up"; break; fi
  echo -n "."
  sleep 3
done
timeout 20 "${SSH[@]}" 'echo "codrawer-tailscale 300000000000" > /sys/power/wake_lock' 2> /dev/null || true
timeout 20 "${SSH[@]}" "[ -f /home/root/codrawer/current/tailscale.sh ]" ||
  { echo "[tailscale] the tablet's release has no tailscale.sh: run scripts/dev/deploy-tablet.sh first"; exit 1; }

if [ "$(timeout 20 "${SSH[@]}" "cat $T/VERSION 2> /dev/null" || true)" != "$VER" ]; then
  echo "[tailscale] uploading $VER"
  timeout 30 "${SSH[@]}" "mkdir -p $T/bin $T/state"
  timeout 300 scp -q "$D/tailscale" "root@$TABLET:$T/bin/tailscale.new"
  timeout 300 scp -q "$D/tailscaled" "root@$TABLET:$T/bin/tailscaled.new"
  # rename over the old files (a running tailscaled keeps its own inode), then restart onto the new
  timeout 60 "${SSH[@]}" "cd $T/bin && chmod 755 tailscale.new tailscaled.new && mv -f tailscale.new tailscale &&
    mv -f tailscaled.new tailscaled && echo $VER > $T/VERSION &&
    { systemctl is-active -q codrawer-tailscale.service && systemctl restart codrawer-tailscale.service || true; }"
else
  echo "[tailscale] $VER already installed"
fi

timeout 30 "${SSH[@]}" "sh /home/root/codrawer/current/boot.sh tailscale on > /dev/null; sleep 4;
  sh /home/root/codrawer/current/tailscale.sh status"
if timeout 30 "${SSH[@]}" "sh /home/root/codrawer/current/tailscale.sh status" | grep -q '^tailscale=up'; then
  echo "[tailscale] logged in; the router is at ws://<tailnet address>:8577/ws/session1 (scripts/dev/qr.sh --tailnet)"
  exit 0
fi
echo "[tailscale] starting the login as $NAME"
timeout 30 "${SSH[@]}" "nohup $T/bin/tailscale --socket=$SOCK up --hostname=$NAME --accept-dns=false \
  > /tmp/codrawer-tailscale-up.log 2>&1 < /dev/null & sleep 8; grep -o 'https://login.tailscale.com/[^ ]*' /tmp/codrawer-tailscale-up.log | head -n 1" |
  sed 's/^/[tailscale] open this link and sign in to your tailnet: /'
