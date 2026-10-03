#!/bin/sh
# Start the bridge engine chosen in /home/root/codrawer/bridge.env: ENGINE=go (default) or rust.
# Both binaries ship in every release; they take the same flags and environment, so switching is
#   sed -i 's/^ENGINE=.*/ENGINE=rust/' /home/root/codrawer/bridge.env && systemctl restart codrawer-bridge
# A release without the chosen binary falls back to Go (and says so in the journal).
DIR=$(cd "$(dirname "$0")" && pwd)
case "${ENGINE:-go}" in
  rust)
    if [ -x "$DIR/codrawer_bridge_rs" ]; then
      echo "[engine] rust"
      exec "$DIR/codrawer_bridge_rs" "$@"
    fi
    echo "[engine] rust requested but $DIR/codrawer_bridge_rs is missing; using go"
    ;;
esac
echo "[engine] go"
exec "$DIR/codrawer_bridge_native" "$@"
