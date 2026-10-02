# xochitl pen data: exact tool, colour, width, and when it reaches disk

Status: investigation (2026-10-02). No production code. **The tablet was asleep for the whole
session.** `192.168.50.156:22` and `10.11.99.1:22` timed out on every try, and a later ping
returned "Destination host unreachable". So this note has **no on-device measurements**. Format
facts come from the open-source parsers and from parsing their Paper Pro fixtures on the desktop
(`uv run --with rmscene`). Section 2 has the timing script to run once the tablet is awake.
Related: ADR 002 (drawings to the model), ADR 006 (latency), ADR 007 (surface composition).

## Verdict

- **Everything we want is in the `.rm` file, per stroke.** That covers tool, palette colour,
  explicit RGBA for highlighter and shader, thickness setting, and per-point x, y, speed,
  direction, width and pressure. Erases, undo, moves and page identity are in the file too, as
  CRDT tombstones and edits. A parser exists in Python (rmscene) and in pure Go (go-rmscene).
- **The per-point `width` is xochitl's own computed width**, in quarter-pixels. Fineliner has a
  constant 16 at size 2. Ballpoint varies between 12 and 18 with pressure. So a renderer does not
  have to guess the width formula. It does have to guess the texture: pencil grain, brush ink
  intensity, ballpoint speckle.
- **Latency is unmeasured, and it decides the architecture.** Field reports only say xochitl is
  closed and that inotify-based tools fight its "timing issue". Plan for **seconds, or on
  page/document close**, not per stroke, until the script below proves otherwise.
- **Recommended:** keep live evdev as the low-latency *preview*. Add an on-tablet watcher in
  the Go bridge that diffs the current page's `.rm` whenever it changes, emits *authoritative*
  stroke records (tool, colour, width per point, xochitl CRDT id), and emits tombstones for
  erase and undo. Clients replace preview strokes with the matching `.rm` strokes as they arrive.

## 1. Storage and format

Location (stock 3.x, needs a check on Codex 6.0.105):
`/home/root/.local/share/remarkable/xochitl/<doc-uuid>.{metadata,content,local,pagedata}`, plus
`<doc-uuid>/<page-uuid>.rm` and `<doc-uuid>.thumbnails/<page-uuid>.png`.

Header: `reMarkable .lines file, version=6` padded to 43 bytes, confirmed in the rmscene fixtures.
After the header come tagged blocks. Each block has a length, a type and a version. Strokes are
`SceneLineItemBlock` entries in a CRDT sequence under a layer group. Each stroke has a `CrdtId`
(author, counter). A deleted stroke stays in the file as an item with `value=None`, so erase and
undo show up as tombstones.

Per stroke (`rmscene/scene_stream.py:line_from_stream`):

| tag | field | type |
| --- | --- | --- |
| 1 | tool id | int |
| 2 | colour id | int |
| 3 | `thickness_scale` | f64 (the size setting: 1.0, 2.0 or 3.0 for sizes 1–3; other values show up, e.g. 1.191 and 2.382) |
| 4 | `starting_length` | f32 |
| 5 | points | subblock, 14 B per point (v2) |
| 6 | timestamp id | CrdtId |
| 7 | `move_id` (optional) | CrdtId, set when a stroke was moved by selection |
| 8 | `color_rgba` (optional) | 4 bytes. On Paper Pro, highlighter and shader carry the real colour and alpha here, with `color = HIGHLIGHT (9)` |

Point v2: `x f32, y f32, speed u16, width u16, direction u8, pressure u8`. Point v1 (older) used
six f32 values.

Tool ids (rmscene `Pen`). `_1` ids are the legacy (v1) tools and `_2` ids are the current ones:

| id | tool | id | tool |
| --- | --- | --- | --- |
| 0 / 12 | paintbrush (brush) | 5 / 18 | highlighter |
| 1 / 14 | pencil | 6 | eraser (stroke eraser, recorded as a stroke) |
| 2 / 15 | ballpoint | 7 / 13 | mechanical pencil |
| 3 / 16 | marker | 8 | erase area |
| 4 / 17 | fineliner | 21 | calligraphy |
| 23 | **shader** (Paper Pro) | | |

Colour ids: 0 black, 1 grey, 2 white, 3 yellow, 4 green, 5 pink, 6 blue, 7 red, 8 grey-overlap,
**9 HIGHLIGHT (use `color_rgba`)**, 10 green_2, 11 cyan, 12 magenta, 13 yellow_2. Ids 10–13 are
the Paper Pro colours. rmc's RGB values for them are approximate (`rmc/exporters/writing_tools.py`
`RM_PALETTE`).

Values parsed from the Paper Pro fixtures (`rmscene/tests/data/*v3.1[45]*.rm`):

```
HIGHLIGHTER_2 HIGHLIGHT rgba=(255,237,117,255) thick=1.0 width=120 (constant)
SHADER        HIGHLIGHT rgba=(48,74,224,77)    thick=2.0 width 29..88
BALLPOINT_2   GREEN_2   rgba=None              thick=2.0 width 12..18 pressure 0..255
FINELINER_2   ...                              thick=2.0 width 16 (constant)
SceneInfo paper_size=(1620, 2160)
```

The highlighter's alpha byte is 255, but xochitl draws it translucent. The shader carries its
real alpha. That matches rmc PR #51.

The `.content` JSON gives per-document state. `extraMetadata` holds `LastTool`, `LastPen`,
`Last<Tool>v2Color` and `Last<Tool>v2Size`. `cPages.pages[]` lists page ids in order, and
`cPages.lastOpened.value` is the page id that is open. The `.metadata` JSON holds `lastOpened`
(ms) and `lastOpenedPage` (index).

## 2. Timing (not measured; script ready)

There is no public measurement for 3.x+ firmware. Run this once the tablet is awake. It is
read-only, and the user should draw single strokes, pause, turn the page, and undo:

```sh
D=/home/root/.local/share/remarkable/xochitl
DOC=$(ls -t $D/*.metadata | head -n 1 | sed 's/.metadata//')       # most recently touched doc
while true; do date +%s.%N | cut -c1-14
  ls -l --full-time $DOC.content $DOC.metadata $DOC.local 2>/dev/null
  ls -lt --full-time $DOC/ | head -n 3; sleep 0.5; done > /tmp/rmwatch.log
```

Use `inotifywait -m -r $D` instead if it is present. Write the log to `/tmp`, never under `$D`.
Line it up against the bridge's pen-up timestamps in `/tmp/codrawer_bridge.log`. The questions to
answer: whether a `.rm` write follows each pen-up and how many ms later; whether the write is
atomic (write a temp file, then rename, which changes the inode); and which of `.content` and
`.metadata` change on a page turn.

## 3. Current document and page

The newest `*.metadata` mtime gives the document, and `cPages.lastOpened` in `.content` gives the
page. Both are only as fresh as xochitl's last save. A faster signal is the `.rm` whose mtime
changed last. A page turn with no ink will not show there.

## 4. Coordinates

Page units are screen pixels. **x is centred: x = 0 is the horizontal middle of the page**, and
the Paper Pro range is −810 to +810. **y starts at 0 at the page top** and grows downward. It can
go past 2160 on scrolled pages (one notebook in remarkable-mcp #188 reaches y = 4474). It can go
negative above a PDF. The layer's group anchors can add an offset. For a stroke on an unscrolled,
unzoomed page:

```
x_norm = (x_rm + 810) / 1620      y_norm = y_rm / 2160
```

This holds if evdev-normalised x/y already match screen x/y, which the hardware loop rendering
upright suggests. It breaks when the user has zoomed or scrolled in xochitl, because evdev is
screen space and `.rm` is document space. SceneInfo `viewport` (fw 3.27+, rmscene PR #53) may
give the transform. To match a live stroke to its `.rm` twin, compare start and end points and
point counts after the transform. A fitted offset/scale per page corrects for zoom.

## 5. Rendering fidelity

| tool | rmc / maxio model | faithful on canvas? |
| --- | --- | --- |
| fineliner | constant width, `1.8 × thickness` (better: point `width/4`) | yes |
| ballpoint | width from pressure and speed; grey intensity from pressure | close; use point width |
| marker | width = `0.9·(width/4 − 0.4·tilt) + 0.1·prev` | close |
| pencil / mech. pencil | width plus opacity from pressure and speed (mech. 0.7 opacity) | shape yes, grain texture no |
| brush | width from pressure and tilt; ink intensity from pressure^1.5 | approximate |
| calligraphy | width from pressure and direction | approximate (nib angle guessed) |
| highlighter | square cap, about 0.3 opacity, `color_rgba` | yes (multiply blend) |
| shader | rgba alpha from the file; round cap | yes (alpha from the file) |
| eraser / erase area | strokes that do nothing in the scene; the erase effect is the tombstoned or split lines | follow the tombstones, don't paint |

Other renderers: **remarks** (Azeirah; rmc-derived, fixes Paper Pro alignment, rmc #31),
**go-rmscene** (pure Go, MIT, v6 plus Paper Pro BGRA colours, 11 tools; young, 7 commits),
**drawj2d** (Java), **rmrl** and **lines-are-beautiful** (v3/v5 only, obsolete for v6). None is
pixel-exact. Using the file's point `width`, `color_rgba` and per-tool caps and opacity gets
within visual tolerance for fineliner, ballpoint, marker, highlighter and shader. Pencil and
brush textures stay approximations.

## 6. Live alternatives to file polling

| signal | gives | risk |
| --- | --- | --- |
| `.content` `extraMetadata.LastTool/…Color/…Size` | the tool and colour in use | only as fresh as the `.content` save |
| goMarkableStream (in `/home/root`) | xochitl's framebuffer, read from process memory as BGRA (about 10% CPU at 5 fps); experimental on Paper Pro | pixels only, no strokes. Reading xochitl's memory depends on the firmware version. Gives "what the user sees" (ADR 007, smart_remarkable) |
| evdev tilt axes (`ABS_TILT_X/Y`, if the Elan exposes them) | tilt for the brush and calligraphy shape | still no tool or colour |
| D-Bus / journal | nothing known to carry tool state | xochitl logs are noisy and undocumented |
| injecting into xochitl (`LD_PRELOAD`, qmldiff/xovi) | exact live state | writes outside `/home` or changes how xochitl starts; violates the read-only rule; brittle across updates |

## First step

With the tablet awake, run the section 2 watch loop for two minutes while the user draws, pauses,
turns pages and undoes. Then `scp` the open page's `.rm`, `.content` and `.metadata` to the
scratch dir and parse them with `uv run --with rmscene`. Record: (a) the delay from pen-up to the
`.rm` write, (b) whether `cPages.lastOpened` and `LastTool` update live, (c) the x/y transform
against the bridge's normalised points for the same strokes. If (a) is under about 2 s, build the
`.rm` watcher in the Go bridge with go-rmscene. If not, the `.rm` path is for reconciling on page
turn only, and live tool and colour need a different source.

## Measured on the device (2026-10-02, Codex 6.0.105)

Read-only: a loop on the tablet recorded changes to the open notebook's files while the user
drew ~90 strokes; the router's `stroke_begin`/`stroke_end` (tablet kernel clock) were logged on
the desktop for the same window.

- Data lives in `/home/root/.local/share/remarkable/xochitl/<doc>/<page>.rm` (+ `<doc>.content`,
  `<doc>.metadata`), as documented.
- **A page's `.rm` is written when the user pauses or leaves the page, not per stroke.** Last
  stroke at …66.3 s → `.rm` written at …76 (~10 s idle). On the second page 45 strokes over 83 s
  produced no write until …89, ~6.5 s after the last stroke, the same second the notebook's
  `.content` changed (page turn). No writes were seen during continuous drawing.
- **Page turns surface within ~1–2 s** in `<doc>.content` (written at …97/98; the first stroke on
  the new page came at …99).
- The written page held exactly the 45 strokes the bridge streamed for it: tool 21 (Calligraphy,
  matching `extraMetadata.LastPen`), colour 0 (black), thickness_scale 2.0; x −586…606 (centred),
  y 143…1673; per-point width 8…42 (the nib's direction-dependent width), speed, direction and
  pressure present. rmscene 0.x warned of unread newer-format data (to inspect).
- `extraMetadata` carries `LastPen`, `Last<Tool>Color`, `Last<Tool>Size`, `LastActiveTool`.

Conclusion: the `.rm` is too slow to replace strokes live, but is an exact, complete
reconciliation source a few seconds after each pause and on every page turn; `.content` gives
page turns promptly. Recommended: live evdev preview → on each `.rm` write, replace the page's
strokes with the file's (tool, colour, per-point width; deletions = erase/undo); on a `.content`
page change, switch the session to that page.
