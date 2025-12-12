# Native Paper Pro bridge (no Python)

This builds a single binary that runs on the Paper Pro **without Python** and streams strokes to the desktop server over WebSocket.

## Build (desktop)

From repo root (Linux/ARM64 target for Paper Pro):

```bash
cd bridge/remarkable/native
GOOS=linux GOARCH=arm64 go build -o codrawer_bridge_native .
```

## Deploy (Paper Pro)

```bash
scp bridge/remarkable/native/codrawer_bridge_native root@<PAPER_PRO_IP>:/home/root/codrawer_bridge_native.new
ssh root@<PAPER_PRO_IP> "chmod +x /home/root/codrawer_bridge_native.new && mv -f /home/root/codrawer_bridge_native.new /home/root/codrawer_bridge_native"
```

Run (keep local ink):

```bash
ssh root@<PAPER_PRO_IP> "NO_GRAB=1 /home/root/codrawer_bridge_native -ws ws://<DESKTOP_IP>:8000/ws/session1 -touch-mode auto"
```

## Flags / env vars

All flags have equivalent env vars (env is the default, flags override).

- **WebSocket**
  - `-ws` / `DESKTOP_WS`: e.g. `ws://192.168.50.2:8000/ws/session1`
  - `-ping-seconds` / `PING_SECONDS` (default: `2`)
  - `-pong-timeout-seconds` / `PONG_TIMEOUT_SECONDS` (default: `8`)

- **Input**
  - `-input` / `INPUT_DEVICE`: explicit device path (e.g. `/dev/input/event2`)
  - `-list-devices`: print `/proc/bus/input/devices` names + handlers and exit
  - `-probe-seconds` / `PROBE_SECONDS`: auto-detect probe window per device
  - `-no-grab` / `NO_GRAB` (default: `true`): keep local ink while streaming

- **Contact detection**
  - `-touch-mode` / `TOUCH_MODE`: `auto|btn|pressure|distance|tool`
  - `-pressure-threshold` / `PRESSURE_THRESHOLD` (default: `0.02`)
  - `-distance-threshold` / `DISTANCE_THRESHOLD` (default: `0`)

- **Stroke emission**
  - `-batch-hz` / `BATCH_HZ` (default: `60`)
  - `-max-batch` / `MAX_BATCH_POINTS` (default: `64`)
  - `-brush` / `BRUSH` (default: `pen`) — eraser tool is emitted as `brush="eraser"`

- **Debugging**
  - `-debug` / `DEBUG`
  - `-dump-events` / `DUMP_EVENTS` (very noisy)
