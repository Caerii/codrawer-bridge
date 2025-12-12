# Architecture

`codrawer-bridge` is infra-first: it routes stroke events and returns AI “ghost ink” as vector strokes. Rendering is client-side.

## Components

### Paper Pro (bridge daemon)

- Reads Linux input events (`/dev/input/event*`) via `evdev`
- Detects pen contact + samples `ABS_X`, `ABS_Y`, `ABS_PRESSURE`
- Normalizes to `[0,1]` and emits:
  - `stroke_begin`
  - `stroke_pts` (batched)
  - `stroke_end`

### Desktop (FastAPI + WebSocket router)

- Accepts WebSocket connections at `/ws/{session_id}`
- Broadcasts inbound `stroke_*` and `cursor` messages to other clients in the session
- Enqueues **only** `stroke_end` for AI work

### AI worker loop

- Per-session background task
- Debounces to batch micro-pauses
- Enforces rate limits (~50 RPM model caps)
- Emits AI strokes on a separate layer:
  - `ai_stroke_begin`
  - `ai_stroke_pts`
  - `ai_stroke_end`

## What this repo deliberately does NOT do

- **No rendering on server**: the server never draws; it only routes events.
- **No continuous per-point model calls**: AI triggers on `stroke_end` (micro-pauses later).
- **No overwriting user ink**: AI is always `layer="ai"`.

## Future extensions

- Multi-user sessions and presence
- Output rendering on-device (push AI strokes back to the Paper Pro)
- Robust record/replay and dataset tooling
- Real model integration (replace stub in `src/codrawer_bridge/server/ai_worker.py`)


