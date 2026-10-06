# ADR 009 — Portable sessions, and call and response in native ink

Status: proposed (2026-10-06) · Owner: Alif / SIG platform · Related: ADR 003 (agent ink is a
governed action), ADR 005 (reply sinks), ADR 007 (surface composition), ADR 008 (universal page
model), `docs/investigations/native-multiplayer-layer.md` (Probe 1), `docs/protocol.md`

## Context

Probe 1 (2026-10-06) showed that codrawer can put a stroke on the reMarkable's open page as real
xochitl ink: through xochitl's own pen-commit path (`SceneController.addDrawingLine`), on a layer
of its own, rendered at once, saved into the notebook and undone by the user's undo. Until then
agent ink lived only on viewers (glasses, phone, web); on the tablet the agent could only type
into a focused text box through a virtual keyboard, which loses characters.

That changes what a session can be. The user writes on paper; an agent answers on the same paper,
in handwriting, next to the question; the glasses show the same exchange live; and the session
should follow the user between the tablet, the phone and the desktop without exposing anything to
the internet.

## Decision

### 1. Call and response in native ink

A reply to something the user wrote or typed on the tablet comes back as ink on the same page.

- **Trigger.** A keyboard line starting with `@ask ` (and the existing `/term`), or a dock action
  (`ask_page`, `ask_selection`, see 4). The command's text and the page (its `page` snapshot, and
  for a selection the lasso's bounding box) go to the agent.
- **Reply as strokes.** Text from an agent (a `/term` reply, the router's AI worker) is rendered
  into strokes by a handwriting library, `packages/hand` (personas: a hand, a pace, jitter), with
  Hershey script plus jitter as the fallback. Strokes are sent on `layer:"ai"` at writing pace, so
  every surface sees the reply write itself in.
- **Placement.** Below the user's last stroke near the command, or in the margin, keeping clear of
  existing ink using the snapshot's per-stroke bounding boxes; never across user ink.
- **On the tablet**, with `NATIVE_AGENT_INK=1`, the bridge forwards each finished ai stroke to the
  codrawer-layer extension, which commits it on the layer `codrawer: agent` of the visible page.
  The user undoes it like their own ink; it is saved and synced like their own ink.
- **Everywhere else** the ai strokes render live as they do today. The page snapshot labels the
  agent layer's strokes `"layer":"ai"`, and clients let the snapshot replace their live copies,
  so nothing is drawn twice.

### 2. Governance (ADR 003, made concrete)

- Agent ink goes only to codrawer's own layer, never into a user layer, and only onto the page on
  screen; the extension checks both before every commit and re-checks at each step.
- Opt-in: `NATIVE_AGENT_INK` is off by default; the user turns it on (bridge.env today, the dock's
  "Agent ink on/off" next).
- Caps in the bridge: only `layer:"ai"`; 32 strokes in progress, 4000 points per stroke, a token
  bucket of 40 strokes refilled at 15 per second. Caps in the extension: 64 strokes per message,
  page-range coordinates, ink tools only (no eraser, highlighter or selection).
- The write-back guard: nothing is committed while the user's pen or finger is on the page.
- Anyone who can join the session with its pairing code can send agent ink; the code is the trust
  boundary until participants carry identities (ADR 008 §2).

### 3. Handwriting personas

A persona is a named hand: glyph set, slant, size, pace (ms per stroke, pauses between words),
pressure profile and colour. The same reply text rendered by the same persona looks the same on
every surface. Personas belong to `packages/hand`; the bridge and the extension know nothing of
them (they see strokes).

### 4. `@` and `#` context references, and the dock

- In the glasses' input line first: `@` names a participant or agent (`@claude`, `@coach`), `#`
  names context (`#page`, `#selection`, `#doc:<title>`); completion comes from the router's
  session state.
- On the tablet later, as a native popup injected by the codrawer-layer extension (XOVI, runtime
  QML, nothing on disk changed). The first piece exists: a toolbar **dock** whose entries come
  from `/run/codrawer/dock.json`, sending `dock_action` messages (docs/protocol.md) that agents act
  on. A selection's "Ask agent" sends the lasso's bounding box with `ask_selection`.

### 5. Portable sessions over Tailscale

The user's tailnet (the tablet, the iPhone, the desktop `aleph-desktop`) is the network a
session lives on: the tablet's router (`-serve :8577`) and the desktop router are reachable at
their tailnet names from anywhere the user's devices are, with no port open to the internet, no
public relay and no exposure beyond the tailnet's ACLs. A session is addressed by its router and
session id (`ws://remarkable.<tailnet>.ts.net:8577/ws/session1`), so a client moves between
Wi-Fi, cellular and the desktop without changing anything but the network it rides on. The
pairing code stays as a second factor. Funnel and public sharing stay off.

## Consequences

- Agent ink becomes part of the user's notebook: durable, synced, undoable. That is the point, and
  the reason it is opt-in and capped.
- The extension is version-bound to xochitl's meta-object names and the `Line` layout; the
  run-time checks refuse to commit on a mismatch, and `xovi-compat.conf` gates new OS versions.
- Clients must honour `"layer":"ai"` in snapshots (the Even G2 app does as of this ADR).
- Restarts of xochitl to load a new extension build are a hazard (the 2026-10-06 reboot): only
  through `boot.sh xovi off|on`, never within 20 s of xochitl's last start.

## Status of the pieces (2026-10-06)

Verified on the device: native commit, save and undo (Probe 1). Built and tested off-device:
placement through the view transform, the ink socket, bridge forwarding (Go and Rust),
snapshots labelling agent ink, the dock and `dock_action`, text insertion into the focused text
box. Not built: `@ask`, the reply placement and handwriting personas in the loop (`packages/hand`
had not landed), `#`/`@` completion, the native popup.
