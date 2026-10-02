# ADR 007 — How the surfaces compose (tablet, glasses, desktop, pods)

Status: proposed (2026-09-27) · Owner: Alif / SIG platform · Related: ADR 001–006, SIG GLASS-04, `Caerii/smart_remarkable`

## Context

Three codebases now touch the same ink:

- **smart_remarkable** (Rust, runs *on* the tablet; a ghostwriter fork): screenshots xochitl's
  framebuffer, sends it to a vision LLM, and writes the answer back as real pen strokes
  (`pen.rs`, SVG or skeleton-traced bitmaps through a virtual pen) or typed text
  (`keyboard.rs`, uinput). Select Mode lassos a region and places the answer in a box; a XOVI
  extension adds LLM/Draw buttons to xochitl's selection menu; a web config UI and a
  simulation harness exist. It owns the **native tablet experience** and the only working
  **render-back** path.
- **codrawer-bridge** (this repo): the Go bridge streams strokes and keystrokes off the tablet
  in real time and types replies back; the router is the **session**: participants, turns,
  broadcast, AI layer, terminal bridge, attachments; clients render (web, iPad, G2).
- **SIG** (superintelligent.group): identity, budgets, receipts, audit, pods that run the
  agents and language servers, the Even G2 Pager and the glasses plans.

Without a decision they will duplicate each other (two virtual keyboards, two LLM callers,
two ways to draw on the page) and the glasses would look mandatory when they are not.

## Decision

**The router's session is the composition point; every surface is an optional peer of it.**

```
                 ┌──────────────── SIG (governance + compute) ────────────────┐
                 │ identity · budgets/receipts · audit · pods (agents, LSP)   │
                 └───────────────▲───────────────────────────────────────────┘
                                 │ MCP tools, SIG session JWTs, receipts
   tablet-native                 │                              glasses (optional)
 ┌────────────────────┐   ┌──────┴──────────┐              ┌──────────────────────┐
 │ smart_remarkable   │◄──┤   codrawer      │──────────────►│ G2 app (Even Hub) or │
 │ screenshot · pen   │   │   router/session│  ws (same     │ direct BLE later     │
 │ render-back · XOVI │   │ turns · AI layer│   protocol)   └──────────────────────┘
 │ buttons · select   │   │ terminal bridge │
 └─────────▲──────────┘   │ attachments     │              ┌──────────────────────┐
           │ uinput/evdev │                 │──────────────►│ web viewer · iPad    │
 ┌─────────┴──────────┐   └──────▲──────────┘              └──────────────────────┘
 │ codrawer Go bridge │──────────┘  strokes, keys out; term replies, AI ink in
 └────────────────────┘
```

Rules:

1. **One session, many surfaces.** The tablet works with no glasses and no desktop viewer:
   bridge + router + smart_remarkable on the tablet is a complete product. The glasses are
   a glance surface; the web viewer and iPad are render surfaces. None is required by another.
2. **One render-back path on the tablet, owned by the codrawer bridge.** *(Revised 2026-10-02
   after `docs/investigations/smart-remarkable.md`.)* smart_remarkable's "virtual pen" writes
   events into the real pen device (`/dev/input/event2`), which the bridge also reads: its ink
   would be streamed back as the user's, and nothing keeps it from drawing while the user's pen
   is down. So the writer must sit next to the pen reader: the bridge injects strokes (porting
   smart_remarkable's pen sequencing, pacing and corner splitting, ~300 lines), marks what it
   injected so it is never echoed, and waits until the user's pen is out of range.
   smart_remarkable sends "draw"/"type" requests to the bridge (its external-writer mode) and
   keeps its LLM, Select Mode and buttons. Tool and colour come from a small XOVI extension on
   the inkling pattern, not from tapping the toolbar. The bridge owns all input devices (one
   uinput keyboard: ADR 005) and the display-buffer reader (XOVI framebuffer-spy, with the
   size-based search as fallback).
3. **One agent path: through the session.** smart_remarkable's triggers (corner tap, LLM
   button, Draw button, Select Mode) become session events: a trigger submits a turn
   (ADR 001) with the selection as the attachment (ADR 002). The LLM call runs in the
   session's terminal/pod under SIG budgets, not from an API key on the tablet. The tablet
   keeps working offline with its own key as a documented fallback mode.
4. **Screenshot and stroke store are both truth, for different questions.** The stroke store
   (bridge) gives geometry, attribution and turn boundaries; the framebuffer screenshot
   (smart_remarkable) gives exactly what the user sees, including typed text and xochitl
   UI. An attachment may carry both; the renderer in ADR 002 prefers strokes and adds a
   screenshot when the page has non-ink content.
5. **Session protocol is the contract.** smart_remarkable speaks the codrawer WebSocket
   protocol (`docs/protocol.md`) as a participant (`kind: "tablet-agent"`); no private side
   channel between it and the bridge beyond local IPC for pen/keyboard injection.
6. **Glasses-specific machinery stays in the glasses app.** Latency budgets (ADR 006), the
   loupe, the HUD transcript and the Even SDK never leak into the router or the tablet.

## Consequences

- smart_remarkable gains a small client module (WebSocket participant; trigger → turn;
  `ai_stroke_*` → pen) and loses nothing; its standalone mode is preserved.
- The bridge keeps evdev/uinput as the low-level layer; the higher-level "type this" and
  "draw this" become session messages consumed by whichever tablet process owns the
  injector. Until that lands, the bridge's own typing stays on for the single-user case.
- SIG's GLASS-04 plan is updated: Phase 5 (render-back) is "the bridge's injector, built from
  smart_remarkable's pen algorithms", with smart_remarkable as a participant that requests
  drawing. Community fixes and ours go to `Caerii/smart_remarkable` (integration branch → `dev`).
- Docs: `docs/sig-integration.md` gets this diagram; `smart_remarkable` gets a
  `docs/codrawer-session.md` describing the participant client once it is written.
