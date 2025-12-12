# codrawer-bridge

Core infrastructure for a low-latency “co-drawer” system:

- **Paper Pro** streams stylus strokes (stroke-native input events)
- **Desktop server** routes those events over WebSocket and triggers an AI worker
- **AI** emits **ghost-layer vector strokes** (`layer="ai"`)
- **Clients render** and animate (server/bridge never render)

This repo is **infra-first** (not a product demo yet).

## Key rules (non-negotiable)

- **AI never overwrites user ink**: AI output is always separate `layer="ai"`.
- **No per-point model calls**: trigger AI only on `stroke_end` (micro-pauses later).
- **Server routes, clients render**: keep payloads incremental and small.
- **Rate limit**: design for **~50 RPM** model caps (throttle + debounce).

## Docs

- `docs/protocol.md` (canonical protocol)
- `docs/architecture.md`
- `docs/latency_budget.md`
- `docs/remarkable_setup.md` (connect + install on Paper Pro)

## Desktop setup (uv)

Requirements:

- Python 3.11+
- `uv`

Install and run:

```bash
uv sync
uv pip install -e .
uv run uvicorn codrawer_bridge.server.app:app --reload --host 0.0.0.0 --port 8000
```

Optional config:

- Copy `env.example` → `.env` and edit values (AI throttle knobs, future model keys).

## Optional: local Node model-server (Cerebras / Vercel AI SDK)

This repo includes a fast local model gateway in `model-server/` (OpenAI-compatible).

- Start it:

```bash
cd model-server
pnpm install
pnpm dev
```

- Point the desktop server at it (in `.env`):

```bash
CODRAWER_MODEL_SERVER_URL=http://127.0.0.1:3100
CODRAWER_MODEL_SERVER_MODEL=blazing_fast
```

Endpoints:

- **Health**: `GET http://localhost:8000/healthz`
- **WebSocket**: `ws://<desktop-ip>:8000/ws/<session_id>`
- **Viewer**: `http://<desktop-ip>:8000/viewer/<session_id>` (renders user vs AI layers)

## Paper Pro bridge

See `bridge/remarkable/README.md`.

## Record/replay harness (no hardware)

Record:

```bash
uv run python -m codrawer_bridge.tools.stroke_sim.record_jsonl --ws ws://127.0.0.1:8000/ws/session1 --out out.jsonl
```

Replay:

```bash
uv run python -m codrawer_bridge.tools.stroke_sim.replay_jsonl --ws ws://127.0.0.1:8000/ws/session1 --in out.jsonl --speed 1.0
```

## Dev commands (always `uv run` on desktop)

```bash
uv run ruff check .
uv run mypy .
uv run pytest -q
```

## License

Apache License 2.0. See `LICENSE`.
