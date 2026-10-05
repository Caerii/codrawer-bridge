#!/usr/bin/env bash
# Compare the two bridge engines (Go and Rust) on the Paper Pro: memory, CPU and battery drain
# under the same synthetic load, so the default engine is chosen on data.
#
#   scripts/dev/engine-bench.sh            # 90 s per engine, idle then load
#   SECS=120 scripts/dev/engine-bench.sh
#
# For each engine: switch ENGINE in bridge.env, restart the bridge, let it settle, then sample on
# the tablet every 2 s — the bridge's resident memory (VmRSS), its CPU time (utime+stime ticks from
# /proc/<pid>/stat) and the battery's current and voltage (/sys/class/power_supply). The first half
# is idle; in the second half this PC streams synthetic strokes into the tablet's router (as a
# participant, with the pairing code), which exercises the router's fan-out and replay paths. The
# pen reader itself sees no input either way, so this measures the engines' baseline and router
# cost, not handwriting. Battery readings include the screen and Wi-Fi, so compare engines run
# back to back, with the screen left alone; the tablet is held awake for the whole run.
# Afterwards the engine that was active before the run is restored.
set -euo pipefail
# CODRAWER_TABLET: the tablet's Wi-Fi address. The default is the maintainer's LAN; set yours.
TABLET="${CODRAWER_TABLET:-192.168.50.156}"
SECS="${SECS:-90}"
SSH=(ssh -o BatchMode=yes -o ConnectTimeout=8 "root@$TABLET")
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$HERE/../../.codrawer/engine-bench-$(date +%Y%m%d-%H%M%S).txt"
mkdir -p "$(dirname "$OUT")"

# The sampler runs on the tablet: one line per sample, "rss_kb cpu_ticks current_uA voltage_uV".
SAMPLER='
P=$(pidof codrawer_bridge_native codrawer_bridge_rs | cut -d" " -f1)
BAT=$(ls -d /sys/class/power_supply/*/ 2>/dev/null | while read d; do [ -e "$d/current_now" ] && echo "$d" && break; done)
end=$(( $(date +%s) + DUR ))
while [ "$(date +%s)" -lt "$end" ]; do
  rss=$(sed -n "s/^VmRSS:[^0-9]*\([0-9]*\).*/\1/p" /proc/$P/status)
  cpu=$(awk "{print \$14 + \$15}" /proc/$P/stat)
  cur=$(cat "$BAT/current_now" 2>/dev/null || echo 0)
  vol=$(cat "$BAT/voltage_now" 2>/dev/null || echo 0)
  echo "$rss $cpu $cur $vol"
  sleep 2
done'

load() { # synthetic strokes into the tablet's router for $1 seconds, as a participant
  local token
  token=$("${SSH[@]}" "sed -n 's/^ROUTER_TOKEN=//p' /home/root/codrawer/bridge.env")
  uv run --quiet --with websockets python - "$TABLET" "$token" "$1" <<'PY'
import asyncio, json, math, sys, time, websockets
tablet, token, secs = sys.argv[1], sys.argv[2], float(sys.argv[3])
async def main():
    url = f"ws://{tablet}:8577/ws/session1?token={token}"
    async with websockets.connect(url) as ws:
        await ws.recv()
        end, k = time.time() + secs, 0
        while time.time() < end:
            sid = f"p_bench_{k}"; k += 1
            await ws.send(json.dumps({"t": "stroke_begin", "id": sid, "layer": "peer", "color": "#888888", "ts": int(time.time() * 1000)}))
            for i in range(60):  # ~1 s stroke, 60 batches of 2 points
                a = i / 60 * 6.28
                pts = [[round(0.5 + 0.1 * math.cos(a + j * 0.01), 4), round(0.5 + 0.1 * math.sin(a), 4), 0.5, int(time.time() * 1000)] for j in range(2)]
                await ws.send(json.dumps({"t": "stroke_pts", "id": sid, "pts": pts}))
                await asyncio.sleep(1 / 60)
            await ws.send(json.dumps({"t": "stroke_end", "id": sid}))
        await ws.send(json.dumps({"t": "clear"}))  # leave the page as it was
asyncio.run(main())
PY
}

# CPU: /proc/<pid>/stat counts in clock ticks (CLK_TCK = 100 on this kernel), so ticks per second
# equals percent of one core.
summarize() { # stdin: samples → "rss avg, cpu % of one core, power mW"
  awk -v secs="$1" '
    NR == 1 { cpu0 = $2 }
    { rss += $1; n++; cpu1 = $2; p += ($3 * $4) / 1e9 }   # µA × µV = pW → mW
    END { if (n) printf "rss %.0f kB | cpu %.2f %% | power %.0f mW (n=%d)\n", rss / n, (cpu1 - cpu0) / (secs) , p / n, n }'
}

prev=$("${SSH[@]}" "sed -n 's/^ENGINE=//p' /home/root/codrawer/bridge.env | tail -n 1")
prev=${prev:-go}
"${SSH[@]}" "echo 'codrawer-bench $(( (SECS * 2 + 60) * 2 ))000000000' > /sys/power/wake_lock"
{
  echo "engine bench $(date) — tablet $TABLET, ${SECS}s idle + ${SECS}s load per engine"
  for engine in go rust; do
    "${SSH[@]}" "grep -q '^ENGINE=' /home/root/codrawer/bridge.env || echo ENGINE=go >> /home/root/codrawer/bridge.env
      sed -i 's/^ENGINE=.*/ENGINE=$engine/' /home/root/codrawer/bridge.env
      systemctl restart codrawer-bridge; sleep 8; journalctl -u codrawer-bridge -n 20 --no-pager | grep '\[engine\]' | tail -n 1"
    idle=$("${SSH[@]}" "DUR=$SECS; $SAMPLER")
    echo "$engine idle : $(echo "$idle" | summarize "$SECS")"
    load "$SECS" &
    busy=$("${SSH[@]}" "DUR=$SECS; $SAMPLER")
    wait
    echo "$engine load : $(echo "$busy" | summarize "$SECS")"
  done
} | tee "$OUT"
"${SSH[@]}" "sed -i 's/^ENGINE=.*/ENGINE=$prev/' /home/root/codrawer/bridge.env; systemctl restart codrawer-bridge; echo codrawer-bench > /sys/power/wake_unlock"
echo "restored ENGINE=$prev · results: $OUT"
