"""
The README demo: a scripted co-drawing session played into a real router and recorded from the
Even Hub simulator, glasses on the left and the phone on the right.

What it shows, act by act (each opened by a title card in the recording):

1. Write: the tablet user writes "what if ink could travel?" in cursive (`layer: "user"`). The
   glasses' loupe follows the pen; the phone shows the whole page on paper.
2. Type: keystrokes from the tablet's Bluetooth keyboard (`key` messages, as the bridge sends
   them) reach the glasses' status strip. A `/` opens the app's own completion popup, then a
   plain line is typed and committed to the transcript.
3. Play together: the user draws a tic-tac-toe grid and plays X. A second participant (Ana,
   `layer: "peer"`, red) answers with O while the user's pen is still moving, and a third (Ben,
   blue) joins and writes "hi!" at the same time. X wins; Ben strikes the winning line while Ana
   adds a heart. On the phone each participant has their colour. The app dashes other people's
   ink on the one-colour lens (apps/even-g2/src/strokes.ts), but at the fit view's scale the 1-bit
   render closes the gaps, so in this recording it reads as solid.
4. Look around: a ring tap switches the glasses from follow to fit and the phone follows it
   (phone/mirror.ts); the long-press menu's *Wide fit on / off* then spreads the page across the
   lens' full width as two 288 x 144 tiles (glasses/layout.ts).

Nothing in the two screens is mocked. Ink and keys are ordinary protocol messages (docs/protocol.md)
sent to a real router over three WebSocket connections (one per participant), the app in the
simulator renders them as it would a Paper Pro's, and the ring and menu go through the simulator's
automation API (`/api/input`), which delivers the same events as the R1 ring. What is synthetic:
the pens and the keyboard are this script, and the title cards and captions are composited.

Where the handwriting comes from. Letters are the Hershey "scripts" font (public domain, A. V.
Hershey, 1967), a single-stroke cursive. A hand does not trace a font, so `handwrite` joins each
word's glyph strokes into the pen-downs a person would make (dots and t-bars come after the word),
gives every letter its own small size and slant drift on a wandering baseline, and `_hand` smooths
it (Catmull-Rom) with a slow wobble and a fine tremor. `_timed` then paces it like a pen: slow in
tight turns, quick on straight runs, easing in at pen-down and out at lift, pressure rising as the
pen slows. Points are sampled at 240 Hz and sent in 60 Hz batches, the bridge's own rhythm. Sizes
are page pixels (the Paper Pro page is 1620 x 2160), normalized on the way out; times are seconds
unless named `_ms`.

Run it (all local; it refuses the real tablet's `session1`):

    # router: the Rust engine runs anywhere
    cd bridge/remarkable/rust && cargo run --release -- -router-only -serve 127.0.0.1:8578
    # glasses app (not 5188, the everyday port)
    cd apps/even-g2 && pnpm dev --port 5190 --strictPort
    # the story: launches the simulator itself (fresh page, follow view, phone on Page),
    # records both screens, writes the GIF and, with ffmpeg on PATH, the MP4
    uv run --with Hershey-Fonts python scripts/dev/demo_story.py \\
        --gif docs/media/demo.gif --mp4 docs/media/demo.mp4

`--work DIR` keeps the raw screenshots and timeline; `--compose DIR` re-renders the GIF and MP4
from them without recording again (for layout changes). Without `--gif`/`--mp4` it only plays.
"""

from __future__ import annotations

import argparse
import asyncio
import io
import json
import math
import os
import random
import shutil
import subprocess
import tempfile
import threading
import time
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path

import websockets

PAGE_W, PAGE_H = 1620, 2160
SAMPLE_HZ = 240
BATCH_MS = 1000 / 60

Who = tuple[str, "str | None", str]  # layer, colour, author (one connection each)
ME: Who = ("user", None, "tablet")
ANA: Who = ("peer", "#d6482a", "ana")
BEN: Who = ("peer", "#2a6fd6", "ben")

# =============================================================================================
# A hand: smoothing, drift and tremor, then pen timing and pressure.
# =============================================================================================

Pt = tuple[float, float]
Sample = tuple[float, float, float, float]  # x px, y px, pressure 0..1, ms from pen-down


def _catmull(pts: list[Pt], per: int = 8) -> list[Pt]:
    """Catmull-Rom through `pts`, `per` samples per segment (page px)."""
    if len(pts) < 3:
        return list(pts)
    p = [pts[0], *pts, pts[-1]]
    out: list[Pt] = []
    for i in range(1, len(p) - 2):
        (x0, y0), (x1, y1), (x2, y2), (x3, y3) = p[i - 1], p[i], p[i + 1], p[i + 2]
        for k in range(per):
            t = k / per
            t2, t3 = t * t, t * t * t
            out.append(
                (
                    0.5
                    * (
                        2 * x1
                        + (-x0 + x2) * t
                        + (2 * x0 - 5 * x1 + 4 * x2 - x3) * t2
                        + (-x0 + 3 * x1 - 3 * x2 + x3) * t3
                    ),
                    0.5
                    * (
                        2 * y1
                        + (-y0 + y2) * t
                        + (2 * y0 - 5 * y1 + 4 * y2 - y3) * t2
                        + (-y0 + 3 * y1 - 3 * y2 + y3) * t3
                    ),
                )
            )
    out.append(pts[-1])
    return out


def _hand(pts: list[Pt], rng: random.Random, wobble: float = 4.0, tremor: float = 0.7) -> list[Pt]:
    """
    Smooth a polyline and make it hand-made: a slow wobble across the whole stroke and a fine
    tremor, both smooth noise (sums of sines with random phases), amplitudes in page px.
    """
    curve = _catmull(pts)
    length = sum(math.dist(curve[i - 1], curve[i]) for i in range(1, len(curve))) or 1.0
    waves = [(rng.uniform(0, 6.3), rng.uniform(0, 6.3), f) for f in (1.1, 2.3)]
    shakes = [
        (rng.uniform(0, 6.3), rng.uniform(0, 6.3), length / rng.uniform(60, 90)) for _ in range(2)
    ]
    out: list[Pt] = []
    s = 0.0
    for i, (x, y) in enumerate(curve):
        if i:
            s += math.dist(curve[i - 1], curve[i])
        u = s / length
        dx = sum(0.5 * wobble * math.sin(2 * math.pi * f * u + a) for a, _, f in waves) / 2
        dy = sum(wobble * math.sin(2 * math.pi * f * u + b) for _, b, f in waves) / 2
        dx += sum(tremor * math.sin(2 * math.pi * f * u + a) for a, _, f in shakes) / 2
        dy += sum(tremor * math.sin(2 * math.pi * f * u + b) for _, b, f in shakes) / 2
        out.append((x + dx, y + dy))
    return out


def _timed(path: list[Pt], speed: float, rng: random.Random) -> list[Sample]:
    """
    Pace a path like a pen: samples at SAMPLE_HZ from pen-down. `speed` is the cruising speed in
    page px/s (the page is ~18 cm wide, so 900 px/s is ~10 cm/s, brisk handwriting). Curvature,
    measured over a few samples so tremor does not count, slows the pen; pressure rises as it
    slows and ramps at either end of the stroke.
    """
    if len(path) < 2:
        path = [path[0], (path[0][0] + 0.5, path[0][1] + 0.5)]
    seg: list[tuple[float, float]] = []  # (length px, local speed px/s)
    for i in range(1, len(path)):
        a, b, c = path[max(0, i - 4)], path[i], path[min(len(path) - 1, i + 4)]
        span = math.dist(a, b) + math.dist(b, c)
        turn = 0.0
        if span > 1.0 and a != b and b != c:
            a1 = math.atan2(b[1] - a[1], b[0] - a[0])
            a2 = math.atan2(c[1] - b[1], c[0] - b[0])
            turn = abs((a2 - a1 + math.pi) % (2 * math.pi) - math.pi) / span
        seg.append((math.dist(path[i - 1], path[i]), speed / (1 + 18 * turn)))
    total = sum(ln for ln, _ in seg) or 1.0
    times, t, walked = [0.0], 0.0, 0.0
    for ln, v in seg:
        walked += ln
        edge = min(walked, total - walked + ln)
        ease = min(1.0, 0.35 + edge / (0.06 * speed))
        t += ln / max(v * ease, 1.0)
        times.append(t)
    vmax = max(v for _, v in seg)
    out: list[Sample] = []
    j = k = 0
    while k / SAMPLE_HZ <= times[-1] or not out:
        tt = min(k / SAMPLE_HZ, times[-1])
        while j < len(seg) - 1 and times[j + 1] < tt:
            j += 1
        f = (tt - times[j]) / ((times[j + 1] - times[j]) or 1e-6)
        (ax, ay), (bx, by) = path[j], path[j + 1]
        p = 0.32 + 0.38 * (1 - seg[j][1] / vmax) + rng.gauss(0, 0.03)
        p *= min(1.0, 0.4 + tt / 0.05) * min(1.0, 0.4 + (times[-1] - tt) / 0.05)
        out.append((ax + (bx - ax) * f, ay + (by - ay) * f, max(0.05, min(1.0, p)), tt * 1000))
        k += 1
    return out


# =============================================================================================
# Handwriting: Hershey script glyphs, joined and drifted the way a hand writes them.
# =============================================================================================

_FONT = None


def _font():
    global _FONT
    if _FONT is None:
        try:
            from HersheyFonts import HersheyFonts
        except ImportError as e:
            raise SystemExit(
                "needs the Hershey font: uv run --with Hershey-Fonts python ..."
            ) from e
        _FONT = HersheyFonts()
        _FONT.load_default_font("scripts")
    return _FONT


def _glyphs(text: str) -> list[tuple[str, list[list[Pt]]]]:
    """Each character with its strokes as the font lays out the line (font units, y down)."""
    f = _font()
    out: list[tuple[str, list[list[Pt]]]] = []
    prev = 0
    for i, ch in enumerate(text):
        cur = [[(float(x), float(y)) for x, y in s] for s in f.strokes_for_text(text[: i + 1])]
        out.append((ch, cur[prev:]))
        prev = len(cur)
    return out


def _is_detail(stroke: list[Pt]) -> bool:
    """A dot or a t-bar: drawn after the word, not on the way through it."""
    xs, ys = [p[0] for p in stroke], [p[1] for p in stroke]
    return len(stroke) <= 2 or (max(xs) - min(xs) <= 2 and max(ys) - min(ys) <= 2)


def handwrite(
    text: str, x0: float, base: float, unit: float, rng: random.Random, slant: float = 0.1
) -> list[list[Pt]]:
    """
    Pen-downs (page px, in writing order) for one line of `text`: left edge `x0`, baseline `base`,
    `unit` px per font unit (ascenders reach 21 units above the baseline). Within a word, glyph
    strokes closer than 14 units are joined into one pen-down; punctuation stands apart, and dots
    and bars follow their word, as a hand goes back for them.
    """
    drift_phase = rng.uniform(0, 6.3)
    words: list[list[list[Pt]]] = [[]]
    details: list[list[list[Pt]]] = [[]]
    for ch, strokes in _glyphs(text):
        if ch == " " or ch in "?!":
            words.append([])
            details.append([])
            if ch == " ":
                continue
        s = 1 + rng.gauss(0, 0.035)
        lean = slant + rng.gauss(0, 0.03)
        gx = min((p[0] for st in strokes for p in st), default=0.0)

        def place(p: Pt, s: float = s, lean: float = lean, gx: float = gx) -> Pt:
            x, y = p[0], p[1] - 9  # y from the baseline, up is negative
            x = gx + (x - gx) * s - y * s * lean
            drift = 0.8 * math.sin(x / 35 + drift_phase) - 0.012 * x
            return (x0 + x * unit, base + (y * s + drift) * unit)

        kept = strokes
        if ch == "!":  # the font's "!" is three overlapping bars and a dot; a hand makes one bar
            kept = [st for st in strokes if _is_detail(st)] + [strokes[0]]
        for st in kept:
            placed = [place(p) for p in st]
            if _is_detail(st):
                if (
                    placed[0] == placed[-1]
                    or len(placed) <= 2
                    and math.dist(placed[0], placed[-1]) < unit
                ):
                    placed = [
                        placed[0],
                        (placed[0][0] + 0.7 * unit, placed[0][1] + 0.5 * unit),
                    ]  # a dot's flick
                details[-1].append(placed)
            else:
                words[-1].append(placed)
    out: list[list[Pt]] = []
    for word, extra in zip(words, details, strict=True):
        run: list[Pt] = []
        for st in word:
            if run and math.dist(run[-1], st[0]) < 14 * unit:
                run.extend(st[1:] if run[-1] == st[0] else st)
            else:
                if run:
                    out.append(run)
                run = list(st)
        if run:
            out.append(run)
        out.extend(extra)
    return out


# =============================================================================================
# Shapes for the game.
# =============================================================================================


def ellipse(
    cx: float, cy: float, rx: float, ry: float, start: float, sweep: float, n: int = 40
) -> list[Pt]:
    """An open ellipse (degrees, y down), as a hand draws an O: a little past its start."""
    return [
        (
            cx + rx * math.cos(math.radians(start + sweep * i / n)),
            cy + ry * math.sin(math.radians(start + sweep * i / n)),
        )
        for i in range(n + 1)
    ]


def heart(cx: float, cy: float, size: float) -> list[Pt]:
    """The classic heart curve from the top dip round and back, `size` px per curve unit."""
    return [
        (
            cx + size * 16 * math.sin(t) ** 3,
            cy
            - size
            * (13 * math.cos(t) - 5 * math.cos(2 * t) - 2 * math.cos(3 * t) - math.cos(4 * t)),
        )
        for t in (2 * math.pi * i / 64 for i in range(65))
    ]


# =============================================================================================
# A schedule of strokes for several participants, and playing it over the protocol.
# =============================================================================================


@dataclass
class Stroke:
    who: Who
    at: float  # s from the act's start
    pts: list[Sample]

    @property
    def end(self) -> float:
        return self.at + self.pts[-1][3] / 1000


@dataclass
class Schedule:
    """Strokes by start time. One pen per participant; different participants overlap."""

    strokes: list[Stroke] = field(default_factory=list)

    def add(self, who: Who, path: list[Pt], speed: float, at: float, rng: random.Random) -> float:
        """One stroke at `at` s; returns when it ends."""
        prev = [s.end for s in self.strokes if s.who == who]
        assert not prev or at >= max(prev), f"{who[2]} would hold two pens"
        s = Stroke(who, at, _timed(path, speed, rng))
        self.strokes.append(s)
        return s.end

    def write(
        self,
        who: Who,
        paths: list[list[Pt]],
        speed: float,
        at: float,
        rng: random.Random,
        lift: float = 0.14,
    ) -> float:
        """Pen-downs in a row, a pen-up travel (`lift` s + distance) between; returns the end."""
        t = at
        for i, p in enumerate(paths):
            if i:
                t += lift + math.dist(paths[i - 1][-1], p[0]) / 4000
            t = self.add(who, p, speed, t, rng)
        return t


class Session:
    """One WebSocket per participant to the same router session, as on a real page."""

    def __init__(self, url: str):
        self.url = url
        self.ws: dict[str, websockets.ClientConnection] = {}
        self.n = 0

    async def open(self, *authors: str):
        for a in authors:
            ws = await websockets.connect(self.url, max_size=2**24)
            await ws.recv()  # hello
            self.ws[a] = ws

    async def close(self):
        for ws in self.ws.values():
            await ws.close()

    async def send(self, author: str, msg: dict):
        await self.ws[author].send(json.dumps(msg))

    async def stroke(self, who: Who, pts: list[Sample]):
        """One stroke in real time: begin, 60 Hz point batches, end."""
        layer, color, author = who
        self.n += 1
        sid = f"{author}_demo_{self.n}"
        start = time.time()
        t0 = int(start * 1000)
        begin: dict = {"t": "stroke_begin", "id": sid, "layer": layer, "brush": "pen", "ts": t0}
        if color:
            begin |= {"color": color, "author": author}
        await self.send(author, begin)
        i = 0
        while i < len(pts):
            due = pts[i][3] + BATCH_MS
            batch = []
            while i < len(pts) and pts[i][3] < due:
                x, y, p, ms = pts[i]
                batch.append(
                    [round(x / PAGE_W, 5), round(y / PAGE_H, 5), round(p, 3), t0 + int(ms)]
                )
                i += 1
            await asyncio.sleep(max(0.0, start + due / 1000 - time.time()))
            await self.send(author, {"t": "stroke_pts", "id": sid, "pts": batch})
        await self.send(author, {"t": "stroke_end", "id": sid, "ts": int(time.time() * 1000)})

    async def play(self, sched: Schedule):
        """Every participant's strokes at their scheduled times, concurrently."""
        t0 = time.time()

        async def run(author: str):
            for s in sorted((s for s in sched.strokes if s.who[2] == author), key=lambda s: s.at):
                await asyncio.sleep(max(0.0, t0 + s.at - time.time()))
                await self.stroke(s.who, s.pts)

        await asyncio.gather(*(run(a) for a in {s.who[2] for s in sched.strokes}))

    async def key(self, key: str, char: str | None = None, shift: bool = False):
        """One key-down from the tablet's keyboard, as the bridge sends it (docs/protocol.md)."""
        m: dict = {
            "t": "key",
            "key": key,
            "code": 0,
            "repeat": False,
            "ts": int(time.time() * 1000),
            "mods": {"shift": shift, "ctrl": False, "alt": False, "meta": False},
        }
        if char is not None:
            m["char"] = char
        await self.send("tablet", m)

    async def type(self, text: str, rng: random.Random, cps: float = 9.0):
        """Type `text` at about `cps` characters a second, with a typist's unevenness."""
        for ch in text:
            await self.key(ch, ch, shift=ch.isupper() or ch in "?!")
            await asyncio.sleep(max(0.03, rng.gauss(1 / cps, 0.035)) + (0.1 if ch == " " else 0))


class Ring:
    """The R1 ring and touchpad, through the simulator's automation API."""

    def __init__(self, sim: str):
        self.sim = sim

    def __call__(self, action: str):
        req = urllib.request.Request(
            f"{self.sim}/api/input",
            data=json.dumps({"action": action}).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        urllib.request.urlopen(req, timeout=5).read()


class Timeline:
    """Marks in s since the story began: act starts, captions and the end, for the compositor."""

    def __init__(self):
        self.t0 = time.time()
        self.marks: list[tuple[float, str, str]] = []  # (t, kind, text)

    def mark(self, kind: str, text: str = ""):
        self.marks.append((time.time() - self.t0, kind, text))


# =============================================================================================
# The acts. Page layout: the sentence on the left, the game on the right, one wide band across
# the middle of the page, so that the wide fit view has something wide to show.
# =============================================================================================

GRID_X, GRID_Y, CELL = 1010, 800, 132  # the tic-tac-toe grid's top-left corner and cell, page px


def cell(r: int, c: int) -> Pt:
    """Centre of the grid cell at row `r`, column `c`."""
    return (GRID_X + CELL * (c + 0.5), GRID_Y + CELL * (r + 0.5))


async def act_write(s: Session, tl: Timeline, rng: random.Random):
    """Act 1: handwriting from the tablet, live on the lens (loupe) and the phone (page)."""
    tl.mark("act", "1|Write|the tablet's pen, live on the lens and the phone")
    tl.mark("caption", "the loupe follows the pen; the phone shows the whole page")
    await asyncio.sleep(0.6)
    sched = Schedule()
    unit = 4.7
    line1 = [_hand(p, rng, 2.0) for p in handwrite("what if ink", 110, 910, unit, rng)]
    line2 = [_hand(p, rng, 2.0) for p in handwrite("could travel?", 140, 1085, unit, rng)]
    t = sched.write(ME, line1, 1050, 0, rng)
    sched.write(ME, line2, 1050, t + 0.45, rng)
    await s.play(sched)
    await asyncio.sleep(1.2)


async def act_type(s: Session, tl: Timeline, rng: random.Random):
    """Act 2: the tablet's keyboard; `/` opens the app's completion popup, then a plain line."""
    tl.mark("act", "2|Type|a keyboard on the tablet, typing onto the glasses")
    tl.mark("caption", "keystrokes reach the glasses' status strip; / opens the commands")
    await asyncio.sleep(0.5)
    await s.key("/", "/")
    await asyncio.sleep(1.4)
    await s.key("t", "t")
    await asyncio.sleep(1.1)
    for _ in range(2):
        await s.key("Backspace")
        await asyncio.sleep(0.15)
    await asyncio.sleep(0.3)
    tl.mark("caption", "a plain line goes to the transcript")
    await s.type("shall we play?", rng)
    await asyncio.sleep(0.45)
    await s.key("Enter")
    await asyncio.sleep(1.4)


async def act_play(s: Session, tl: Timeline, rng: random.Random):
    """Act 3: three participants on one page, their strokes overlapping in time."""
    tl.mark("act", "3|Play together|three people on one page, at the same time")
    tl.mark("caption", "you play X; Ana (red) answers while your pen is still moving")
    await asyncio.sleep(0.5)
    sched = Schedule()
    g = rng.gauss
    x1, y1, x2, y2 = GRID_X, GRID_Y, GRID_X + 3 * CELL, GRID_Y + 3 * CELL
    bars = [
        ((x1 + CELL + g(0, 4), y1 - 18), (x1 + CELL + g(0, 6), y2 + 14)),
        ((x1 + 2 * CELL + g(0, 4), y1 - 14), (x1 + 2 * CELL + g(0, 6), y2 + 18)),
        ((x1 - 16, y1 + CELL + g(0, 4)), (x2 + 12, y1 + CELL + g(0, 6))),
        ((x1 - 12, y1 + 2 * CELL + g(0, 4)), (x2 + 18, y1 + 2 * CELL + g(0, 6))),
    ]
    grid = [[a, ((a[0] + b[0]) / 2 + g(0, 3), (a[1] + b[1]) / 2 + g(0, 3)), b] for a, b in bars]
    t = sched.write(ME, [_hand(p, rng, 3) for p in grid], 1300, 0, rng, lift=0.12)

    def x_mark(r: int, c: int, k: float = 38) -> list[list[Pt]]:
        cx, cy = cell(r, c)
        return [
            [(cx - k, cy - k), (cx + k + g(0, 3), cy + k)],
            [(cx + k, cy - k - 2), (cx - k + g(0, 3), cy + k + 2)],
        ]

    def o_mark(r: int, c: int) -> list[list[Pt]]:
        cx, cy = cell(r, c)
        return [ellipse(cx, cy, 39 + g(0, 2), 41 + g(0, 2), -110 + g(0, 8), -385)]

    t = sched.write(ME, [_hand(p, rng, 2) for p in x_mark(1, 1)], 900, t + 0.35, rng)
    ta = sched.write(ANA, [_hand(p, rng, 2) for p in o_mark(0, 1)], 850, t - 0.25, rng)
    # Ben joins: "hi!" beside the grid, while Ana's O and your next X are being drawn
    hi = handwrite("hi!", x2 + 40, y1 + 70, 3.6, rng)
    sched.write(BEN, [_hand(p, rng, 1.5) for p in hi], 800, ta - 0.45, rng)
    t = sched.write(ME, [_hand(p, rng, 2) for p in x_mark(0, 0)], 900, ta + 0.5, rng)
    ta = sched.write(ANA, [_hand(p, rng, 2) for p in o_mark(0, 2)], 850, t + 0.6, rng)
    t = sched.write(ME, [_hand(p, rng, 2) for p in x_mark(2, 2)], 900, ta + 0.7, rng)
    # the win: Ben strikes it through while Ana draws a heart
    (ax, ay), (bx, by) = cell(0, 0), cell(2, 2)
    strike = [(ax - 68, ay - 64), ((ax + bx) / 2 + 6, (ay + by) / 2 - 4), (bx + 70, by + 68)]
    sched.add(ANA, _hand(heart(x2 + 100, y2 - 50, 3.0), rng, 2), 700, t + 0.5, rng)
    sched.add(BEN, _hand(strike, rng, 4), 1200, t + 0.7, rng)
    await s.play(sched)
    tl.mark("caption", "X wins: Ben strikes the line as Ana sends a heart, both at once")
    await asyncio.sleep(2.2)


async def act_look(tl: Timeline, ring: Ring):
    """Act 4: the ring changes the framing; the phone follows; wide fit from the menu."""
    tl.mark("act", "4|Look around|the ring frames the page; the phone follows")
    tl.mark("caption", "")
    await asyncio.sleep(0.7)
    tl.mark("caption", "ring tap: follow → fit, on the glasses and the phone")
    ring("click")
    await asyncio.sleep(2.6)
    tl.mark("caption", "long-press menu → Wide fit: the page across the whole lens")
    ring("context_menu")
    await asyncio.sleep(0.8)
    for _ in range(6):  # "Wide fit on / off" is the seventh entry (glasses/layout.ts)
        ring("down")
        await asyncio.sleep(0.2)
    await asyncio.sleep(0.4)
    ring("click")
    await asyncio.sleep(3.4)


async def story(ws_url: str, ring: Ring, tl: Timeline, seed: int):
    rng = random.Random(seed)
    s = Session(ws_url)
    await s.open("tablet", "ana", "ben")
    try:
        tl.t0 = time.time()
        await act_write(s, tl, rng)
        await act_type(s, tl, rng)
        await act_play(s, tl, rng)
        await act_look(tl, ring)
        tl.mark("end")
    finally:
        await s.close()


# =============================================================================================
# The simulator, launched fresh per take so the page, the view and the phone stage start clean
# (`stage=page` holds for one load; `mode` and `wide` would otherwise be remembered).
# =============================================================================================


def clear_page(ws_url: str):
    """New drawing for the session, so the router replays nothing to the fresh app."""

    async def go():
        async with websockets.connect(ws_url) as ws:
            await ws.recv()
            await ws.send(json.dumps({"t": "clear", "ts": int(time.time() * 1000)}))
            await asyncio.sleep(0.3)

    asyncio.run(go())


def _simulator_cmd() -> list[str]:
    """
    The simulator's command line. On Windows the npm shim is a .cmd, and cmd.exe would cut the
    app URL at its first `&`, so the shim's own target (node + bin/index.js) is run directly.
    """
    exe = shutil.which("evenhub-simulator")
    if not exe:
        raise SystemExit(
            "evenhub-simulator is not on PATH (npm i -g @evenrealities/evenhub-simulator)"
        )
    js = (
        Path(exe).parent
        / "node_modules"
        / "@evenrealities"
        / "evenhub-simulator"
        / "bin"
        / "index.js"
    )
    node = shutil.which("node")
    if os.name == "nt" and js.exists() and node:
        return [node, str(js)]
    return [exe]


def launch_simulator(app: str, ws_url: str, port: int) -> subprocess.Popen:
    url = f"{app}/?ws={ws_url}&mode=follow&wide=0&stage=page&theme=paper&view=canvas"
    proc = subprocess.Popen(
        [*_simulator_cmd(), "--automation-port", str(port), url],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    sim = f"http://127.0.0.1:{port}"
    for _ in range(160):
        try:
            if b"pong" in urllib.request.urlopen(f"{sim}/api/ping", timeout=1).read():
                break
        except OSError:
            time.sleep(0.25)
    for _ in range(80):  # until the app's router link is up
        try:
            log = json.loads(
                urllib.request.urlopen(f"{sim}/api/console?since_id=0", timeout=2).read()
            )
            if any("[codrawer] connected" in e.get("message", "") for e in log.get("entries", [])):
                break
        except OSError:
            pass
        time.sleep(0.25)
    # The status strip counts as "typing" for 15 s after the last key, and at load that clock
    # reads zero (hud/render.ts TYPING_VIEW_MS), so the strip opens as an empty input line.
    # Let it settle into the metrics line first, as an app that has been running a while shows.
    time.sleep(16)
    return proc


def stop(proc: subprocess.Popen):
    if os.name == "nt":  # the launcher is a .cmd shim: take its whole tree
        subprocess.run(["taskkill", "/T", "/F", "/PID", str(proc.pid)], capture_output=True)
    else:
        proc.terminate()


class Grabber(threading.Thread):
    """Polls one simulator screenshot endpoint as fast as it answers: `<prefix>_<time>.png`."""

    def __init__(self, url: str, out: Path, prefix: str):
        super().__init__(daemon=True)
        self.url, self.out, self.prefix, self.stopped = url, out, prefix, False

    def run(self):
        while not self.stopped:
            try:
                data = urllib.request.urlopen(self.url, timeout=5).read()
                (self.out / f"{self.prefix}_{time.time():.3f}.png").write_bytes(data)
            except OSError:
                time.sleep(0.05)


# =============================================================================================
# Compositing: glasses | phone on paper, title cards between acts, then GIF and MP4.
# The lens image is placed 1:1 (576 x 288, the simulator's framebuffer), so it stays crisp.
# =============================================================================================

W, H = 960, 500
PAPER = (241, 237, 228)
INK = (38, 36, 33)
MUTED = (128, 122, 112)
RULE = (222, 216, 204)
LENS_GREEN = (64, 255, 120)


def _fonts() -> dict:
    from PIL import ImageFont

    def font(names: tuple[str, ...], size: int):
        for n in names:
            try:
                return ImageFont.truetype(n, size)
            except OSError:
                pass
        return ImageFont.load_default()

    regular = ("segoeui.ttf", "Inter-Regular.ttf", "DejaVuSans.ttf")
    semibold = ("seguisb.ttf", "Inter-SemiBold.ttf", "DejaVuSans-Bold.ttf")
    return {
        "label": font(semibold, 12),
        "caption": font(regular, 16),
        "badge": font(semibold, 13),
        "sub": font(regular, 19),
        "big": font(semibold, 40),
        "url": font(semibold, 32),
    }


def logo(size: int):
    """logo.svg drawn with Pillow at 1024 px (tile, stroke, dot, faint plus), then reduced."""
    from PIL import Image, ImageDraw

    s = 1024
    ramp = Image.linear_gradient("L").resize((s, s))  # 0 at the top, 255 at the bottom
    diag = Image.blend(ramp, ramp.rotate(90), 0.5)  # (x + y) / 2 along the 45° diagonal
    c0, c1 = (
        Image.new("RGB", (s, s), (0x63, 0x66, 0xF1)),
        Image.new("RGB", (s, s), (0xA8, 0x55, 0xF7)),
    )
    tile = Image.composite(c1, c0, diag)
    mask = Image.new("L", (s, s), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, s - 1, s - 1), radius=224, fill=255)
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    img.paste(tile, (0, 0), mask)
    d = ImageDraw.Draw(img)

    def bez(p0: Pt, p1: Pt, p2: Pt, p3: Pt, n: int = 60) -> list[Pt]:
        return [
            (
                (1 - t) ** 3 * p0[0]
                + 3 * (1 - t) ** 2 * t * p1[0]
                + 3 * (1 - t) * t * t * p2[0]
                + t**3 * p3[0],
                (1 - t) ** 3 * p0[1]
                + 3 * (1 - t) ** 2 * t * p1[1]
                + 3 * (1 - t) * t * t * p2[1]
                + t**3 * p3[1],
            )
            for t in (k / n for k in range(n + 1))
        ]

    curve = bez((750, 300), (600, 150), (300, 150), (250, 450)) + bez(
        (250, 450), (200, 750), (550, 850), (750, 700)
    )
    d.line(curve, fill="white", width=80, joint="curve")
    for x, y in (curve[0], curve[-1]):
        d.ellipse((x - 40, y - 40, x + 40, y + 40), fill="white")
    plus = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    pd = ImageDraw.Draw(plus)
    pd.line((400, 512, 650, 512), fill=(255, 255, 255, 153), width=40)
    pd.line((525, 400, 525, 624), fill=(255, 255, 255, 153), width=40)
    return Image.alpha_composite(img, plus).resize((size, size), Image.Resampling.LANCZOS)


class Composer:
    """Lays out one frame: the lens in a dark lens-shaped bezel, the phone in a minimal frame."""

    def __init__(self):
        from PIL import Image, ImageDraw

        self.Image = Image
        self.f = _fonts()
        self.logo_big, self.logo_small = logo(88), logo(44)
        self.pw, self.ph = 270, 360  # the 600 x 800 webview at 0.45
        self.phone_xy = (W - 24 - (self.pw + 18), 22)
        self.pad = 16  # lens bezel, px
        self.radius = 26  # the lens image's corner radius, px
        self.lens_mask = Image.new("L", (576, 288), 0)
        ImageDraw.Draw(self.lens_mask).rounded_rectangle(
            (0, 0, 575, 287), radius=self.radius, fill=255
        )
        self.lens_xy = (24, 22 + (self.ph + 18 - (288 + 2 * self.pad)) // 2)

    def lens(self, png: bytes):
        """The simulator keeps the lens image in the alpha channel; light it green on black."""
        Image = self.Image
        alpha = Image.open(io.BytesIO(png)).convert("RGBA").getchannel("A")
        return Image.composite(
            Image.new("RGB", alpha.size, LENS_GREEN), Image.new("RGB", alpha.size, (0, 0, 0)), alpha
        )

    def phone(self, png: bytes):
        return (
            self.Image.open(io.BytesIO(png))
            .convert("RGB")
            .resize((self.pw, self.ph), self.Image.Resampling.LANCZOS)
        )

    def frame(self, lens, phone, caption: str, act: str):
        from PIL import ImageDraw

        f = self.Image.new("RGB", (W, H), PAPER)
        d = ImageDraw.Draw(f)
        lx, ly = self.lens_xy
        p = self.pad
        lw, lh = 576 + 2 * p, 288 + 2 * p
        d.rounded_rectangle(
            (lx, ly, lx + lw - 1, ly + lh - 1), radius=self.radius + p, fill=(20, 22, 21)
        )
        d.rounded_rectangle(
            (lx + 5, ly + 5, lx + lw - 6, ly + lh - 6),
            radius=self.radius + p - 5,
            outline=(46, 50, 48),
        )
        f.paste(lens, (lx + p, ly + p), self.lens_mask)
        px, py = self.phone_xy
        d.rounded_rectangle(
            (px, py, px + self.pw + 17, py + self.ph + 17), radius=24, fill=(28, 28, 30)
        )
        f.paste(phone, (px + 9, py + 9))
        label_y = py + self.ph + 18 + 10
        d.text(
            (lx + lw // 2, label_y),
            "EVEN G2 GLASSES",
            font=self.f["label"],
            fill=MUTED,
            anchor="mt",
        )
        d.text(
            (px + 9 + self.pw // 2, label_y), "PHONE", font=self.f["label"], fill=MUTED, anchor="mt"
        )
        cy = H - 48
        d.line((24, cy - 12, W - 24, cy - 12), fill=RULE)
        x = 24
        if act:
            num, name = act.split("|")[:2]
            tag = f"{num}  {name.upper()}"
            tw = int(d.textlength(tag, font=self.f["badge"]))
            d.rounded_rectangle((x, cy, x + tw + 22, cy + 24), radius=12, fill=INK)
            d.text((x + 11, cy + 12), tag, font=self.f["badge"], fill=PAPER, anchor="lm")
            x += tw + 36
        if caption:
            d.text((x, cy + 12), caption, font=self.f["caption"], fill=INK, anchor="lm")
        return f

    def card(self, title: str, sub: str, number: str = "", url: bool = False):
        from PIL import ImageDraw

        f = self.Image.new("RGB", (W, H), PAPER)
        d = ImageDraw.Draw(f)
        if number:
            f.paste(self.logo_small, (W // 2 - 22, 140), self.logo_small)
            d.text((W // 2, 236), f"{number} · {title}", font=self.f["big"], fill=INK, anchor="mm")
            d.text((W // 2, 286), sub, font=self.f["sub"], fill=MUTED, anchor="mm")
        else:
            f.paste(self.logo_big, (W // 2 - 44, 118), self.logo_big)
            d.text(
                (W // 2, 256), title, font=self.f["url" if url else "big"], fill=INK, anchor="mm"
            )
            d.text((W // 2, 304), sub, font=self.f["sub"], fill=MUTED, anchor="mm")
        return f


def _ease(x: float) -> float:
    return x * x * (3 - 2 * x)


def _palette(frames: Path, out: Path):
    """
    The GIF's one 256-colour palette, written as a 16 x 16 swatch. A palette built from frame
    statistics alone spends itself on paper and lens green and leaves the participants' thin
    strokes muddy, so frames are sampled and joined by gradients from paper to each ink and from
    black to lens green, weighted to about a third of the sample.
    """
    from PIL import Image, ImageDraw

    picks = sorted(frames.glob("f*.png"))[::12]
    tiles = [Image.open(p).convert("RGB").reduce(2) for p in picks]
    tw, th = tiles[0].size
    inks = [
        (PAPER, (0xD6, 0x48, 0x2A)),
        (PAPER, (0x2A, 0x6F, 0xD6)),
        (PAPER, INK),
        ((0, 0, 0), LENS_GREEN),
        (PAPER, (0x6E, 0x9E, 0x86)),
        (PAPER, (0x63, 0x66, 0xF1)),
        (PAPER, (0xA8, 0x55, 0xF7)),
    ]
    band = max(8, (len(tiles) * th) // (2 * len(inks)))
    sample = Image.new("RGB", (tw, th * len(tiles) + band * len(inks)))
    for i, t in enumerate(tiles):
        sample.paste(t, (0, th * i))
    d = ImageDraw.Draw(sample)
    for j, (a, b) in enumerate(inks):
        y0 = th * len(tiles) + band * j
        for x in range(tw):
            f = x / (tw - 1)
            d.line(
                (x, y0, x, y0 + band - 1),
                fill=tuple(int(a[k] + (b[k] - a[k]) * f) for k in range(3)),
            )
    q = sample.quantize(colors=256, method=Image.Quantize.MEDIANCUT)
    flat = (q.getpalette() or [])[: 256 * 3]
    flat += [0] * (256 * 3 - len(flat))
    swatch = Image.new("RGB", (16, 16))
    swatch.putdata([(flat[3 * i], flat[3 * i + 1], flat[3 * i + 2]) for i in range(256)])
    swatch.save(out)


def compose(work: Path, gif: str | None, mp4: str | None, fps: int = 15):
    """Turn a take's screenshots and timeline into frames, then the GIF and the MP4."""
    from PIL import Image

    tl = json.loads((work / "timeline.json").read_text())
    t0, marks = tl["t0"], tl["marks"]

    def shots(prefix: str) -> list[tuple[float, Path]]:
        return sorted(
            (float(p.stem.split("_", 1)[1]), p) for p in (work / "shots").glob(f"{prefix}_*.png")
        )

    gl, ph = shots("g"), shots("p")
    c = Composer()
    frames = work / "frames"
    shutil.rmtree(frames, ignore_errors=True)
    frames.mkdir()
    n = 0

    def emit(img, seconds: float = 0.0, count: int = 1):
        nonlocal n
        for _ in range(max(count, int(round(seconds * fps)))):
            img.save(frames / f"f{n:05d}.png")
            n += 1

    def fade(a, b, k: int = 5):
        for i in range(1, k + 1):
            emit(Image.blend(a, b, _ease(i / (k + 1))))

    def latest(seq: list[tuple[float, Path]], wall: float) -> Path:
        best = seq[0][1]
        for ts, p in seq:
            if ts > wall:
                break
            best = p
        return best

    cache: dict[Path, Image.Image] = {}

    def load(p: Path, kind: str):
        if p not in cache:
            cache[p] = c.lens(p.read_bytes()) if kind == "g" else c.phone(p.read_bytes())
        return cache[p]

    acts = [(t, txt) for t, k, txt in marks if k == "act"]
    end = next(t for t, k, _ in marks if k == "end")
    intro = c.card("codrawer", "your pen, live on every surface")
    outro = c.card(
        "github.com/Caerii/codrawer-bridge",
        "stroke-native co-drawing for tablet, glasses, phone and agents",
        url=True,
    )
    emit(intro, 1.7)
    last = intro
    for i, (start, act) in enumerate(acts):
        stop_t = acts[i + 1][0] if i + 1 < len(acts) else end
        num, name, sub = act.split("|")
        card = c.card(name, sub, num)
        fade(last, card)
        emit(card, 1.0)
        k = 0
        while start + k / fps < stop_t:
            t = start + k / fps
            caption = ""
            for mt, kind, txt in marks:
                if kind == "caption" and start <= mt <= t:
                    caption = txt
            img = c.frame(
                load(latest(gl, t0 + t), "g"), load(latest(ph, t0 + t), "p"), caption, act
            )
            if k == 0:
                fade(card, img)
            emit(img)
            last = img
            k += 1
    emit(last, 0.8)  # rest on the payoff
    fade(last, outro, 7)
    emit(outro, 2.2)
    print(f"{n} frames at {fps} fps ({n / fps:.1f} s)")
    ff = shutil.which("ffmpeg")
    src = ["-framerate", str(fps), "-i", str(frames / "f%05d.png")]
    if mp4:
        if not ff:
            print("no ffmpeg on PATH: no MP4")
        else:
            subprocess.run(
                [
                    ff,
                    "-y",
                    "-loglevel",
                    "error",
                    *src,
                    "-c:v",
                    "libx264",
                    "-preset",
                    "slow",
                    "-crf",
                    "15",
                    "-pix_fmt",
                    "yuv420p",
                    "-movflags",
                    "+faststart",
                    mp4,
                ],
                check=True,
            )
            print(f"wrote {mp4}: {os.path.getsize(mp4) / 1e6:.2f} MB")
    if gif:
        pal = work / "palette.png"
        _palette(frames, pal)
        if ff:
            subprocess.run(
                [
                    ff,
                    "-y",
                    "-loglevel",
                    "error",
                    *src,
                    "-i",
                    str(pal),
                    "-lavfi",
                    "paletteuse=dither=sierra2_4a:diff_mode=rectangle",
                    "-loop",
                    "0",
                    gif,
                ],
                check=True,
            )
        else:
            palette = (
                Image.open(pal).convert("RGB").quantize(colors=256, method=Image.Quantize.MEDIANCUT)
            )
            imgs = [Image.open(p).convert("RGB") for p in sorted(frames.glob("f*.png"))]
            q = [im.quantize(palette=palette, dither=Image.Dither.FLOYDSTEINBERG) for im in imgs]
            q[0].save(
                gif,
                save_all=True,
                append_images=q[1:],
                duration=int(1000 / fps),
                loop=0,
                optimize=True,
            )
        print(f"wrote {gif}: {os.path.getsize(gif) / 1e6:.2f} MB")


# =============================================================================================


def main():
    ap = argparse.ArgumentParser(description=(__doc__ or "").strip().splitlines()[0])
    ap.add_argument("--ws", default="ws://127.0.0.1:8578/ws/demo")
    ap.add_argument("--app", default="http://localhost:5190", help="the glasses app's dev server")
    ap.add_argument("--sim-port", type=int, default=9901, help="simulator automation port")
    ap.add_argument(
        "--no-launch", action="store_true", help="use a simulator that is already running"
    )
    ap.add_argument("--gif", help="write the recording as this GIF")
    ap.add_argument("--mp4", help="and/or this MP4 (needs ffmpeg)")
    ap.add_argument("--fps", type=int, default=15)
    ap.add_argument("--work", help="keep screenshots and frames here (default: a temp dir)")
    ap.add_argument("--compose", metavar="WORK", help="only re-render a kept --work dir")
    ap.add_argument("--seed", type=int, default=11, help="the hands' randomness")
    a = ap.parse_args()
    if a.compose:
        compose(Path(a.compose), a.gif, a.mp4, a.fps)
        return
    if a.ws.rstrip("/").endswith("/session1"):
        raise SystemExit("refusing session1: that is the real tablet's page")
    record = bool(a.gif or a.mp4)
    work = Path(a.work or tempfile.mkdtemp(prefix="codrawer-demo-"))
    (work / "shots").mkdir(parents=True, exist_ok=True)
    for old in (work / "shots").glob("*.png"):
        old.unlink()
    sim = f"http://127.0.0.1:{a.sim_port}"
    clear_page(a.ws)
    proc = (
        None
        if a.no_launch
        else launch_simulator(a.app, a.ws.replace("127.0.0.1", "localhost"), a.sim_port)
    )
    grabbers: list[Grabber] = []
    tl = Timeline()
    try:
        if record:
            grabbers = [
                Grabber(f"{sim}/api/screenshot/glasses", work / "shots", "g"),
                Grabber(f"{sim}/api/screenshot/webview", work / "shots", "p"),
            ]
            for g in grabbers:
                g.start()
        asyncio.run(story(a.ws, Ring(sim), tl, a.seed))
    finally:
        for g in grabbers:
            g.stopped = True
            g.join()
        if proc:
            stop(proc)
    (work / "timeline.json").write_text(json.dumps({"t0": tl.t0, "marks": tl.marks}, indent=1))
    if record:
        compose(work, a.gif, a.mp4, a.fps)
        print(f"screenshots and frames kept in {work}")


if __name__ == "__main__":
    main()
