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
# CODRAWER_TABLET: the tablet's Wi-Fi address. The default is the maintainer's LAN; set yours.
TABLET="${CODRAWER_TABLET:-192.168.50.156}"
# CODRAWER_LAN_IP: this PC's LAN address (the phone loads the app from it). Maintainer's default.
LAN_IP="${CODRAWER_LAN_IP:-192.168.50.2}"
KEYDIR="${CODRAWER_KEYDIR:-$HOME/.codrawer}"
SSH=(ssh -o BatchMode=yes -o ConnectTimeout=5 "root@$TABLET")
NATIVE="$ROOT/bridge/remarkable/native"
# Seconds and a random suffix keep two deploys of the same commit in the same minute from writing
# into one release folder (it happened: two builds' binaries mixed, and `release verify` failed).
VERSION="$(date -u +%Y.%m.%d-%H%M%S)-$(git -C "$ROOT" rev-parse --short HEAD)$(git -C "$ROOT" diff --quiet || echo -dirty)-$(od -An -N2 -tx1 /dev/urandom | tr -d ' \n')"
STAGE="$ROOT/.codrawer/releases/$VERSION"

echo "[deploy] building release $VERSION"
mkdir -p "$KEYDIR" "$STAGE/units"
# -s -w: release builds are stripped (symbol table and DWARF); panics still print stack traces.
(cd "$NATIVE" && GOOS=linux GOARCH=arm64 go build -ldflags="-s -w" -o "$STAGE/codrawer_bridge_native" .)
# The Rust engine ships alongside (ENGINE=go|rust in bridge.env picks one at start).
# CODRAWER_SKIP_RUST=1 skips it; a failed Rust build only warns (Go stays the default engine).
if [ "${CODRAWER_SKIP_RUST:-0}" != 1 ] && command -v cargo > /dev/null; then
  echo "[deploy] building the rust engine (aarch64-unknown-linux-musl)"
  if (cd "$ROOT/bridge/remarkable/rust" && cargo build --quiet --release --target aarch64-unknown-linux-musl); then
    cp "$ROOT/bridge/remarkable/rust/target/aarch64-unknown-linux-musl/release/codrawer_bridge_rs" "$STAGE/"
  else
    echo "[deploy] WARN rust build failed; releasing the go engine only"
  fi
fi
TOOL="$ROOT/.codrawer/codrawer-release.exe"
(cd "$NATIVE" && go build -o "$TOOL" ./cmd/codrawer-release)
B="$ROOT/bridge/remarkable/boot"
cp "$B"/boot.sh "$B"/install.sh "$B"/bt-up.sh "$B"/keyboard-keeper.sh "$B"/run-bridge.sh "$B"/bridge.env.example \
  "$B"/compat.conf "$B"/codrawer-boot.service "$B"/xovi.sh "$B"/xovi-compat.conf "$B"/tailscale.sh "$STAGE/"
cp "$B"/units/*.service "$STAGE/units/"

# The XOVI payload (xovi/ in the release, signed with the rest): boot.sh's codrawer-xovi unit
# starts it after boot under xovi.sh's gates and crash guard (docs/what-codrawer-changes.md).
#   - xovi.so, start, stock: XOVI v0.3.3 from asivery/rm-xovi-extensions (release v19-23052026,
#     xovi-aarch64.tar.gz, sha256 32d64d1262ddc984e3235c7d0340a398fe6d5b3efa6a979865f5977b32630d27;
#     the pre-v20-08092026 tarball has the same three files), vendored in
#     bridge/remarkable/xovi/vendor (LGPL-3.0; its README). $CODRAWER_XOVI_DIR overrides the
#     directory; either way the files are checked against the pins below.
#   - codrawer-layer.so: built here from bridge/remarkable/xovi/codrawer-layer (Docker).
# All four or none: a release without the payload simply leaves the tablet stock (CODRAWER_SKIP_XOVI=1
# skips it on purpose).
XOVI_DIR="${CODRAWER_XOVI_DIR:-$ROOT/bridge/remarkable/xovi/vendor}"
XOVI_PINS="d4df820c25c634c511de11067279d8310fa4f656dc52bd4540db6beac4ffd446  xovi.so
bf15dfd641deea3e4487b9182957938a3dc824c340383c9243b7f118bfe829dc  start
e29494c9fff5ede390b06f1f5e27ca59e4f7bc81d25889822a123ccad1fd686d  stock"
if [ "${CODRAWER_SKIP_XOVI:-0}" = 1 ]; then
  echo "[deploy] CODRAWER_SKIP_XOVI=1: release without the XOVI payload"
elif ! (cd "$XOVI_DIR" 2> /dev/null && echo "$XOVI_PINS" | sha256sum -c --quiet > /dev/null 2>&1); then
  echo "[deploy] WARN $XOVI_DIR lacks the pinned xovi.so/start/stock; release without the XOVI payload"
elif ! command -v docker > /dev/null || ! "$ROOT/bridge/remarkable/xovi/codrawer-layer/build.sh" > /dev/null; then
  echo "[deploy] WARN codrawer-layer build failed (Docker?); release without the XOVI payload"
else
  mkdir -p "$STAGE/xovi"
  cp "$XOVI_DIR/xovi.so" "$XOVI_DIR/start" "$XOVI_DIR/stock" "$STAGE/xovi/"
  cp "$ROOT/bridge/remarkable/xovi/codrawer-layer/out/codrawer-layer.so" "$STAGE/xovi/"
  # the extension's own files: the injected dock, the live overlay, and which injections to make
  # (xovi.sh EXTRAS)
  cp "$ROOT/bridge/remarkable/xovi/codrawer-layer/qml/dock.qml" "$ROOT/bridge/remarkable/xovi/codrawer-layer/qml/selection-ask.qml" \
    "$ROOT/bridge/remarkable/xovi/codrawer-layer/qml/live.qml" \
    "$ROOT/bridge/remarkable/xovi/codrawer-layer/inject.conf" "$STAGE/xovi/"
  echo "[deploy] XOVI payload: codrawer-layer.so $(sha256sum "$STAGE/xovi/codrawer-layer.so" | cut -c1-12)…"
fi
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

# One deploy at a time, from any machine or agent: a lock directory on the tablet's /run (tmpfs,
# so a reboot clears it). mkdir is atomic. A lock older than 15 minutes is a crashed deploy and is
# taken over; otherwise wait up to 10 minutes for it.
LOCK=/run/codrawer/deploy.lock
LOCK_OWNER="$VERSION $(hostname) $$"
for i in $(seq 1 60); do
  got=$(timeout 15 "${SSH[@]}" "mkdir -p /run/codrawer; if mkdir $LOCK 2>/dev/null; then echo '$LOCK_OWNER' > $LOCK/owner; echo ok; else
    age=\$(( \$(date +%s) - \$(stat -c %Y $LOCK) )); if [ \$age -gt 900 ]; then echo '$LOCK_OWNER' > $LOCK/owner; touch $LOCK; echo stale; else cat $LOCK/owner; fi; fi" 2>/dev/null || echo unreachable)
  case "$got" in ok|stale) break ;; esac
  [ "$i" = 1 ] && echo "[deploy] waiting: another deploy holds the tablet ($got)"
  [ "$i" = 60 ] && { echo "[deploy] gave up waiting for the deploy lock ($got)"; exit 1; }
  sleep 10
done
# Release the lock on any exit, but only if it is still ours.
trap 'timeout 15 "${SSH[@]}" "grep -qx \"$LOCK_OWNER\" $LOCK/owner 2>/dev/null && rm -rf $LOCK" 2>/dev/null || true' EXIT

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
  [ -e \$R/codrawer_bridge_rs ] && chmod +x \$R/codrawer_bridge_rs
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
