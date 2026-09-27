# Protocol (codrawer-bridge)

This protocol is **stroke-native**: the bridge sends raw stroke events; the server routes; clients render. AI output is **always** on a separate `ai` layer (ghost ink).

## Transport

- WebSocket: `/ws/{session_id}`
- Messages are JSON objects with a required string field `t` (type).

## Normalization rules

- **Coordinates**: normalized floats \(x,y\) in `[0,1]` (client decides pixel mapping).
- **Pressure**: normalized float `p` in `[0,1]`.
- **Timestamps**: integers in **milliseconds**.

## Layer semantics

- `layer="user"`: user ink (from Paper Pro).
- `layer="ai"`: AI ghost ink (server→clients). **AI never overwrites user ink**.

## Message types

### `hello` (server → client)

Sent once on connection.

```json
{"t":"hello","session":"session1"}
```

### `stroke_begin` (bridge → server → broadcast)

```json
{"t":"stroke_begin","id":"u_123","layer":"user","brush":"pen","ts":1730000000123}
```

Fields:
- `id`: stroke id (string, unique within a session)
- `layer`: `"user"` (AI may also use same shape with `"ai"` but current server treats AI separately)
- `brush`: client hint (e.g. `"pen"`, `"eraser"`). Rendering/erase behavior is **client-side**.
- `color` (optional): client hint (e.g. `"#00ff88"`). Input events do not provide UI-selected color; set it via client/bridge config.
- `ts`: ms timestamp

### `stroke_pts` (bridge → server → broadcast)

Points are batched for throughput (target ~60Hz, but not required).

```json
{"t":"stroke_pts","id":"u_123","pts":[[0.12,0.34,0.6,1730000000130],[0.121,0.341,0.62,1730000000146]]}
```

Each point is `[x, y, p, t]`.

### `stroke_end` (bridge → server → broadcast; also triggers AI)

```json
{"t":"stroke_end","id":"u_123","ts":1730000000456}
```

**AI triggering rule**: the server enqueues AI work **only** on `stroke_end` (micro-pauses may be added later), and enforces strict throttling (see `docs/latency_budget.md`).

### `cursor` (optional, bridge/client → server → broadcast)

```json
{"t":"cursor","x":0.5,"y":0.2,"ts":1730000000789,"who":"paperpro"}
```

### `prompt` (optional, client → server; triggers AI)

Send a free-form instruction for the AI to draw on the **AI layer**. The server does **not** broadcast this
message by default; it only produces `ai_stroke_*` output.

```json
{"t":"prompt","text":"write hello in neat handwriting","mode":"handwriting","ts":1730000001200}
```

Fields:

- `text`: what you want the AI to draw / write
- `mode`: `"draw"` or `"handwriting"`
- `x`,`y` (optional): normalized anchor point for placing the output (otherwise the server uses last cursor or center)
- `ts` (optional): ms timestamp

### `clear` (any client → server → broadcast)

Start a new drawing. The server forgets its rolling context for the session (recent strokes,
prompts, AI plans) and forwards the message to every other client, which wipes its canvas.
Nothing is persisted or replayed; clients own rendering.

```json
{"t":"clear","ts":1730000003000}
```

### `key` (keyboard bridge → server → broadcast)

One key-down (or auto-repeat) from a keyboard paired to the tablet. `char` is present only for
text-producing keys with no Ctrl/Alt/Meta held; `key` uses browser-style names for the rest
(`Enter`, `Backspace`, `ArrowUp`, `F3`, …). Clients own line editing and any command syntax.

```json
{"t":"key","key":"A","char":"A","code":30,"repeat":false,"mods":{"shift":true,"ctrl":false,"alt":false,"meta":false},"ts":1730000004000}
```

### `doc` (client → server → broadcast)

A participant shares the document it is editing (plain text / markdown). The router keeps the
latest, forwards it to every other client, and writes it to `<term cwd>/.codrawer/doc.md` so
the terminal agent can Read it. A `term_prompt` with `"context":"doc"` gets a trailer pointing
the agent at that file. Last writer wins; clients adopt an incoming document only when they
have no unsaved edits (a CRDT is deferred, see the SIG IDE-CRDT ladder).

```json
{"t":"doc","text":"# Notes\n- first line","cursor":{"line":2,"col":13},"reason":"auto|save|share|prompt"}
```

### `term_prompt` / `term_answer` (client → server) and `term` (server → clients)

The router can attach an [even-terminal](https://www.npmjs.com/package/@evenrealities/even-terminal)
session (Claude Code / Codex) to a codrawer session. Configure `CODRAWER_TERM_URL` and
`CODRAWER_TERM_TOKEN` on the router; clients never hold the token or a second connection.

```json
{"t":"term_prompt","text":"list the failing tests"}
{"t":"term_answer","text":"y"}
{"t":"term","kind":"text","text":"bridge online"}
{"t":"term","kind":"note","text":"— done (1 turns, $0.0100) —"}
{"t":"term","kind":"permission","text":"⚠ Bash — run pytest  y / a / n ?"}
```

`term_prompt` may carry `attach`: `"turn"` (default: the ink drawn since the last submitted line),
`"page"` (everything on the page) or `"none"`. The router renders the drawing to
`<term cwd>/.codrawer/turns/turn-N.png` plus a geometry JSON and appends a trailer asking the
agent to read it (ADR 002); a `term` status `✎ attached N strokes` confirms.

`term_answer` resolves a pending permission (`y` allow, `a` always, anything else deny) or
question; with nothing pending it is a prompt. Streamed assistant text is coalesced (~150 ms)
into `kind:"text"` chunks; tool starts/ends, progress, results and errors are `kind:"note"`;
`kind:"status"` reports the bridge itself (attached, dropped, misconfigured).

### `ai_stroke_*` (server → clients)

AI strokes are streamed in a separate layer and **never** replace user strokes.

```json
{"t":"ai_stroke_begin","id":"ai_abcd1234","layer":"ai","brush":"ghost"}
{"t":"ai_stroke_pts","id":"ai_abcd1234","pts":[[0.5,0.5,0.6],[0.51,0.5,0.6]]}
{"t":"ai_stroke_end","id":"ai_abcd1234"}
```

AI points are `[x, y, p]` (no timestamps; clients animate as desired).

### `ai_intent` (server → clients)

Emitted before a group of `ai_stroke_*` messages when the model states what it is about to draw.
Clients may show `plan` as a status line; it never carries ink.

```json
{"t":"ai_intent","plan":"add a small roof line over the box"}
```

SIG mode adds `participant_id` and `run_id` (see `docs/sig-integration.md`).

## Compatibility notes

- The server is a **router**; it does not render and should not send full canvas state.
- Clients own rendering and any “virtual hand” animation.
- Keep payloads small; do not resend the entire stroke history.

## Seeing the AI layer (important)

AI strokes are emitted as `ai_stroke_*` messages but **are not automatically rendered on the Paper Pro** by this repo.

To verify AI output:
- Use the built-in dev viewer: `GET /viewer/{session_id}` (AI is red, user is green)
- Or record WS traffic and confirm `ai_stroke_begin/pts/end` appear


