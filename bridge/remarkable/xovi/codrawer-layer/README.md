# codrawer-layer (XOVI probe)

A XOVI extension that runs inside xochitl on the reMarkable Paper Pro and puts a stroke on the
open page, on its own layer named `codrawer: test`, through xochitl's own commit path
(`SceneController.addDrawingLine` + `SceneTileManager.renderLineToTiles`). It is Probe 0 and
Probe 1 of `docs/investigations/native-multiplayer-layer.md`; the results are recorded there.

It hooks no function. It finds the visible DocumentView, takes its `SceneController`, pen handler,
tile manager and viewport, and calls their meta-methods by name on the GUI thread. The stroke's
`Line` value is created by xochitl's own default constructor (through `QMetaType`) and then given
our points by filling its documented fields; `main.cpp` explains the layout and the run-time
checks that refuse to build a `Line` if this xochitl differs.

Tested on: reMarkable 3.29.0.149 / Codex 6.0.105, xochitl Qt 6.10.3, XOVI v0.3.3
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

```bash
ssh root@<tablet> 'echo "stroke page=<page-uuid>" > /tmp/codrawer-layer/cmd; sleep 2; tail -n 20 /tmp/codrawer-layer/log'
```

## Remove

- Reboot (`systemctl --no-block reboot`): the tmpfs drop-in disappears and xochitl starts stock.
- Or without a reboot: `/home/root/xovi/stock` (unmounts the drop-in and restarts xochitl).
- Files: `rm -rf /home/root/xovi /tmp/codrawer-layer`.

The test layer and stroke are ordinary page content: undo them in xochitl, or delete the layer
from the layers panel.
