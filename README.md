# codrawer-bridge

Core infrastructure for a low-latency “co-drawer” system:

- **Paper Pro** streams stylus strokes (stroke-native input events)
- **Desktop server** routes those events over WebSocket and triggers an AI worker
- **AI** emits **ghost-layer vector strokes** (`layer="ai"`)
- **Clients render** and animate (server/bridge never render)

This repo is **infra-first** (not a product demo yet). It is also the stroke-native surface of
Superintelligent Group's fluid-interface direction: SIG agents (local and cloud) join a session as
participants, and the Even Realities G2 glasses show a glanceable crop of the same canvas. See
`docs/sig-integration.md` for the SIG plan and protocol extensions.

## Repo layout

| Path | Role |
| --- | --- |
| `src/codrawer_bridge/` | Desktop server: FastAPI WebSocket router, AI worker, dev viewer, record/replay tools |
| `bridge/remarkable/native/` | Paper Pro device bridge (Go, single static binary, no Python on the device) |
| `bridge/remarkable/codrawer_bridge.py` | Older Python device bridge (evdev); kept for reference |
| `model-server/` | Local OpenAI-compatible model gateway (Vercel AI SDK): Cerebras fast path, Bedrock, Together |
| `codrawer-ipad/` | iPad client (SwiftUI + PencilKit) with a Rocq prover pane |
| `experimental/even-g2-codrawer-viewer/` | Even Realities G2 viewer: rasterizes the live canvas to 640×350 HUD frames (mock-tested; Even Hub bridge is a stub) |
| `docs/` | Protocol (canonical), architecture, latency budget, device setup, SIG integration |

Not tracked on purpose: compiled device binaries (build from source), `*.jsonl` stroke recordings,
`mock_output*/` frames, `node_modules/`, and every `.env`. Copy `env.example` and
`model-server/.env.example` instead.

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
- `docs/sig-integration.md` (how SIG agents, identity, and the Even G2 attach to a session)
- `docs/even-g2-testing.md` (simulator, developer mode, QR sideload, manifest and CORS rules)

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

- Configure Cerebras (in `model-server/.env`, not committed):

```bash
CEREBRAS_API_KEY=...
```

- Point the desktop server at it (in `.env`):

```bash
CODRAWER_MODEL_SERVER_URL=http://127.0.0.1:3100
CODRAWER_MODEL_SERVER_MODEL=blazing_fast
```

### Optional: add a local context image patch (multimodal)

If your model supports vision, you can attach a small rendered PNG patch (local area around the stroke)
to improve “what’s on the page” awareness:

```bash
CODRAWER_MODEL_SERVER_USE_CONTEXT_IMAGE=1
CODRAWER_MODEL_SERVER_CONTEXT_IMAGE_PX=256
CODRAWER_MODEL_SERVER_CONTEXT_IMAGE_WINDOW=0.22
```

Notes:

- This adds a bit of CPU + payload size (still small at 256×256).
- If the model doesn’t support images, leave it off.

Endpoints:

- **Health**: `GET http://localhost:8000/healthz`
- **WebSocket**: `ws://<desktop-ip>:8000/ws/<session_id>`
- **Viewer**: `http://<desktop-ip>:8000/viewer/<session_id>` (renders user vs AI layers)

## Paper Pro bridge

Use the native Go bridge (`bridge/remarkable/native/README.md`; build with `GOOS=linux GOARCH=arm64`). The Python bridge in `bridge/remarkable/README.md` is the older path.

## iPad and Even G2 clients

- iPad: `codrawer-ipad/README.md` (`run_ipad.sh` has one developer's simulator ids hardcoded; edit before use).
- Even G2: `experimental/even-g2-codrawer-viewer/README.md` (`pnpm install && pnpm test` renders mock frames without hardware).

## Record/replay harness (no hardware)

Recordings are `*.jsonl` and gitignored; keep them out of commits.

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
