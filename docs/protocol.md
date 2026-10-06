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
`goto_accepted` (with `result`, the extension's reply) says the user tapped a `goto` offer and the
tablet went there.

### `goto` (client or agent → server → tablet bridge): "take me there"

Opens a document on the tablet, turns to a page, and can briefly frame a region. Nothing is drawn
into the page and nothing is saved.

```json
{"t":"goto","doc":"<doc uuid>","page":"<page uuid>","region":[0.1,0.2,0.3,0.4],"flash":true,
 "reason":"cited: Lemma 2","origin":"user"}
```

Fields: `doc` the document's uuid; `page` (optional) a string, a page uuid or a page index counted
from 0 in digits (`"3"`; the routers read `page` as a string, as in `page` messages, and drop a
message where it is a number; absent: where the document was last left); `region` (optional) `[x0, y0, x1, y1]` normalised
like every point (`x = (x_rm + w/2)/w`, `y = y_rm/h`), each in −0.5..1.5; `flash` (default true
with a region) frames the region for 2 s; `reason` (≤ 120 characters) is what the offer says;
`origin` is `"user"` only when the user's own tap produced it (a citation, a search result, a
dock entry on a client).

**Never yank.** The tablet navigates at once only for `"origin":"user"`. Anything else (an agent's
pointer, a message without an origin) becomes an offer in the tablet's dock, "Go to <reason>?",
with a dot on the dock button; it waits 10 minutes, a newer offer replaces it, and only the user's
tap on it navigates (then `dock_action` `goto_accepted`). Nothing navigates while the pen or a
finger is on the page. The bridge checks the message (agentink/goto.go and agent_ink.rs, the same
rules and bytes) and has a hook for ADR 011's consent scopes (allows everything until the scopes
reach the tablet). Navigation uses xochitl's own path (`MainView.onOpened`, `DocumentView.openPage`;
codrawer-layer `src/navigate.h`), so archived documents, password locks and the last-opened page
behave as when the user opens them.

### `agent_status` (agent → tablet)

What an agent answering on the page is doing, and where, so the tablet can show it live without
writing anything into the notebook: an animated "thinking" overlay over the spot the answer will
take, which the codrawer-layer extension draws and removes (not ink, never saved). Sent by
codrawer-agentd (`src/codrawer_bridge/agentd`) for each `ask_page` / `ask_selection`.

```json
{"t":"agent_status","id":"agentd_7","agent":"agentd","state":"thinking","bbox":[-120,1168,633,1540],"doc":"<doc uuid>","page":"<page uuid>","ts":1791325634200}
{"t":"agent_status","id":"agentd_7","agent":"agentd","state":"writing","bbox":[-120,1168,633,1630],"doc":"…","page":"…","ts":…}
{"t":"agent_status","id":"agentd_7","agent":"agentd","state":"done","ok":true,"bbox":[-120,1168,633,1630],"doc":"…","page":"…","ts":…}
```

Fields: `id` one request (the three states of a request share it); `state` `thinking` (the model
is reading; `bbox` is the spot reserved for a typical answer, or the selection when agent ink is
off), `writing` (the hand is writing; `bbox` is the answer's actual block), `done` (finished or
failed, `ok` says which; clear the overlay); `bbox` `[x0, y0, x1, y1]` in xochitl's page units
with x centred, like `dock_action`'s (normalize with `x = (x_rm + w/2)/w`, `y = y_rm/h`).
`thinking` may be followed directly by `done` (no answer, or text only).

Relay: the Go, Rust and Python routers relay `agent_status` to every other client like
`dock_action`, and the tablet bridge (agentink/live.go, agent_ink.rs) forwards it to the
extension's ink socket as `{"op":"overlay","id","kind":"thinking"|"clear","state","bbox",
"style"}` (`writing` and `done` clear; `writing` keeps the answer block's bbox). The extension
(codrawer-layer `src/live.h`, `qml/live.qml`) plays a small animation at the top left of the
reserved spot (`style`: `pen`, the default, a nib doodling with a comet trail; `drop`; `glyph`)
and, when the answer's first stroke streams in (the bridge also sends ai strokes live, point by
point, while they are written), hands it off into that stroke; never saved. agentd's fallback is a
static "…" in agent ink at the reserved spot (`--thinking dots`); with the overlay live,
`--thinking overlay` drops the dots.

### Personal marks: `mark_seen`, `mark_ask`, `mark_define`, `mark_invoke`, `mark_feedback`, `mark_query`, `marks`

Marks that earn their meaning (ADR 013, `packages/marks`): the user invents a glyph; the first
time it appears beside their notes the agent asks, once, what it means; after that it acts, with a
quiet confirmation until it has earned trust. Recognition runs in a **recogniser host** for one
owner (today the owner's phone, `apps/even-g2` "Watch my ink for marks"; later the desktop
broker). Every router relays these messages to the other clients, like `key` (Go, Rust and Python
routers), and stores nothing.

Coordinates follow this document (normalized page coordinates, Unix ms), with one exception:
**glyph ink** `ink_mm` / `examples` is in millimetres relative to the glyph's own bounding box,
because a mark's examples are shapes, not places, and the recogniser's size gate needs real size.

```jsonc
// host → all: a gesture read as a mark, an ambiguity, or a candidate worth asking about
{"t":"mark_seen","occurrence":"oc_k3","owner":"p_alif","strokes":["1:204"],"page":"<page>",
 "bbox":[0.62,0.18,0.66,0.23],"result":"candidate","reason":"isolated","relation":"beside","why":"…","ts":1791262400123}

// host → all: one batched question, at a pause in the writing, at most one every 5 minutes
{"t":"mark_ask","ask":"ma_k4","owner":"p_alif","options":["tag","flashcard","ask_agent","delegate","latex","replay_from","send"],
 "items":[{"occurrence":"oc_k3","strokes":["1:204"],"bbox":[…],"ink_mm":[[[4.1,0],[0.8,3.7],…]],"reason":"isolated","seen":1}],"ts":…}

// any surface → host: an answer or an edit (op: create | decline | refine | rename | add_example |
// remove_example | retract | restore | share | unshare | adopt)
{"t":"mark_define","op":"create","by":"p_alif","ask":"ma_k4","occurrence":"oc_k3",
 "meaning":{"action":"flashcard","params":{}},"ts":…}
{"t":"mark_define","op":"create","by":"p_alif","examples":[[[[0,0],[3,4]]]],"meaning":{"action":"tag","params":{"tag":"todo"}},"name":"todo bolt","ts":…}
{"t":"mark_define","op":"retract","by":"p_alif","mark":"mk_k5","ts":…}

// host → all: a mark fired (mode confirm: waits for an accept; notify: done, undo offered; silent: done)
{"t":"mark_invoke","invocation":"iv_k6","mark":"mk_k5","owner":"p_alif","name":"spark",
 "meaning":{"action":"flashcard","params":{}},"mode":"confirm","confidence":0.81,"why":"$P 0.043 ≤ τ 0.085, …",
 "occurrence":{"strokes":["1:240"],"bbox":[…],"page":"<page>"},
 "target":{"page":"<page>","strokes":["1:231","1:232"],"region":[0.08,0.41,0.39,0.44],"since":1791262390000},
 "effect":{"t":"primer_request","what":"flashcard","learner":"p_alif","front":{…},"source":"mark","mark":"mk_k5","invocation":"iv_k6"},"ts":…}

// any surface → host: the verdict
{"t":"mark_feedback","invocation":"iv_k6","verdict":"accept","by":"p_alif","via":"phone","ts":…}

// any surface → hosts: the registry, please; a host answers with the marks visible to the asker
{"t":"mark_query","by":"p_kim"}
{"t":"marks","owner":"p_alif","marks":[…],"ts":…}
```

- **Actions map onto existing messages** (`effect`, sent by the host alongside a `notify` or
  `silent` invoke, or after the accept of a `confirm`): `delegate` → `task_create`
  (`trigger:"mark"`, ADR 012); `send` → `task_create` to the `drafts` pod with
  `authority:"act_with_consent"` (the send itself still needs initials on its card); `flashcard` →
  `primer_request` `what:"flashcard"` (the Primer schedules it; feat/primer); `ask_agent` →
  `term_prompt` with `attach:"page"` and the `region`; `latex` → `latex_recognize`
  (docs/investigations/latex-on-tablet.md §5); `tag` → none (the invocation is the record);
  `replay_from` → none (a client opens Thinking replay at `target.since`; the phone does).
- **Who may act.** A mark recognises only its owner's ink. `by` must be the owner for every edit;
  sharing makes a mark visible in `marks` answers, and another participant adopts it as a copy of
  their own (`op:"adopt"`). A consequential action (`send`) is always `confirm`.
- **Built-ins first.** A gesture that answers a task card is a `task_answer` (ADR 012), never a
  personal mark; ink on a card that answers nothing is not a mark either.
- The dock entry `mark_teach` (`dock_action`, kind selection) asks the host to treat the lasso
  selection as a candidate and ask about it now.

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

### `typer_config` (client → server → bridge; the bridge's answer → server → broadcast, replayed to joiners)

The speed at which the tablet bridge types `term` replies into xochitl's focused text field (its
uinput typer: `bridge/remarkable/rust/src/typer.rs`, `native/typer.go`, the fallback when the
codrawer-layer extension cannot insert the text itself; inserted text arrives at once and has
no speed). The bridge owns the setting; anyone may ask for a change, and only the bridge's
acknowledgement says what is in force.

```json
{"t":"typer_config","speed":"fast"}
{"t":"typer_config"}
{"t":"typer_config","speed":"fast","char_ms":12,"burst":10,"enter_ms":150,"substitute":false,"keymap":"UnitedStates","untypeable":"[]^`{}~","ok":true}
{"t":"typer_config","speed":"careful","char_ms":12,"burst":10,"enter_ms":150,"substitute":false,"keymap":"UnitedStates","untypeable":"[]^`{}~","ok":false,"error":"speed must be careful, fast or instant"}
```

Speeds (one write = one `write()` to the virtual keyboard; every keystroke stays in its own
SYN frames):

| `speed` | one write carries | `char_ms` default | 400 characters |
| --- | --- | --- | --- |
| `careful` | one keystroke | 12 | ~4.8 s (verified on the device) |
| `fast` | a word and its separator, at most 16 keys | 12 | ~0.9 s |
| `instant` | up to `burst` keys (default 10), never past an Enter | 40 | ~1.6 s; **uncalibrated defaults** |

Request fields, all optional: `speed`; `char_ms`, the pause after each write in ms (1–1000); `burst`,
instant's keys per write (1–16); `enter_ms`, the least pause after a write that ends with Enter
(0–2000, default 150); `substitute`, true to replace characters the keyboard cannot type with
stand-ins (`[`→`(`, `^`→`**`, …) instead of leaving them out. A `speed` resets `char_ms` to that
speed's default before a given `char_ms` applies; the other fields alone adjust the current
speed. A request with no fields asks for the current setting.
A bad value refuses the whole request (`"ok":false` with `error`, and the unchanged setting). A
change applies from the next reply on. Requests carry no `ok`. The bridge ignores any
`typer_config` that has one.

The bridge answers every request with an acknowledgement and announces its setting the same way
on every new connection. The routers (Python, Go, Rust) relay `typer_config` like any broadcast
and keep the latest acknowledgement with `"ok":true`, which they replay to a joiner after the
page, the strokes and the document (not to `?replay=0` sources). `clear` keeps it. The bridge
starts from its environment: `TYPE_SPEED` (`careful|fast|instant`), else `TYPE_BATCH=word` for
`fast`, else `careful`; `TYPE_CHAR_MS` (> 0), `TYPE_BURST`, `TYPE_ENTER_MS` and
`TYPE_SUBSTITUTE=1` override the preset's values. The Even G2 app's phone ⋯ menu shows the
acknowledged speed under "Reply typing speed" and asks for one when tapped.

`keymap` and `untypeable` describe the keyboard. xochitl turns key codes into characters with its
own Type Folio table for the keyboard language set in its Settings (`InputLocale` in
xochitl.conf; `TYPE_KEYMAP` overrides), and the typer presses keys from the same table
(`scripts/dev/epaper_keymap.py --typer`). It never presses a dead key. Under United States the
table has no key for ``[ ] { } ^ ` ~``, under United Kingdom only for ``^ ` ~``. Agents whose
replies are typed into the tablet should avoid them: LaTeX, for one, loses its braces.

Each write also waits until the pen is out of range and no finger touches the screen, plus
300 ms: xochitl ignores keys in the meantime. Before a reply that follows pen or touch activity,
or a pause of more than 1 s, the typer presses End and waits 150 ms. That puts xochitl back in
text mode without changing the text.

**From the tablet's dock.** A `dock_action` whose `id` is `typer_careful`, `typer_fast` or
`typer_instant` sets that speed: the bridge applies it as it sends the `dock_action` on (which is
relayed as usual) and then sends the acknowledgement. `/run/codrawer/dock.json` replaces the
dock's built-in list when it has entries, so a file offering the speeds repeats the built-in ones:

```json
{"entries":[
  {"id":"status","label":"codrawer status"},
  {"id":"agent_ink","label":"Agent ink on/off"},
  {"id":"practice_coach","label":"Practice coach"},
  {"id":"ask_page","label":"Ask about this page"},
  {"id":"ask_selection","label":"Ask about selection"},
  {"id":"typer_careful","label":"Reply typing: careful"},
  {"id":"typer_fast","label":"Reply typing: fast"},
  {"id":"typer_instant","label":"Reply typing: instant"}]}
```

The dock's entries are plain `{id, label}` with no checked state. Nothing writes this file yet.

### `typer_note` (tablet bridge → server → broadcast)

What a typed reply lost: the characters the tablet's keyboard table cannot type, in order. The
glasses show it on the status strip.

```json
{"t":"typer_note","dropped":"[]{}","count":4,"keymap":"UnitedStates"}
```

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

### `primer` (Primer agent → clients) and `primer_request` (client → Primer agent)

The Primer (ADR 010) is a tutor that reads a learner's handwritten proof, re-renders it as LaTeX,
tracks what the learner knows, and answers in the page's own medium. It runs inside the desktop
router (`CODRAWER_PRIMER=1`) or joins any router as a client
(`uv run python -m codrawer_bridge.primer live --ws ws://<router>/ws/<session> --learner NAME`).
The Go and Rust routers relay both messages to every other client and do not replay them.

A client asks for a reading or a hint, or manages the learner's file:

```json
{"t":"primer_request","what":"proof","learner":"nell","ts":1759700000000}
```

- `what`: `proof` (read the page now), `hint` (the next rung of the hint ladder for the current
  proof), `plan` (send the plan and learner summary again), `forget` (delete this learner's file
  on the desktop; the Primer answers with an empty learner), `coach_on` / `coach_off` (consent
  to, and pause, the practice coach's watching: reading positions and the attempt log), `grade`
  (read the page and mark it up in red pen, below), `clear_marks` (take the last marks back),
  `mock_start` (start a mock exam; optional `problems`, four lists of three bank ids, and `scale`,
  a time compression for demos and tests only), `mock_problem` with `n` 1–3 (the problem she is
  writing now), `mock_grade` (grade now instead of the next morning), `mock_stop`, `mock_status`,
  `features` with `features` (`{"<feature>": true|false}`: consent per kind of watching),
  `goals_set` with `goals` (her edits; only she agrees), `goals`, `dispute` with `target`
  (`mastery:<concept>`, `misconception:<id>`, `calibration`) and `claim` (`known`, `not_known`,
  `wrong`), `insight` with `id` and `verdict` (`confirmed` or `dismissed`), `review` (the next due
  item), `review_answer` with `id` and `grade` (1 Again … 4 Easy), `self_explanation` with `text`
  (the key idea, in her words, for the notebook), and `report`. A `proof` request may carry
  `confidence` (0..1, how sure she is before the check).
- `learner`: the learner's chosen name. Identity is per person, not per device, because a family
  shares one tablet and one Even account (ADR 010). Lowercase letters, digits, `-` and `_`, at
  most 32 characters; anything else is folded to that alphabet.

A line typed on the tablet's keyboard that reads `/proof`, `/hint` or `/grade` is the same
request (`/coach` asks for the coach view; `/mock start`, `/mock grade` and `/p 1`…`/p 3` drive a
mock exam; `/sure 70` records her confidence before the next check; `/review` asks for a review); the Primer assembles lines from `key` messages itself.

The Primer answers with one message per reading:

```json
{"t":"primer","v":1,"id":"pr_3","mode":"offline","model":null,
 "proof":{"title":"√2 is irrational","goal":"\\sqrt{2}\\notin\\mathbb{Q}","technique":"contradiction",
   "steps":[{"n":1,"latex":"\\sqrt{2}=\\tfrac{p}{q},\\ p,q\\in\\mathbb{Z},\\ q\\neq 0","text":"Suppose √2 = p/q",
             "justification":"assumption for contradiction","refs":[],"concepts":["contradiction"],
             "confidence":0.93,"status":"gap","note":"lowest terms is never assumed",
             "strokes":["u_12","u_13"],"bbox":[0.11,0.31,0.62,0.36]}],
   "tex":"\\documentclass{article}…","check":{"prover":"lean","status":"failed","detail":"…"}},
 "findings":[{"id":"sqrt2_no_lowest_terms","label":"Never assumes p/q is in lowest terms","step":1,"kind":"missing_rigor"}],
 "grade":{"score":2,"max":10,"band":"partial","estimate":true,"rigor":"…","exposition":"…"},
 "move":{"kind":"socratic","text":"In step 5 you conclude both p and q are even. Why is that a contradiction?",
         "glance":"Primer: why is 'both even' a contradiction?","step":5,"hint_level":0},
 "learner":{"name":"nell","summary":"…","mastery":[{"concept":"parity","label":"Parity","p":0.71}],
            "misconceptions":[{"id":"…","label":"…","count":1}],"due":["induction"]},
 "plan":{"exam":"2026-12-05","weeks":[{"n":1,"start":"2026-10-12","focus":["…"],"problems":12,"mock":null}],
         "queue":[{"id":"pigeonhole_square","title":"…","why":"stretch"}]}}
```

Fields:
- `mode`: `live` (a Claude model read the page; `model` names it) or `offline` (no API key: a
  fixture transcription matched to these strokes, or nothing). Clients show which.
- `proof.steps[]`: one per logical step, in order. `latex` is the step re-typeset (KaTeX-safe,
  no `$` delimiters), `text` a plain reading, `justification` the reason the learner gave (or
  `""`), `refs` the earlier step numbers it uses, `concepts` concept ids (ADR 010's graph),
  `confidence` the recognizer's 0..1, `status` `ok` | `gap` | `error` | `unclear`, `note` the
  Primer's one-line comment. `strokes` are the `stroke_begin` ids of the ink the step was read
  from and `bbox` their normalized bounds `[x0, y0, x1, y1]`: a client highlights them when the
  step is tapped.
- `proof.tex`: a complete LaTeX document. `proof.check.status` is `checked`, `failed` or
  `not_checked`; `checked` only ever follows a prover run that succeeded.
- `grade`: a Putnam-style 0–10 estimate, always `estimate: true`; `band` is `complete` (10),
  `minor_flaws` (8–9), `partial` (1–7) or `none` (0).
- `move.kind`: `socratic` | `hint` | `worked_example` | `affirm` | `debrief` | `notice` (the
  Primer could not read the page, e.g. offline with unknown ink) | `silence`. `glance` is one line
  (at most 48 characters) for the glasses. A `silence` move is never sent: the Primer simply
  waits. `move.finding` names the catalog entry the move addresses.
- `learner` and `plan` summarize the learner's file, which stays on the desktop (ADR 010);
  `learner.name` says whose it is. `plan.queue[]` items carry `why`, the coach's reason.
- `coach`: the practice coach's view: `watching` (consented and on), `next` (suggested problems,
  each with `why`), `weak` (weak concepts and recurring misconceptions, each with `why`),
  `attempts` (count), `last_reading` (the document she last had open), `nudge` (one short line
  after an attempt, or null).
  `coach.potd` is the problem of the day (the same all day, with its statement).
- `markup` (after `grade`): the teacher's marks, drawn as agent ink in the same moment. `layer` is
  `codrawer: teacher`, `author` `primer:teacher`, `color` `#d03030`; each of `marks[]` has `id`,
  `kind` (`caret`, `circle`, `underline`, `strike`, `question`, `check`, `comment`, `arrow`,
  `score`, `summary`), `step`, `finding`, `short` (what is written on the page, at most about
  eight words, a pointer and never the fix), `long` (the explanation for the phone), `latex` (the
  step's), `bbox` (normalized) and `strokes` (the ids of its ink). Clients list the marks, explain
  one when it is tapped, and hide or show them as one layer by author.
- `mock` (while a mock exam exists): `id`, `status` (`running` | `awaiting_grading` | `graded` |
  `abandoned`), `phase` (`session` | `break` | `before` | `done`), `session` and `of`, `until`
  (Unix ms when the phase ends: clients count down themselves), `cursor` (the problem being
  written), `problems` (the session's three, with statements: the text fallback when agent ink is
  off), `grade_after` (Unix ms), `fresh_page` (the Primer waits for a fresh page to write the
  problems), `glance` (the glasses' quiet line), and once graded `report` (`total` of `max` 120,
  `estimate: true`, and per problem `session`, `n`, `title`, `score`, `band`, `rigor`,
  `exposition`, `findings`).
- `metacog`: her side of the model (ADR 010): `calibration` (`curve` of bins with mean
  `confidence`, mean `outcome` and `n`; `brier`; `gap`, positive when more sure than the grades;
  `flags` per technique), `calibration_nudge`, `goals` (`target`, `target_score`, `topics`,
  `weekly_hours`, `nudging`, `revisit_days`, `agreed_ms`, `history`), `goals_revisit` (the Primer
  may offer to revisit them), `features` (per kind of watching: `on` and `label`; all off until she
  turns them on), `review` (the next due item: `id`, `kind`, `prompt`, `r`, or null), `items`
  (count), and, with activity review on, `insights` (`id`, `kind`, `text`, `suggestion`,
  `confidence`, `evidence` with replay links).
- `report` (after `report` or the dock's `my_progress`): `file`, `url` (a path on the desktop
  router, `GET /primer/reports/<learner>/<file>`), `portfolio` (her reports so far), or `error`.
- `proof`, `findings`, `grade` and `move` are absent from an answer to `plan`, `forget` or the
  coach dock entry, and from mock updates.

The Primer never draws on the user's layer. When it writes on the page (a suggested problem, a
mock's problems, the teacher's marks, and later its replies: ADR 009, call and response), its ink
is `stroke_*` on the `ai` layer like any agent ink (ADR 003), with an `author` (`primer:teacher`
for marks) and, on `stroke_begin`, `ink_layer`: the named native layer a tablet with native agent
ink should commit it to (`codrawer: teacher`), so the marks hide and undo as one layer there too.
The strokes carry real point timestamps; they are sent at that pace and pause while the learner's
pen is down.

### `dock_entries` and `dock_query` (agents → the tablet's dock)

The dock's entries come from `/run/codrawer/dock.json` (`{"entries":[{"id","label"},…]}`, see
`dock_action`). An agent announces the entries it answers, so the tablet's bridge can write them
there (merging owners, each owner's list replaced whole; the bridge side is not built yet, and
until it is the extension's built-in list carries the same ids):

```json
{"t":"dock_entries","owner":"primer","entries":[
  {"id":"practice_coach","label":"Practice coach · watching","badge":"watching","hint":"What's next, weak spots, today's plan"},
  {"id":"ask_page","label":"Ask about this page","hint":"The Primer reads the proof on this page"},
  {"id":"ask_selection","label":"Ask about selection","kind":"selection","hint":"The Primer reads the selected ink"},
  {"id":"grade_page","label":"Grade this page","hint":"Teacher's marks in red, on their own layer"},
  {"id":"grade_selection","label":"Grade selection","kind":"selection","hint":"Teacher's marks on the lassoed proof"}]}
```

The desktop router sends the Primer's entries to every joining client when `CODRAWER_PRIMER=1`,
and again in answer to `{"t":"dock_query"}`. While the practice coach is watching, its entry's
label says so and `badge` is `"watching"` (ADR 010: the learner always sees that it is on). The
Primer acts on `dock_action` `practice_coach` (the coach view, and the next problem written onto
the page as agent ink), `ask_page` (a reading of the page), `ask_selection` (a reading of the
strokes inside the lasso's `bbox`), `grade_page` and `grade_selection` (the same, marked up in red
pen). All routers relay the three messages as they are.

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


