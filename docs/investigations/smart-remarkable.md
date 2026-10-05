# smart_remarkable: what it does, how, and what codrawer should take from it

Status: investigation (2026-10-02). Read-only study of source; nothing was run on the tablet.
Related: ADR 007 (surface composition), ADR 008 (universal page model),
`xochitl-pen-data.md` (display buffer, `.rm` timing), `durable-install.md`.

Clones studied (scratchpad, not committed):

| repo | ref | notes |
| --- | --- | --- |
| `yangg1224/smart_remarkable` (upstream) | `cb78706` (2026-07-08), 18 commits, branches `main`, `draw-button` | MIT, 73 stars, 13 forks, 3 issues (all closed) |
| `Caerii/smart_remarkable` (our fork) | `cb78706` | **public, identical to upstream**: same HEAD, same branches, zero extra commits (created 2026-07-22, nothing pushed since) |
| `mattpetters/smart_remarkable` `feat/paper-pro-lan-client` | `aa36b18` (2026-09-29), 24 commits ahead | most useful downstream fork (see §6) |
| `guibor/smart_remarkable` `beta/pro/3.29.0.148` | `f5a58ce` (2026-09-21), 42 ahead | OpenClaw/AppLoad/qmd ports for 3.28–3.29 |

Paths below are relative to the upstream clone unless they name another repo.

## Verdict

- **smart_remarkable is a two-day squash of ghostwriter plus Select Mode, an LLM/Draw button and
  image generation.** All 18 commits are from 2026-07-07/08. It is not a GitHub fork of ghostwriter;
  `b02475a` is an "Initial commit" import. It is a single Rust binary that you start over SSH. There is
  no service, no IPC API, no persistence and no CI.
- **Its "virtual pen" is not a uinput device.** It opens the real digitizer node `/dev/input/event2`
  and `write()`s events into it (`src/pen.rs:28-34`, `send_events` at `169-300`). The kernel delivers
  injected events to **every reader of event2, including our Go bridge**. So if smart_remarkable
  draws remote strokes while our bridge streams event2, each stroke echoes back into the session as
  if the tablet user drew it, and nothing can tell them apart afterwards. ADR 008 §4 says "virtual
  pen (uinput)". That should read "evdev injection into the pen node".
- **It sets tool and colour by tapping the toolbar with synthetic finger events at hard-coded
  coordinates**, and checks the result with screenshots (`src/touch.rs:450-690`). Upstream never sets
  a colour on the main path. It just switches to pen slot 1 (`src/main.rs:920-950`).
- **Its XOVI extension adds buttons and does nothing else.** It injects QML `LLM`/`Draw` buttons
  beside the selection menu and signals by touching `/tmp/*_trigger` files. It finds the
  `SceneController` but never calls it. It does **not** insert strokes into the scene. The
  in-process techniques that matter for us (native tool switch through `DocumentView.penHandler`,
  native selection delete, layers, `grabWindow`, meta-method probing) are in its ancestor
  **nathanmarlor/inkling**. smart_remarkable ported only the button part.
- **Its screen capture is goMarkableStream's heuristic, copied with its geometry errors.** It reads
  1632×2154, treats the BGRA data as RGBA, makes no front/back buffer choice, and encodes a full PNG
  on every capture. The mattpetters fork replaces it with XOVI `framebuffer-spy`, which returns the
  exact address and stride (1620×2160, stride 6528, BGRA). That is the path to copy for our tiles.
- **Recommendation:** port the small injection primitives to Go and put the injector **in the
  bridge**, next to the event2 reader. Reasons: echo suppression and "wait until the real pen is out
  of range" both need to know which events we wrote. Then add a small XOVI control extension, built
  on inkling's pattern, that sets tool, colour, thickness and layer natively. Keep smart_remarkable
  as the LLM, Select Mode and buttons app, and make it a session participant that asks the bridge to
  draw. This amends ADR 007 rule 2. Details are in §7.

## 1. Architecture

**Languages and crates.** One Rust crate (`Cargo.toml:1-50`, v0.4.0, Rust 1.92 in
`.tool-versions`). It uses tokio, reqwest/ureq (LLM HTTP), `evdev 0.13` (device I/O and uinput),
`resvg 0.47`/usvg, `svg2polylines 0.8`, `image`/`imageproc`, `figment`+`toml` (config), `warp`
(web UI) and `rust-embed` (prompts, fonts, uinput `.ko`). There is a second binary
`src/bin/experiment.rs`. The XOVI extension is separate C code (`xovi-ext/llmbutton/main.c`, 418
lines).

**Process model.** One process, three tokio tasks: `trigger_task` → `processing_task` →
`progress_task`, joined by mpsc/watch channels (`README.md:320-357`, `src/coordinator.rs`). Triggers
can be a corner tap, a four-finger tap, or the existence of `/tmp/llm_button_trigger` or
`/tmp/draw_button_trigger`, polled about every 150 ms (`src/touch.rs:54-64`, `183-300`). A
trigger takes a screenshot, optionally crops to the selection, calls the LLM with a forced tool
(`draw_text`, `draw_svg`, `draw_answer`, `draw_sketch`), and then types or draws. Device paths are
hard-coded per model: pen `event2`, touch `event3` on the Paper Pro (`src/pen.rs:28-32`,
`src/touch.rs:135-138`). Model detection reads `/etc/hwrevision` (`ferrari 1.0` = Paper Pro,
`src/device.rs:21-35`).

**Running and install.** Cross-build with `cross` for `aarch64-unknown-linux-gnu` (Paper Pro) or
armv7 (rM2), `scp`, then run by hand: `ANTHROPIC_API_KEY=… ./smart_remarkable --select-mode`,
optionally under `nohup` (`README.md:214-286`, `build.sh`). There is **no systemd unit, installer or
update path**, and nothing survives a reboot, let alone an OS update. On the Paper Pro, if
`/dev/uinput` is missing it `insmod`s an embedded GPL-2.0 `uinput-<3.16|3.17|3.18|3.22>.ko`, keyed
on `IMG_VERSION` (`src/util.rs:637-690`, `THIRD_PARTY_LICENSES.md`). If the OS version has no
bundled module it panics (`util.rs:679`). Our tablet already has `/dev/uinput`, because our bridge
creates its keyboard there.

**Config.** Layers are defaults < `~/.smart_remarkable.toml` < `SMART_REMARKABLE_*` env < CLI
(`src/config.rs:92-125`). `--save-config` persists the resolved config.

**Web UI.** `--web-server` serves warp on **0.0.0.0:8080 with no authentication**
(`src/web_server.rs:90`). Routes: `GET/POST /api/config`, `GET /api/status` and
`POST /api/simulation/trigger` (`web_server.rs:32-72`). `GET /api/config` returns the whole `Config`
(`web_server.rs:130-133`), and that includes `engine_api_key` and `image_api_key` when they were
set through the config or CLI (`config.rs:15,35`). On Wi-Fi that leaks keys to the LAN.

**Simulation harness.** `src/simulation/` (screenshot, touch and interaction-log simulators) plus
`--test-mode rm2|rmpp`, `--test-touch-events-file`, `--test-screenshot-dir`, `--input-png`,
`--no-draw/--no-submit/--no-loop/--no-trigger` (simulated triggers can also come from
`POST /api/simulation/trigger`). `run_eval.sh` and `evaluations/` hold model
comparisons from 2024 (inherited from ghostwriter). The harness covers trigger → LLM → plan. It does
**not** emulate xochitl, so injection behaviour is untestable off-device.

**Tests.** 13 `#[test]`s: marquee detection on two real Paper Pro captures
(`src/screenshot.rs:699-721`), SVG layout (`util.rs`), menu detection
(`tests/menu_detect.rs`) and offline image tracing (`tests/trace_image.rs`). There is no CI
(`a9029cf` removed `.github/workflows`).

## 2. Screen capture on the Paper Pro (`src/screenshot.rs`)

| step | code | what it does |
| --- | --- | --- |
| pid | `145-158` | spawns `pidof xochitl` on every capture |
| base | `189-219` | **end** address of the *last* `/dev/dri/card0` line in `/proc/pid/maps` |
| pointer | `222-249` | from there, walks 4-byte length headers at `+8` (glibc malloc chunk sizes) until one is ≥ `1632*2154*4`; returns the chunk start |
| read | `251-259` | one `read_exact` of `1632*2154*4` B (14.06 MB) from `/proc/pid/mem` |
| decode | `261-310`, `378-386` | full-res PNG encode as **RGBA**, decode, nearest-neighbour resize to 768×1024, 180° check, PNG re-encode |

This is a line-for-line copy of goMarkableStream's `internal/remarkable/pointer_arm64.go`
(`calculateFramePointer`, last changed `fcdb5ec`) and of its `const_arm64.go` (1632×2154).
Problems:

- **Geometry.** The real buffer is 1620×2160 visible pixels in rows of 6528 B (1632 px), which
  matches our measurement in `xochitl-pen-data.md`. Reading it as contiguous 1632×2154 leaves the
  12 padding columns in the image and drops the last 6 rows. That is harmless for an LLM screenshot,
  but wrong for pixel-exact tiles.
- **Pixel format.** The buffer is BGRA but is encoded as RGBA, so red and blue swap on colour ink.
  mattpetters fixes this by swapping `p[2],p[1],p[0]` (`smart_remarkable_matt/src/framebuffer.rs:34-43`).
- **Double buffer.** There is no front/back handling. It takes the first chunk that is large enough
  after the last card0 mapping. Our two ~14.1 MB anonymous mappings are not distinguished.
- **Rotation.** Only 0° and 180° are handled, by counting dark toolbar pixels (`312-337`;
  `util.rs:26-47` mirrors injected coordinates). Landscape is not handled.
- **Speed.** Nothing is measured in the repo. Each capture is a 14 MB read plus a full-res PNG
  encode, a decode and a re-encode. `get_pixel` decodes the stored PNG **on every call**
  (`683-696`), and the toolbar probes call it in loops: up to 50 calls in `touch.rs:487-489` and
  450 in `touch.rs:506-507`. That is hundreds of 768×1024 PNG decodes per tool-state check. Expect
  capture plus tool detection to take seconds on the A53. It is fine for an LLM turn and useless for
  live streaming.

**The better path is in mattpetters `src/framebuffer.rs` (`aa36b18`).** When xochitl has XOVI's
`framebuffer-spy.so` mapped (`108-112`), it writes `>eframebuffer-spy$getConfigString:` to
`/run/xovi-mb` and reads `/run/xovi-mb-out` (`85-105`). The reply is
`0xADDR,1620,2160,2,6528,0` (address, width, height, format, stride, flags; Paper Pro Move:
`960,1696,…,3840`, `26-29`). It caches the result per xochitl `pid:starttime` (`113-124`), then
reads `stride*height` from `/proc/pid/mem`. Its docs say the allocator heuristic is unreliable once
XOVI changes the heap layout (`framebuffer.rs:1-2`, `docs/PAPER_PRO_MOVE.md`). That bears directly
on us. If we install any XOVI extension, the goMarkableStream heuristic may break, and
framebuffer-spy becomes the correct discovery method.

**Reuse for our tiles:** reuse the *method*, not the code. In Go:
1. If `framebuffer-spy` is loaded, ask it once per xochitl lifetime.
2. Otherwise, pick the anonymous mapping of the right size (our two 14.1 MB mappings) and choose the
   active one by reading a 1-row probe from each after a known stroke.
3. Read only the dirty rectangle's rows (`stride*h` bytes at `addr + y*stride + x*4`).
4. Never PNG-encode the full frame.

framebuffer-spy registering "one stable buffer per process" (`framebuffer.rs:118-119`) suggests it
gives the buffer xochitl actually paints, which would settle the front/back question. **Verify** on
our firmware.

## 3. The virtual pen (`src/pen.rs`, 825 lines)

**Device.** `Device::open("/dev/input/event2")` (`28-34`), the real Elan digitizer, the same node
our bridge reads. smart_remarkable creates no uinput pen, so the "name, capabilities, ABS ranges"
are the real device's. Its constants are max X 11180 and max Y 15340 (`302-316`, the same as
goMarkableStream). uinput is used only for the keyboard (§5). So the question "does xochitl accept
a second, uinput pen on the Paper Pro?" is **untested in this lineage**. inkling *does* create a
true uinput pen on the rM2 (ABS_X 0–20966, Y 0–15725, pressure 0–4095, distance 0–255, tilt
±9000; `nathanmarlor/inkling daemon/inkling/src/device/uinput.rs:1-27`). On the Paper Pro, nobody
has published that test.

**Events written.**

| action | events | code |
| --- | --- | --- |
| hover-then-press | `ABS_X, ABS_Y, BTN_TOOL_PEN=1, BTN_TOUCH=0, ABS_PRESSURE=0, ABS_DISTANCE=100, SYN`, then `BTN_TOUCH=1, ABS_PRESSURE=2630, ABS_DISTANCE=0, SYN` | `185-206` |
| move | `ABS_X, ABS_Y, SYN` | `291-300` |
| lift | `PRESSURE=0, DISTANCE=100, BTN_TOUCH=0, BTN_TOOL_PEN=0, SYN` | `208-219` |
| erase | same, with `BTN_TOOL_RUBBER` (321) | `230-289` |

Pressure is the constant 2630, and there is no tilt and no per-point pressure. The exception is
`draw_bitmap_alpha_pressure` (`580-649`), an unused experiment that maps alpha to pressure by
lifting and re-pressing. Tool-dependent width, as on ballpoint, brush or calligraphy, cannot vary
along a stroke. xochitl only erases on `BTN_TOOL_RUBBER`, whatever the toolbar shows (`71-78`,
`SELECT_MODE.md:126-136`; measured by the author on 2026-07-08).

**Coordinates.** Everything is planned in a 768×1024 "virtual" space (`15-16`) and then mapped
linearly: `x_in = x/768*11180`, `y_in = y/1024*15340` (`804-824`). Points are rounded to
**integer virtual pixels** (`335-337`, `678`). One virtual pixel is about 2.1 screen pixels, so the
precision is about 2 px with staircasing. Remote strokes would lose detail. The mapping is screen
space only, with no knowledge of xochitl zoom or scroll.

**Speed and pacing.** Segments are subdivided to 1 virtual unit per event (`324-344`, `354`), with
a 1 ms sleep every 100 events and 2–3 ms around each pen-up and pen-down (`391-396`, `431-436`,
`274-287`). There is no points-per-second budget. A 1000-px line is about 480 writes with about
5 ms of sleep, effectively instantaneous. The author notes that "xochitl drops tool-transition and
move events sent as a raw burst" (`271-273`). inkling solved the same problem with batched writes
plus a tuned `--pps` (`uinput.rs:22-27`). No events per second are measured anywhere.

**Fighting the real pen.** There is no guard: no proximity check, no `EVIOCGRAB`, no queue (grep
for proximity/hover/grab finds only the hover-then-press comment). If the user's pen is in range,
injected and real events interleave on one device state machine and both strokes corrupt. Our
bridge must also treat injected events specially (see the verdict).

**Tool and colour.** These come from toolbar automation through synthetic **touch** on `event3`
(`touch.rs:366-439`). Hard-coded virtual coordinates are the palette button `(35,35)`, sidebar
x=28, pens at y=80/130, text at 187, eraser at 240, and size and colour cells (`453-476`). State is
read back from screenshots (`484-564`). `select_fineliner` sets thin plus black (`599-633`). The
main draw path uses `switch_to_tool(Ballpoint)` and `restore_tool` (`main.rs:920-950`), which sets
no colour. All of this is tied to one firmware, one language and one toolbar layout.
mattpetters goes further: a temporary "answer pen" profile chosen from the 9-cell native palette
(`ink_session.rs:26-54`), with the user's tool, size and colour restored afterwards (`1cb24f7`
"default answers to blue and offer four color choices"). That is still taps and screenshots.

**SVG and bitmap to strokes.**
- `draw_svg_paths`: usvg flattens text to paths, then `svg2polylines` at 0.5 tolerance, with pen
  lifts at corners over 25° on long-segment shapes and a 3-unit overshoot (`346-448`, `653-665`).
- `draw_svg_centerline`, the default (`main.rs:369-384`): rasterise at 2× (1536×2048), Zhang-Suen
  thinning, skeleton tracing, 5-point smoothing (`699-729`; `src/skeleton.rs:7,103,127`).
- `draw_bitmap_centerline`: the same for image-model PNGs, plus a speck filter (<4 px) and a uniform
  fit into a rectangle (`736-793`).
- Raster scan modes (`110-149`, `452-575`) are legacy.

**Limits.** One pen device and serial drawing. ~2 px quantisation. Fixed pressure, no tilt. Ink
goes into whatever tool, layer and colour is active. The toolbar must sit where the constants
expect it. Rotation is 0 or 180 only. There is no zoom or scroll model. Strokes it injects become
ordinary user ink: xochitl saves them to `.rm` with the tool that was active, and they are undoable.
That last property is what we want from render-back.

## 4. The XOVI extension (`xovi-ext/llmbutton/`)

- **Build and install.** `llmbutton.xovi` is just `version 0.1.0`, with no imports and no
  overrides. `xovi.c` and `xovi.h` are xovigen output (`xovi.c:1`). There is no Makefile or build
  script in the repo and no `.so`. The recipe is inkling's: `xovigen.py`, `gcc -fPIC -shared` for
  aarch64. Install means copying the `.so` into `/home/root/xovi/extensions.d/` and starting
  xochitl under XOVI (`LD_PRELOAD`). It is not durable: XOVI needs `xovi/start` on every boot and a
  rebuilt hashtab per OS version (`durable-install.md` §1).
- **Hooks.** None. It uses no function hooks at all. At construct time it `dlsym`s about 25 exported
  Qt6 symbols (`main.c:370-405`). It tries three manglings of the `QByteArray(const char*, n)`
  constructor because the `int` one is missing on Qt 6.11 (`387-398`). It starts a pthread
  (`417`).
- **Main loop.** Every **3 s** (`361-368`) it posts a job to the GUI thread through
  `QMetaObject::invokeMethodImpl` on `QCoreApplication::self` (`338-359`). Calling Qt off-thread
  crashed xochitl (`339-343`). The job walks `allWindows()` → `QQuickRootItem` → `childItems`
  (`130-162`). It collects `SceneController`s, `DocumentView`/`DeviceScene` views, and items whose
  class name contains "Select" (`123-136`). On finding `SelectionContextualMenu` (`171-176`) it
  creates two QML `Rectangle{TapHandler}` buttons via `QQmlComponent::setData/create`, parented to
  the menu's parent as siblings (`184-221`, `252-324`). On the next poll it reads the buttons'
  `llmTapped`/`drawTapped` property and touches the trigger file (`263-279`). Because of the 3 s
  poll, the buttons can appear up to 3 s after a lasso and the tap is acted on up to 3 s later.
- **What it adds.** Two buttons, nothing else. It never invokes the `SceneController`. The
  header comment still says "Phase 2: READ-ONLY probe" (`9-16`), which is stale. The selection
  delete it relies on is done by **tapping the trash icon found in a screenshot**
  (`main.rs:386-420`, `screenshot.rs:511-636`), not natively.
- **Ancestor (inkling `xovi-ext/README.md`, `inklingfb/main.c`)** already does more through
  xochitl's own Qt meta-methods, on the rM2 (Qt 6, arm32):
  - native tool switch by writing `DocumentView.penHandler` properties `lineTool`, `gestureMode`
    and `lineThickness`, with the toolbar highlight restored through `selectedButton` (`616-676`);
  - native delete by emitting `SceneSelectionHandler.deleteSelection()`;
  - `SceneController::clearLines`, `addLayer`/`setCurrentLayer`/`deleteLayer`,
    `addSelectionRect`, `clearSelectedItems`;
  - capture with `QQuickWindow::grabWindow` on the worker thread;
  - a probe that dumps every property and method of the `SceneController`s, `DocumentView`s and
    `penHandler` (`/tmp/inkling_probe`).

  It has no stroke-insertion call either.

**What in-app writing with arbitrary tool and colour would take (ADR 008 §4.1).**

1. *Probe (read-only, hours).* Port inkling's meta-method dump to aarch64 and our firmware (Qt 6.x,
   with the aarch64 `x8` sret fix described in `main.c:22-37`). List the `SceneController`,
   `penHandler` and `DocumentView` invokables and properties. The two questions: does
   `penHandler` expose a **colour** property next to `lineTool`/`lineThickness`, and does any
   invokable accept line or point data?
2. *XOVI-assisted injection (days, low risk).* An extension that, on request over
   `xovi-message-broker`, sets `penHandler` tool, thickness and colour, and optionally switches to a
   "remote/ai" layer, before our injector draws a stroke. It restores the user's state afterwards.
   This gives per-author colours and tools with no toolbar taps and no screenshots. Strokes are
   still drawn one at a time, only while the user's pen is out of range.
3. *True scene insertion (weeks, high risk).* This is only possible if step 1 finds an invokable,
   or by a XOVI *override* of an internal C++ function (Line/Scene construction). That kind of hook
   needs symbols, is version-specific, and is what inkling warns against ("xovi's trampoline races
   on hot, multithreaded paths"). It is the only route to **simultaneous** remote and local ink on
   the page, which ADR 008 already notes.

## 5. Keyboard, LLM, Select Mode

**Keyboard** (`src/keyboard.rs`). An `evdev` uinput device named **"Virtual Keyboard"**
(`93-99`) with US letters, digits, punctuation, Enter, Tab, Shift, Backspace, Esc, Ctrl and Alt
(`28-91`). It sends 10 ms per character with a SYN after each (`239-269`). `Ctrl+1..4` select
heading/body/bullet styles (`272-303`). Progress "dots" are typed into the document and then
backspaced (`305-324`). Ours (`bridge/remarkable/native/uinput.go`, "codrawer virtual keyboard",
`keyboard.go:97`) does the same with raw ioctls, adds Unicode fallbacks (dashes, quotes, ellipsis;
`uinput.go:142-170`) and configurable pacing. They are equivalent, and ours is the better typer.
**Conflict found:** our `findKeyboardDevice` (`keyboard.go:102-137`) skips only our own name and
returns the first device whose name contains "keyboard". If smart_remarkable is running before a
Bluetooth keyboard connects, the bridge will read smart_remarkable's "Virtual Keyboard" and stream
its typed answers and progress dots as user keystrokes. Fix: skip `BUS_VIRTUAL` devices (bus
`0x06`) or any `Virtual Keyboard` name.

**LLM.** An `LLMEngine` trait with OpenAI, Anthropic and Google backends (`src/llm_engine/`). Each
uses tool-forced requests from `prompts/*.json`. Anthropic-only extras are thinking and web search
(`anthropic.rs:93-120`). The image model is Gemini `gemini-2.5-flash-image` (`src/image_gen.rs`).
API keys live on the tablet, and a missing key panics. By ADR 007 rule 3 this becomes the fallback
mode, and session turns go through the router and terminal.

**Select Mode.** Two ways to select:
- corner-tap, then two taps for the selection and two for the placement box
  (`coordinator.rs::collect_selection`, `SELECT_MODE.md:7-31`);
- native lasso plus the LLM/Draw button. The selection rectangle is found as the largest connected
  region of exact grey (190–198) in the screenshot (`screenshot.rs:416-504`).

The crop is sent to the model, and the answer is fitted into the box (`util.rs:254-456`).
"Draw on a drawing" deletes the original through the trash-icon tap, with a dense rubber sweep as
fallback, but only after generation succeeds (`README.md:86-97`, `main.rs:386-420`).

## 6. Quality, licence, activity, Paper Pro status

- **Licence.** MIT (`LICENSE`), plus the GPL-2.0 uinput `.ko`s from `pl-semiotics/rM-input-devices`
  (`THIRD_PARTY_LICENSES.md`, fixed in `bd49904` for issue #1). Lineage: `awwaiid/ghostwriter`
  (MIT, 565 stars, last push 2026-07-10, adds Paper Pure "tatsu" support in `1e1a8b2`). Screen
  capture is from goMarkableStream and reSnap (MIT). The drawing idea is from rmkit lamp. The
  XOVI pattern is from `nathanmarlor/inkling` (MIT). XOVI itself is LGPL-3.0, and
  `rm-xovi-extensions` (framebuffer-spy, qt-resource-rebuilder) is GPL-3.0.
- **Code quality.** Reasonable Rust with good on-device findings in comments. But: hard-coded
  device paths and UI coordinates, `unwrap`/`panic` on device open and missing keys
  (`pen.rs:34`, `touch.rs:144-145`, `util.rs:679`), repeated PNG decodes, a new `Touch` and
  `Screenshot` per helper call, an unauthenticated web UI that leaks keys, no CI, and few tests.
- **Activity.** Upstream went quiet after 2026-07-08. The fork network carries the work:
  - mattpetters: Paper Pro Move, registered framebuffer capture, colour profiles, native
    settings panel via qt-resource-rebuilder, LAN/Codex/Claude bridge, systemd override plus
    Tailscale (2026-09-26..29);
  - guibor: OpenClaw bridge, AppLoad, per-firmware `xovi-qmd/` ports for 3.28.0.163–169 and
    3.29.0.148, guarded deploy and rollback scripts.

  `Caerii/smart_remarkable` has none of this yet.
- **Paper Pro status.** Developed and tested on the Paper Pro (marquee fixtures are `rmpp_*.png`,
  Qt 6.11 notes in `main.c`). Capture uses the fragile heuristic. Toolbar coordinates are tied to
  one layout. uinput modules exist only for OS 3.16–3.18 and 3.22. Known gaps: no landscape, no
  zoom or scroll, injection collides with the real pen, and XOVI (when used) can break the capture
  heuristic.

## 7. What codrawer should do

**Overlaps with our bridge.** Both read event2: we stream it, they write into it. Both create a
uinput keyboard. Both read xochitl's display buffer: we plan to for tiles, they do for LLM
screenshots. Both have LLM callers: ours is the session and terminal. Both detect the device model
and coordinate ranges.

**Reuse (port to Go, about 300 lines):**
- the hover-then-press pen-down sequence and lift (`pen.rs:185-219`);
- rubber erase (`230-289`);
- segment subdivision with pacing (`324-344`);
- polyline splitting at corners (`346-448`), for agent SVG;
- 180° mirroring (`util.rs:40-47`).

Keep the SVG and skeleton tracing (`skeleton.rs`, `draw_svg_centerline`) in smart_remarkable, or
on the desktop for agent ink. The tablet bridge should receive points, not SVG.

**Call as a component:** smart_remarkable's LLM, Select Mode, Draw, image generation and XOVI
buttons, as a session participant (ADR 007 rule 5).

**Contribute to the Caerii fork** (in this order):
1. capture: framebuffer-spy path, plus correct 1620×2160 and stride 6528 BGRA fallback (cherry-pick
   from mattpetters `framebuffer.rs`), and decode-once `get_pixel`;
2. web UI: bind 127.0.0.1 by default, redact keys, optional token;
3. rename the keyboard to `smart_remarkable virtual keyboard` and honour `--no-keyboard` (the field
   already exists, `config.rs:21`);
4. a proximity guard (don't inject while `BTN_TOOL_PEN=1` on event2) and a points-per-second
   budget;
5. an "external injector" mode: when the codrawer bridge is present, send `draw`/`type` requests to
   it over a local socket instead of writing event2 and uinput itself;
6. the codrawer participant client (trigger → turn with the selection attached);
7. an XOVI build script, plus moving from a 3 s poll to a shorter one or a signal;
8. consider merging mattpetters' Move support and colour profile work.

**Recommended integration plan.**

```
            router/session (page model, ADR 008)
                 │ ws: page_update, stroke_*, "draw"/"type" requests
   ┌─────────────▼──────────────── tablet ─────────────────────────────┐
   │ codrawer bridge (Go) — sole owner of input devices                │
   │  reader: event2 pen, keyboard ─► strokes/keys (skips own injects) │
   │  injector: event2 writes, paced, only when real pen out of range  │
   │  typer: one uinput keyboard (ADR 005)                             │
   │  tiles: display buffer via framebuffer-spy addr/stride, dirty rows│
   │  local socket ◄── smart_remarkable (LLM/Select/Draw, participant) │
   │  xovi-mb ──► codrawer-ink XOVI ext: penHandler tool/colour/layer  │
   └───────────────────────────────────────────────────────────────────┘
```

1. **Amend ADR 007 rule 2.** The render-back *path* is "the bridge's injector, using
   smart_remarkable's algorithms", not smart_remarkable's process. The injector has to sit next to
   the event2 reader. That is the only place that knows which events it wrote, so it can mark them
   `origin=injected` (ADR 008) instead of echoing them, and the only place that knows the real pen
   is in range, so it can queue.
2. **Probe (read-only, on-device, when the tablet is awake):**
   - does xochitl on our firmware draw from a *uinput* pen device (a clean second pen would make
     echo filtering trivial by device);
   - framebuffer-spy availability and output;
   - inkling-style dump of `penHandler` properties (is there a colour property?).
3. **Go injector** in `bridge/remarkable/native/inject`. Input is page-model strokes in page units
   (1620×2160), mapped to event2 units (11180×15340), unzoomed only for now. It queues while the
   real pen is in range plus about 500 ms. It paces at a measured points-per-second rate and drops
   its own events from the reader. Test: one stroke from the phone onto the page (ADR 008 step 4).
4. **codrawer-ink XOVI extension** (inkling pattern, aarch64): set tool, colour, thickness and layer
   per stroke over xovi-message-broker. Map each author's colour to the nearest Paper Pro ink. Gate
   it by OS version (`durable-install.md`).
5. **Tiles** from the same process, framebuffer-spy first and size scan second, with no full-frame
   encode.
6. **Later:** research true scene insertion (§4 step 3) for simultaneity.

Open questions to verify on the device: whether xochitl accepts uinput pens on the Paper Pro;
whether `penHandler` has colour; framebuffer-spy on our OS build; the safe injection rate before
`SYN_DROPPED`; how injected strokes behave under zoom and scroll.
