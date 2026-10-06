# Native Paper Pro bridge (no Python)

This builds a single binary that runs on the Paper Pro **without Python** and streams strokes to the desktop server over WebSocket.

## Reading order

The code is written to be read top to bottom: every file opens with what it is for and the
facts it rests on. Start with `main.go`'s overview (the data-flow diagram), then:

| Step | Where | What you learn |
| --- | --- | --- |
| 1 | `main.go`, `config.go` | the modes, every flag and env var with its unit and default |
| 2 | `bridge.go` | how the sources are wired, and the reconnecting connection loop |
| 3 | `pen_stream.go` → `pen/` | pen device → `pen.Machine` → outbox; why the machine lives for the whole process; stroke batching, hover, wire units |
| 4 | `linux_input.go`, `device_select.go` | evdev records and ioctls; finding the pen (and why bridge.env names `event2`) |
| 5 | `keyboard.go` | a paired keyboard → `key` messages |
| 6 | `typer.go`, `uinput.go` | `term` replies typed into the tablet through a virtual keyboard |
| 7 | `page_watch.go` → `pagewatch/` → `rmlines/` | the saved page as the source of truth: which page is open, the `page` message, then the `.rm` v6 parser (`rmlines.go` model → `reader.go` → `parse.go` → `tree.go` → `tools.go`) |
| 8 | `ws_client.go` | the keepalive that notices a dead link even while the pen is idle |
| 9 | `serve.go` → `router/` | the session router on the tablet (`router.go` → `conn.go` → `dispatch.go` → `session.go` → `replay.go` → `docsync.go` → `client.go`) |
| 10 | `release_cmd.go`, `release/`, `cmd/codrawer-release/` | signed releases; then `../boot/boot.sh` for how they are switched on the tablet |

## Tests

```bash
cd bridge/remarkable/native
go test -count=1 ./router/ ./pen/ ./release/ ./rmlines/ ./pagewatch/   # any OS
GOOS=linux GOARCH=arm64 go vet ./... && GOOS=linux GOARCH=arm64 go build -o /dev/null .
# the main package builds only for Linux; from Windows run its tests in a container:
GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go test -c -o main.test . && \
  MSYS_NO_PATHCONV=1 docker run --rm -v "$(pwd -W 2>/dev/null || pwd):/w" alpine:3.20 /w/main.test
bash ../boot/test/run.sh                                               # boot.sh, in Docker
```

## Router on the tablet (`-serve`)

`-serve :8577` also runs the stroke router (`router/`) in the same process, so the glasses app
connects to the tablet directly and the desktop is not needed for streaming. The bridge then
streams into it over loopback (`-ws ws://127.0.0.1:8577/ws/session1`); the boot service does this
by default (`../boot/bridge.env.example`). It relays `stroke_*`, `key`, `cursor`, `clear`, `doc`,
replays the current page to a client that joins mid-drawing, and gives each client its own bounded
queue (a stalled phone is dropped and reconnects, instead of slowing the tablet). AI and `/term`
stay on the desktop Python router. `-router-only` runs just the router (e.g. on a desktop).
Tests run anywhere: `go test ./router/`.

## Page watcher (the tablet's saved page)

The bridge reads xochitl's saved pages (read-only) and sends the open page as a `page` message
(`docs/protocol.md`) on each save (~6–10 s after a pause) and page turn: exact tool, colour,
per-point width, erases and undos. `rmlines/` parses `.rm` v6 files; `pagewatch/` finds the open
page and builds the message. It is on when boot.sh marks the OS tested (`CODRAWER_OS_TESTED=1`);
`PAGE_WATCH=on|off` (`-page-watch`) overrides, `XOCHITL_DIR` (`-xochitl-dir`) and
`PAGE_POLL_MS` tune it. The watcher sleeps on inotify and looks only when xochitl writes;
`PAGE_POLL_MS` paces retries (a file mid-write) and the fallback when inotify is unavailable
(docs/investigations/idle-cost.md). `codrawer_bridge_native -page-dump` prints the open page's
message once and exits. Tests run anywhere: `go test ./rmlines/ ./pagewatch/`.

## The toolbar eraser (`TOOL_FILE`)

evdev shows the pen's eraser end (brush `eraser`), but not the Eraser picked in xochitl's
toolbar and used with the tip. When the codrawer-layer XOVI extension runs inside xochitl
(`../xovi/codrawer-layer`, tethered), it writes the selected tool to `/run/codrawer/tool`. The pen
machine checks it at each pen-down: while it says `eraser`, a tip stroke goes out as
`"brush":"eraser","tool":"eraser"` and every client cuts ink with it. A missing file, or one
older than 3 s, changes nothing. `TOOL_FILE` (`-tool-file`) moves it; `off` disables it. Tests:
`go test ./pen/ ./toolhint/`.

## Build (desktop)

From repo root (Linux/ARM64 target for Paper Pro):

```bash
cd bridge/remarkable/native
GOOS=linux GOARCH=arm64 go build -o codrawer_bridge_native .
```

Release builds (`scripts/dev/deploy-tablet.sh`) add `-ldflags="-s -w"` to strip the symbol table
and DWARF (8.9 MB → 6.1 MB on arm64).

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
  - `-ws` / `DESKTOP_WS`: e.g. `ws://<lan-ip>:8577/ws/session1`
  - `-ping-seconds` / `PING_SECONDS` (default: `10`)
  - `-pong-timeout-seconds` / `PONG_TIMEOUT_SECONDS` (default: `25`)

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

- **Keyboard** (a Bluetooth/USB keyboard bonded to the tablet; see `docs/remarkable_bluetooth.md`)
  - `-keyboard` / `KEYBOARD_DEVICE`: `auto` (default; a device with a `kbd` handler that is not the power key), `off`, or `/dev/input/eventN`
  - `-keyboard-grab` / `KEYBOARD_GRAB` (default `false`): make the bridge the only consumer; by default the tablet UI keeps receiving keys
  - emits `key` messages (browser-style names, US-layout `char`, modifiers); reopens the node when the keyboard sleeps

- **Typing replies into the tablet** (virtual keyboard via `/dev/uinput`)
  - `-type-replies` / `TYPE_REPLIES` (default `true`): `term` replies from the router are typed into whatever text field the tablet has focused
  - `-type-char-ms` / `TYPE_CHAR_MS` (default `12`): pacing between keystrokes
  - registers as `codrawer virtual keyboard`; the prompt echo is skipped, notes/permissions get their own line

- **Debugging**
  - `-debug` / `DEBUG`
  - `-dump-events` / `DUMP_EVENTS` (very noisy)
