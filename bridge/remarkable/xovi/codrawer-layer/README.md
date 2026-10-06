# codrawer-layer (XOVI probe)

> **Status (2026-10-05): built, not yet run on the device. Probe 0, Probe 1 and the erase probe
> (`watch`, `save`; `docs/investigations/native-erase.md`) have not been executed.** The tablet went to sleep (off Wi-Fi) before XOVI was installed, so nothing is installed
> on it. The command table below describes what the extension does once it is installed.

A XOVI extension that runs inside xochitl on the reMarkable Paper Pro and puts a stroke on the
open page, on its own layer named `codrawer: test`, through xochitl's own commit path
(`SceneController.addDrawingLine` + `SceneTileManager.renderLineToTiles`). It is Probe 0 and
Probe 1 of `docs/investigations/native-multiplayer-layer.md`; the results are recorded there.

It hooks no function. It finds the visible DocumentView, takes its `SceneController`, pen handler,
tile manager and viewport, and calls their meta-methods by name on the GUI thread. The stroke's
`Line` value is created by xochitl's own default constructor (through `QMetaType`) and then given
our points by filling its documented fields; `main.cpp` explains the layout and the run-time
checks that refuse to build a `Line` if this xochitl differs.

Target (not yet run on it): reMarkable 3.29.0.149 / Codex 6.0.105, xochitl Qt 6.10.3, XOVI v0.3.3
(`xovi.so` sha256 `d4df820c…6ffd446`, from rm-xovi-extensions `v19-23052026`/`pre-v20-08092026`).

## Build

```bash
bridge/remarkable/xovi/codrawer-layer/build.sh      # needs Docker; output in out/
```

The first run builds `codrawer-xovi-build:trixie` (Debian trixie, aarch64 g++, Qt 6.8 arm64).
An extension built against Qt 6.8 runs on the tablet's Qt 6.10.3 (Qt 6 binary compatibility).

## Install (tethered: gone after a reboot)

XOVI's tethered start mounts a tmpfs over `/etc/systemd/system/xochitl.service.d`, writes the
`LD_PRELOAD` drop-in there and restarts xochitl. Nothing is written to the rootfs or to the
persistent `/etc`; a reboot returns the tablet to stock. Only `xovi.so`, its `start`/`stock`
scripts and this extension are needed. qt-resource-rebuilder is **not** activated, so no
`rebuild_hashtable` is required.

```bash
# on the desktop
scp out/codrawer-layer.so root@<tablet>:/home/root/xovi/extensions.d/
# on the tablet (xovi/ unpacked from the official rm-xovi-extensions xovi-aarch64.tar.gz,
# with qt-resource-rebuilder moved out of extensions.d)
/home/root/xovi/start
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

```bash
ssh root@<tablet> 'echo "stroke page=<page-uuid>" > /tmp/codrawer-layer/cmd; sleep 2; tail -n 20 /tmp/codrawer-layer/log'
```

## Remove

- Reboot (`systemctl --no-block reboot`): the tmpfs drop-in disappears and xochitl starts stock.
- Or without a reboot: `/home/root/xovi/stock` (unmounts the drop-in and restarts xochitl).
- Files: `rm -rf /home/root/xovi /tmp/codrawer-layer`.

The test layer and stroke are ordinary page content: undo them in xochitl, or delete the layer
from the layers panel.
