# LaTeX on the Paper Pro: rendering, editing and handwriting → LaTeX

Status: research and design (2026-10-06). No code ships with this document except the spikes under
`scripts/dev/latex_spikes/`. It answers how codrawer could bring LaTeX to the reMarkable Paper Pro:
compile and render it, convert handwriting to it, and edit its source on the tablet with a rendered
preview opened by a button. It proposes a set of primitives and an architecture, and backs them
with measurements.

Method: everything on the tablet was **read-only** (ssh `cat`/`ls`/`grep` of `/proc`, `/usr/lib`,
the xochitl config and journal, plus one `scp` of a system library *off* the tablet). Nothing was
installed or written there, and nothing was restarted. Compilation and rendering spikes ran on
the desktop (i7-10700KF, Windows 11, Docker). Inputs: `native-multiplayer-layer.md`,
`native-erase.md`, the `codrawer-layer` XOVI extension (`bridge/remarkable/xovi/codrawer-layer/`),
ADR 005, 007 and 008, `keyboard-latency.md`, `what-codrawer-changes.md` (Tailscale), and the Primer
(ADR 010, recognition and `latex.py`). The Primer is work in progress and **not yet on `dev`**:
ADR 009/010 and its code live in an unmerged worktree, so this document cites its design, not
merged code.

## Recommendation in one page

1. **Phase 1: render on the desktop, show the result natively on the tablet.** The desktop joins
   the tablet's session as a `renderer` participant over the tailnet or LAN. It renders math with
   MathJax under Node (≈5–12 ms per formula, measured) and whole documents with Tectonic (≈1 s warm,
   measured). The SVG/PNG comes back to the tablet, where the `codrawer-layer` extension does one
   of two things with it:
   - shows it in a **QML preview panel**. xochitl already loads QtSvg and its image plugin, so an
     `Image` can display the SVG directly.
   - or, on request, **inserts it into the page as a native image item**. This uses
     `SceneController.insertImageFileAsSceneItem(QUrl, QPointF)`, which exists in xochitl 3.29's
     meta-object (see below). The image is saved, synced, movable with the lasso and undoable.

   The phone keeps its KaTeX rendering (the Primer's panel). A dock button "Render LaTeX" and a
   lasso action "Convert to LaTeX" drive it. Effort: about 2–3 weeks, gated by one on-device probe
   of `insertImageFileAsSceneItem`.
2. **Phase 2: offline math on the tablet with no new native code.** Run the same MathJax bundle
   (TeX → SVG with no DOM, 1.8 MB) in a **QML `WorkerScript`**, Qt's own V4 JavaScript engine on its
   own thread. xochitl already maps `libQt6QmlWorkerScript`. QtSvg then draws the result.
   - The spike ran this bundle in QJSEngine: it works, and QtSvg renders it faithfully.
   - It is slow: 70–290 ms per formula on the desktop's V4, which suggests **≈0.5–2 s per formula
     on the A53**. That is acceptable for "render when I pause", not for keystroke-by-keystroke
     preview.
   - MicroTeX (C++, Qt backend) or JKQTMathText is the fallback if the device measurement
     disappoints. It is fast, but means native code inside xochitl and a math font to ship.
3. **Phase 3: a full on-tablet editor, and offline documents.**
   - The editor is a QML panel fed by the bridge's evdev key stream. The bridge grabs the
     keyboard (`EVIOCGRAB`) while the panel is open, and the extension delivers the decoded
     characters as `QKeyEvent`s with explicit text. This bypasses xochitl's keymap, which is why
     `[ ] { } ^ ~` are lost today (decoded below).
   - Optionally, a static **Tectonic** (aarch64 musl, 26 MB) on `/home` compiles full documents
     offline from a pre-warmed ~42 MB cache. That is verified on aarch64 under emulation, with an
     estimated 5–10 s per compile on the A53.

**Why the `^ [ ] { } \ ~` characters vanish** (new, decoded from xochitl's platform plugin):
- xochitl maps physical keys itself, in `libepaper.so`. With no Type Folio and no `InputLocale`
  setting it falls back to its built-in **"US" table**. In that table `[`/`]` are *dead acute* and
  *dead diaeresis*, `{`/`}` are *dead grave* and *dead tilde*, Shift+6 is *dead circumflex*, and
  the `` ` ``/`~` key is unmapped.
- **No key produces `[ ] { }` at all** in that table. Of the nine locales, only UK has them, and
  UK has no `\`.
- A dead key starts a compose sequence that xochitl's input context resolves or drops ("Invalid
  sequence"). `\` *is* mapped (KEY_BACKSLASH → U+005C), so its loss is probably collateral: it
  followed a dead key in the test string. This still needs checking on the device.
- So no uinput layout trick can type LaTeX into xochitl. Text has to arrive above the keymap:
  `SceneController.pasteText(…)`, a `QKeyEvent` with text, or our own panel.

## 1. Facts measured on the tablet (2026-10-06, read-only)

| Fact | Value | How |
| --- | --- | --- |
| SoC / CPU | i.MX 8M Mini ("imx8mm-ferrari"), 4 × **Cortex-A53** (implementer 0x41, part 0xd03), 600/1200/**1800 MHz**, `schedutil`; features `fp asimd aes pmull sha1 sha2 crc32` | `/proc/cpuinfo`, cpufreq sysfs |
| RAM | 2.0 GB, ~1.3 GB available with xochitl running; swap 0.96 GB zram + 1.5 GB on dm-1 | `free`, `/proc/swaps` |
| Storage | `/home` 46 GB, **43.4 GB free**; rootfs 515 MB, **42.6 MB free** (so anything large goes on `/home`) | `df -h` |
| Kernel / OS | Linux 6.12.49 aarch64, reMarkable 3.29 / Codex, BusyBox 1.37 | `uname`, `os-release` |
| Interpreters | no `perl`, `python3`, `node`, `curl`; `wget`, `tar`, `xz` present | `command -v` |
| Fonts | EB Garamond (variable, roman + italic), Noto Sans (+ Arabic, Devanagari, Hebrew, JP, KR, SC, Thai, Lao), Noto Sans Mono. **No math font** | `/usr/share/fonts/ttf` |
| Tailscale | `tailscaled --tun=userspace-networking` (no `/dev/net/tun`): tailnet peers can reach the tablet's listening ports, but **tablet processes cannot dial tailnet addresses** without a SOCKS/HTTP proxy | `bridge/remarkable/boot/tailscale.sh`, `what-codrawer-changes.md` |

**Qt modules xochitl has mapped** (`/proc/<xochitl>/maps`, xochitl pid 336, Qt 6.10.3):
- Core: `Core`, `Gui`, `DBus`, `Network`, `Xml`, `WebSockets`.
- QML: `Qml`, `QmlCore`, `QmlMeta`, `QmlModels`, **`QmlWorkerScript`**.
- Quick: `Quick`, `QuickLayouts`, `QuickTemplates2`, `QuickControls2` (+ Basic, Fusion, Impl).
- **`Svg`**.
- Plugins: `imageformats/libqsvg.so` (with gif/ico/jpeg), `platforms/libepaper.so`, the QtCore,
  Controls, Layouts, Templates and Window QML plugins.
- Non-Qt: **`libpdfium.so`**, `libfreetype`, `libharfbuzz`, `libfontconfig`, `libQtWebAppHttpServer`
  (the USB web interface), `libdatachannel`.

**Installed but not loaded** (in `/usr/lib` and `/usr/lib/qml`; an injected QML component can
`import` them, and Qt loads the library on demand):
- **`QtQuick.Shapes`** (`libQt6QuickShapes`) and **`QtQuick.VectorImage`** (`libQt6QuickVectorImage*`,
  Qt ≥ 6.8: draws SVG as Shapes).
- `QtQuick.LocalStorage`, `QtNetwork` (QML), `QtWebSockets` (QML), `Qt.labs.*`, `Concurrent`, `Sql`.
- Not present: no QtPdf, no QtWebEngine.

So the answer to "does xochitl ship QtSvg / Quick Shapes?" is yes and yes:
- QtSvg is loaded and live, so an `Image { source: "file:///…/x.svg" }` decodes through `libqsvg`.
- Shapes and VectorImage are on disk and importable.

## 2. Rendering engines: on the tablet versus remote

### (a) Tectonic (Rust, XeTeX-based)

- **Builds.** The 0.17.0 release (2026-07-27) ships `tectonic-0.17.0-aarch64-unknown-linux-musl`
  (9.9 MB gzip). It is a **25.9 MB static ELF** that needs nothing from the tablet's glibc.
- **Spike** (`scripts/dev/latex_spikes/tectonic_bench.sh`): one amsmath/amsthm proof document
  (the Primer's shape) compiled with a fresh cache.

  | Run | x86_64 musl, native (Docker) | aarch64 musl under qemu-user |
  | --- | --- | --- |
  | cold (download files + build `latex` format) | 53.6 s | 81.5 s |
  | warm | **1.0 s** (0.95–1.11 over 3 runs) | 5.8 s |
  | offline, `--only-cached` | **0.93 s, rc 0** | 5.0 s, rc 0 |
  | output | `math.pdf` 20,261 B | identical size |
  | peak RSS (warm) | **181 MB** | — |
  | cache after one document | **42 MB** (24 MB format file + 19 MB bundle files) | same |

  The aarch64 binary runs and produces the same PDF. Under emulation the times only prove that
  it works. For the A53: a Cortex-A53 at 1.8 GHz runs single-thread code roughly 6–10× slower than
  this i7 core (in-order core, small caches; a published-benchmark ratio, **not measured here**).
  So expect **≈5–10 s per warm compile**, and minutes for the first format build.
- **Offline use** works once the cache holds every file a document needs. `--only-cached` succeeded
  with no network. A new `\usepackage` needs the network again, or a pre-warmed cache shipped with
  the release (bundle files are fetched on demand from the itar bundle; 0.17 fetches them
  concurrently).
- **Fidelity:** full documents, almost all of CTAN through the bundle, XeTeX (Unicode, OpenType).
- **Risk:**
  - 181 MB RSS next to xochitl is fine (1.3 GB available), but the compile pegs a core for
    seconds, so it would run in the bridge's process group at low priority, never inside xochitl.
  - Tectonic emits PDF; the tablet would still have to rasterize it. xochitl has pdfium in
    process, but no API of ours reaches it. Options: render to PNG on the tablet with a second
    static tool, or use Tectonic's `-o` with `dvisvgm`, which is not in Tectonic.

### (b) A minimal TeX Live

TeX Live ships `aarch64-linux` binaries. A `scheme-basic` install is about 116 MB without docs
(other counts give ~265 MB, depending on what is counted), and `scheme-small` about 210 MB
([size notes](https://latex.silmaril.ie/formattinginformation/size.html),
[TeX Live guide](https://tug.org/texlive/doc/texlive-en/texlive-en.html)). Space is not the
problem (43 GB free). The problems:
- The installer and `tlmgr` are **Perl**, and the tablet has no Perl. The tree would have to be
  built on the desktop for aarch64 and copied over, then maintained by hand.
- Several engine wrappers expect a full userland.
- It fits less well than Tectonic's single static binary in our signed-release model
  (`durable-install.md`).

**Not recommended.** Tectonic gives the same fidelity with one file.

### (c) MicroTeX (C++ LaTeX math renderer, Qt backend)

[NanoMichael/MicroTeX](https://github.com/NanoMichael/MicroTeX): MIT licence, C++17, CMake or
Meson.
- **Backends:** Qt (`-DQT=ON`), Cairo, GDI+, Skia, wasm.
- **Output:** renders formulas through a small `Graphics2D` interface, plus a headless mode that
  writes SVG.
- **Scope:** math only (formulas, matrices, arrays, text inside math). It is not a document
  engine.
- **State:** the last commits were 2024-04 (master) and 2024-08 (`openmath` branch, OpenType-math
  fonts converted to its own `.clm` format). It is unmaintained since.
- **Fonts:** it needs a math font. The tablet has none, so we would ship one (Latin Modern Math or
  similar, under 1 MB).

**Fit:**
- It compiles with the toolchain we already have (`codrawer-layer/Dockerfile`: aarch64 g++,
  Qt 6.8 arm64 headers; Qt 6 binary compatibility carries it to 6.10.3).
- A `Graphics2D` implementation over `QPainter`, in a `QQuickPaintedItem` registered from the
  extension, draws formulas straight into an injected QML panel. Native speed, so per-formula
  times in milliseconds are likely. Not measured.

**Alternative of the same kind:** [JKQTMathText](https://github.com/jkriege2/JKQtPlotter)
(part of JKQtPlotter, LGPL-2.1, Qt 5/6, maintained: pushed 2026-09-23). It is a `QPainter`
LaTeX-math renderer and better maintained than MicroTeX.

**Risk:** this is native code running *inside* xochitl, whose unit has `WatchdogSec=60` and
`OnFailure=emergency.target` (`native-multiplayer-layer.md`). A renderer crash is a xochitl crash,
which the XOVI guard then turns into the kill switch. Static initialisation and font loading must
be lazy and must fail closed.

### (d) KaTeX or MathJax inside xochitl's own JavaScript engine

Spike: `scripts/dev/latex_spikes/qjs_mathjax.py`, run with PySide6's Qt 6.11. That is the same V4
engine and QtSvg code as the tablet's 6.10.3.

- **KaTeX runs in V4 but is useless there.** `renderToString` returns HTML: 3,650 B for one
  display formula, with `vlist` spans and 36 `style=` attributes. CSS does the layout, and QML's
  `Text` rich-text subset cannot do it. KaTeX's MathML output needs a MathML renderer, which Qt
  does not have. **KaTeX stays on the phone** (a browser), as in the Primer's panel.
- **MathJax 3 with `liteAdaptor` (no DOM) → SVG runs in V4.**
  - The bundle is 1.82 MB (esbuild IIFE, `--target=es2016`). It needs one shim: V4 has no
    `globalThis` (ES2020), so the loader prepends `var globalThis = this;`.
  - The output is self-contained SVG (`fontCache: 'none'`: glyphs as filled paths), 6–12 KB per
    formula.

  | Spike: six formulas (fraction, integral, sum, `aligned`, `cases`, matrices) | Node 24 (V8) | QJSEngine (V4, Qt 6.11), desktop |
  | --- | --- | --- |
  | bundle load | 119 ms | 361–734 ms |
  | first call, six formulas | 70 ms | 428–1,434 ms |
  | warm, six formulas | **29 ms** (≈5 ms each) | 491–1,753 ms (≈80–290 ms each) |
  | QtSvg draw, 120 px tall | — | 1–12 ms each, `isValid()` true for all six |

  (The V4 range spans four runs on a desktop shared with other jobs; V4 is 15–40× slower than V8
  here.) The PNGs drawn by QtSvg are typographically correct: stacked fractions, stretched
  parentheses around matrices, `\implies`, aligned columns.
- **On the A53:** ×6–10 on the V4 numbers gives **≈0.5–3 s per formula and 3–7 s to load the
  bundle**. That is an estimate to confirm with one on-device measurement (Phase 2's first probe).
- **Where it would run:** never on xochitl's GUI thread (the 60 s watchdog, and a frozen UI). A QML
  **`WorkerScript`** runs JavaScript in its own V4 engine on its own thread, and xochitl already
  maps `libQt6QmlWorkerScript`. Another option is a `QJSEngine` that the extension owns on a
  `QThread`.
- **Fidelity:** TeX math with every MathJax package (AMS environments, `cases`, `matrix`, `\mathbb`,
  `\operatorname`, …). No document layout, and no TikZ.
- **Currency:** the spike used MathJax 3 (`mathjax-full`). MathJax 4.1.3 (2026-07,
  [mathjax/MathJax-src](https://github.com/mathjax/MathJax-src)) is current, and its V4
  compatibility must be rechecked.

**Display of the SVG on the tablet**, from what is loaded:
- `Image { source: "file:///run/codrawer/latex/<id>.svg"; sourceSize.height: … }` decodes through
  `libqsvg` (loaded) and rasterizes at the requested size. That suits e-ink.
- `QtQuick.VectorImage` would draw the paths as Shapes (on disk, not loaded). It is not needed.

### (e) Remote rendering on the desktop, over the tailnet or LAN

- **Math:** MathJax under Node, the same bundle, ≈5 ms per formula warm.
- **Documents:** Tectonic, about 1 s warm, or the desktop's own TeX Live. The Primer's
  `latex.compile_tex` already prefers `pdflatex`, then `tectonic`, then `xelatex`, with a 180 s cap.
- **Returned to the tablet:**
  - SVG (6–12 KB per formula);
  - PNG at the tablet's 227 dpi for pages (PDF → PNG with pdfium/poppler on the desktop);
  - the PDF itself for export;
  - optionally stroke paths (§3b).
- **Transport, a constraint we measured:**
  - The tablet's Tailscale runs in userspace mode, so a tablet process cannot open a connection
    *to* the desktop's tailnet address. The tablet's router *can* be reached from the tailnet.
  - The renderer therefore **dials in**: it joins the tablet's session (`ws://<tablet>:8577/ws/<s>`)
    as a participant of kind `renderer`, exactly as the desktop router and the Primer join today.
  - No new listener on the tablet, no proxy.
  - The alternative is to enable `tailscaled --socks5-server` and give the bridge a SOCKS dialer.
- **Latency budget** (estimated, not measured end to end):

  | Hop | Time |
  | --- | --- |
  | key → bridge → tablet router | < 20 ms (`keyboard-latency.md`) |
  | router → desktop | ~2–20 ms LAN or direct WireGuard; more through a DERP relay |
  | MathJax | ~5–12 ms |
  | SVG back to the tablet | ~2–20 ms |
  | extension writes the file, `Image` reloads, e-ink partial refresh | not measured |
  | **total** | **≈50–300 ms** before the panel refresh |

**Comparison**

| Engine | Where | Fidelity | Latency (per formula / doc) | Size on tablet | Offline | Main risk |
| --- | --- | --- | --- | --- | --- | --- |
| Tectonic | tablet | full documents | est. 5–10 s warm doc; minutes cold | 26 MB + ~40–100 MB cache | yes, after cache warm | CPU minutes on first use; PDF still needs rasterizing |
| TeX Live minimal | tablet | full documents | est. similar to Tectonic | 116–265 MB | yes | no Perl; hand-maintained tree |
| MicroTeX / JKQTMathText | in xochitl (extension) | math only | likely ms (native, not measured) | few MB + math font | yes | native code in xochitl's process (watchdog) |
| MathJax in V4 (WorkerScript) | in xochitl (QML) | math only (all of MathJax) | est. 0.5–3 s; 3–7 s first load | 1.8 MB JS | yes | slow; V4 ES gaps (`globalThis`) |
| KaTeX in V4 | in xochitl | — (HTML output Qt can't lay out) | — | — | — | not viable |
| Remote (MathJax/Tectonic on desktop) | desktop | full | ~10 ms math, ~1 s doc + network | 0 | no | needs desktop reachable; DERP latency |

## 3. Display targets on the tablet

### (a) A non-destructive QML overlay or preview panel

- **How it is injected.** The extension creates a `QQmlComponent` in xochitl's own `qmlEngine`, the
  runtime injection framework being built for the toolbar dock. It parents the panel to the
  DocumentView's window. Nothing is saved, so this is the safe default for previews.
- **What it contains:**
  - the source;
  - the rendered SVG (`Image`), or a status line;
  - the actions Edit / Insert as image / Insert as ink / Export.
- **Anchored to the page.** An overlay bound to a page region must follow pan and zoom through
  `sceneToView`/`viewToScene` and `tileManager.sceneToViewTransform`, as in
  `native-multiplayer-layer.md` §3. A docked side panel avoids that entirely, which is why Phase 1
  uses a panel.
- **Crash discipline**, from inkling: keep the component alive for the process lifetime, never
  parent into the selection menu's container, and whitelist property reads.

### (b) Typeset output as native strokes on the agent layer

This is feasible, and the stroke count is modest. MathJax's SVG for the six spike formulas holds
10–23 paths, **13–33 closed contours** and 400–740 segment commands. Converted to `Line`s, that is
13–33 strokes per formula through `addDrawingLine` on our layer (the Probe 1 route). But glyphs are
*filled outlines*, and a pen draws *lines*:

- **Outline only** (stroke each contour): hollow letters. Legible above roughly 8 mm glyph height,
  muddy below. Cheapest.
- **Outline plus hatch fill**: looks typeset, but costs many strokes (hundreds per formula), and
  the eraser and lasso see a cloud of tiny lines.
- **Centre-line tracing** (skeletonize the rasterized glyph, smart_remarkable's approach for
  bitmaps): single-stroke but wobbly at junctions.
- **Single-stroke font substitution** (recommended if ink is wanted): ask MathJax for
  `fontCache: 'local'`, which emits each glyph as `<use href="#MJX-TEX-…-<codepoint>">` with a
  transform. Then replace each glyph by a Hershey-style single-line glyph scaled into the same box,
  and keep MathJax's rules (fraction bars, radicals) as straight strokes. The result reads like neat
  handwriting, about one stroke per glyph part, and fully erasable and editable as ink.

Ink is the right target when the user wants to *keep writing around and over* the typeset math, or
wants the agent's answer in the medium (ADR 009/010, call and response). For pure display, (d)
below is better.

### (c) A rendered PDF page in the notebook

- xochitl renders PDFs with **pdfium, in process** (`libpdfium.so` mapped; it also writes PDFs with
  it on export).
- A PDF is its own *document*. Notebook pages can be inserted between its pages, but no API inserts
  a PDF page into a notebook.
- Ways to get a PDF document onto the tablet:
  - **USB web interface upload**: xochitl's in-process QtWebApp server, with `/upload` and
    `/documents/` routes in the binary. USB only, and it must be enabled in Settings. Whether the
    bridge on the tablet may post to it locally is untested.
  - **Cloud sync** (rmapi and the like): it needs the account, and adds latency.
  - **Writing files into xochitl's data directory**: it needs a xochitl restart to show. Rejected,
    as everywhere in this repo.

**Conclusion:** PDF is an *export* format (send to desktop or phone, attach to a turn, ADR 002), not
the in-notebook display path. For a full rendered page inside a notebook, rasterize it on the
desktop and use (d).

### (d) New: a native image item, `SceneController.insertImageFileAsSceneItem`

**Evidence.** xochitl 6.0.105's `SceneController` meta-object strings list, in its invokable
block next to `addDrawingLine`:
- `pasteText`, `pasteClipboardContent`, `pasteClipboardContentAsFloatingSceneImage`;
- **`insertImageFileAsSceneItem` (`QUrl fileUrl`, …)**, **`insertImageAsSceneItem` (`QImage image`)**;
- `insertItemsAtCursorPosition`, `selectImageAtPoint`, `selectionContainsImage`.

The scene-queue wrappers carry the full signatures:
- `SceneController::insertImageFileAsSceneItem(const QUrl&, QPointF)::{lambda(Scene*)}`
- `SceneController::insertImageAsSceneItem(const QImage&)::{lambda(Scene*)}`

The same pattern as `addDrawingLine`. Nearby strings: `createPersistedSceneImageItem`, "failed to
persist image resource", `CrdtImageItem`, `imagePastingEnabled`.

So 3.29 has **persisted image items in the page CRDT**. Inserting one from a file is a single
meta-call from the extension on the GUI thread. The rendered formula then:
- becomes part of the page;
- saves and syncs;
- moves and scales with the lasso;
- undoes;
- is never confused with the user's ink.

That makes it the best "Insert" target for display.

**Unknowns for a probe** (Probe L1, §8):
- which formats it accepts (PNG surely; SVG maybe, through qsvg);
- how image pixels map to page units, so we can set a resolution;
- whether `imagePastingEnabled` gates it;
- what the `.rm` block looks like. Our pagewatch must tolerate it; rmscene 0.8 may not parse image
  blocks.

## 4. Editing LaTeX source on the tablet

### Why xochitl drops `^ [ ] { } \ ~`: decoded

xochitl reads physical keyboards in its own platform plugin, `libepaper.so`
(`EpaperEvdevKeyboardHandler`), not Qt's evdev plugin (`libqevdevkeyboardplugin.so` is installed
but not mapped).

**How the table is chosen.** The plugin carries one static table per locale, exported as
`EpaperEvdevKeyboardMap::Locale::<Country>::keymap`:
- with a Type Folio attached, the Folio firmware's language (`…/rm_hwmon_keyboard…/language`; it
  reads "No such device" here, since no Folio is attached);
- else the `InputLocale` Qt setting (absent from `xochitl.conf`);
- else, in the plugin's own words, "No keymap set by QT settings or firmware, defaulting to US."

**The US table**, decoded by `scripts/dev/latex_spikes/xochitl_keymap.py`:

| Key (Linux code) | Plain | Shift | A US layout expects |
| --- | --- | --- | --- |
| KEY_6 (7) | `6` | **dead circumflex** (U+0302) | `^` |
| KEY_LEFTBRACE (26) | **dead acute** | **dead grave** | `[` `{` |
| KEY_RIGHTBRACE (27) | **dead diaeresis** | **dead tilde** | `]` `}` |
| KEY_GRAVE (41) | *unmapped* (Key_unknown) | *unmapped* | `` ` `` `~` |
| KEY_BACKSLASH (43) | `\` | `\|` | `\` `\|` |

Every locale, for the LaTeX-critical characters:

| Locale | `[` `]` `{` `}` | `~` | `^` | `` ` `` | `\` |
| --- | --- | --- | --- | --- | --- |
| US (default) | none | dead | dead | dead | KEY_BACKSLASH |
| UK | KEY_LEFTBRACE/RIGHTBRACE (Shift for braces) | dead | dead | none | none |
| DE, FR, ES, IT, SE, DK, NO | none | dead or none | dead or none | dead or none | none |

**What happens to a dead key.** The input context (`devicekeyboard/keyboardinputcontext.cpp`, log
strings "Partial sequence", "Completed sequence", "Invalid sequence", `composeIndex`) holds it.
Followed by a character with no composition, the sequence is invalid and is dropped.

**`\`.** It is in the table, so typed on its own it should arrive. In a test string such as
`^[]{}\~` it follows the dead tilde, which explains its loss. To confirm: type `a\b` alone.

**Consequence.** No uinput layout or key-code mapping can type `[ ] { }` into xochitl under the
default table, because nothing maps to them. Switching `InputLocale` to UK would gain them and
lose `\` and `` ` `` (and move `@`/`"`), and it changes the user's settings. Rejected. Dead key
plus space may yield a spacing `^`/`~`, but that is untested and does not help the brackets.

### Options, ranked

1. **Our own QML editor panel, fed by the bridge (recommended for source editing).**
   - The bridge already reads the Bluetooth keyboard from evdev with its own complete US map
     (`keyboard.go`: `26: {"[", "{"}, 27: {"]", "}"}, 41: {"`", "~"}, 43: {"\\", "|"}`).
   - While the panel is open, the bridge takes an **exclusive grab** (`EVIOCGRAB`) so xochitl stops
     seeing the keys. The kernel releases the grab if the bridge dies, so a crash never strands the
     keyboard. The bridge then sends decoded key events over the extension's socket.
   - The extension posts each one to the panel's `TextArea` as a `QKeyEvent` *with its text*. The
     platform keymap and the input context both sit upstream of that, so every character arrives,
     and Qt's editor gives cursor, selection, undo and clipboard for free.
   - The `key` stream also still reaches the session, so the glasses and phone mirror the source.
2. **Text injection into xochitl's own text, above the keymap.** This is for "type this LaTeX into
   my text box", and it also fixes the general typer (ADR 005) for every non-keymap character:
   - `SceneController.pasteText(…, PasteMode, MergeActionMode)`, or `Clipboard.setTextFromString`
     followed by `pasteClipboardContent`;
   - or a `QKeyEvent` with text to the focused item.

   Which of these xochitl's text item honours is for Probe L2. Until then, the uinput typer should
   keep **refusing** the unmappable characters (today it types them and xochitl drops them), and
   report them.
3. **Snippets and templates.** Templates such as `\frac{□}{□}`, `\sum_{□}^{□}`, `\begin{align}…`
   and Greek letters come from a palette in the panel, the glasses HUD (`/` completion already
   exists), or the phone. They save typing, but they *require* option 1 or 2 to land, since they
   contain braces.

### The round trip with the Primer, and live preview

```
ink (lasso)  ──Convert to LaTeX──▶  Primer recognize (Claude reads the rendered ink, ADR 002)
                                     → steps[].latex + strokes + bbox (already in the Primer's message)
     ▲                                          │ latex_doc{source, ink=[ids], region}
     │ insert as image / ink                    ▼
 tablet page ◀── render (desktop MathJax/Tectonic, or on-tablet WorkerScript) ◀── edit in panel
```

- **Binding to the ink.** The Primer already returns, per step, the stroke ids it read and their
  normalized `bbox`. A `latex_doc` keeps them, so the preview can sit next to the ink, and tapping
  a step highlights its strokes. After an edit, the source is the truth and the ink is history. The
  user's ink is **never** deleted or rewritten automatically.
- **Live preview:**
  - split the source into blocks (each display environment or `$…$`), hash each, and re-render
    only changed blocks;
  - debounce about 250 ms after the last key, drop stale results by `rev`;
  - remotely, ≈5–10 ms of MathJax per block, so it feels live;
  - on the tablet (Phase 2), render on pause only, at 0.5–3 s per block;
  - document mode (Tectonic) renders on an explicit Render or a long pause, about 1 s on the desktop.

## 5. Primitives

A minimal set:

1. **`latex_doc`**: a LaTeX object bound to a page region or an ink selection. Fields:
   - `id`, `page` (ADR 008 page id), `region` `[x0,y0,x1,y1]` (normalized page coordinates);
   - `ink` (stroke ids it came from, possibly empty);
   - `mode`: `inline` | `display` | `document`;
   - `source` and `rev`;
   - `render`: `{state: idle|pending|ok|error, rev, engine, svg?, png?, w, h, log?}`;
   - `placed`: `{as: overlay|image|ink, item_ids}`;
   - `author`, `provenance` (human / agent run id, ADR 003).

   It lives in the page's Yjs document (ADR 008), next to strokes, so it syncs, merges and replays
   like them. Render *results* are cached by `(source hash, engine, mode)` and are not CRDT data.
2. **render** `(doc, rev) → svg | png | pdf`, by the best available engine: remote → WorkerScript
   → none.
3. **insert as image** `(doc) → image item` through `insertImageFileAsSceneItem`, at the doc's
   region.
4. **insert as ink** `(doc) → strokes` on the `ai`/`codrawer:` layer (single-stroke glyphs, §3b).
5. **open in editor** `(doc)` → panel, keyboard grab.
6. **export** `(doc, tex | pdf)` → a file on the desktop or phone, or a turn attachment.
7. **recognize** `(stroke ids, region) → latex_doc` (the Primer's recognizer, as a request).

### Protocol: new message types, all relayed by every router like `primer`

| Message | Direction | Body |
| --- | --- | --- |
| `latex_doc` | any → all (and as a Yjs map entry once page model v1 lands) | the object above; upsert by `id`; `deleted: true` tombstones |
| `latex_render` | tablet/phone → renderer | `{id, rev, source, mode, want: ["svg","png","pdf","strokes"], dpi?}` |
| `latex_rendered` | renderer → all | `{id, rev, ok, engine, ms, svg?, png?, pdf_url?, strokes?, log?}`; clients drop it if `rev` is stale |
| `latex_recognize` | tablet/phone → Primer | `{id, strokes: [ids], region}` → answered with a `latex_doc` |
| `latex_place` | client → tablet extension | `{id, as: "image"\|"ink"\|"overlay", at?}` → the extension acts, then updates `latex_doc.placed` |
| `latex_export` | client → renderer | `{id, format: "tex"\|"pdf"}` → `latex_rendered` with `pdf_url`/`tex` |

A `renderer` participant (kind `renderer`) advertises `{engines: ["mathjax","tectonic"]}` in its
hello. The tablet extension advertises `["mathjax-v4"]` once Phase 2 lands. Requests go to whoever
advertises, preferring remote.

### Mapping onto the toolbar dock and the lasso action being built

**Dock.** `/run/codrawer/dock.json` gains an entry such as
`{"id": "latex.render", "label": "TeX", "icon": "…", "action": "latex_render_view"}`. The
extension's dock button emits `dock_action {id: "latex.render"}` to the bridge:
- on a selection, it behaves as "Convert to LaTeX";
- otherwise it opens the panel on the page's last `latex_doc`, or a new empty one.

**Lasso.** A selection-menu entry "Convert to LaTeX" emits
`lasso_action {action: "latex_convert", strokes, bbox}`:
- the bridge turns it into `latex_recognize`;
- when the `latex_doc` arrives, the panel opens with its source and render.

**Panel buttons** map 1:1 to `latex_place` (Insert image / Insert ink), `open in editor`, and
`latex_export`.

## 6. Architecture

```
          desktop (aleph-desktop)                         tablet (Paper Pro)
 ┌─────────────────────────────────────┐   ws over tailnet/LAN   ┌──────────────────────────────┐
 │ renderer participant (Python/Node)  │ ──────── dials in ─────▶│ tablet router :8577 (session)│
 │  MathJax (Node) · Tectonic · PDF→PNG│◀──── latex_render ───── │  relays latex_* like primer  │
 │ Primer (recognize: ink → LaTeX)     │───── latex_rendered ───▶│                              │
 └─────────────────────────────────────┘                         │ Go bridge: evdev keyboard,   │
            ▲  phone: KaTeX panel (Primer)                        │   EVIOCGRAB while editing,   │
            └──────────── same session ──────────────────────────│   unix socket ⇄ extension    │
                                                                 │ codrawer-layer (XOVI, in     │
                                                                 │  xochitl): dock button, lasso│
                                                                 │  action, QML panel (Image of │
                                                                 │  SVG, TextArea), WorkerScript│
                                                                 │  MathJax (phase 2), insert:  │
                                                                 │  insertImageFileAsSceneItem /│
                                                                 │  addDrawingLine              │
                                                                 └──────────────────────────────┘
```

Rules, consistent with ADR 007:
- **The session is the composition point.** The renderer and the Primer are participants. The
  tablet works without them, degrading to on-tablet math (Phase 2) or "no renderer" status.
- **The bridge owns input devices** (the keyboard grab).
- **The extension owns everything inside xochitl**: panel, image insert, ink insert.
- **Heavy work stays out of xochitl's process and GUI thread.** Compiling runs on the desktop or as
  a bridge child process. JavaScript runs in a WorkerScript.

## 7. Phased plan, risks and effort

| Phase | Scope | Effort | Gate / risk |
| --- | --- | --- | --- |
| **L1 probe** | extension command `imginsert page=… file=… x= y=`: insert a PNG via `insertImageFileAsSceneItem`; verify render, save, undo, lasso move, sync, `.rm` block (pagewatch tolerance); try SVG | 1–2 days | the method exists in the meta-object (evidence above); unknowns are formats, scale, pagewatch |
| **L2 probe** | `pastetext page=… text=…` through `SceneController.pasteText` and through a `QKeyEvent` with text, into a focused text box; type `a\b` alone with uinput to settle `\` | 1 day | which route xochitl's text item honours |
| **Phase 1** | renderer participant (MathJax via Node + Tectonic, reusing Primer `latex.py`); `latex_*` messages in Go/Rust/Python routers; extension QML panel showing SVG; dock button + lasso action → Primer recognize → panel; Insert as image; phone KaTeX mirrors | **2–3 weeks** | needs desktop reachable (dial-in design avoids tailnet egress); dock/lasso framework landing; QML injection stability |
| **Phase 2** | MathJax bundle in a WorkerScript inside the panel (offline math); measure per-formula time on the A53 first; fallback MicroTeX/JKQTMathText as a QQuickPaintedItem if > ~2 s | 1 week (+1–2 weeks if native fallback) | V4 speed on A53; V4 ES gaps; memory of a second engine |
| **Phase 3** | full editor: EVIOCGRAB + key events into the panel's TextArea, block-wise live preview, snippets palette/HUD templates, export .tex/.pdf; optional on-tablet Tectonic with pre-warmed cache shipped in the signed release, run by the bridge at low priority; Insert as ink via single-stroke glyphs | 3–4 weeks | keyboard grab must never strand input (kernel releases on fd close; also release on panel close/timeout); Tectonic first-use cost; ink legibility |

**Risks across phases:**
- **OS updates.** Meta-method names and signatures can change, as with everything in the
  extension. Gate on `xovi-compat.conf` plus a runtime self-test that the methods exist in the
  meta-object.
- **Data safety.** We only ever *add* image items or strokes on our layer. User ink and text are
  never deleted. Insert operations go through xochitl's own CRDT writer.
- **Privacy.** Recognition sends rendered ink to a model under ADR 010's rules. Rendering sends
  only LaTeX source to the user's own desktop.
- **E-ink.** Previews should update by block, not by keystroke, when on-device. The refresh cost
  was not measured here.

## 8. Open questions for on-device probes (in order)

1. L1: `insertImageFileAsSceneItem` formats, scale and persistence. Does pagewatch survive an image
   block?
2. L2: `pasteText` and `QKeyEvent(text)` into xochitl's text. Does `\` arrive alone through uinput?
   Does dead key plus space give `^`/`~`?
3. One `WorkerScript` MathJax timing on the A53: load and per formula.
4. Tectonic natively on the A53, from `/home` with a pre-warmed cache, run by hand once with the
   user's consent (this study installed nothing).
5. Whether `EVIOCGRAB` on the keyboard interacts with xochitl's keyboard-connected UI (it watches
   udev, not events, so likely not).

## Sources

**Project:**
- `docs/investigations/native-multiplayer-layer.md`
- `docs/investigations/native-erase.md`
- `bridge/remarkable/xovi/codrawer-layer/` (README, main.cpp, Dockerfile)
- `docs/adr/005`, `007`, `008`
- `docs/investigations/keyboard-latency.md`
- `docs/what-codrawer-changes.md` (Tailscale)
- `bridge/remarkable/boot/tailscale.sh`
- `bridge/remarkable/native/keyboard.go`, `uinput.go`
- Primer (unmerged): `src/codrawer_bridge/primer/latex.py`, `recognize.py`,
  `apps/even-g2/src/primer/panel.ts`, `docs/protocol.md` (`primer`)

**Tablet evidence (read-only, 2026-10-06):**
- `/proc/<xochitl>/maps`, `/proc/cpuinfo`, cpufreq sysfs, `free`, `df`
- `/usr/lib`, `/usr/lib/qml`, `/usr/share/fonts`, `xochitl.conf`
- `libepaper.so`: copied off and decoded
- xochitl 6.0.105 binary strings (from the `native-multiplayer-layer.md` extraction)

**External:**
- Tectonic releases (0.17.0, aarch64-unknown-linux-musl):
  <https://github.com/tectonic-typesetting/tectonic/releases>
- MicroTeX: <https://github.com/NanoMichael/MicroTeX>
- JKQtPlotter / JKQTMathText: <https://github.com/jkriege2/JKQtPlotter>
- MathJax source (v3 `mathjax-full`, v4 current): <https://github.com/mathjax/MathJax-src>
- KaTeX (0.19.0): <https://github.com/KaTeX/KaTeX>
- TeX Live guide: <https://tug.org/texlive/doc/texlive-en/texlive-en.html>
- TeX Live sizes: <https://latex.silmaril.ie/formattinginformation/size.html>
- Qt WorkerScript: <https://doc.qt.io/qt-6/qml-qtqml-workerscript-workerscript.html>
- Qt VectorImage: <https://doc.qt.io/qt-6/qml-qtquick-vectorimage-vectorimage.html>
- XOVI: <https://github.com/asivery/xovi>

## Appendix: reproducing the spikes

| Spike | Script | Notes |
| --- | --- | --- |
| 1. xochitl's modules and hardware | the ssh `cat`/`ls` commands in §1 | read-only; BusyBox `head` needs `-n` |
| 2. Tectonic on aarch64 | `scripts/dev/latex_spikes/tectonic_bench.sh` | in Docker; aarch64 through `qemu-aarch64-static` inside an amd64 container (no binfmt needed) |
| 3. MathJax in QJSEngine + QtSvg; KaTeX output | `scripts/dev/latex_spikes/mathjax_entry.js`, `qjs_mathjax.py` | scratch `pnpm add mathjax-full@3 katex esbuild`; `uv run --with pyside6` |
| 4. xochitl keymaps | `scripts/dev/latex_spikes/xochitl_keymap.py` | `uv run --with pyelftools`; input `libepaper.so` copied off the tablet |
| 5. Image-item and paste APIs | strings of the extracted xochitl binary | `SceneController` meta-strings and `…::insertImageFileAsSceneItem(QUrl const&, QPointF)` lambda symbol |
