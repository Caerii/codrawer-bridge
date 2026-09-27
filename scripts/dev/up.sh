#!/usr/bin/env bash
# Bring the desktop half of the codrawer loop up, idempotently (Windows / Git Bash).
#   scripts/dev/up.sh            # even-terminal + router + glasses app + simulator
#   scripts/dev/up.sh --no-sim   # skip the simulator
#   scripts/dev/up.sh --tablet   # also (re)start the bridge + keyboard keeper on the Paper Pro
# Every parameter has an env override; defaults match docs/even-g2-testing.md.
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ROOT_WIN="$(cygpath -w "$ROOT" 2>/dev/null | sed 's#\\#/#g' || echo "$ROOT")"
LAN_IP="${CODRAWER_LAN_IP:-192.168.50.2}"
TERM_PORT="${CODRAWER_TERM_PORT:-3456}"
TERM_TOKEN="${CODRAWER_TERM_TOKEN:-sig-glasses}"
ROUTER_PORT="${CODRAWER_ROUTER_PORT:-8577}"
APP_PORT="${CODRAWER_APP_PORT:-5188}"
SIM_PORT="${CODRAWER_SIM_PORT:-9898}"
TABLET="${CODRAWER_TABLET:-192.168.50.156}"
LOGS="${CODRAWER_LOGS:-$ROOT/.codrawer/logs}"
mkdir -p "$LOGS"
WANT_SIM=1; WANT_TABLET=0
for a in "$@"; do case "$a" in --no-sim) WANT_SIM=0;; --tablet) WANT_TABLET=1;; esac; done

listening() { netstat -ano 2>/dev/null | grep -q -E ":$1 .*LISTEN"; }
wait_http() { for _ in $(seq 1 "$2"); do curl -s -m 2 -o /dev/null "$1" && return 0; sleep 1; done; return 1; }

echo "[up] repo: $ROOT_WIN"

# 1. even-terminal
if listening "$TERM_PORT"; then echo "[up] even-terminal already on :$TERM_PORT"; else
  (cd "$ROOT" && even-terminal start --token "$TERM_TOKEN" --provider claude --cwd "$ROOT_WIN" -p "$TERM_PORT" --log-file "$LOGS/even-terminal.log" > "$LOGS/even-terminal.out" 2>&1 &)
  wait_http "http://127.0.0.1:$TERM_PORT/" 20 && echo "[up] even-terminal started on :$TERM_PORT" || echo "[up] WARN even-terminal not answering yet"
fi

# 2. router
if listening "$ROUTER_PORT"; then echo "[up] router already on :$ROUTER_PORT (restart it yourself if the code changed)"; else
  (cd "$ROOT" && CODRAWER_TERM_URL="http://127.0.0.1:$TERM_PORT" CODRAWER_TERM_TOKEN="$TERM_TOKEN" CODRAWER_TERM_CWD="$ROOT_WIN" \
    CODRAWER_MODEL_SERVER_URL="${CODRAWER_MODEL_SERVER_URL:-}" CODRAWER_AI_AUTO_ENABLED="${CODRAWER_AI_AUTO_ENABLED:-0}" CODRAWER_AGENTIC_ENABLED="${CODRAWER_AGENTIC_ENABLED:-0}" \
    uv run uvicorn codrawer_bridge.server.app:app --host 0.0.0.0 --port "$ROUTER_PORT" > "$LOGS/router.log" 2>&1 &)
  wait_http "http://127.0.0.1:$ROUTER_PORT/healthz" 30 && echo "[up] router started on :$ROUTER_PORT" || echo "[up] WARN router not healthy; see $LOGS/router.log"
fi

# 3. glasses app
if listening "$APP_PORT"; then echo "[up] app already on :$APP_PORT"; else
  (cd "$ROOT/apps/even-g2" && VITE_HMR_HOST="$LAN_IP" pnpm dev > "$LOGS/vite.log" 2>&1 &)
  wait_http "http://127.0.0.1:$APP_PORT/" 40 && echo "[up] app started on :$APP_PORT (phone: http://$LAN_IP:$APP_PORT)" || echo "[up] WARN app not answering; see $LOGS/vite.log"
fi

# 4. simulator (own session)
if [ "$WANT_SIM" = 1 ]; then
  if curl -s -m 2 "http://127.0.0.1:$SIM_PORT/api/ping" 2>/dev/null | grep -q pong; then echo "[up] simulator already up (automation :$SIM_PORT)"; else
    (evenhub-simulator --automation-port "$SIM_PORT" "http://localhost:$APP_PORT/?ws=ws://localhost:$ROUTER_PORT/ws/simtest" > "$LOGS/sim.log" 2>&1 &)
    for _ in $(seq 1 25); do sleep 1; curl -s -m 2 "http://127.0.0.1:$SIM_PORT/api/ping" 2>/dev/null | grep -q pong && break; done
    echo "[up] simulator on session simtest (automation :$SIM_PORT)"
  fi
fi

# 5. tablet (optional; it must be awake)
if [ "$WANT_TABLET" = 1 ]; then
  if timeout 8 ssh -o BatchMode=yes -o ConnectTimeout=5 "root@$TABLET" "true" 2>/dev/null; then
    timeout 40 ssh -o BatchMode=yes "root@$TABLET" "killall codrawer_bridge_native 2>/dev/null; sleep 1; \
      (NO_GRAB=1 nohup /home/root/codrawer_bridge_native -ws ws://$LAN_IP:$ROUTER_PORT/ws/session1 -input /dev/input/event2 -touch-mode auto -keyboard auto -type-replies > /tmp/codrawer_bridge.log 2>&1 &); \
      n=\$(ps | grep keyboard-keeper.sh | grep -v grep | wc -l); [ \"\$n\" = 0 ] && (nohup sh /home/root/keyboard-keeper.sh > /dev/null 2>&1 &); sleep 4; tail -n 3 /tmp/codrawer_bridge.log"
    echo "[up] tablet bridge restarted"
  else
    echo "[up] tablet $TABLET unreachable (asleep?) — wake it and rerun with --tablet"
  fi
fi

echo "[up] QR for the phone: evenhub qr --url http://$LAN_IP:$APP_PORT"
