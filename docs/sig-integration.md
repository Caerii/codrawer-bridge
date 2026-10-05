# SIG integration (Superintelligent Group)

This repo is the stroke-native half of SIG's "fluid interface" direction: a reMarkable
Paper Pro (and iPad) streams pen strokes, SIG agents answer with vector ghost ink, and the
Even Realities G2 glasses show a glanceable crop of the same canvas. The full plan lives in
the SIG repo as **`docs/plans/GLASS-04-stroke-native-codrawer.md`**; this page is the
bridge-side view of it.

## How the pieces compose (see `adr/007-surface-composition.md`)

The router's session is the composition point; every surface is an optional peer of it.
The tablet is complete on its own: the Go bridge streams strokes and keys out and injects
typed replies and AI ink back, and `smart_remarkable` (Rust, on-device) owns the native
experience: framebuffer screenshots, real pen render-back, the XOVI selection buttons and
Select Mode. The Even G2 app is a glance surface; the web viewer and iPad are render
surfaces; SIG supplies identity, budgets, receipts and the pods that run agents and language
servers. One agent path (through the session's terminal/pod), one render-back path on the
tablet (smart_remarkable's pen), one typing service, one protocol (`protocol.md`).

Decisions are in `adr/`: 001 turn as the unit of record · 002 image attachment path (verified:
the agent Reads `.codrawer/turns/turn-N.png` + geometry JSON and answers about the drawing) ·
003 agent ink as a governed action · 004 terminal keying and arbitration · 005 reply sinks and
the virtual keyboard · 006 latency budget per surface · 007 surface composition.

## What SIG needs from this bridge

| Need | Today | Change |
| --- | --- | --- |
| Identity | anyone on the LAN with the session id joins; one `user` layer | `join` message carrying a SIG session JWT; a layer per participant |
| Governed agents | anonymous local AI worker, no budget or audit | the worker runs inside a SIG compute envelope (reserve → meter per `stroke_end` → settle); cloud pod agents join as `kind=agent` participants over the same WebSocket |
| Durability + presence | in-memory sessions; late joiners see a blank page | router writes strokes through to SIG (`ink_strokes`, append-only) and hydrates joiners; `presence` roster |
| Human verdict on agent ink | none | `ink_accept` / `ink_reject` → tombstone + audit row (`approved_via=ipad|web|even_g2`) |
| Glasses | the G2 app in `apps/even-g2/` (loupe, follow/fit views, ring menu; verified on hardware) | promoted into the SIG Pager as a view: follow-crop + agent intent line; ring = accept / reject / next |
| Tablet render-back | Paper Pro is input-only | Phase 5: draw accepted agent ink on the e-paper |

Nothing above changes the three non-negotiables in the README. Per-point model calls stay
forbidden, AI ink stays on its own layer, and the server keeps routing while clients render.

## Protocol extensions (backward compatible)

```jsonc
// first message from any client when CODRAWER_SIG_URL is set
{"t":"join","token":"<SIG session JWT>","participant":{"kind":"human","display":"Alif","device_id":"paperpro-01"}}
// server reply (replaces the bare hello)
{"t":"hello","session":"s1","participant_id":"p_7f3a","layer":"p_7f3a"}

// strokes gain attribution; "user" / "ai" remain accepted aliases for old clients
{"t":"stroke_begin","id":"u_123","participant_id":"p_7f3a","layer":"p_7f3a","brush":"pen","ts":1730000000123}

// agent intent is now attributed and tied to a governed run
{"t":"ai_intent","participant_id":"p_agent1","run_id":"run_…","plan":"add a small roof line over the box"}

// a human's verdict on a group of agent strokes
{"t":"ink_reject","stroke_ids":["ai_abcd"],"reason":"off-topic","ts":1730000002000}

// roster broadcast
{"t":"presence","participants":[{"participant_id":"p_7f3a","kind":"human","display":"Alif"},{"participant_id":"p_agent1","kind":"agent","display":"Codrawer"}]}
```

Agents **transact, they do not type**: an agent commits whole strokes (or a small group
under one `ai_intent`), never a per-point stream, so a human can accept or undo the group
as a unit.

## Config the bridge will read

```bash
CODRAWER_SIG_URL=https://api-dev.superintelligent.group   # unset = legacy open LAN mode
CODRAWER_SIG_ANON_KEY=...                                  # PostgREST anon key (RLS does the rest)
CODRAWER_SIG_SESSION_TOKEN=...                             # for keyboard-less devices: minted via the SIG pair-device handoff
CODRAWER_SIG_WORKSPACE_ID=...                              # the SIG workspace the ink session belongs to
```

Secrets stay in `.env` (gitignored). The device bridge only ever holds a short-lived,
scoped session token, never a service key.

## Phase order

0. Repo hygiene + these docs (done).
1. `join` + SIG-backed `ink_sessions` / `ink_participants` / `ink_strokes`; hydrate on join.
2. Governed agent participant (compute envelope, receipts, audit); cloud pod agents attach.
3. Presence + per-participant layers in the iPad/web clients; accept/reject + tombstones.
4. Even G2 view inside the SIG Pager; ring gestures; voice `prompt` via even-terminal.
5. Render accepted agent ink back onto the Paper Pro.

## Related SIG material

- `docs/plans/GLASS-01` — the reserve → meter → settle envelope the agent worker reuses.
- `docs/plans/GLASS-02` — Pager auth (`pair-device` handoff), ring input (F9), crowd awareness (F10).
- `docs/plans/GLASS-03` — Walking Deliberation, the voice loop that pairs with this canvas.
- `packages/glasses-pager/` — the Even G2 app that `apps/even-g2/` folds into.
