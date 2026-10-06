# codrawer-layer (XOVI probe)

> **Status (2026-10-06): run on the device (3.29.0.149, tethered).** `dump` and the erase probe's
> `watch` work: `strokeCompleted` decodes ink, the eraser end and the toolbar eraser
> (`docs/investigations/native-erase.md`). Tool following (below) feeds the bridge. `stroke` (Probe 1)
> and the `save` routes are still untested. Since 2026-10-06 every codrawer release ships it, and
> the tablet starts it after each boot under a crash guard (Install, below).

A XOVI extension that runs inside xochitl on the reMarkable Paper Pro and puts a stroke on the
open page, on its own layer named `codrawer: test`, through xochitl's own commit path
(`SceneController.addDrawingLine` + `SceneTileManager.renderLineToTiles`). It is Probe 0 and
Probe 1 of `docs/investigations/native-multiplayer-layer.md`; the results are recorded there.

It hooks no function. It finds the visible DocumentView, takes its `SceneController`, pen handler,
tile manager and viewport, and calls their meta-methods by name on the GUI thread. The stroke's
`Line` value is created by xochitl's own default constructor (through `QMetaType`) and then given
our points by filling its documented fields; `main.cpp` explains the layout and the run-time
checks that refuse to build a `Line` if this xochitl differs.

Target (run on it): reMarkable 3.29.0.149 / Codex 6.0.105, xochitl Qt 6.10.3, XOVI v0.3.3
(`xovi.so` sha256 `d4df820c25c634c511de11067279d8310fa4f656dc52bd4540db6beac4ffd446`, identical in
rm-xovi-extensions `v19-23052026` and `pre-v20-08092026`). The build is reproducible: the same
source gives the same `codrawer-layer.so` hash.

## Build

```bash
bridge/remarkable/xovi/codrawer-layer/build.sh      # needs Docker; output in out/
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
| `save page=<uuid> via=deferred\|modified\|abouttosleep\|sleepcycle` | Asks xochitl to store the page's pending lines now through one of its own meta-methods (see `main.cpp` `cmdSave`); with `watch` on, `worker.linesStored` shows whether and when it did. Try the routes in that order; `sleepcycle` last. |
| `dumpscene page=<uuid>` | Calls xochitl's debug slot `SceneController::dumpScene()`; output, if any, goes to xochitl's journal. |
| `tool` | Logs the tool line last written to `/run/codrawer/tool` (see below). |

```bash
ssh root@<tablet> 'echo "stroke page=<page-uuid>" > /tmp/codrawer-layer/cmd; sleep 2; tail -n 20 /tmp/codrawer-layer/log'
```

## Following the tool (`/run/codrawer/tool`)

From load on, without a command, the extension follows the pen handler's `lineTool` and
`lineThickness` (100 ms timer on the GUI thread: two property reads) and writes one line,
`<tool> <thickness>`, to `/run/codrawer/tool` by rename on every change, plus a rewrite every
second as a heartbeat. Tools: `eraser`, `erase_area`, `clear_page`, `select`, `highlighter`,
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
