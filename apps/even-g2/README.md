# codrawer on the Even Realities G2

Even Hub web app that mirrors a live codrawer-bridge session on the glasses: the ink is
rasterized into a 288×144 image container (the SDK's maximum) and the agent's stated
intent (`ai_intent.plan`) plus connection state go into a text container underneath.

Verified in the Even Hub simulator on 2026-09-26 (SDK 0.0.16, simulator 0.9.5).

## Run

```bash
# 1. router (port 8000 is often taken on dev machines; 8577 is the convention here)
uv run uvicorn codrawer_bridge.server.app:app --host 0.0.0.0 --port 8577

# 2. ink: a Paper Pro, the iPad app, or a looped recording
uv run python -m codrawer_bridge.tools.stroke_sim.replay_jsonl \
  --ws ws://127.0.0.1:8577/ws/session1 --in <recording>.jsonl \
  --speed 1.5 --max-gap-ms 400 --only-t-prefix stroke_

# 3. this app (port 5188; 5173 is usually held by another Vite)
cd apps/even-g2 && pnpm install && pnpm dev

# 4. simulator with the automation API
evenhub-simulator --automation-port 9898 http://localhost:5188
```

Config via query string once, then remembered in localStorage: `?ws=ws://<host>:8577/ws/session1`,
`?mode=follow|full`, `?highlight=all|user|ai`, `?window=0.22`.

## Editor

`/edit` (or the menu's *Edit document*) opens a full-screen editor: a real buffer with a cursor
that the view follows, wrapped at the same width as the transcript. Plain keys edit; Enter
continues markdown list prefixes; arrows, Home/End, PageUp/Down, Delete, Tab; Ctrl+Left/Right by
word; Ctrl+Home/End to the ends. `Ctrl+K` opens the command line over the document (any command,
then back), `Ctrl+S` saves and shares it with the session (`doc` message), `Ctrl+E` leaves.
A ring click in the editor saves; the ring scrolls by line. The document autosaves 2 s after
the last edit to the WebView's storage and the Even bridge's storage, and is shared with the
session so the terminal agent can Read it (`.codrawer/doc.md`); a `/term` sent from the editor
tells the agent to read it first.

## Latency model and tunables

Bytes per image update are the latency budget on real glasses. Live ink therefore goes
through a small **loupe** container that follows the pen; the big **canvas** container is
refreshed only at `stroke_end` (or every `canvas_ms` during a long stroke). Frames are
latest-wins per container, throttled by the measured round trip, and image data crosses the
WebView bridge as base64 (2x faster than the SDK's default number array even in the simulator).

| Query param | Default | Effect |
| --- | --- | --- |
| `img=WxH` | `288x144` | canvas container size (max 288x144) |
| `loupe=WxH` / `loupe=0` | `128x64` | loupe size, or disable it |
| `fmt=gray4` | `gray8` | packed 4-bit pixels, half the bytes |
| `enc=array` | `b64` | revert to number[] marshaling |
| `frame_ms` / `canvas_ms` | `60` / `1200` | per-container push floors |
| `ai=0` | `1` | start with the AI ghost layer hidden |
| `binarize=0` | `1` | keep antialiased grey (compresses worse) |
| `bench=1` | | on-device benchmark: rebuilds the page per config and reports min/median ms in the HUD and console; `bench=0` returns |

The HUD status line shows `L<ms>/<count> · C<ms>/<count>`: round trip and pushes per container.

## Input

Contextual menu (long-press / context gesture): Toggle AI ghost · Follow / fit page ·
Cycle emphasis · Zoom in · Zoom out. The AI toggle persists.


## Keyboard (bridged from the tablet)

A keyboard bonded to the Paper Pro arrives as `key` messages (see `docs/protocol.md`). The app
keeps a transcript in the text container: the current line shows with a cursor while you type,
Enter commits it, Backspace/Escape edit, ArrowUp/Down (or the ring in text view) scroll back.
A leading slash makes a command:

| Command | Effect |
| --- | --- |
| `/hw <text>` | AI handwrites `<text>` on the canvas (`prompt`, mode handwriting) |
| `/draw <text>` | AI draws `<text>` (`prompt`, mode draw) |
| `/new` | new drawing for every client |
| `/ai` | toggle the AI ghost layer |
| `/text` | toggle the full-screen text view (8 transcript lines; one rebuild) |
| `/clear` | clear the transcript (also Ctrl+L) |
| `/term <text>` | one instruction to the even-terminal session (router bridge) |
| `/mode term` / `/mode ink` | plain lines go to the terminal / stay local |

Typing `/` shows a completion popup; ArrowUp/Down highlight, Tab or ArrowRight completes,
Enter on a single match completes too. A pending terminal permission (`y / a / n`) or question
takes the next whole line. Rows are filled from the bottom with our own conservative wrapping
so the input line is always the last visible row.

Text updates follow keystrokes at a 150 ms floor while typing, then fall back to the quiet
2 s cadence so they never compete with ink. `?view=text` starts in the text view.

| Gesture | Effect |
| --- | --- |
| click | toggle follow (crop around the pen) / full page |
| double click | cycle emphasis: all → user → ai |
| scroll up / down | zoom the follow window in / out |

## What the SDK actually does (learned in the simulator)

- Build container and update objects with the SDK classes (`new ImageContainerProperty({...})`,
  `new ImageRawDataUpdate({...})`, …); plain object literals fail the type check.
- `createStartUpPageContainer` returns `invalid` (1) if a page already exists, which is what
  happens on every HMR reload. Fall back to `rebuildPageContainer` with the same containers.
- Raw Gray8 (one byte per pixel, width × height) is accepted by `updateImageRawData`; the
  simulator renders it directly. Never overlap two image updates: chain them.
- Click arrives as a `sysEvent` **without** `eventType` (protobuf omits 0 = CLICK);
  double-click as `sysEvent.eventType = 3`; scroll up/down arrive as a `textEvent` on the
  event-capture container with `eventType` 1 / 2.
- Exactly one container carries `isEventCapture: 1`; if any container sets `zOrderIndex`,
  all must.
- The simulator's `/api/console` fills with one "Flutter Bridge intercepted" line per
  update; poll with `?since_id=` and filter for your own prefix.

## Automation

```bash
curl http://127.0.0.1:9898/api/screenshot/glasses -o shot.png
curl -X POST http://127.0.0.1:9898/api/input -H 'Content-Type: application/json' -d '{"action":"click"}'
curl 'http://127.0.0.1:9898/api/console?since_id=0'
```

## Device

Two ways onto the glasses:

- **Package** — `pnpm ehpk` builds `codrawer.ehpk`; drag it onto the Even Hub developer portal
  ("Drag and drop .ehpk file to create a project") to install it as a prototype app. The package has
  no dev server to share a host with, so the router address is baked in at build time:
  `ws://192.168.50.2:8577/ws/session1` by default, or `VITE_CODRAWER_WS=ws://<ip>:8577/ws/<session> pnpm ehpk`.
  Its origin must be in `app.json`'s network whitelist. `edition` in `app.json` is the manifest
  schema (`202601`), not a date: `evenhub pack` rejects anything else.
- **Sideload** — `VITE_HMR_HOST=<lan-ip> pnpm dev`, then `evenhub qr --url http://<lan-ip>:5188`;
  the router is assumed on the same host as the dev server.
See `docs/even-g2-testing.md`.
