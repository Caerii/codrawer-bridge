# ADR 003 — Agent ink is a governed action

Status: proposed (2026-09-27) · Owner: SIG platform · Related: SIG GLASS-01/04, ADR 001

## Context

Today AI ink comes from the router's own worker (a stub or the local model-server) on the
`ai` layer, with no identity, budget or audit. With a terminal session in the loop, the agent
should be able to answer a turn with a drawing, and that drawing must be as accountable as
any other agent action in SIG.

## Decision

The agent draws only through a **codrawer MCP server** registered in the terminal session's
working directory (`.mcp.json`, the same mechanism INFRA-05 uses for governed SIG tools).
Tools:

| Tool | Does |
| --- | --- |
| `draw_polylines(strokes, layer?)` | normalized `[x,y,p]` polylines → `ai_stroke_*` on the AI layer, tagged with the current turn |
| `write_handwriting(text, x, y)` | text rendered to strokes (model-server handwriting path or a stroke font), placed at an anchor |
| `clear_ai_ink()` | tombstones the agent's ink on the page |
| `read_page()` | the page as image + geometry (the ADR 002 renderer), for a second look |

Rules, carried over from the codrawer protocol and the SIG Pager:

- AI ink never overwrites user ink; it lives on its own layer and a human accepts or rejects
  it (`ink_accept` / `ink_reject`, tombstones, audit row with `approved_via`).
- Every tool call runs inside the session's SIG compute envelope (reserve → meter → settle)
  and writes an `audit_events` row with `provenance=codrawer`, the turn id and the agent id.
- The router validates geometry (normalized range, point count caps, stroke count caps per
  turn) before broadcasting; oversized replies are truncated with a note.
- On the tablet, the bridge that commits agent ink into xochitl (Go `agentink`, Rust
  `agent_ink.rs`) also rate-caps it: a token bucket refilled at 30 strokes a second with a burst
  of 60; a stroke over the cap is dropped and counted, so a runaway agent cannot fill a
  notebook. Raised from 15 a second (burst 40) on 2026-10-07 because the user asked for very
  fast write-back, agentd's "very fast" hand, about 14.4 strokes a second, which ran into the old
  cap. The cap is one bucket for all agent ink on the tablet, set in its `bridge.env` with
  `AGENT_INK_RATE` (1..200 a second) and `AGENT_INK_BURST` (1..400); a bad value keeps the
  default. Points may lie anywhere on a long, scrolled page (y up to 40000 page units).

## Consequences

- The router exposes an authenticated local HTTP endpoint the MCP server posts to; the
  token stays on the desktop.
- The AI worker's stub/heuristic path stays for offline demos but is labelled as such.
- Handwriting quality depends on the model-server; a stroke font is the fallback so the
  tool never fails silently.
