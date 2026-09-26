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

## Input

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

`app.json` whitelists `http://localhost:8577` / `ws://localhost:8577`; add your LAN origin for
the phone. `pnpm build` then `evenhub pack app.json dist -o codrawer.ehpk`, or sideload with
`evenhub qr --url http://<lan-ip>:5188` after `VITE_HMR_HOST=<lan-ip> pnpm dev`.
See `docs/even-g2-testing.md`.
