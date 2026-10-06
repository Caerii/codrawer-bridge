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
- `layer="peer"`: another participant's ink (a phone, a browser), with its `color` and `author`.
- `layer="ai"`: AI ghost ink (server→clients). **AI never overwrites user ink**. On the Go and
  Rust routers, which carry no `ai_stroke_*`, an agent joins as a client and draws with
  `stroke_*` on `layer:"ai"` (optionally with its own `color`, `size` and `author`). With
  `NATIVE_AGENT_INK=1` on the tablet, the bridge also commits each finished ai stroke as real
  xochitl ink on the open page, on a layer named `codrawer: agent` (ADR 009; the codrawer-layer
  XOVI extension): it saves into the notebook and the user can undo it. The bridge forwards only
  `layer:"ai"`, caps it (32 strokes in progress, 4000 points per stroke, 40 strokes then 15 per
  second) and maps `color` (`#rrggbb[aa]`) and `brush`/`tool` to xochitl's ARGB and pens.

## Routers

Two implementations speak this protocol: the desktop Python router (`src/codrawer_bridge/server`,
everything below) and the stroke-only Go router inside the tablet bridge
(`bridge/remarkable/native/router`, `-serve`), which drops `prompt`/`ai_*`, answers `term_*`
with a `term` status, and **replays the current page** to a client right after its `hello`: the
tablet's latest saved `page`, if any, then the live `stroke_begin`/`stroke_pts`/`stroke_end`
recorded since it (or since the last `clear`). The Python router replays only the `page`.

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
  `"eraser"` is the tablet's eraser end. xochitl cuts the lines it passes over (it never stores the
  eraser), so clients do the same as its points arrive: every point of the tablet's earlier ink
  (layer `user`) within the eraser radius of its path goes, splitting lines; other layers are not
  cut. The radius is 28.8 page px plus the ink's half width at the tablet's default zoom
  (`docs/investigations/native-erase.md`, `apps/even-g2/src/erase.ts`).
  The toolbar's Eraser used with the tip is sent the same way when xochitl reports it (the
  codrawer-layer XOVI extension; `bridge/remarkable/native/README.md`, "The toolbar eraser"), with
  `"tool":"eraser"` added. Its radius depends on the eraser size (5 × size² page px; 20 at size 2),
  while clients use the eraser end's radius.
- `color` (optional): client hint (e.g. `"#00ff88"`). Input events do not provide UI-selected color; set it via client/bridge config.
- `ts`: ms timestamp

### `stroke_pts` (bridge → server → broadcast)

Points are batched for throughput (target ~60Hz, but not required).

```json
{"t":"stroke_pts","id":"u_123","pts":[[0.12,0.34,0.6,1730000000130],[0.121,0.341,0.62,1730000000146]]}
```

Each point is `[x, y, p, t]`.

Agent ink sent as `stroke_*` on `layer:"ai"` carries the time its (simulated) hand drew each
point (`packages/hand`); clients may play such strokes out at that timing rather than on arrival.
The Even G2 phone stage does (`apps/even-g2/src/playout.ts`), so a turn posted in one burst still
appears at the pace it was written.

### `stroke_end` (bridge → server → broadcast; also triggers AI)

```json
{"t":"stroke_end","id":"u_123","ts":1730000000456}
```

**AI triggering rule**: the server enqueues AI work **only** on `stroke_end` (micro-pauses may be added later), and enforces strict throttling (see `docs/latency_budget.md`).

### `stroke_delete` (client → server → broadcast)

Take strokes back: an undo, "clear my strokes", or an agent replacing a frame of an animation.

```json
{"t":"stroke_delete","ids":["p_k3j9x0ab_m1x2","ai_frame_41"],"ts":1730000000500}
```

Fields:
- `ids`: the strokes to remove (their `stroke_begin` ids).
- `ts` (optional): ms timestamp.

Rules (the Go and Rust routers, `bridge/remarkable/native/router`, `bridge/remarkable/rust/src/router`):
- A client may delete only the strokes it began: the owner is the **connection** that sent the
  `stroke_begin`, so after a reconnect a client no longer owns what it drew before.
- Exception: strokes on the `ai` layer may be deleted by any client (agent ink is a proposal any
  participant may take back, ADR 003).
- Unknown ids are ignored: never seen, already deleted, evicted, cleared, or covered by a `page`
  snapshot (the tablet's saved page is the tablet's to change; its erases arrive in the next `page`).
- The router drops the deleted strokes from its replay log, so late joiners never see them, and
  relays the message to every other client. If it refused or did not know some ids, it relays
  `{"t":"stroke_delete","ids":[…the accepted ones…],"ts":…}` instead; if none were accepted, nothing.
- Points that still arrive for a deleted stroke are relayed but not recorded; clients ignore them
  too (the app keeps the deleted ids until the next `clear`). A new `stroke_begin` with the same
  id is a new stroke.

Clients apply their own deletes locally before sending (the sender gets no echo). The Python
router does not handle `stroke_delete` yet.

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

### `page` (tablet bridge → server → broadcast; replayed to joiners)

The tablet's **saved page**, from the bridge's read-only page watcher (`bridge/remarkable/native/
pagewatch`, ADR 008). xochitl writes a page's `.rm` about 6–10 s after the user pauses and when
the page is left, and records page turns in `<doc>.content` within 1–2 s. The bridge sends a
`page` whenever the open page's file is rewritten or the open page (or document) changes, and
again on every reconnect. The snapshot is the page: erased and undone strokes are simply absent,
and strokes on hidden layers are left out.

```json
{"t":"page","doc":"<doc uuid>","page":"<page uuid>","title":"Sketches","rev":1759406400123,"w":1620,"h":2160,
 "strokes":[{"id":"1:42","tool":"calligraphy","color":0,"rgba":"#000000ff","size":2,"layer":"0:11",
             "pts":[[0.52101,0.31388,0.502,0.00463],[0.52133,0.31402,0.533,0.00494]]}]}
```

Fields:
- `doc`, `page`: xochitl's document and page ids; `title`: the document's name when known.
- `rev`: Unix ms on the tablet's clock (the same clock as `stroke_begin.ts`). The snapshot holds
  everything drawn on this page up to `rev`. It is the `.rm` mtime; on a page change it is the later
  of that and the `.content` write that recorded the turn.
- `w`, `h`: the page size in page units (Paper Pro 1620 × 2160).
- `strokes[]`, in drawing order:
  - `id`: xochitl's CRDT id (`author:counter`), stable across saves.
  - `tool`: one of `fineliner`, `ballpoint`, `marker`, `pencil`, `mechanical_pencil`, `brush`,
    `calligraphy`, `highlighter`, `shader`, `eraser`, `erase_area`, or `pen` when unknown. Clients
    do not paint `eraser` or `erase_area`, because their effect is already in the snapshot.
  - `color`: xochitl's palette id (0 black, 1 grey, 2 white, 3 yellow, 4 green, 5 pink, 6 blue,
    7 red, 8 grey overlap, 9 highlight (see `rgba`), and the Paper Pro inks 10 green, 11 cyan,
    12 magenta, 13 yellow).
  - `rgba`: the resolved display colour `#rrggbbaa`: the stroke's own colour for Paper Pro
    highlighter and shader, otherwise the palette's (Paper Pro ink values are approximations).
    xochitl draws the highlighter translucent even though its alpha is stored as `ff`. The
    shader's alpha is real.
  - `size`: the tool's thickness setting (`thickness_scale`: 1, 2, 3, or fractions).
  - `layer`: the layer id, or `"ai"` for strokes on the `codrawer: agent` layer: agent ink the
    tablet committed natively (NATIVE_AGENT_INK). Clients treat those as AI strokes, and a
    snapshot that carries any replaces the finished live `ai` strokes, which it now holds.
  - `pts`: `[x, y, p, w]`. `x, y` are normalised to the page: `x = (x_rm + w/2) / w` (xochitl's x is
    centred) and `y = y_rm / h`. Points on a scrolled page can fall outside 0..1. `p` is pressure
    0..1. `w` is xochitl's computed stroke width at that point as a fraction of the page width (the
    file stores quarter pixels: `w = width / 4 / 1620`).

Routers keep the latest `page` per session and send it to a joiner right after `hello`. The Go
router also uses it as the page's **base**: on a `page` it drops recorded live strokes whose
`stroke_begin.ts` is not after `rev` (they are in the snapshot, or were erased), and replays the
`page` first and then the live strokes recorded after it. `clear` drops the page.
`?replay=0` sources get no replay. Clients do the same with their own copy. They replace
earlier snapshot strokes with the new snapshot, keep live strokes whose `stroke_begin.ts > rev`,
and on a different `page`/`doc` clear the view (AI layer included) and show the new page.
xochitl commits a stroke (ink or erase) when the pen lifts, so the Even G2 client also keeps a
live stroke that has not ended or whose `stroke_end.ts > rev` (a save taken while the pen was
down), and applies kept eraser strokes again to the new snapshot.

### `dock_action` (tablet bridge → server → broadcast)

A tap in codrawer's own UI inside xochitl: the dock button the codrawer-layer XOVI extension
injects into the toolbar (its entries come from `/run/codrawer/dock.json` on the tablet), or a
selection's "Ask agent". The extension hands it to the bridge, which adds `doc` (when the page is
the one its page watcher knows) and `ts`, and sends it like a key. Agents act on it; the routers
relay it.

```json
{"t":"dock_action","id":"ask_page","page":"<page uuid>","doc":"<doc uuid>","source":"dock","ts":1791262400123}
{"t":"dock_action","id":"ask_selection","page":"<page uuid>","doc":"<doc uuid>","bbox":[-560,281,-136,379],"items":3,"selected_ms_ago":4200,"source":"dock","ts":1791262400123}
```

Fields: `id` the entry's id (`status` is answered on the tablet and never sent; first entries
`agent_ink`, `practice_coach`, `ask_page`, `ask_selection`); `page`, `doc` the page on screen;
`source` the injection that sent it. `ask_selection` adds the last lasso selection on that page:
`bbox` `[x0, y0, x1, y1]` as xochitl signalled it (`SceneController.areaSelected`, scene units,
x centred) and `items`, the number of selected items. Clients resolve the selected strokes from
their `page` snapshot (strokes with points inside `bbox` after the conversion `x = (x_rm + w/2)/w`).

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

### `doc_update` / `doc_state` / `doc_compact` (shared live editing)

Clients keep the document as a [Yjs](https://yjs.dev) CRDT and send each batch of local edits as
`{"t":"doc_update","u":"<base64 Yjs update>"}`. Routers relay it to every other client, keep the
log, and replay it to a joiner right after `hello` as `{"t":"doc_update","us":["…","…"]}`.
Updates are idempotent and commutative, so a client resends its full state on every connect.
The Go router compacts: past 256 entries it sends `{"t":"doc_compact"}` to the client that just
wrote, which answers `{"t":"doc_state","u":"<full state>"}`; the log becomes that state plus
whatever arrived after the request. `clear` does not touch the document. Live-editing clients
mark their plain-text `doc` copies `"crdt":true` and ignore such copies from others.

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
- Keep payloads small; do not resend the entire stroke history. The exception is `page`, which
  is the tablet's whole saved page, sent only on a save or a page change (about 3.7 bytes of
  JSON per byte of `.rm`: a 45-stroke calligraphy page is 169 KB). The Go router accepts
  messages up to 16 MB.

## Seeing the AI layer (important)

AI strokes are emitted as `ai_stroke_*` messages but **are not automatically rendered on the Paper Pro** by this repo.

To verify AI output:
- Use the built-in dev viewer: `GET /viewer/{session_id}` (AI is red, user is green)
- Or record WS traffic and confirm `ai_stroke_begin/pts/end` appear


