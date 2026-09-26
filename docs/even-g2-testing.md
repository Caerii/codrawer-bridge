# Testing with the Even Realities G2 (and the reMarkable) — dev loop

Verified against hub.evenrealities.com/docs on 2026-09-26. Re-check versions before relying on them
(simulator 0.9.3 tracks SDK 0.0.14 at time of writing).

## What runs where

| Piece | Runs on | Notes |
| --- | --- | --- |
| reMarkable native bridge | Paper Pro (ssh root) | Build from source: `cd bridge/remarkable/native && GOOS=linux GOARCH=arm64 go build -o codrawer_bridge_native .` (binary is gitignored). Setup: `docs/remarkable_setup.md`. |
| Desktop router | laptop, `:8000` | `uv sync && uv run uvicorn codrawer_bridge.server.app:app --host 0.0.0.0 --port 8000`. Web viewer at `/viewer/session1`. |
| model-server | laptop, `:3100` | Optional; needed for ghost ink. `cd model-server && pnpm dev`. |
| Even Hub app | the Even phone app's WebView, relayed over BLE to the glasses | Must be a **web app** (Vite). The Node viewer in `experimental/even-g2-codrawer-viewer/` is a mock harness only; its `strokeRasterizer.ts` logic ports to a browser canvas. |
| Even Hub simulator | laptop | `npm i -g @evenrealities/evenhub-simulator`, then `evenhub-simulator http://localhost:5173`. Emulates containers, text, input events (up/down/click/double-click/long-press), 16 kHz PCM audio. Not frame pacing, BLE timing or LZ4 image validation. |

## Tooling to install once

```bash
npm i -g @evenrealities/evenhub-simulator @evenrealities/evenhub-cli
# in Claude Code:
/plugin marketplace add even-realities/everything-evenhub
/plugin install everything-evenhub       # quickstart, template, glasses-ui, handle-input,
                                          # test-with-simulator, simulator-automation, sdk-reference, ...
```

SDK: `@evenrealities/even_hub_sdk` (npm). Packaging: `evenhub pack app.json dist -o app.ehpk`.

## Loop 1 — no hardware (today)

1. Router up, then replay a recording so the canvas is live:
   `uv run python -m codrawer_bridge.tools.stroke_sim.replay_jsonl --ws ws://127.0.0.1:8000/ws/session1 --in <rec>.jsonl`
2. Scaffold the G2 app (`quickstart` skill or `template image`), point it at `ws://<lan-ip>:8000/ws/session1`,
   draw strokes into a canvas, downsample to the image container (20–200 px wide, 20–100 px tall,
   4-bit greyscale 0–15), push with `updateImageRawData`, and never overlap two image updates.
3. `evenhub-simulator http://localhost:5173`; drive it with the `simulator-automation` skill
   (screenshots, injected input, console logs).

## Loop 2 — real glasses on the LAN

1. Even phone app → Even Hub tab → enable **Developer Mode**.
2. Dev server: `npm run dev` with `server: { host: true, hmr: { host: '<lan-ip>' } }` in `vite.config.ts`
   (HMR must not point at localhost; the phone cannot reach it).
3. `evenhub qr --url "http://<lan-ip>:5173"` and scan from the Even Hub tab ("Scan QR").
4. Plain HTTP is fine for local testing. Phone and laptop on the same Wi-Fi with no AP isolation;
   if scans fail silently, use a phone hotspot or Tailscale.

## Loop 3 — real glasses + the reMarkable

Same as Loop 2 with the Paper Pro streaming into the router instead of a replay. The Paper Pro,
the laptop and the phone all need to reach `:8000`. Local ink stays on the tablet (`NO_GRAB=1`);
AI ink shows on the web viewer, the iPad, and the G2 crop.

## Manifest and server requirements

- `app.json` needs a `network` permission with a `whitelist` of **full origins**, no wildcards or
  bare hosts, e.g. `http://<lan-ip>:8000`. Voice features additionally need the microphone permission.
- The whitelist does **not** replace CORS. The router must answer with
  `Access-Control-Allow-Origin: *` (and the preflight headers for non-simple requests). Add
  FastAPI `CORSMiddleware` before testing from the phone; the WebSocket handshake itself is not
  CORS-gated but any HTTP call from the app is.
- Display constants differ between sources: the SIG plans assume 640×350; the simulator docs state
  576×288. Confirm on the device before committing layout numbers.

## Surface B (voice) is available now

`@evenrealities/even-terminal` 0.8.1 is installed on this machine and Tailscale is up, so the
glasses-driven Claude loop from the SIG plans (INFRA-05, GLASS-03) works independently of the
canvas app. A `prompt` message into the router from that loop is the cheapest voice → ink test.
