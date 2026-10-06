# UI automation inside xochitl: design

Status: design (2026-10-06), approved by the user; implementation follows in milestones.
Related: `bridge/remarkable/xovi/codrawer-layer` (the extension this lives in),
`docs/investigations/native-multiplayer-layer.md` (the meta-call pattern, Probe 1),
`docs/investigations/keyboard-and-text.md` (text routes), ADR 003 (governed agent actions).

## The problem

Every device check so far needed the user's hands: open the notebook, go to the page, focus a
text box, lasso, tap the dock, tap undo. Overnight and in CI-like loops nobody is there. A
Playwright-style driver that runs *inside* xochitl can do these steps the way the UI does them,
read the result back from xochitl's own objects, and screenshot it, so that a flow is a script
with a pass/fail per step.

Inside the process is the point: synthesized Qt events reach the QQuickWindow directly (no
uinput, no keymap, no dropped keys, no echo into the bridge's pen reader), and state is read
from the same objects the UI binds to, not inferred from pixels.

## The facts it rests on

- codrawer-layer already finds the visible `DocumentView`, its `SceneController`, pen handler,
  tile manager and viewport; walks the item tree (`tree`); calls meta-methods by name on the GUI
  thread (`invoke`); waits on conditions without blocking (`waitFor`); and creates QML in
  xochitl's engine. Probe 1 and the dock proved each on 3.29.0.149.
- The toolbar is a GridLayout of ToolLoaders with stable objectNames
  (`editingToolLoader_<tool>`, `secondaryToolLoader_<tool>`), so tools have selectors.
- Mouse events reach xochitl's MouseAreas (the injected dock's MouseArea received the user's
  taps), so taps can be synthesized as QMouseEvents to the window; QTouchEvents are the second
  route for items that only take touch (smart_remarkable: TapHandler).
- Layer and selection changes land a moment after the call (scene jobs), so every action is
  followed by a wait on its observable effect, not a sleep.

## The interface: /run/codrawer/auto.sock

A second Unix socket (0600, root), separate from the ink socket so automation can be off while
ink is on. One JSON request per line, one JSON reply per line, in order:

```
{"id":"1","cmd":"state"}
{"id":"1","ok":true,"state":{"locked":false,"doc":{"id":"…","title":"Test"},"page":{"id":"…","index":3,"count":12},
  "tool":"pen 2","zoom":1,"scroll":[0,-342],"focus":"TextLabel","popups":[],"paused":false}}
{"id":"2","cmd":"tap","x":56,"y":1044}                     → {"id":"2","ok":true}
{"id":"3","cmd":"wait_for","cond":"page.index==2","timeout_ms":3000} → {"id":"3","ok":true,"waited_ms":420}
{"id":"4","cmd":"grab","x":0,"y":0,"w":1620,"h":2160}       → {"id":"4","ok":true,"png":"/tmp/codrawer-layer/grab-4.png"}
{"id":"5","cmd":"delete_page"}                              → {"id":"5","ok":false,"error":"blocked: destructive"}
```

Commands, by milestone:

1. **Read and look** (no input): `state`, `find selector` (bounds, visibility, class, text of the
   matching items; selectors are `tree`'s: `class:`, `name:`, `text:`, `prop:`), `grab` (PNG of
   a region; see below), `wait_for cond timeout`.
2. **Navigate** through xochitl's own functions where they exist: `open doc=<id>` (the library's
   open function; else a tap on its tile), `goto page=<id|index>` (`DocumentView.goToPageId` or
   the page controller), `tool name=<pen|eraser|select|…>` (a tap on the ToolLoader found by
   its objectName), `pan`, `zoom`.
3. **Input**: `tap x y`, `long_press x y ms`, `swipe x0 y0 x1 y1 ms`, `stroke points` (a pen
   stroke as tablet events, for lasso flows), synthesized as QMouseEvent (then QTouchEvent if a
   target ignores mice) with `QCoreApplication::sendEvent` to the QQuickWindow, on the GUI
   thread, paced by timers.
4. **Edit** (only in the test notebook, below): `new_page`, `text_insert` (the ink socket's
   routes), `undo`.

`grab` uses `QQuickWindow::grabWindow()`. inkling warns it must not run on the GUI thread on the
rM2 render loop; on the Paper Pro this is checked first in a read-only probe (time it; a hang
would trip xochitl's 60 s watchdog), and the fallback is reading the display buffer from
`/proc/<pid>/mem` (the scratch `fbgrab` tool, read-only, already used in Probe 1).

## Guardrails (hard, in the extension, not the client)

- **Destructive actions are blocked by construction.** There is no command to delete a notebook
  or page, empty the trash, or open account, sync, passcode, security or factory-reset settings.
  Synthesized taps are refused when the item under the point (found with `childAt` down the
  tree) or any ancestor matches the deny list: objectNames and classes containing `delete`,
  `trash`, `erase_all`/`eraseAll`, `reset`, `factory`, `passcode`, `security`, `account`,
  `sync`, `signout`/`logout`; and the settings menu as a whole (`secondaryToolLoader_settingsMenu`).
  The deny list is matched case-insensitively and logged with the refusal.
- **Edits only in "codrawer: test".** Commands that change content (`new_page`, `text_insert`,
  `stroke`, taps while a document other than "codrawer: test" is open) are refused unless the
  visible document's title is exactly that. Navigation and reading elsewhere are allowed.
- **The user wins.** Any physical pen or touch event (the pen handler's `gestureStarted`, or a
  touch reaching the window that automation did not send) pauses automation; every later command
  answers `paused` until an explicit `{"cmd":"resume"}`.
- **Locks are never bypassed.** If the lock screen is up (its item is found in `state`),
  commands other than `state`/`grab` answer `locked`; the driver never types a passcode.
- **Visible and logged.** Every command and its result go to the extension's log; while a
  client is connected the dock shows "automation active".
- Off unless enabled: the socket exists only when `/home/root/codrawer/AUTOMATION` exists (the
  user's opt-in, as a file, like the kill switches).

## The desktop runner: scripts/dev/rmflow.py

`uv run scripts/dev/rmflow.py flows/<name>.json` opens an SSH tunnel to the extension's loopback
listener (127.0.0.1:8579, the same protocol as auto.sock; dropbear forwards TCP ports but not
Unix sockets, and the tablet has no Unix-socket client), so nothing is on the router or the
network, runs a flow's steps
in order, grabs a screenshot after each step that asks for one, and prints a report: step, ok or
the error, time, screenshot path. A flow is a JSON list of commands with expectations
(`expect: {"state.page.index": 2}`), so the flows double as tests.

Sample flows (`scripts/dev/flows/`):

1. `open-test-page2.json`: `state` → `open doc=<codrawer: test>` → `goto page=2` → expect the
   page index → `grab`.
2. `lasso-ask.json`: in the test notebook, `tool name=select` → `stroke` a closed loop around
   existing ink → wait for `selection.items > 0` → tap the selection menu's "Ask agent" → expect
   the bridge to log the `dock_action`.
3. `text-roundtrip.json`: focus a text box (tap the typing tool, then the page) → `text_insert`
   → `text_read` → expect the text back → `undo` → expect it gone.

## As built (2026-10-06)

- Milestone 1 (`state`, `find`, `wait_for`, `resume`, the opt-in file, pause, lock) and the
  pure guardrails (`auto_rules.h`, tested by `test.sh`) are in the extension.
- Milestones 2 and 3 are built and not yet run on the device: `grab` (copies the display buffer
  from the process's own memory and encodes the PNG off the GUI thread), `tap`, `long_press`,
  `swipe`, `tap_item selector`, `tool name` (taps the ToolLoader `editingToolLoader_<name>`),
  `open title` (taps the library tile's title), `goto page` (the first of `goToPageId`,
  `goToPage`, `setCurrentPage` found on the DocumentView chain), and `text_insert`/`text_read`
  (the ink socket's routes; insert only in the test notebook). Every press is checked against
  the deny list on the item under the point and its ancestry; with another notebook open only
  the close button and the page overview may be tapped.
- Open questions for the device: whether xochitl's lasso takes mouse drags at all (the selection
  tool may follow only the pen; then the lasso flow needs a synthesized tablet event), and the
  display buffer's pixel format (Probe 1's grabs came out with shifted colours).

## Milestones

1. This design, then `state`, `find`, `wait_for` on auto.sock (read-only), merged with tests of
   the parsing and guards that run off-device.
2. `grab` after its timing probe; `rmflow.py` with flow 1's read-only part.
3. Navigation and synthesized input with the deny list and the pause; flows 1-3.

Each milestone ships in one release and loads with one guarded `boot.sh xovi on`.
