# ADR 008 — A universal page model for multiplayer codrawing

Status: proposed (2026-10-02) · Owner: Alif / SIG platform · Related: ADR 001, 003, 006, 007,
`docs/investigations/xochitl-pen-data.md`, `docs/investigations/direct-ble-tablet.md`

## Context

codrawer is meant to be the collaboration framework that the existing tools are pieces of:
goMarkableStream shows the tablet's screen, rmscene reads its files, XOVI hooks its app,
smart_remarkable writes back onto its page, the Even SDK drives the glasses. None of them is at
once vector-native, multi-device, multi-person and agent-native.

Today the session is a stream of ephemeral messages (`stroke_*`, `cursor`, `key`) plus a page
replay held by the router, and a separate Yjs document for text (`doc_update`). Strokes have no
author, no tool or colour beyond `brush: pen|eraser`, no stable page identity, and nothing
written by another device can land on the reMarkable page itself. Measured on 2026-10-02:

- the tablet's `.rm` page files carry the exact tool, colour, size and per-point width of every
  stroke, but are written only when the user pauses (~6–10 s) or leaves the page;
- page turns surface in `<doc>.content` within ~1–2 s;
- xochitl's display buffer holds the exact rendered ink in real time (pixels, not vectors).

## Decision

### 1. One page model, shared as a CRDT

A **page** has a stable id (for a reMarkable page: its xochitl document id + page id), a size in
page units (the Paper Pro's 1620 × 2160; other surfaces map onto it) and layers (`user`, `ai`,
later named layers).

A **stroke** is immutable once committed:

| Field | Meaning |
| --- | --- |
| `id` | stable, globally unique (the bridge's id; `.rm` CrdtId once reconciled) |
| `author` | participant id (see 2) |
| `tool` | reMarkable vocabulary: fineliner, ballpoint, marker, pencil, mechanical_pencil, brush, calligraphy, highlighter, shader, eraser, erase_area; plus `pen` for unknown |
| `color` | ARGB; reMarkable ink colours map to their ARGB, participants default to their own colour |
| `size` | the tool's thickness setting |
| `points` | `[x, y, pressure, width?, t?]` in page units; `width` when the source knows it (the `.rm` per-point width) |
| `layer`, `provenance` | `human` or `agent` with the run id (ADR 003) |
| `deleted` | tombstone (erase, undo, lasso delete, ink_reject) |

The page is a Yjs document — the mechanism already shipped for shared text (`doc_update`,
compaction, replay; `apps/even-g2/src/collab.ts`, the Go router's doc log): strokes are added
once, deletions are tombstones, devices merge without conflicts and offline edits sync on
reconnect. Per-author undo follows from authorship. The routers stay dumb: relay, log, compact,
replay.

**Live motion stays ephemeral.** `stroke_begin/pts/end` and `cursor` keep flowing at pen rate
for previews; a stroke enters the page model when it ends.

### 2. Every device is a participant

A participant has an id, a display name, a colour (assigned on join, editable) and a kind
(`tablet`, `phone`, `ipad`, `web`, `glasses`, `agent`). Presence (live cursor, hover pointer,
"drawing now") travels on the ephemeral channel. Colour is how people tell each other apart:

- phone / web / iPad: full colour — strokes and hover pointers in the author's colour;
- the reMarkable Paper Pro: its colour inks (black, grey, white, blue, red, green, yellow, cyan,
  magenta, …), nearest match to the author's colour, when strokes are written natively (4);
- glasses: one colour; other authors are drawn dashed or dimmer.

A tablet user's own strokes keep the ink they chose on the tablet.

### 3. Sources reconcile into the model

- **reMarkable**: evdev stream (live, ~16 ms) → provisional strokes; on each `.rm` write the
  bridge (read-only watcher) replaces the page's strokes with the file's — exact tool, colour,
  widths, and deletions as tombstones; on a `<doc>.content` page change the session switches
  page. Later, display-buffer tiles give pixel-exact live rendering as a view, not as data.
- **Phone / iPad / web**: touch and Apple Pencil produce strokes directly in the model.
- **Agents**: produce strokes through the ADR 003 MCP tools into the model (`provenance=agent`).

### 4. Strokes from others appear natively on the reMarkable page

Ownership stays with smart_remarkable (ADR 007), which already has a virtual pen and a XOVI
extension. Ranked:

1. **XOVI extension inside xochitl** — insert strokes into the open scene with any tool and
   colour, no input simulation; depends on a durable install across OS updates
   (`docs/investigations/durable-install.md`).
2. **Virtual pen (uinput)** — replays a stroke as if drawn by hand, so xochitl renders, saves and
   can undo it; draws with the currently selected tool and colour (per-author colour would need
   toolbar automation), and must wait until the user's pen is out of range.
3. **Writing `.rm` files** — only for pages that are not open (xochitl would overwrite them).

The bridge marks strokes it injected (`origin=injected`, the model id) so the `.rm`
reconciliation recognises them instead of duplicating them.

## Consequences

- One schema serves the glasses, the phone stage, a web viewer, remote peers and agents; the
  protocol gains `page_update` (Yjs, like `doc_update`), `participant`/`presence` messages and a
  `page` switch, and keeps `stroke_*`/`cursor` for live motion.
- The Go and Rust routers, the Python router and the app each need the page-update relay
  (already built for the document: same code path).
- Native writing depends on smart_remarkable and on the durable-install decision.
- Open: the coordinate transform under xochitl zoom/scroll; mapping arbitrary participant
  colours onto the Paper Pro's fixed ink palette; access control once peers are remote (pairing,
  per-session tokens); layer semantics for agent ink (accept/reject from ADR 003).

## First steps

1. Durable install (in research) so tablet-side pieces survive OS updates.
2. Page model v1: Yjs page document + participants with colours in the app and routers; the
   phone becomes a second input device (draw on the phone, see it on the glasses and stage).
3. `.rm` watcher in the bridge (read-only) → exact tools/colours and erase/undo into the model.
4. Native write-back probe with smart_remarkable: one stroke from the phone onto the tablet page.
5. Display-buffer tiles for pixel-exact live rendering.
