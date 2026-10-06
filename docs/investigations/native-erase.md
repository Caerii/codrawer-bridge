# Erasing on the Paper Pro: what xochitl does, how codrawer predicts it, and the native route

Status: investigation (2026-10-05). Track A (prediction in the clients) is implemented on
`feat/erase-prediction`; Track B (observing erasures inside xochitl) is built as the erase probe on
`feat/xovi-erase-probe` and **has not been run on the device**.

Method: read-only. The user's notebook "Test" (doc `4c0e2d44-…`, erased on 2026-10-05) was copied
off the tablet with `scp` and read with rmscene 0.8; rmc's `erasers.rm` fixture
(`bridge/remarkable/native/rmlines/testdata`) was plotted and measured; xochitl 6.0.105's QML and
meta-strings come from the binary extracted for `native-multiplayer-layer.md`. Nothing was written to
the tablet.

## The problem

The user: "when you erase things, it takes so long to erase the strokes; they should erase as quick
as things get drawn." Live, the bridge streams the eraser end's motion (brush `eraser`). The page's
true result arrives only when xochitl saves the page's `.rm`, which the page watcher polls every
second but which xochitl writes 6–70 s apart. Two client bugs made it worse: the phone stage drew a
live eraser on its own scratch layer, so it cut nothing until the pen lifted, and both renderers
used a fixed on-screen width (×6 the pen on the glasses, 24 px on the phone) unrelated to the
tablet's eraser, so ink the tablet had erased lingered until the save.

## 1. What xochitl's eraser does

**It splits lines; it never stores the eraser.** A v6 `.rm` holds no line with the eraser tool. An
erased line is tombstoned and the parts that survive are inserted as new lines *at the original's
place in the drawing order*: their CRDT `left`/`right` point at the deleted line's neighbours, not at
the end of the layer. A line wholly under the eraser is only deleted.

From the user's page `22b067bb` (rmscene; `left`/`right` are the sequence neighbours):

```
LINE 1:71  DELETED (del_len=29)
LINE 1:100 DELETED (left=1:99 del_len=12)
LINE 1:112 CALIGRAPHY n=2 bbox=(-263.3,1335.4)-(-263.3,1335.4) left=1:111 right=0:0
LINE 1:118 CALIGRAPHY n=6 bbox=(-454.0,471.1)-(-453.7,473.6) left=1:99 right=1:100   <- piece, put back between 1:99 and 1:100
LINE 1:119 DELETED (left=1:118 right=1:100)
```

From rmc's `erasers.rm` (a Paper Pro page; its own handwriting labels the tests "Back of the
eraser pen on the rm pro" and "Eraser tool at various sizes: smallest, medium, largest, selection
eraser"):

```
LINE 1:48 DELETED (del_len=6) … LINE 1:55 DELETED (del_len=4)
LINE 1:59 BALLPOINT n=8  first (-352.7,2288.9 p4)   last (-356.6,2299.4 p165) left=1:53 right=1:54
LINE 1:60 BALLPOINT n=12 first (-351.5,2297.2 p217) last (-351.0,2296.7 p250) left=1:59 right=1:54
…                                                    (1:59–1:66: the tops and bottoms of letters whose middles the eraser end took)
```

The user's page `b211bf76` (erased today) shows the other case: `1:16 DELETED del_len=64`, i.e. the
64 lines 1:16–1:79 were each wholly erased; 1:80–1:88 are later writing appended at the end.

**It commits on pen-up.** xochitl's `DocumentView` QML (extracted from the binary):

```qml
onStrokeCompleted: (stroke) => {
    …
    if (stroke.isHighlighter) { controller.highlightWithLine(stroke, snapMode); }
    else if (stroke.isEraserTool) { controller.eraseWithLine(stroke); }
    else if (stroke.isSelectionTool) { … }
    else { controller.addDrawingLine(stroke); }
```

While the eraser moves, the tablet paints the swept path out of its framebuffer (the
`MaskedEraser`/`renderEraserSolid` pipeline); the scene changes when the pen lifts. Either way the
user sees ink vanish as the eraser passes, which is what the clients must show.

**The swept width is the eraser's thickness, and pressure plays no part.**

```qml
function calculateEraserThickness(thickness) {
    // The eraser is a bit special in that it treats the thickness as a squared value.
    return thickness * thickness;
}
lineThickness: (lineTool === Line.Eraser ? calculateEraserThickness(documentViewTools.activePen.thickness)
                                         : documentViewTools.activePen.thickness) / root.penScale
eraserThickness: calculateEraserThickness(2.4) / root.penScale;
```

So the eraser tool's sizes 1/2/3 have thickness 1, 4 and 9, and the Marker's eraser end (the
handler's `eraserThickness`) a fixed 2.4² = 5.76, whatever eraser size the toolbar shows. `penScale`
follows the zoom (1 at the default), so a zoomed-in eraser is smaller on the page.

**Radius: 5 page px per unit of thickness.** The largest empty circle inside each erased hatch of
`erasers.rm` (points densified to 1 px, scipy KD-tree), and the plotted channel edges:

| eraser | thickness | gap between surviving centrelines | 10 × thickness + ink width (4.25) |
| --- | --- | --- | --- |
| tool, smallest | 1 | 13–17.6 px | 14.3 |
| tool, medium | 4 | 46–48 px | 44.3 |
| tool, largest | 9 | 90–98 px | 94.3 |
| Marker's eraser end | 5.76 | 57–64 px | 61.9 |

A point of a line goes when its centre is within `5 × thickness + its half width` of the eraser's
centre line: **28.8 page px (+ the ink's half width) for the eraser end** at the default zoom
(Paper Pro page px, 1620 × 2160, ~0.11 mm each). The fit is within the measurement's ±3 px (one
point spacing).

**Erase selection.** `Line.EraseSection` ("selection eraser") cuts every line along the lasso's
boundary: in `erasers.rm` the blob-shaped hole has clean cut edges through each hatch line (pieces,
not whole lines removed). It is not stored either. "Erase all strokes" is a menu action
(`eraseAllSelected`), not a stroke.

**What the bridge can and cannot see.** The pen's evdev stream tells the eraser end apart
(`BTN_TOOL_RUBBER` → brush `eraser`), so the eraser end is predicted. The toolbar's Eraser or
Erase selection used with the *tip* arrives as an ordinary `pen` stroke: from the input device it is
indistinguishable from ink, and the clients draw it as ink until the save replaces it. Only the
native route below fixes that.

## 2. Track A: prediction in the clients (implemented)

`apps/even-g2/src/erase.ts` (pure) and `strokes.ts`:

- Each batch of eraser points (layer `user`, brush `eraser`) cuts the tablet's ink drawn before it:
  points within 28.8 px + half width of the eraser path are masked out (`Stroke.gone`), so lines
  split exactly where xochitl splits them. Peers' and the AI's ink are not cut (they are not on the
  tablet). `?eraser=<px>` overrides the radius; `?erase=0` turns prediction off.
- A uniform 64-px grid over the page's points finds the ink near each eraser segment; it is built
  once per page and extended as strokes end. **Measured (test/erase.test.ts, Node 22, this desktop):
  5,000 strokes × 40 points (200k points), a 200-point eraser in 4-point batches: index 16–23 ms
  once, then 16–22 ms for all 199 segments, 0.3–0.45 ms per batch; 537 strokes cut.**
- Rebasing on a save: xochitl commits at pen-up, so a live stroke is kept if it has not ended or
  ended after the save's `rev` (not only if it began after it), and kept erasers cut the new
  snapshot again, so erased ink never comes back while the tablet has yet to save the erase.
- Phone stage: the erase repaints only the changed region of the finished-ink cache, every frame;
  the eraser shows as its true circle. Glasses: survivors only, the eraser's outline at its true
  radius; the loupe and the wide view redraw on each batch, the canvas at the next lull (as for ink).
  Timelapses paint history whole and cut as it happened.

Screenshots (headless Edge + simulator, local Rust router): scratchpad `erase-shots/`
(`phone-1-before` … `phone-4-stale-save`, `glasses-*`).

Follow-up: the Go and Rust routers still replay only live strokes that *began* after `rev`; a client
joining in the seconds between an erase and the save that holds it misses that eraser.

## 3. Track B: observing erasures natively (routes, ranked)

All routes run inside xochitl through XOVI's hook-free meta-call model (`native-multiplayer-layer.md`
§1); the probe is `bridge/remarkable/xovi/codrawer-layer` on `feat/xovi-erase-probe`.

1. **`ScenePenInputHandler::strokeCompleted(Line)` → the exact erase, at pen-up.** Evidence: the QML
   above; the signal is in the handler's meta-strings (`strokeCompleted Line line`). The `Line` is
   what `eraseWithLine` receives: tool (`Eraser` / `EraseSection`), thickness (+40, a double: 5.76 for
   the eraser end) and the path (the `QList<Point>` at +16, the layout `buildLine` already checks).
   It covers what evdev cannot: the toolbar eraser and erase selection with the tip, and the
   zoom-scaled thickness. Risk: low (a signal connection; the receiver reads one value on the GUI
   thread). Would send: `{"t":"erase","id":"<the live stroke id, if matched>","tool":"eraser|erase_section","thickness":5.76,"pts":[[x,y],…]}`
   in normalized page coords; clients apply the exact cut (and the lasso clip for `erase_section`)
   and drop the prediction for that stroke.
2. **SceneController / DocumentWorker signals → when the scene and the file change.** Candidates from
   the meta-strings: `SceneController.documentContentChanged`, `updated`, `itemsBoundingRectChanged`,
   `undoAvailableChanged`, `aboutToUndo`/`aboutToRedo`; `DocumentWorker.contentsUpdated`,
   `linesStored(page, pageId, size)`, `hasPendingChanged`, `jobQueueSizeChanged`, `modified`;
   `QmlDocumentWrapper.pageUpdated(pageIndex)` and property `hasPendingStoreLines`;
   `DocumentLockManager.pageModified`, `linesStored(page, pageId, size)`. These give *that* the scene
   changed (and undo/redo, which no live stream shows), not *what* changed. Risk: low; worker signals
   arrive on its thread (the probe's receiver is thread-safe and formats only plain values). Would
   send: a nudge to the bridge's page watcher (`{"t":"scene_changed","page":…}` over the local
   socket) to read the `.rm` as soon as `linesStored` fires instead of on its 1 s poll.
3. **Ask xochitl to save now.** No `save` slot exists by that name. Candidates, all xochitl's own:
   `DocumentWorker::startDeferredRequestTimers()`, `DocumentWorker::onModifiedPageId(id)`, emitting
   `DocumentWorker::aboutToSleep()`, and `DocumentLockManager::setSleepState(bool)` (sleep then wake;
   last resort: it may release document locks). Cost when it works: one `StoreLines` job, the same
   write xochitl does anyway (this notebook's pages are 0.4–16 KB), plus earlier cloud-sync uploads.
   Risk: medium until measured (unknown side effects of the sleep path). Combined with route 2's
   `documentContentChanged`, it would turn every erase and undo into a fresh `page` within ~1 s.
4. **`SceneController::dumpScene()`**, a debug slot: if it prints the scene's lines, it is a page
   snapshot without a save. Unknown output and cost; the probe calls it only on request.
5. **The undo stack.** No `QUndoStack` is exposed: `SceneController` has `undo`/`redo`,
   `undoAvailable`/`redoAvailable` and `aboutToUndo`/`aboutToRedo` only, and the erase's undo
   commands are built internally (`createEraseItemsActions`). Covered by route 2's signals.
6. **Hooking the scene's line-removal code.** xochitl's own classes export no symbols (stripped PIE);
   hooking `eraseWithLine`'s scene job means patching unexported code by address per OS version.
   Rejected (version-fragile, hot multithreaded path).

Recommendation: routes 1 + 2 first (read-only), then route 3 once a save trigger is measured safe.

## 4. Device test plan (when the user is ready)

Prerequisites: XOVI tethered as in `codrawer-layer/README.md` (nothing persistent; a reboot
returns the tablet to stock), the extension built by `build.sh` (sha256 printed by the build). Open
a scratch notebook page; note its page id (`.content`, or `doctor`).

```bash
T=root@192.168.50.156; P=<page-uuid>
scp out/codrawer-layer.so $T:/home/root/xovi/extensions.d/ && ssh $T /home/root/xovi/start
ssh $T "echo 'watch page=$P' > /tmp/codrawer-layer/cmd"; sleep 2
ssh $T "tail -n 80 /tmp/codrawer-layer/log"
```

Expect `hook pen.strokeCompleted(Line)`, `hook scene.documentContentChanged()` (and the other
SceneController signals), `hook worker.linesStored(…)`, and `watch: N signals hooked on page <P>`.

1. Write a word with the tip, lift. Expect `signal pen.strokeCompleted(line=Line{tool=… eraser=false
   …})`, then `signal scene.…` lines within ~100 ms, and 6–10 s later `signal worker.linesStored(…)`.
2. Erase across it with the Marker's eraser end, lift. Expect `Line{tool=<Eraser> eraser=true
   thickness=5.76 …path=/tmp/codrawer-layer/line-<ms>.txt}` and a `scene.` signal right after. Copy
   that file and the page's `.rm` after the save: the cut ends must sit 28.8 px + half the ink width
   from the path (the calibration of §1, now exact).
3. Undo (two-finger tap). Expect `scene.aboutToUndo` / `undoAvailableChanged`.
4. `echo 'pending page=$P'`, then try `save page=$P via=deferred`, `via=modified`,
   `via=abouttosleep` (one at a time, each right after an erase). A route works when
   `worker.linesStored` follows within ~1 s and the `.rm` mtime changes (`stat -c %Y <page>.rm`; BusyBox).
   Try `via=sleepcycle` only if none of those work, and check the page is still editable after it.
5. Optional: `dumpscene page=$P`, then `journalctl -u xochitl -n 50`.
6. `unwatch`; `/home/root/xovi/stock` or reboot.

Go: (1) and (2) decode with `eraser=true` and a path; `linesStored` is seen; xochitl stays
responsive (no watchdog restart, pen latency unchanged). Then build route 1's `erase` message.
No-go signs: `Line … list=… (disagrees; points not read)` (the layout differs on this build: use
gadget properties only), no `strokeCompleted` (the handler is not the DocumentView's
`strokeHandler`), xochitl restarting (`journalctl -u xochitl` shows a crash: stop and `stock`).

## 5. A 30-second check without XOVI (radius, pressure, zoom)

On a fresh page at the default zoom: draw three horizontal lines with the fineliner. Cross the
first with the eraser end lightly, the second pressing hard, both straight down; zoom in 2× and
cross the third. Turn the page (forces a save), then on the desktop:

```bash
scp root@192.168.50.156:/home/root/.local/share/remarkable/xochitl/<doc>/<page>.rm /tmp/check.rm
uv run --with rmscene python - <<'EOF'
from rmscene import read_blocks
from rmscene.scene_stream import SceneLineItemBlock
for b in read_blocks(open('/tmp/check.rm','rb')):
    if isinstance(b, SceneLineItemBlock) and b.item.value:
        p = b.item.value.points; print(b.item.item_id, round(p[0].x), round(p[-1].x), round(p[0].y))
EOF
```

Each crossed line becomes two pieces; the gap between them (end x of one, start x of the next) is
expected at ~62 px for both pressures (no pressure dependence) and ~33 px for the zoomed one
(`/ penScale`). A different gap: set `?eraser=` to (gap − ink width) / 2 and record it here.

## 6. Device results (2026-10-06, 3.29.0.149, XOVI tethered)

The first install loaded `codrawer-layer.so` but never ran it. `build.sh`'s `-fvisibility=hidden`
had also hidden `_xovi_construct`, so xovi found no constructor. It is now exported explicitly.
`watch` then hooked 154 signals, and xochitl stayed up with no restart. The user wrote, erased
with the eraser end, erased with the toolbar Eraser and the tip, and turned pages:

| what | `pen.strokeCompleted` |
| --- | --- |
| ink (fineliner-like, calligraphy) | `tool=13` / `tool=21`, `eraser=0`, thickness 1 / 2 |
| Marker's eraser end | `tool=6 eraser=1 thickness=5.76`, point width 230 (¼ px), path file written |
| toolbar Eraser (size 2) with the tip | `tool=6 eraser=1 thickness=4`, point width 160, path file written |

So both erasers reach `strokeCompleted` with their path, and they are told apart from ink by
`isEraserTool`, and from each other by thickness (5.76 = 2.4², fixed; the toolbar eraser is size²).
`worker.linesStored` followed each stroke 10–15 s later. The handler stayed connected across page
turns and new pages.

**The current tool is a property.** `PenInputLineHandler.lineTool` (notify `lineToolChanged`)
reads `SharpPencilv2` with a pen selected. With the toolbar Eraser selected it is `Eraser`, and
`lineThickness` is then the eraser's size². `eraserTool` (the eraser end's tool) is `Eraser`. The
extension now copies `lineTool` to `/run/codrawer/tool` (README "Following the tool"). The bridge
streams tip strokes as brush `eraser` while that file says `eraser` (package `toolhint`).

Not measured yet: the radius check against a saved `.rm`. The user erased whole words, so no
partly cut line survived to measure a gap. The toolbar eraser's radius should be 5 × size² +
half the ink width, which is 20 px at size 2, against 28.8 px for the eraser end. Clients still
use 28.8 px for both. Also untested: the `save` routes, which need an erase right before the
command.
