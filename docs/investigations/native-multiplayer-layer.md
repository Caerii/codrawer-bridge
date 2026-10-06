# Native multiplayer layer: peer strokes on the Paper Pro's open page

Status: investigation + design (2026-10-02). Feasibility study for making strokes from other
participants appear natively and simultaneously on the reMarkable Paper Pro's open notebook page,
on their own layer, while the user keeps drawing with the real pen.

Method: read-only. We copied `/usr/bin/xochitl` off the tablet (read-only `scp`) and inspected it
locally (ELF dynamic symbols, relocations, `QMetaType` interface structs, extracted QML
resources), read inkling / xovi / rm-xovi-extensions / smart_remarkable sources, and did small
read-only probes on the tablet (it was awake this session). **Nothing was installed or modified on
the tablet; no notebook was touched.** Related: ADR 007 (surface composition, revised rule 2),
ADR 008 (universal page model, §4 native write-back ranking + simultaneity), `smart-remarkable.md`,
`xochitl-pen-data.md`, `durable-install.md`.

Device confirmed this session: `IMG_VERSION=3.29.0.149`, `VERSION_ID=6.0.105` (Codex), xochitl
pid 331 `--system`, Qt **6.10.3**, 34 threads, no `/home/root/xovi` present (clean, unmodified).

## Verdict (go / no-go)

**GO** to build the smallest in-app probe (Probe 1 below). The architecture is sound and the
native commit path is confirmed to exist and to be callable the way inkling already calls xochitl.
The in-app route (XOVI extension calling xochitl's own `SceneController`) is **strictly better than
the evdev pen-injection path ranked #1 in ADR 008 §4**: it is truly simultaneous with the user's
pen, needs no "pen out of range" queueing, carries any tool/colour/ARGB, and — because it never
touches `/dev/input/event2` — produces **no evdev echo** into our pen reader.

**One unknown gates full go/no-go**: constructing the `Line` value that carries our *points*.
Everything else (create/select/name a layer, insert a line, render it, have it saved and undoable)
is confirmed. Probe 1 is designed to resolve exactly this unknown, in days.

## 1. How XOVI works on the Paper Pro (confirmed for 3.29.0.149 / Codex 6.0.105)

- **Hooking model.** XOVI (asivery/xovi, LGPL-3.0, aarch64 prebuilts for the Paper Pro) is an
  `LD_PRELOAD` shim. It can *override* (hook) any function reachable through the global symbol
  scope by inserting an aarch64 trampoline (`movz/movk x8,…; br x8`) at the function's entry and
  routing to `override$<sym>`; an extension can still call the original via `$<sym>`. Hooks are
  matched by **mangled symbol name**, so they need a symbol to exist. It also acts as a mini
  dynamic linker: extensions export/import symbols to each other. A per-call mutex makes hooking
  blocking/hot paths risky (`$noLock` exists but is discouraged). inkling's hard-won rule — **do
  not hook** xochitl's hot multithreaded paths — holds here.
- **Why hooking is largely unnecessary for us.** xochitl is a **PIE, stripped of its own symbols**:
  of 215 exported dynamic symbols, essentially all are Qt/stdc++ template instantiations; `xochitl`'s
  own classes (`SceneController`, `Line`, …) export **no** symbols. So you cannot hook or directly
  call xochitl methods by symbol. The viable model is inkling's: **resolve only Qt's exported
  symbols by `dlsym`, then drive xochitl through its Qt meta-object system** (walk the live QtQuick
  tree, read properties, invoke slots/signals by string name). No xochitl symbol needed.
- **QML / resource patching.** qt-resource-rebuilder (GPL-3.0) rebuilds Qt resources at startup
  from `.qrr` (replace), `.rcc` (add) and `.qmd` (qmldiff patch) files in
  `exthome/qt-resource-rebuilder`. `.qmd` patches are keyed to xochitl's exact QML and need a
  **hashtable rebuilt per OS version** (`rebuild_hashtable`). guibor's fork already carries
  `xovi-qmd/` ports for 3.28.0.163–169 and 3.29.0.148 — i.e. our version line is actively tracked
  by the community. We would prefer to avoid `.qmd` (the version-fragile part) and stay on the
  meta-call path, which only needs class/method *names* (stable across point releases) plus Qt's
  stable exported ABI.
- **IPC to the outside.** Two shipped mechanisms: **xovi-message-broker** (`/run/xovi-mb` +
  `/run/xovi-mb-out` pipes, and a QML/C signal bus) and plain files/sockets (inkling uses
  `/tmp/*_trigger` files + a localhost HTTP listener; smart_remarkable's framebuffer path already
  speaks the broker). For a stroke firehose from our Go bridge, a dedicated **unix domain socket**
  opened by the extension is the right channel; the broker is fine for low-rate control.
- **Durability** (`durable-install.md`): XOVI is tethered — `xovi/start` tmpfs-drops
  `LD_PRELOAD`/`XOVI_ROOT` over `xochitl.service.d` on each boot, nothing persistent, rebuild the
  hashtable per OS version. This fits our `boot.sh`/compat.conf plan; **never** persist a
  `xochitl.service.d` drop-in, and **never** `umount -R /etc` (drops the dropbear bind).

## 2. xochitl's object model for pages, layers and strokes (from the 6.0.105 binary + its QML)

Recovered from the binary's Qt meta-strings, `QMetaType` interface structs and 517 QML resources
extracted from the executable.

### SceneController — the page/layer/stroke controller, exposed to QML

`SceneController` is a QML-exposed `QObject` (`QQmlListProperty<SceneController>`,
`SceneController*` properties on the views). Its meta-object carries these **invokable** members
(names verbatim from the binary), all callable by string via `QMetaObject::invokeMethodImpl`
exactly as inkling does:

- **Layers (a — create/select a layer): confirmed fully meta-callable.**
  `addLayer()`, `deleteLayer(int)`, `moveLayer(int,int)`, `mergeLayerDown(int)`,
  `setCurrentLayer(int)`, `setLayerName(int,QString)`, `setLayerVisible(int,bool)`,
  `isLayerVisible(int)`, `clearLinesInLayer(int)`; properties `currentLayer`, `layerCount`,
  `layerStates`, signals `currentLayerChanged`/`layerStatesChanged`. xochitl's own layer QML
  (`SceneController.setCurrentLayer/setLayerName/addLayer`) uses exactly these, and inkling already
  drives `addLayer`+`setCurrentLayer`+`deleteLayer` on the rM2 for its scratch layer.
- **Insert a line (b): confirmed as the native commit entry point.**
  `addDrawingLine(const Line& line)` is in `SceneController`'s meta-object. It is **literally what
  xochitl's own `DocumentView.onStrokeCompleted` calls** to commit a finished pen stroke
  (`controller.addDrawingLine(stroke)`), with siblings `highlightWithLine(Line,SnapMode)`,
  `eraseWithLine(Line)`, `selectWithLine(Line,…)`, and `createImageSnippetFromStroke(Line,…)`.
  A snap/shape gesture reaches it the same way (`SnapHandler.onRequestAddLine → addDrawingLine`).
- **(c) render immediately + saved + undoable: confirmed by construction.** Because
  `addDrawingLine` *is* the ordinary pen-commit path: the stroke renders through the same tile
  pipeline (`tileManager.renderLineToTiles(stroke)` runs right after in the same handler), is
  written to the page `.rm` on the normal save (`UpdateLines`/`StoreLines` jobs), and is undoable
  (`undo`/`redo`, `undoAvailable`). It is a first-class CRDT line, so it also **syncs to the cloud**
  like any user ink.
- **(d) while the user is drawing — thread/lock.** The internal wrapper symbol for the call is of
  the form `SceneController::addDrawingLine(const Line&)::{lambda(Scene*)}` — i.e. the controller
  **enqueues a callback onto the scene's own job queue** (the same `SceneCallbackOnThread`/
  `DocumentWorker` machinery that `LoadLines`/`UpdateLines` use), rather than mutating the scene
  under the caller. That is the key reason the in-app path can be *simultaneous*: our insert is
  serialized with the user's live stroke by xochitl's own scene locking, not by us dodging the pen.
  Practical rule from inkling still applies: issue the meta-calls **on the GUI thread** (post with
  `invokeMethodImpl` + `QCoreApplication::self`); only `grabWindow` is worker-thread-only.

### Line — the stroke value type (the crux)

`Line` is a **QMetaType-registered value type / QML value type** (interface struct present, has a
`staticMetaObject`, default/copy/move ctors, `size = 88` bytes). Default ctor sets tool,
`argb = 0xff000000` (black) and `thickness = 1.0`; the layout places the points container near
offset 16, colour/tool in the first 16 bytes, thickness at 40. Its meta-object exposes **read**
properties `tool` (`Line::Tool`), `color`/`argb`, `pointCount`, `lineLength()`, `boundingRect`,
`isHighlighter`, `isEraserTool`, `isSelectionTool`, `hasExportedColor`, and the `Line::Tool` /
`Line::Color` enums (Paintbrush, Pencil, Ballpoint, Marker, Fineliner, Highlighter, Eraser,
SharpPencil, Calligraphy, ShadingMarker, …v2 variants; colours Black, Gray, White, Highlighter*,
Blue, Green, Cyan, Magenta, Yellow + ArgbCode).

**The gap:** in every QML occurrence, a `Line` is *received* from the native pen handler
(`onStrokeCompleted: (stroke) =>`) or returned by an overlay (`snapHandler.lastLine()`); **nothing
in xochitl's QML constructs a `Line` from raw points**, and the point data is not a QML-writable
property. So you cannot build a populated `Line` purely from QML/meta-properties. The two ways to
get our points into a `Line`:

1. **Via the pen-input pipeline (preferred, in-process, no evdev).** Feed points into
   `ScenePenInputHandler` / `PenInputSurface` / `PenInputLineHandler` so xochitl assembles the
   `Line` itself and fires `strokeCompleted` → `addDrawingLine`. `ScenePenInputHandler` exposes
   `strokeCompleted(Line)`, `gestureStarted/Moved/Ended`, and the writable tool/colour properties
   below; `PenInputSurface`/`Digitizer` expose `beginStroke`/`endStroke`/`strokePending`/
   `setStrokeRegion`. This is "injection" but **inside the app, not through `/dev/input/event2`** —
   so it is parallel-safe and un-echoed. Feasibility of driving it from outside the normal
   digitizer thread is the main thing Probe 1 must establish.
2. **Construct the `Line` by address (fallback, version-pinned).** Call a non-exported `Line`
   points-constructor / append by its binary offset for this exact build (recoverable the same way
   we recovered the `QMetaType` ctor addresses here). Works, but is brittle across OS updates and
   needs per-version RE — the kind of thing `durable-install.md`'s compat gating exists for.

### Tool, colour, thickness per author — confirmed natively settable

`penHandler` (class `ScenePenInputHandler`, on `DocumentView.penHandler`) exposes **writable**
`lineTool` (`Line::Tool`), `lineColor` (`Line::Color`), **`lineArgbCode` (uint32 ARGB)** and
`lineThickness` (plus eraser equivalents). So arbitrary per-author **ARGB colour** and **any tool**
are set natively with no toolbar taps — inkling already writes `penHandler.{lineTool,gestureMode,
lineThickness}`. This fully satisfies ADR 008's "tool and colour through a small XOVI extension".

## 3. Alternatives if direct insertion proves infeasible

- **QML overlay item (live, not saved) + later commit.** xochitl already has the pattern:
  `ShapesOverlay` / `SelectionImage` / `SnapHandler` render a provisional line on top of the scene
  during a gesture. A `codrawer-overlay` QML item (added via `.rcc`/qmldiff, or an injected
  `QQmlComponent` like inkling's button) could draw peer strokes live over the page and commit them
  with `addDrawingLine` when they end. Good decoupling of *liveness* from *commit*, and a safe
  fallback if driving the pen pipeline is hard. Downside: overlay rendering must track viewport
  pan/zoom (transforms are available: `sceneToView`/`viewToScene`, `tileManager.sceneToViewTransform`).
- **Write `.rm` and reload.** Only safe for pages **not** currently open — xochitl owns and will
  overwrite the open page's `.rm` on its own save (measured 6–10 s cadence, `xochitl-pen-data.md`).
  Already the ADR 008 §4 rank-3 path. Not usable for the *open* page, which is the whole ask.
- **Display-buffer drawing.** Writing xochitl's framebuffer fights its repaint pipeline
  (continuous `markDirty`/`requestRepaint`/tile paints) and is not vector, not saved, not undoable.
  Rejected, as in ADR 008.
- **evdev pen injection (ADR 008 §4 rank 1).** Still the only route that needs **no** in-app hook,
  so it stays the fallback. But it is serial, single-colour-per-toolbar-state, must wait for the
  real pen to be out of range, and echoes into our pen reader (requiring tagging). The in-app path
  removes all four problems — hence the recommendation to invest in it.

## 4. Design: the `codrawer-layer` XOVI extension

```
router/session (ADR 008 page model)
   │ page_update / stroke_* / participants
codrawer Go bridge (tablet, owns input devices, read-only pagewatch)
   │ unix socket  /run/codrawer-ink.sock   (stroke firehose + control)
codrawer-layer.so  (XOVI extension, inkling meta-call pattern, aarch64)
   │ GUI-thread meta-calls on SceneController / penHandler
xochitl scene  →  layer "codrawer: <name>",  addDrawingLine(Line)
```

- **Architecture.** Hook-free, inkling's model: a worker thread reads the socket; all Qt access is
  posted to the GUI thread via `invokeMethodImpl`+`QCoreApplication::self`. It `dlsym`s only Qt
  symbols; it finds the active `SceneController` by walking `allWindows() → QQuickRootItem →
  childItems` for `DocumentView`/`DeviceScene` (exactly inkling's `locate()`), reused verbatim.
- **Receiving strokes.** Our Go bridge opens/owns the socket and streams page-model strokes
  (normalized coords, tool, ARGB, per-point pressure/width). Control (which page, create layer,
  set author colour) can go over xovi-message-broker; bulk points over the socket.
- **Stroke mapping.** page-model stroke → `Line`: tool → `Line::Tool`; colour ARGB → set
  `penHandler.lineArgbCode` (exact colour) or nearest `Line::Color` for PP palette authors; size →
  `lineThickness`; points → page-units → xochitl **scene** coords (centred x: `x_scene = x_rm`,
  learn the live view↔scene offset from a selection the way inkling does; respect zoom/scroll via
  `tileManager` transforms). Populate the `Line` via the pen pipeline or the version-pinned ctor
  (Probe 1 decides). Then `setCurrentLayer(ourLayer)` → `addDrawingLine(line)` →
  `renderLineToTiles`.
- **Per-author layer.** On first stroke from author A: `addLayer()`, `setLayerName(idx,
  "codrawer: <name>")`, cache idx; restore the user's `currentLayer` after each insert (inkling's
  spin-layer save/restore pattern).
- **Echo suppression.** Inserted strokes are real CRDT lines, so our **read-only `pagewatch`** will
  see them on the next `.rm` save. Suppress by (i) our layer name prefix `codrawer:` — pagewatch
  tags those strokes `origin=injected` and does not re-broadcast them as the user's — and (ii) by
  matching our own model ids. Crucially, because we never write `/dev/input/event2`, the **pen
  reader never sees them at all** (unlike evdev injection), so there is no live-stream echo.
- **OS gating.** `.so` in `/home/root/xovi/extensions.d/`; XOVI started by `boot.sh` each boot;
  hashtable only needed if we add `.qmd` (prefer not to). compat.conf gates the feature on
  `3.29.0.149 / 6.0.105` and on a runtime self-test (find a `SceneController`, confirm
  `addDrawingLine` is in its meta-object) before enabling; otherwise fall back to evdev injection.

## 5. Risks

- **OS updates.** The meta-call surface (class + method *names*, Qt exported ABI) is the most
  stable thing to depend on and survived rM2→PP lineage in inkling; point releases rarely rename
  slots. The **fragile** parts are (a) any `.qmd` we add (per-version hashtable) and (b) the
  `Line`-by-offset constructor fallback (per-version RE). Mitigation: avoid `.qmd`; prefer the pen
  pipeline for `Line` construction; gate hard on version + self-test; keep evdev injection as the
  always-works fallback.
- **Data corruption.** Only ever `addLayer` a new layer and `addDrawingLine` into **our** layer;
  never call delete/erase/move/clearLines on user content. Inserted strokes go through xochitl's
  own CRDT writer, so the file stays valid and conflict-resolvable. Our pagewatch stays read-only.
- **Sync.** Our strokes are genuine CRDT lines → they sync to the reMarkable cloud like user ink.
  That is usually desirable (peers' contributions persist), but means it is **not** ephemeral;
  if a session wants peer ink to be throwaway, use the QML-overlay alternative and never commit.
- **Performance / stability.** Meta-calls must be short and on the GUI thread; batch points per
  stroke, insert on stroke-end (live preview stays on our other surfaces). Respect inkling's crash
  lessons (never parent into the selection menu's Container; keep the injected component alive for
  the process lifetime; whitelist property reads).

## 6. Phased plan

- **Probe 0 — read-only confirmation on device (0.5 day).** Port inkling's meta-dump to aarch64 and
  dump `SceneController`, `DocumentView.penHandler`, and a live `Line`'s meta-object on *our* build;
  confirm `addDrawingLine` arity, the layer slots, `lineArgbCode`, and whether any `Line` point
  setter/`PenInput*` entry is reachable. Confirm xovi-message-broker availability. (Much of this is
  already answered from the binary here; Probe 0 just confirms on-device.)
- **Probe 1 — the feasibility gate (3–5 days).** A `codrawer-layer.so` that, on a trigger, (1)
  `addLayer` + `setLayerName("codrawer: test")` + `setCurrentLayer`, (2) builds ONE hard-coded
  multi-point `Line` (black fineliner), (3) `addDrawingLine`. **Success = the stroke appears on the
  open page, renders immediately, survives a page save (`.rm`, verified read-only by pagewatch),
  and is undoable.** This resolves the single open unknown (building a populated `Line`): if the
  pen-pipeline route works, full GO; if only the offset-ctor route works, GO with per-version RE
  cost; if neither, fall back to evdev injection (ADR 008 §4.1).
- **Integration (1–2 weeks after Probe 1).** Go bridge ⇄ socket; stroke→`Line` mapping incl. the
  scene-coord transform under pan/zoom; per-author layers + author ARGB via `penHandler`; echo
  suppression in pagewatch (`codrawer:` layer tag + id match); compat gating + `boot.sh`;
  one-peer end-to-end: a phone stroke lands on the open page on its own layer while the user draws.

## Effort estimate

- Probe 0: **~0.5 day** (on-device confirmation; largely pre-answered here).
- Probe 1 (go/no-go gate): **3–5 days** — aarch64 build toolchain + xovigen, meta-call plumbing
  (reuse ~400 lines of inkling), and solving `Line` construction (the risk). Add **1–2 days** if
  the version-pinned offset ctor is required.
- Integration to a shippable single-peer native layer: **~2 weeks**.
- **Total: ~3 weeks**, contingent on Probe 1. Recommendation: fund Probe 1 now; it buys the
  decision between the superior in-app path and the evdev-injection fallback within a week.

## Appendix: evidence trail (read-only, this session)

- `scp root@<tablet-ip>:/usr/bin/xochitl` → local inspection (Codex 6.0.105, Qt 6.10.3, PIE,
  own symbols stripped; 215 exported dynamic syms, all Qt/stdc++).
- `SceneController` meta-object: `addDrawingLine`, `highlightWithLine`, `eraseWithLine`,
  `selectWithLine`, `createImageSnippetFromStroke`, `addLayer`, `deleteLayer`, `setCurrentLayer`,
  `setLayerName`, `setLayerVisible`, `clearLinesInLayer`, `mergeLayerDown`, `undo`/`redo`,
  `currentLayer`/`layerCount` — recovered from the binary's meta-strings.
- Internal wrapper `SceneController::addDrawingLine(const Line&)::{lambda(Scene*)}` → scene-queue
  dispatch (basis for the simultaneity claim).
- `Line` `QMetaType` interface struct @ `0x17a1640` (size 88, has `staticMetaObject`); default ctor
  sets argb black + thickness 1.0; read-only meta-properties `tool`/`color`/`argb`/`pointCount`/
  `boundingRect`/`isHighlighter`…; no QML-writable points property.
- `ScenePenInputHandler` / `PenInputLineHandler`: writable `lineTool`, `lineColor`, `lineArgbCode`
  (uint32), `lineThickness`; signal `strokeCompleted(Line)`.
- xochitl's own `DocumentView` QML (extracted from the binary) commits via
  `controller.addDrawingLine(stroke)` in `onStrokeCompleted`.
- inkling `xovi-ext/inklingfb/main.c`: the hook-free meta-call pattern (locate / invoke / layer
  save-restore) we reuse.
- Scratch (not committed): `…/scratchpad/xovi-research/` (xochitl binary, extracted QML, symbol and
  metatype dumps; inkling, xovi, rm-xovi-extensions clones).

## Probe 0 / Probe 1: progress (2026-10-03)

**Status: not yet run on the device.** The tablet was reachable at first. It then dropped off
Wi-Fi, even though a kernel wake lock was held, before XOVI was installed. It was still
unreachable some 30 minutes later. **Nothing was installed on the tablet.** No notebook was
modified. This section records what was done and what was learned off-device.

Done on the device (read-only):
- Open document: **"Jerki"** (`523ba935-7a27-4fec-88a3-ae768aa1f596`). Open page index 1,
  id `d07db0a2-a9e2-4ef4-a304-df88316512ce`. Its `.rm` is 424 B, and
  `codrawer_bridge_native -page-dump` showed `"strokes":[]` (a fresh, empty page). The whole
  document folder plus its `.content`/`.metadata`/`.local`/thumbnails was copied off with a
  SHA256SUMS file. The copy is in the session scratchpad, not committed.
- The `xochitl.service` unit has `WatchdogSec=60`, `StartLimitBurst=4` in 600 s and
  `OnFailure=emergency.target`. A crash loop therefore ends in emergency mode. All work in the
  extension is a short GUI-thread job.
- glibc 2.43, libstdc++ 6.0.36, Qt 6.10.3 (Core, Gui, Qml, Quick, …). There is no
  `/etc/systemd/system/xochitl.service.d`, so XOVI's tmpfs drop-in would not shadow anything.

XOVI selection (verified, not installed):
- The xovi.so is **v0.3.3**, sha256 `d4df820c25c634c511de11067279d8310fa4f656dc52bd4540db6beac4ffd446`.
  It is byte-identical in the asivery/xovi release and in the rm-xovi-extensions bundles
  `v19-23052026` and `pre-v20-08092026`. Its `start` script has sha256 `bf15dfd6…829dc`.
  Both hashes are the ones guibor/smart_remarkable pinned for 3.29.0.148.
- Plan: a minimal tethered install under `/home/root/xovi`, containing only `xovi.so`,
  `start`/`stock` and `codrawer-layer.so`. qt-resource-rebuilder stays out, because no `.qmd`
  is used, so `rebuild_hashtable` is not needed. `start` tmpfs-mounts the drop-in, and a reboot
  removes it.

Static findings that change the plan for Probe 1 (from the 6.0.105 binary, `bridge/remarkable/xovi/codrawer-layer/main.cpp`):
- **Route 1 (feed points through the pen pipeline) has no meta-callable entry.** I checked the
  meta-strings of the pipeline classes:
  - `ScenePenInputHandler` exposes only `setSelectionActive`, `queryIntermediateState` and
    `setShapeDetection`, plus its tool/colour properties and signals.
  - `PenInputHandler` exposes `lockMainThread`/`unlockMainThread`, `setTransform` and
    `timeSincePenUp`.
  - `PenInput` exposes `updateInRange` and `setFilterEvents`.
  - `Digitizer` exposes `setStrokeRegion` and `setPenClose`.
  - `PenInputSurfaceManager` exposes `registerInput` and `registerExclusion`.

  Points reach the pipeline through C++ virtual calls from `PenInputThread`/`DigitizerRM1xx::run`,
  which reads evdev. Route 1 would therefore need unexported virtuals called by vtable slot, or a
  XOVI hook on libc `read` on the blocking digitizer thread. Both are what XOVI and inkling warn
  against. Probe 0's `dump` will confirm this on the live build.
- **Route 2 does not need a constructor called by address. A `Line` can be built from its data
  layout.** This layout comes from static disassembly of the default constructor, move
  constructor, `operator==` and destructor (all reached through its `QMetaTypeInterface`). The
  probe re-checks it at run time.

  | offset | content |
  | --- | --- |
  | 0 | colour (default 9 = ArgbCode) |
  | 4 | tool |
  | 8 | ARGB (default `0xff000000`) |
  | 16 | `QList<Point>` (d, ptr, size) |
  | 40 | thickness (double, default 1.0) |
  | 48 | starting length (float) |
  | 56 | bounding rect (QRectF) |
  | 88 | total size |

  A `Point` is 14 packed bytes, `f32 x, f32 y, u16 speed, u16 width, u8 direction, u8 pressure`,
  which is exactly the `.rm` v6 point record. The destructor frees the list through
  `QArrayData::deallocate(d, 14, …)`.

  The probe builds the value as follows:
  1. Create the `Line` with `QMetaType::fromName("Line")`, so xochitl's own default constructor
     runs.
  2. Check the default bytes against the table above.
  3. Move a Qt-allocated `QList` into offset 16 and fill in the scalar fields.
  4. Read the value back through the gadget's `tool`, `pointCount`, `boundingRect` and
     `lineLength()`. If any check fails, it commits nothing.
- The gadget has no `color`/`argb` property, only `tool`, `pointCount`, `isHighlighter`,
  `isSelectionTool`, `isEraserTool`, `hasExportedColor`, `boundingRect` and `lineLength()`.
  Colour and ARGB are verified through the raw layout.
- Clipboard paste is not a route. The clipboard holds native `QList<std::shared_ptr<SceneItem>>`,
  not serialized data.

Next (when the tablet is awake; hold a wake lock **and** keep the screen awake):
1. Install the minimal XOVI and run `xovi/start`.
2. Confirm xochitl reopens "Jerki" at page `d07db0a2…`.
3. Run `dump` (Probe 0), then `linetest`, then `pencolor page=… argb=ff1f6fe0`.
4. Run `stroke page=d07db0a2-a9e2-4ef4-a304-df88316512ce` (Probe 1).
5. Verify with `-page-dump`, and capture the display buffer with a read-only grabber.

Open question: the wake lock alone did not keep the tablet on Wi-Fi. xochitl's own idle suspend
probably ignores `/sys/power/wake_lock`. Check `systemd-inhibit --list` or the xochitl sleep
setting next time.

## Probe 1: results (2026-10-06) — GO

Run on the device (3.29.0.149 / Codex 6.0.105, XOVI v0.3.3 at boot), on a fresh page of the
notebook "Test" (page `ae4d6014-…`), with the notebook backed up first (scp, not committed).

1. **The layout table was half wrong, and the run-time check caught it.** The first `stroke`
   refused before touching the scene: the gadget's `tool` read 9 before and after we wrote 17 at
   +4. The default constructor's 9 at +0 is the **tool**, and +4 is the **colour** (Black = 0 by
   default; ArgbCode = 9 makes +8 the colour). The point list at +16 read back exactly (120
   points), and the bounding rect is computed from the points. Corrected in `main.cpp`; `linetest`
   then read back `tool 9 -> 17, pointCount 120, boundingRect (-564,281 428x98)`.
2. **Layer slots act asynchronously.** `addLayer()` returned with `layerCount` unchanged; the new
   layer appeared (and was selected) moments later, after the scene's own job ran. The first
   attempt therefore stopped without drawing but left an empty "Layer 2" selected, on which the
   user then wrote. The commit is now a chain of short GUI-thread steps that each wait (20 ms
   timer, never blocking) for the controller to report the previous effect: add, name (read back
   through `layerName(int)`, since `layerStates` does not read from C++), select, draw, wait for
   `itemsBoundingRect` to change, select the user's layer again by name.
3. **It renders, saves and undoes.** Log:
   `ink: addDrawingLine x1 on layer 2 … ink: ok 1 (1 stroke(s), layer "codrawer: test", 314 ms)`,
   the user's layer restored. A read-only framebuffer grab showed the wave on the page at once.
   xochitl saved the `.rm` 5 s later; `-page-dump` showed the user's 56 calligraphy strokes on
   their layer, unchanged, and **one fineliner stroke `#d03030ff` with 120 points on a new layer**.
   The user tapped undo once: the wave disappeared and their writing stayed.
4. **Placement: `addDrawingLine` takes the pen's frame, not page coordinates.** The wave given at
   x −560…−140, y 285…375 was saved at x +12…+432, y −12…+78: shifted by the view's pan (the
   user's page was scrolled). xochitl maps a pen stroke through the view transform when it
   commits it, so ink meant for page coordinates is first mapped with the tile manager's own
   `sceneToViewTransform` (`main.cpp`, "Placement"). Not yet verified on the device.

Verdict: **GO for route 2**, no function called by address, no hook. Integration (agent ink
socket, bridge forwarding with `NATIVE_AGENT_INK`, page snapshots labelling the agent layer `ai`)
is built; see ADR 009.

## Reboot incident (2026-10-06)

While loading a new extension build by hand (`boot.sh xovi off`, copy the `.so`, run XOVI's
`start`), the second xochitl restart came 9 s after the first. Stock xochitl, still loading its
library, segfaulted while shutting down (`status=11/SEGV`); `OnFailure` ran `rm-emergency.sh`,
which rebooted the tablet. The new extension never ran. No notebook was damaged (the probe page's
`.rm` had been saved 4 min earlier; backups existed).

**Rule: never restart xochitl within 20 s of its last start, and never run XOVI's `start` or
`stock` by hand; use `boot.sh xovi off|on`.** `xovi.sh` now enforces it: `boot` waits for the
same main PID for 20 s (as before), and `off` waits until xochitl's main process is 20 s old
(`/proc/<pid>/stat` start time against `/proc/uptime`), refusing after 300 s. New extension
builds reach the tablet in a signed release (`deploy-tablet.sh`) and load with one guarded
`boot.sh xovi on`.
