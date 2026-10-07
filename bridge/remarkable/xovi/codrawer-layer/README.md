# codrawer-layer (XOVI extension)

> **Status (2026-10-06): runs at every boot on the device (3.29.0.149).** Verified there: `dump`,
> the erase probe's `watch`, tool following, **Probe 1** (a stroke on its own layer; renders,
> saves, undoes), agent ink through the socket placed in page coordinates (verified at pan and
> zoom), the dock and its actions, the lasso follower. Built, less exercised on the device: text
> insertion routes, UI automation milestones 2 and 3 (`grab`, input, navigation).

A XOVI extension that runs inside xochitl on the reMarkable Paper Pro. It puts strokes on the
open page, each source on its own layer (`codrawer: agent`, `codrawer: test`), through xochitl's
own commit path (`SceneController.addDrawingLine` + `SceneTileManager.renderLineToTiles`); it
types text into the focused text box, follows the selected tool and the lasso, injects a dock
button into the toolbar, and offers a guarded UI automation socket. It is Probe 0 and Probe 1 of
`docs/investigations/native-multiplayer-layer.md`, grown into the native half of codrawer.

It hooks no function. It finds the visible DocumentView, takes its `SceneController`, pen
handler, tile manager and viewport, and calls their meta-methods by name on the GUI thread. A
stroke's `Line` value is created by xochitl's own default constructor (through `QMetaType`) and
then given our points by filling its documented fields; `src/line_layout.h` explains the layout
and `src/line.cpp` the run-time checks that refuse to build a `Line` if this xochitl differs.

Target (run on it): reMarkable 3.29.0.149 / Codex 6.0.105, xochitl Qt 6.10.3, XOVI v0.3.3
(`xovi.so` sha256 `d4df820c25c634c511de11067279d8310fa4f656dc52bd4540db6beac4ffd446`, identical in
rm-xovi-extensions `v19-23052026` and `pre-v20-08092026`). The build is reproducible: the same
source gives the same `codrawer-layer.so` hash.

## Module map

Every module opens with its own prose overview (the problem, the facts and measurements it rests
on, the data flow, the threading). Read them in this order:

| # | module | lines | what it is |
| --- | --- | --- | --- |
| 1 | `src/entry.cpp` | 109 | `_xovi_construct`, the extension's thread, and the wiring of the modules (hooks) |
| 2 | `src/log.{h,cpp}`, `src/paths.h` | 146 | one stamped log line per fact; every file and socket path |
| 3 | `src/qtmeta.{h,cpp}` | 303 | meta-calls by name (`invoke`), signals into functions (`Relay`), `waitFor` |
| 4 | `src/scene.{h,cpp}` | 347 | the item tree, the visible page (`findOpenPage`), layers, selectors, `tree` |
| 5 | `src/line_layout.h` *(pure)*, `src/line.{h,cpp}` | 323 | xochitl's `Line` bytes; building one from our points, reading one back |
| 6 | `src/ink.{h,cpp}` | 370 | the commit chain: our layer, `addDrawingLine`, the user's layer back; the queue |
| 7 | `src/toolfollow.{h,cpp}` | 273 | the visible pen handler: `/run/codrawer/tool`, the followed view, the write-back guard |
| 8 | `src/text.{h,cpp}` | 204 | text into the focused text box (route A `replaceText`, route B input method) |
| 9 | `src/ink_protocol.h` *(pure)*, `src/inksock.{h,cpp}` | 521 | `/run/codrawer/ink.sock`: agent ink and its governance, text ops, goto, status, actions |
| 10 | `src/selection.{h,cpp}` | 171 | the last lasso selection (`areaSelected`) |
| 11 | `src/goto_req.h` *(pure)*, `src/navigate.{h,cpp}` | 491 | "take me there": open a document by id, turn to a page, flash a region; folders; offers |
| 12 | `src/live.{h,cpp}`, `qml/live.qml` | 234 + 555 | agent ink drawn as it streams in (Pen region), removed at commit; the "thinking" animation |
| 13 | `src/inject_conf.h` *(pure)*, `src/inject.{h,cpp}` | 439 | QML injected into xochitl (the dock), `inject.conf`, dock actions to the bridge |
| 14 | `src/auto_rules.h` *(pure)*, `src/autostate.{h,cpp}` | 294 | automation's guardrails; `state`, `find`, pause and lock |
| 15 | `src/procmaps.h` *(pure)*, `src/grab.{h,cpp}` | 140 | `grab`: the display buffer copied out of xochitl's memory |
| 16 | `src/autoinput.{h,cpp}` | 258 | synthesized taps and swipes behind the deny list; navigation; text |
| 17 | `src/automation.{h,cpp}` | 244 | `auto.sock` and `127.0.0.1:8579`, the opt-in, request dispatch |
| 18 | `src/cmdline.h` *(pure)*, `src/cmdline_qt.h`, `src/commands.{h,cpp}` | 242 | the command file `/tmp/codrawer-layer/cmd` |
| 19 | `src/probes.{h,cpp}`, `src/watch.{h,cpp}` | 631 | **probes**: `dump`, `linetest`, `stroke`, `tree`, `xform`, …; the erase probe `watch` |

What each module uses (besides `log`, `paths` and `qtmeta`, which nearly all use); the graph has
no cycle:

```
log, paths, the pure headers         (depend on nothing of ours)
qtmeta     <- log
scene      <- qtmeta
line       <- line_layout
toolfollow <- scene
text       <- toolfollow
ink        <- line, scene, toolfollow, ink_protocol
navigate   <- scene, toolfollow, goto_req
live       <- toolfollow
inksock    <- ink, text, navigate, live, ink_protocol
selection  <- scene, toolfollow
autostate  <- scene, toolfollow
inject     <- inksock, selection, autostate, navigate, inject_conf
grab       <- procmaps
autoinput  <- autostate, grab, text, navigate, auto_rules
automation <- autoinput, autostate, inksock, auto_rules
probes     <- ink, line, scene;  watch <- line, scene
commands   <- probes, watch, inject, navigate, toolfollow
entry      <- everything it wires
```

Where a module must tell one that depends on it, it offers a hook that `entry.cpp` sets: the
user's pen pauses automation; the bridge's status line, automation clients coming and going, and
a settled lasso and a "Go to …?" offer coming or going refresh or create the injected UI.

*(pure)* headers use no Qt and are tested on the desktop (`test.sh`, `tests/*_test.cpp`).

## Build and test

```bash
bridge/remarkable/xovi/codrawer-layer/build.sh      # needs Docker; output in out/
bridge/remarkable/xovi/codrawer-layer/test.sh       # host tests of the pure headers (Docker, any g++ image)
bridge/remarkable/xovi/codrawer-layer/qmltest.sh    # the injected QML, offscreen (Docker, Qt 6 QML runtime)
scripts/dev/inktest.py                              # on-device regression: agent ink lands where aimed
```

The first run builds `codrawer-xovi-build:trixie` (Debian trixie, aarch64 g++, Qt 6.8 arm64).
An extension built against Qt 6.8 runs on the tablet's Qt 6.10.3 (Qt 6 binary compatibility).
`_xovi_construct` is marked `visibility("default")`: under `-fvisibility=hidden` it was missing
from the dynamic symbol table, and xovi loaded the extension without ever calling it.

## Install: every codrawer release, started at boot

`scripts/dev/deploy-tablet.sh` builds this extension (`build.sh`) and puts it in the release's
`xovi/` with XOVI's `xovi.so`, `start` and `stock` (pinned by sha256, taken from
vendored in `../vendor`), all covered by the release signature. qt-resource-rebuilder is **not**
shipped, so no `rebuild_hashtable` is needed.

On the tablet, `boot.sh start` (the boot stub) starts the bridge and then `codrawer-xovi.service`,
which runs `bridge/remarkable/boot/xovi.sh boot`. It installs the payload into `/home/root/xovi`
(XOVI's own layout) and runs XOVI's own tethered `start`: a tmpfs over
`/etc/systemd/system/xochitl.service.d` with the `LD_PRELOAD` drop-in, then one xochitl restart.
It does so only on an OS listed in `bridge/remarkable/boot/xovi-compat.conf`, without the kill
switch `/home/root/codrawer/XOVI_DISABLED`, and once xochitl has run settled for 20 s. For 60 s
after the start it watches xochitl; at the first sign of trouble it runs `stock` and writes the
kill switch with the reason. The full rules are in `xovi.sh` and `docs/what-codrawer-changes.md`
("XOVI").

```bash
ssh root@<tablet> sh /home/root/codrawer/current/boot.sh doctor     # xovi=running | disabled (…) | …
ssh root@<tablet> journalctl -u codrawer-xovi                       # what the guard saw
```

A new extension in a release replaces the file only while XOVI is not running (a mapped `.so` is
never rewritten), so it takes effect at the next boot; `doctor` says so meanwhile.

By hand, for a quick test of a new build without a release (gone at the next reboot):

```bash
sh /home/root/codrawer/current/boot.sh xovi off                    # stock, so the .so is not mapped
scp out/codrawer-layer.so root@<tablet>:/home/root/xovi/extensions.d/
/home/root/xovi/start                                              # unguarded; the next boot reinstalls the release's copy
```

## Use

Commands go into `/tmp/codrawer-layer/cmd` (one per line); results are appended to
`/tmp/codrawer-layer/log`. Commands that change the page must name it, and are refused unless
that page is the one on screen.

| command | effect |
| --- | --- |
| `dump` | Probe 0: logs the meta-objects of SceneController, the pen handler, tile manager, viewport, the pen-input pipeline, the `Line` gadget and `Scene::LayerState`, and the current layer list. Read-only. |
| `linetest` | Builds a `Line` with the probe's points and reads it back through the gadget (`tool`, `pointCount`, `boundingRect`, `lineLength()`). Touches no scene. |
| `pencolor page=<uuid> argb=<hex>` | Writes `penHandler.lineArgbCode`, reads it back, restores the old value. |
| `layers page=<uuid>` | Logs the page's layers, current layer and undo state. |
| `stroke page=<uuid> [argb=<hex>]` | Probe 1: creates (or reuses) the layer `codrawer: test`, selects it, commits one hard-coded 120-point fineliner wave in the given ARGB colour (default `ff1f6fe0`), renders it to tiles, repaints, and selects the user's layer again. |
| `watch page=<uuid> [full=1]` | Erase probe (`docs/investigations/native-erase.md`): connects a logging receiver to the pen handler's `strokeCompleted(Line)` (decoded; eraser paths, or every path with `full=1`, are written to `/tmp/codrawer-layer/line-<ms>.txt`), `gestureStarted/Ended`, and every signal of the page's SceneController, DocumentWorker (except `tileReady`), QmlDocumentWrapper and DocumentLockManager. Hooks no function; rate-limited to 20 lines per signal per second. Read-only. |
| `unwatch` | Disconnects everything `watch` connected. |
| `pending page=<uuid>` | Logs whether the document has unsaved lines and the worker's queue (read-only). |
| `save page=<uuid> via=deferred\|modified\|abouttosleep\|sleepcycle` | Asks xochitl to store the page's pending lines now through one of its own meta-methods (see `src/watch.cpp` `cmdSave`); with `watch` on, `worker.linesStored` shows whether and when it did. Try the routes in that order; `sleepcycle` last. |
| `dumpscene page=<uuid>` | Calls xochitl's debug slot `SceneController::dumpScene()`; output, if any, goes to xochitl's journal. |
| `tool` | Logs the tool line last written to `/run/codrawer/tool` (see below). |
| `stroke … adopt=<n> restore=<n>` | Probe options: name an existing last layer instead of adding one; select layer `n` afterwards. |
| `xform page=<uuid>` | Logs every view↔scene transform xochitl exposes for the page (read-only). |
| `tree [match=<spec>] [depth=<n>]` | Logs the live QML item tree, or the items matching `class:`/`name:`/`text:`/`prop:` with their ancestry (read-only; for finding where to inject). |
| `inject name=<n> parent=<spec>[^] qml=<file> [after=1]` | Creates our QML file in xochitl's engine, parented into the matched item (`^`: its parent; `after=1`: stacked after it). `uninject name=<n>` removes it. `exthome/codrawer-layer/inject.conf` lists the ones to make from load on. |
| `goto_doc doc=<uuid> [page=<uuid\|index>] [region=x0,y0,x1,y1] [flash=0]` | Opens the document (any, by id), turns to the page, frames the region (normalised) for 2 s (`src/navigate.h`). Navigation: the open document closes. The automation socket has the same as `goto_doc`, plus `goto` (a page in the open document). |
| `folder action=enter\|up\|home [id=<uuid>]` | Library folders through xochitl's explorer (`enter` closes the open document, as "show in folder" does). |

## The socket: agent ink, text, actions (`/run/codrawer/ink.sock`)

A Unix socket (0600) the bridge connects to (`INK_SOCKET`, `agent_ink.go` / `agent_ink.rs`). On
connect the extension says `hello codrawer-layer ink text_insert text_read goto`. Then, one JSON
object per line:

- **Agent ink** (with `NATIVE_AGENT_INK=1` on the bridge): `{"id","page","layer":"agent",
  "strokes":[{"tool","argb","thickness","pts":[[x,y,pressure,width_px],…]}]}` in page units
  (x centred). The extension refuses any page but the visible one, any tool that is not ink, more
  than 64 strokes or 4000 points, and out-of-range points; it commits into the layer
  `codrawer: agent` in page coordinates, unmapped (`addDrawingLine` takes page coordinates:
  verified on the device 2026-10-06 at pan and zoom; native-multiplayer-layer.md, Probe 1
  item 4). It waits
  while the user's pen is down. Answer: `ok <id> <n>` or `err <id> <why>`.
- **Text**: `{"op":"text_insert","id","text"}` puts text into the focused text item of the visible
  page, as an input method's commit (Return between lines); `{"op":"text_read","id"}` answers
  `text <id> {…}`. Refused (`err`) with no focused text item on the page, or while the pen is down.
- **Take me there** (`src/navigate.h`): `{"op":"goto","id","doc","page","region","flash","mode",
  "reason"}` opens the document through xochitl's own path (`MainView.onOpened`), turns to the page
  (`DocumentView.openPage`) and frames the region for 2 s. `mode:"go"` (the bridge sets it only
  for the user's own tap elsewhere) navigates; anything else is an offer, "Go to …?", first in the
  dock with a dot on its button, carried out only when the user taps it. Answer: `ok <id> goto …`,
  `ok <id> goto_offer` or `err <id> <why>`.
- **Live ink and thinking** (`src/live.h`, `qml/live.qml`): `{"op":"live","id","page","argb",
  "width","pts":[[x,y,p,t],…]}` (an ai stroke's new points as they stream in),
  `{"op":"live_end","id","committed"}`, `{"op":"overlay","id","kind":"thinking"|"clear","state",
  "bbox","style"}` (from the router's `agent_status`). The overlay plays strokes at the speed they
  were written in an e-paper Pen region, removes each once its native line is committed, and
  plays a small "thinking" animation (styles `pen`, `drop`, `glyph`) that hands off into the
  answer's first stroke. Never saved; paused while the pen is down. No replies. It is anchored
  to the paper (page units; its root follows the tile manager's transform, so it stays put on
  the page while that scrolls or zooms), covers only what it draws, takes no input and is
  destroyed when idle. A tap on Ask starts the doodle at once (pending, below the selection)
  until an agent's status adopts it; with none in 8 s it shows a "?" and the dock says no agent
  answered. `done` ends with a tick, or with the agent's note as a brief caption.
- **Actions** (extension → bridge): `{"t":"dock_action",…}` from the dock and the selection
  menu's Ask (`qml/selection-ask.qml`: after the menu's delete button, shown when the selection
  holds strokes; it sends what the dock's "Ask about selection" sends, with source `selection`).

## The dock (`qml/dock.qml`)

A toolbar button with a panel beside it. Entries come from `/run/codrawer/dock.json`
(`{"entries":[{"id","label"},…]}`, re-read on change) or the built-in list: codrawer status
(answered on the tablet), Agent ink on/off, Practice coach, Ask about this page, Ask about
selection. A tap sends a `dock_action` (docs/protocol.md). Where it goes is a line in
`inject.conf`, found with `tree` on the device; the release ships `dock.qml` and `inject.conf`
into `exthome/codrawer-layer/` (xovi.sh).

The button is xochitl's own `ArkControls.ToolButton` (the face of every toolbar button), created
at run time, so it shows the native press feedback (a black cell, the icon inverted) and stays
"selected" while its list is open, like the layers button. Like undo and redo it is an action:
it never selects itself in the toolbar, so the drawing tool stays as it was. Without
`ark.controls` it falls back to the same look in plain QtQuick (confirmed on the device).

The panel is built like xochitl's own toolbar foldouts (ToolbarFoldout): an item in the toolbar's
tree, not a Popup; white, a 2 px black border, 112 px rows with 32 px Medium labels, 2 px
dividers, a pressed row inverted, and the status reply as its last row. It marks itself an e-paper
Overlay region (`xofm.libs.epaper` ScreenModeItem) and blocks the pen under it
(`PenInputBlocker`), as xochitl's on-canvas UI does: the first version, a QtQuick.Controls Popup,
let the page's ruled lines show through its white rows on the device. A tap outside closes it.
`qmltest.sh` loads the file offscreen on the desktop with and without stand-ins for xochitl's
modules and fails on any QML warning (one on the tablet would trip the XOVI_NO_INJECT gate).

```bash
ssh root@<tablet> 'echo "stroke page=<page-uuid>" > /tmp/codrawer-layer/cmd; sleep 2; tail -n 20 /tmp/codrawer-layer/log'
```

## Following the tool (`/run/codrawer/tool`)

From load on, without a command, the extension follows the pen handler's `lineTool` and
`lineThickness` through their change signals and writes one line, `<tool> <thickness>`, to
`/run/codrawer/tool` by rename on every change; a 2 s timer touches the file (utime) as a
heartbeat and looks for the pen handler only while none is known. Tools: `eraser`, `erase_area`, `clear_page`, `select`, `highlighter`,
`shader`, `zoom`, `pen`, or `none` when no document is open. The bridge (`TOOL_FILE`, package
`toolhint`) reads it at each pen-down and streams tip strokes as brush `eraser` while it says
`eraser`, the way it already streams the eraser end. A file older than 3 s is ignored, so a
stock xochitl leaves the bridge as before. `/run` is tmpfs.

Measured on 3.29.0.149 (2026-10-06): `strokeCompleted` gives `tool=6 eraser=1 thickness=4` for
the toolbar eraser (size 2) used with the tip, and `thickness=5.76` for the Marker's eraser end.
Ink is `eraser=0` (tool 13 SharpPencilv2, 21 Calligraphy).

## Remove

- Off, now and at every later boot: `sh /home/root/codrawer/current/boot.sh xovi off` (runs
  `stock`, writes `XOVI_DISABLED`). Back on: `boot.sh xovi on`.
- Files: after `xovi off`, `rm -rf /home/root/xovi /tmp/codrawer-layer`.

The test layer and stroke are ordinary page content: undo them in xochitl, or delete the layer
from the layers panel.

## Measured on the device (2026-10-06)

- **Idle cost of tool following.** xochitl over 60 s with hands off, the event-driven build
  (signals plus a 2 s heartbeat): 7 ticks of CPU (utime+stime at 100 Hz, about 0.1 %) and 82
  voluntary context switches. The 100 ms polling build measured 613 and 1589 ticks in two noisy
  runs (another deploy in one, possibly the user's pen in the other), so the comparison is
  indicative, not exact.
- **The dock.** `tree match=name:toolbarLayout depth=1` showed the left toolbar as a GridLayout
  of 112 × 112 ToolLoaders (`editingToolLoader_redoButton` at y 876). Injected after redo at run
  time (no restart), the dock took the next cell (0,988 112×112) and the spacer below shrank by
  112. The user tapped every entry: each `dock_action` reached the bridge's log, and
  `ask_selection` carried the lasso's rect (`areaSelected(0, QRectF(-480.8,2982.8 209.9x331.9))`
  on a scrolled page).

## More socket lines

- bridge → extension: `status <text>` (shown under "codrawer status"; the bridge sends it on
  connect and when the dock's "Agent ink on/off" toggles native agent ink, a choice the bridge
  keeps in `/home/root/codrawer/state/native_agent_ink`).
- `text_insert` tries route A first: `SceneController.replaceText` on the page's focused root
  text document, verified by `rootDocumentLength` (`ok … via=replace len a->b`, or `unverified`).
  The focused item's input method (route B) is the fallback. `textprobe page=<uuid>` logs the
  text API's state and the signatures of the text and image members (read-only).

## Injection options and gates

`inject.conf` lines may add `when=selection` (made right after a lasso, when the selection menu
exists, instead of by the 2 s tick) and `inert=1` (taps are logged, never sent: a new button's
first rollout). `qml/selection-ask.qml` ("Ask agent") is shipped but not yet listed: the first
lasso after load logs the selection menu's tree, which decides its line. After each guarded start
xovi.sh checks that `codrawer-layer.so` is mapped and that xochitl's journal holds no error from
our QML; such an error writes `XOVI_NO_INJECT` (no injections; ink and text go on).
