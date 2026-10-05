#!/usr/bin/env bash
# Create an SSH key that can do exactly one thing on the tablet: run codrawer's repair
# (install.sh --if-needed). Put the private key in a phone shortcut ("Run script over SSH" in
# iOS Shortcuts, or Termux) to restore codrawer after a reMarkable update with one tap, no
# computer. authorized_keys and SSH over Wi-Fi survive OS updates; the key cannot open a shell.
set -euo pipefail
TABLET="${CODRAWER_TABLET:-192.168.50.156}"
KEYDIR="${CODRAWER_KEYDIR:-$HOME/.codrawer}"
mkdir -p "$KEYDIR"
KEY="$KEYDIR/repair_ed25519"
[ -f "$KEY" ] || ssh-keygen -q -t ed25519 -N '' -C codrawer-repair -f "$KEY"
LINE="command=\"sh /home/root/codrawer/current/install.sh --if-needed\",restrict $(cat "$KEY.pub")"
ssh -o BatchMode=yes "root@$TABLET" "mkdir -p /home/root/.ssh && touch /home/root/.ssh/authorized_keys &&
  grep -q 'codrawer-repair' /home/root/.ssh/authorized_keys || echo '$LINE' >> /home/root/.ssh/authorized_keys"
echo "Repair key installed on $TABLET. Private key for the phone shortcut: $KEY"
echo "Test it: ssh -i $KEY root@$TABLET   (runs the repair and exits)"
