"""
The showcase: eight short scenes of co-drawing across domains (a proof, an integral,
recognition, physics, chemistry, music, a flowchart, a multiplayer party), played into a real
router and recorded from the Even G2 simulator (left) and the app in a browser (right).

**What is simulated, and what is real.** The pens, the "agent" and the "recognition" are this
script: scripted strokes with no model behind them, and the phone's clicks and its one mouse
drawing are scripted too (Playwright). Every scene where the agent acts carries a visible tag
saying so ("simulated agent", "scripted recognition"), and the opening card says "simulated:
scripted pens and agent, real app". Everything rendered is real: the strokes are ordinary
protocol messages (docs/protocol.md) sent over one WebSocket per participant to the Rust router,
and both screens are the app (apps/even-g2) drawing what it received: the lens in the Even Hub
simulator, and the phone stage in a headless browser, a second instance of the app joined to the
same session. The only things painted afterwards are the title cards, the captions, the tags,
the speed badges and the frame around the two screens. Handwriting stretches play at 1.5–3×,
with a badge saying so; animation plays in real time. The finale's undo is the new
`stroke_delete` from the phone's menu, and its timelapse is the app's own export (phone menu ⋯ →
Export timelapse…), decoded from the file it saved and played at 2.5×.

**The agent's ink** is on the `ai` layer, sent the way an agent joins a tablet router: as a
client drawing `stroke_*` with `layer:"ai"` and its own colour (violet). The phone draws it in
that colour; the lens has one colour, so there it is as bright as the user's ink (emphasis
`all`; a double click would dim it).

**Animation** is erasing. A character is four or five ai strokes (head, body, legs, arms, a hat);
each frame draws the new pose (stroke_begin, one stroke_pts, stroke_end) and then deletes the old
one with `stroke_delete`, which the router relays and drops from its replay. Walks interpolate a
six-pose cycle. The phone redraws on every animation frame, so motion there is smooth; the lens
gets one image per update and each costs about 200 ms on the glasses (ADR 006), so with
`canvas_ms=300` it shows two to four frames a second. The captions say so where it shows.

**The hand.** User ink is the Hershey "scripts" cursive (public domain, A. V. Hershey, 1967),
joined into the pen-downs a hand makes, with per-letter size and slant drift, a slow wobble and a
fine tremor, then paced like a pen: slow in turns, quick on straight runs, pressure rising as it
slows (the techniques of scripts/dev/demo_story.py, branch docs/demo-gif). The agent writes in
Hershey "futural" with no wobble at an even pace: neater, as a machine would. Sizes are page
pixels (the Paper Pro page is 1620 × 2160), normalized on the way out; times are seconds unless
named `_ms`. Points are sampled at 240 Hz and sent in 60 Hz batches, the bridge's rhythm.

**Run it** (all local, its own ports; it refuses the real tablet's `session1`):

    # router: the Rust engine, on its own port
    bridge/remarkable/rust/target/release/codrawer_bridge_rs -router-only -serve 127.0.0.1:8580
    # the glasses app (not 5188, the everyday port)
    cd apps/even-g2 && pnpm exec vite --host 127.0.0.1 --port 5194 --strictPort
    # the show: launches the simulator (automation :9902) and a headless Edge/Chrome, records
    uv run --with Hershey-Fonts --with playwright --with websockets --with pillow \\
        python scripts/dev/showcase.py --mp4 docs/media/showcase.mp4 \\
        --gif docs/media/showcase.gif --stills docs/media

`--preview DIR` renders each scene's final page (and a few animation frames) to PNGs without
any router, in seconds, for layout work. `--work DIR` keeps the raw screenshots and timeline;
`--compose DIR` re-renders the video from them without recording again.

Reading order: the hand (smoothing, pacing) → letters (fonts and layout) → shapes and characters
→ the session (pens, sprites, the ring) → the eight scenes → recording (simulator, browser,
grabbers) → compositing (frames, cards, MP4, GIF, stills).
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
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from pathlib import Path

PAGE_W, PAGE_H = 1620, 2160
SAMPLE_HZ = 240
BATCH_MS = 1000 / 60

HAND_TEMPO = 1.4  # every hand's cruising speed, scaled: a brisk writer (the scenes' speeds × this)

AGENT_COLOR = "#7b3fd6"  # violet: the agent's own ink
ANA_COLOR = "#d6482a"  # red
BEN_COLOR = "#2a6fd6"  # blue

Pt = tuple[float, float]
Path_ = list[Pt]
Sample = tuple[float, float, float, float]  # x px, y px, pressure 0..1, ms from pen-down

# =============================================================================================
# The hand: smoothing, wobble and tremor, then pen timing and pressure (demo_story.py's).
# =============================================================================================


def _catmull(pts: Path_, per: int = 8) -> Path_:
    """Catmull-Rom through `pts`, `per` samples per segment (page px)."""
    if len(pts) < 3:
        return list(pts)
    p = [pts[0], *pts, pts[-1]]
    out: Path_ = []
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


def _length(path: Path_) -> float:
    return sum(math.dist(path[i - 1], path[i]) for i in range(1, len(path)))


def _hand(pts: Path_, rng: random.Random, wobble: float = 3.0, tremor: float = 0.7) -> Path_:
    """
    Smooth a polyline and make it hand-made: a slow wobble across the whole stroke and a fine
    tremor, both smooth noise (sums of sines with random phases), amplitudes in page px.
    """
    curve = _catmull(pts)
    length = _length(curve) or 1.0
    waves = [(rng.uniform(0, 6.3), rng.uniform(0, 6.3), f) for f in (1.1, 2.3)]
    shakes = [
        (rng.uniform(0, 6.3), rng.uniform(0, 6.3), length / rng.uniform(60, 90)) for _ in range(2)
    ]
    out: Path_ = []
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


def _timed(path: Path_, speed: float, rng: random.Random) -> list[Sample]:
    """
    Pace a path like a pen: samples at SAMPLE_HZ from pen-down at a cruising `speed` (page px/s;
    900 px/s is about 10 cm/s, brisk handwriting). Curvature, measured over a few samples so the
    tremor does not count, slows the pen; pressure rises as it slows and ramps at either end.
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


def _smooth(u: float) -> float:
    """Smoothstep easing on 0..1."""
    u = max(0.0, min(1.0, u))
    return u * u * (3 - 2 * u)


def _neat(path: Path_, speed: float) -> list[Sample]:
    """
    The agent's pacing: an even pressure (0.42, tapering a little at the ends) along the path at
    a steady `speed` (page px/s), eased in and out over the whole stroke. No wobble, no tremor.
    """
    if len(path) < 2:
        path = [path[0], (path[0][0] + 0.5, path[0][1] + 0.5)]
    cum = [0.0]
    for i in range(1, len(path)):
        cum.append(cum[-1] + math.dist(path[i - 1], path[i]))
    total = cum[-1] or 1.0
    dur = max(0.06, total / speed)
    n = max(2, int(dur * SAMPLE_HZ))
    out: list[Sample] = []
    j = 0
    for k in range(n + 1):
        target = _smooth(k / n) * total
        while j < len(cum) - 2 and cum[j + 1] < target:
            j += 1
        f = (target - cum[j]) / ((cum[j + 1] - cum[j]) or 1e-6)
        (ax, ay), (bx, by) = path[j], path[j + 1]
        p = 0.42 * min(1.0, 0.7 + 3 * min(k / n, 1 - k / n))
        out.append((ax + (bx - ax) * f, ay + (by - ay) * f, p, k / SAMPLE_HZ * 1000))
    return out


# =============================================================================================
# Letters: Hershey glyphs laid out on a line, as a hand writes them or as the agent does.
# A line of text may hold a few marks the fonts lack (√ ² ˣ ₂ ∫ ⇒ − ∎ ✓ ° θ δ); they are drawn
# here as strokes in the same font units (y down, baseline 0, capitals reach −21).
# =============================================================================================


class Font:
    """One Hershey font: each character's strokes (font units, x from 0, baseline 0), advance."""

    def __init__(self, name: str):
        try:
            from HersheyFonts import HersheyFonts
        except ImportError as e:
            raise SystemExit(
                "needs the Hershey font: uv run --with Hershey-Fonts python ..."
            ) from e
        self.f = HersheyFonts()
        self.f.load_default_font(name)
        self.cache: dict[str, tuple[list[Path_], float]] = {}

    def glyph(self, ch: str) -> tuple[list[Path_], float]:
        if ch not in self.cache:
            g = next(iter(self.f.glyphs_for_text(ch)), None)
            if g is None:
                self.cache[ch] = ([], 12.0)
            else:
                strokes = [
                    [(float(x - g.left_offset), float(y - 9)) for x, y in s] for s in g.strokes
                ]
                self.cache[ch] = (strokes, float(g.char_width))
        return self.cache[ch]


_FONTS: dict[str, Font] = {}


def font(name: str) -> Font:
    if name not in _FONTS:
        _FONTS[name] = Font(name)
    return _FONTS[name]


def _symbol(ch: str, nxt: float) -> tuple[list[Path_], float] | None:
    """The marks the fonts lack, in font units; `nxt` is the next glyph's advance (for √'s bar)."""
    if ch == "√":
        return [[(0, -6), (3, -8), (8, 1), (13, -19), (14 + nxt, -19)]], 14
    if ch == "∫":
        return [
            _catmull([(13, -20), (10, -21), (8, -17), (6, 0), (4, 13), (1, 15), (-1, 12)], 6)
        ], 14
    if ch == "⇒":
        return [[(2, -9), (17, -9)], [(2, -3), (17, -3)], [(13, -13), (20, -6), (13, 1)]], 24
    if ch == "−":
        return [[(3, -6), (15, -6)]], 18
    if ch == "∎":  # the outline, then filled with a zigzag so it reads solid
        fill: Path_ = [(3, -1), (3, -12), (12, -12), (12, -1), (3, -1)]
        for i in range(12):
            y = -1.6 - i * 0.88
            fill += [(3.6, y), (11.4, y - 0.7)] if i % 2 == 0 else [(11.4, y), (3.6, y - 0.7)]
        return [fill], 16
    if ch == "✓":
        return [[(1, -7), (5, -1), (14, -16)]], 16
    if ch == "°":
        return [ellipse(3, -17, 2.6, 2.6, 0, 380, 14)], 7
    if ch == "θ":
        return [ellipse(6, -7, 4.5, 7.5, -90, 365, 24), [(1.8, -7), (10.2, -7)]], 13
    if ch == "δ":
        return [
            [
                (10, -14),
                (7, -16),
                (3, -15),
                (4, -12),
                (9, -9),
                (11, -5),
                (10, -1),
                (6, 0),
                (2, -2),
                (1, -5),
                (3, -8),
                (8, -9),
            ]
        ], 13
    return None


SCRIPT_SUBS = {"²": ("2", -10.0), "ˣ": ("x", -10.0), "₂": ("2", 5.0)}


def lay(
    text: str,
    x0: float,
    base: float,
    unit: float,
    face: str = "scripts",
    rng: random.Random | None = None,
    slant: float = 0.0,
) -> tuple[list[Path_], float]:
    """
    One line of `text` as pen-downs (page px, writing order) and its width (px). `unit` is px per
    font unit; `x0` the left edge; `base` the baseline. With `rng` it is a hand: every glyph gets
    its own small size and slant drift on a wandering baseline, a word's glyph strokes that nearly
    touch are joined into one pen-down, and dots and bars follow their word; without, it is the
    agent's even type (`face` futural), one stroke per glyph stroke.
    """
    f = font(face)
    drift_phase = rng.uniform(0, 6.3) if rng else 0.0
    words: list[list[Path_]] = [[]]
    details: list[list[Path_]] = [[]]
    x = 0.0
    chars = list(text)
    for i, ch in enumerate(chars):
        if ch == " ":
            x += f.glyph(" ")[1] if f.glyph(" ")[1] else 10
            words.append([])
            details.append([])
            continue
        scale, dy = 1.0, 0.0
        nxt = f.glyph(chars[i + 1])[1] if i + 1 < len(chars) else 12.0
        sym = _symbol(ch, nxt)
        is_sym = sym is not None
        if sym:
            strokes, adv = sym
        elif ch in SCRIPT_SUBS:
            base_ch, dy = SCRIPT_SUBS[ch]
            strokes, adv = f.glyph(base_ch)
            scale = 0.6
        else:
            strokes, adv = f.glyph(ch)
        s = scale * ((1 + rng.gauss(0, 0.035)) if rng else 1.0)
        lean = slant + (rng.gauss(0, 0.03) if rng else 0.0)
        # letters of a word may join; marks, digits, sub- and superscripts are pen-downs apart
        joinable = rng is not None and ch.isalpha() and not is_sym and ch not in SCRIPT_SUBS
        if not joinable and words[-1]:
            words.append([])
            details.append([])

        def place(p: Pt, s: float = s, lean: float = lean, gx: float = x, dy: float = dy) -> Pt:
            px, py = gx + p[0] * s, p[1] * s + dy
            px -= py * lean
            drift = (0.8 * math.sin(px / 35 + drift_phase) - 0.01 * px) if rng else 0.0
            return (x0 + px * unit, base + (py + drift) * unit)

        for st in strokes:
            placed = [place(p) for p in st]
            if len(st) <= 2 and max(abs(st[0][0] - st[-1][0]), abs(st[0][1] - st[-1][1])) <= 2:
                placed = [
                    placed[0],
                    (placed[0][0] + 0.7 * unit, placed[0][1] + 0.5 * unit),
                ]  # a dot's flick
                details[-1].append(placed)  # dots go back after the word, as a hand does
            else:
                words[-1].append(placed)
        if not joinable:
            words.append([])
            details.append([])
        x += adv * scale
    out: list[Path_] = []
    for word, extra in zip(words, details, strict=True):
        run: Path_ = []
        for st in word:
            if rng and run and math.dist(run[-1], st[0]) < 6 * unit:
                run.extend(st[1:] if run[-1] == st[0] else st)
            else:
                if run:
                    out.append(run)
                run = list(st)
        if run:
            out.append(run)
        out.extend(extra)
    return out, x * unit


def text_width(text: str, unit: float, face: str = "scripts") -> float:
    return lay(text, 0, 0, unit, face)[1]


# =============================================================================================
# Shapes, and the characters made of them.
# =============================================================================================


def ellipse(
    cx: float,
    cy: float,
    rx: float,
    ry: float,
    start: float = 0,
    sweep: float = 360,
    n: int = 48,
    rot: float = 0,
) -> Path_:
    """An ellipse arc (degrees, y down, rotated by `rot` degrees), as a pen goes round it."""
    c, s = math.cos(math.radians(rot)), math.sin(math.radians(rot))
    out = []
    for i in range(n + 1):
        a = math.radians(start + sweep * i / n)
        x, y = rx * math.cos(a), ry * math.sin(a)
        out.append((cx + x * c - y * s, cy + x * s + y * c))
    return out


def line(a: Pt, b: Pt, n: int = 8) -> Path_:
    return [(a[0] + (b[0] - a[0]) * i / n, a[1] + (b[1] - a[1]) * i / n) for i in range(n + 1)]


def arrow(a: Pt, b: Pt, head: float = 26, spread: float = 26) -> list[Path_]:
    """A shaft from `a` to `b` and a two-sided head at `b` (one pen-down each)."""
    ang = math.atan2(b[1] - a[1], b[0] - a[0])
    h1 = (
        b[0] - head * math.cos(ang - math.radians(spread)),
        b[1] - head * math.sin(ang - math.radians(spread)),
    )
    h2 = (
        b[0] - head * math.cos(ang + math.radians(spread)),
        b[1] - head * math.sin(ang + math.radians(spread)),
    )
    return [line(a, b, 12), [h1, b, h2]]


def bezier(p0: Pt, p1: Pt, p2: Pt, p3: Pt, n: int = 40) -> Path_:
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


def rect(x0: float, y0: float, x1: float, y1: float, overshoot: float = 0.0) -> Path_:
    """A box from its top-left corner round, closing with a little overshoot as a hand does."""
    pts = [(x0, y0), (x1, y0), (x1, y1), (x0, y1), (x0, y0)]
    if overshoot:
        pts.append((x0 + overshoot, y0 + 2))
    out: Path_ = []
    for i in range(1, len(pts)):
        out.extend(line(pts[i - 1], pts[i], 10)[0 if i == 1 else 1 :])
    return out


def polygon(pts: list[Pt], close: bool = True) -> Path_:
    seq = [*pts, pts[0]] if close else pts
    out: Path_ = []
    for i in range(1, len(seq)):
        out.extend(line(seq[i - 1], seq[i], 10)[0 if i == 1 else 1 :])
    return out


def blob_fill(
    cx: float, cy: float, rx: float, ry: float, rot: float = -20, turns: float = 2.6
) -> Path_:
    """A filled note head: a pen spiralling in from the rim, so the head reads solid."""
    n = int(turns * 28)
    out = []
    c, s = math.cos(math.radians(rot)), math.sin(math.radians(rot))
    for i in range(n + 1):
        u = i / n
        a = 2 * math.pi * turns * u
        k = 1 - 0.85 * u
        x, y = rx * k * math.cos(a), ry * k * math.sin(a)
        out.append((cx + x * c - y * s, cy + x * s + y * c))
    return out


# A walk cycle: six key poses (degrees from vertical, + is forward): left thigh, left knee bend,
# right thigh, right knee bend, left arm, right arm. Interpolated over the phase (0..1 per step
# pair), so the figure walks smoothly however often a frame is drawn.
WALK = [
    (24, 4, -22, 8, -20, 22),
    (14, 2, -10, 40, -12, 14),
    (0, 6, 8, 30, 0, 0),
    (-22, 8, 24, 4, 22, -20),
    (-10, 40, 14, 2, 14, -12),
    (8, 30, 0, 6, 0, 0),
]


def walk_pose(phase: float) -> tuple[float, ...]:
    """The cycle's pose at `phase` (cycles; 1 = two steps), interpolated between key poses."""
    u = (phase % 1.0) * len(WALK)
    i = int(u)
    a, b = WALK[i % len(WALK)], WALK[(i + 1) % len(WALK)]
    f = _smooth(u - i)
    return tuple(x + (y - x) * f for x, y in zip(a, b, strict=True))


def figure(
    x: float,
    ground: float,
    pose: tuple[float, ...] = (0, 4, 0, 4, -8, 8),
    size: float = 1.0,
    facing: int = 1,
    lift: float = 0.0,
    hat: bool = False,
    arms: tuple[Pt, Pt] | None = None,
) -> list[Path_]:
    """
    A stick figure standing on `ground` (page y of the lower foot) at `x`, `size` × about 230 px
    tall: head, body, legs (one stroke, foot to foot), arms (one stroke, hand to hand) and, with
    `hat`, a mortarboard. `pose` is (thigh, knee, thigh, knee, arm, arm) in degrees, + forward;
    `arms` overrides the hands with directions (unit vectors, page coords) for pointing and
    cheering. `lift` raises the whole figure (a jump), px.
    """
    leg, body, arm, head = 52 * size, 80 * size, 44 * size, 23 * size
    tl, kl, tr, kr, al, ar = pose
    f = facing

    def limb(origin: Pt, a1: float, a2: float, ln: float) -> tuple[Pt, Pt]:
        k = (
            origin[0] + f * ln * math.sin(math.radians(a1)),
            origin[1] + ln * math.cos(math.radians(a1)),
        )
        e = (k[0] + f * ln * math.sin(math.radians(a2)), k[1] + ln * math.cos(math.radians(a2)))
        return k, e

    hip0 = (x, 0.0)
    kL, fL = limb(hip0, tl, tl - kl, leg)
    kR, fR = limb(hip0, tr, tr - kr, leg)
    drop = max(fL[1], fR[1])
    oy = ground - drop - lift

    def at(p: Pt) -> Pt:
        return (p[0], p[1] + oy)

    hip = at(hip0)
    sh = (hip[0], hip[1] - body)
    if arms:
        (dxl, dyl), (dxr, dyr) = arms
        eL = (sh[0] + dxl * arm, sh[1] + dyl * arm)
        hL = (eL[0] + dxl * arm, eL[1] + dyl * arm)
        eR = (sh[0] + dxr * arm, sh[1] + dyr * arm)
        hR = (eR[0] + dxr * arm, eR[1] + dyr * arm)
    else:
        eL, hL = limb(sh, al, al + 25, arm)
        eR, hR = limb(sh, ar, ar + 25, arm)
    cx, cy = sh[0], sh[1] - head - 8 * size
    out = [
        ellipse(cx, cy, head, head, -90, 360, 28),
        line((sh[0], sh[1] - 8 * size), hip, 6),
        [at(fL), at(kL), hip, at(kR), at(fR)],
        [hL, eL, sh, eR, hR],
    ]
    if hat:
        top = cy - head
        out.append(
            [
                (cx - 30 * size, top - 4 * size),
                (cx, top - 14 * size),
                (cx + 30 * size, top - 4 * size),
                (cx, top + 4 * size),
                (cx - 30 * size, top - 4 * size),
                (cx + 22 * size, top + 1 * size),
                (cx + 26 * size, top + 22 * size),
            ]
        )
    return out


def unit_vec(deg: float) -> Pt:
    """A direction in page coords from degrees (0 = right, 90 = down)."""
    return (math.cos(math.radians(deg)), math.sin(math.radians(deg)))


def ball_char(x: float, y: float, r: float, squash: float = 0.0, look: float = 1.0) -> list[Path_]:
    """A bouncing ball with eyes: `squash` > 0 flattens it (landing), < 0 stretches it (flight)."""
    rx, ry = r * (1 + 0.35 * squash), r * (1 - 0.35 * squash)
    cy = y + (r - ry)
    ex = x + look * r * 0.32
    return [
        ellipse(x, cy, rx, ry, -90, 360, 26),
        [(ex - 7, cy - 6), (ex - 6, cy - 2)],
        [(ex + 7, cy - 6), (ex + 8, cy - 2)],
        ellipse(ex, cy + 2, 8, 6, 20, 140, 8),
    ]


# =============================================================================================
# The session: one WebSocket per participant, pens that draw in real time, sprites that animate.
# =============================================================================================


class Session:
    """
    The participants' connections to one router session. In a dry run (`--preview`) nothing is
    sent and nothing waits: messages update an in-memory page that preview() renders.
    """

    def __init__(self, url: str, dry: bool = False):
        self.url, self.dry = url, dry
        self.ws: dict[str, object] = {}
        self.drains: list[asyncio.Future] = []
        self.n = 0
        self.page: dict[str, dict] = {}  # dry: id → {layer, color, pts}
        self.frames: list[
            list[Path_]
        ] = []  # dry: every animation frame of the scene, for the preview

    async def open(self, *authors: str):
        if self.dry:
            return
        import websockets

        for a in authors:
            ws = await websockets.connect(self.url, max_size=2**24)
            await ws.recv()  # hello
            self.ws[a] = ws
            # everyone else's ink comes back to each pen: read it and let it go, or the router
            # finds this client's queue full and drops it as a stalled client
            self.drains.append(asyncio.ensure_future(self._drain(ws)))

    @staticmethod
    async def _drain(ws):
        try:
            async for _ in ws:
                pass
        except Exception:  # noqa: BLE001 - the connection closed; nothing to read
            pass

    async def close(self):
        for ws in self.ws.values():
            await ws.close()  # type: ignore[attr-defined]

    async def send(self, author: str, msg: dict):
        if self.dry:
            t = msg["t"]
            if t == "stroke_begin":
                self.page[msg["id"]] = {
                    "layer": msg.get("layer", "user"),
                    "color": msg.get("color"),
                    "pts": [],
                }
            elif t == "stroke_pts" and msg["id"] in self.page:
                self.page[msg["id"]]["pts"].extend(msg["pts"])
            elif t == "stroke_delete":
                for i in msg["ids"]:
                    self.page.pop(i, None)
            elif t == "clear":
                self.page.clear()
            return
        await self.ws[author].send(json.dumps(msg))  # type: ignore[attr-defined]

    async def sleep(self, s: float):
        if not self.dry:
            await asyncio.sleep(s)

    def new_id(self, author: str) -> str:
        self.n += 1
        return f"{author}_show_{self.n}"


class Pen:
    """One participant: an author, a layer and (for peers and the agent) a colour."""

    def __init__(self, s: Session, author: str, layer: str, color: str | None = None):
        self.s, self.author, self.layer, self.color = s, author, layer, color

    def _begin(self, sid: str, t0: int) -> dict:
        m: dict = {"t": "stroke_begin", "id": sid, "layer": self.layer, "brush": "pen", "ts": t0}
        if self.color:
            m |= {"color": self.color, "author": self.author}
        return m

    async def stroke(self, pts: list[Sample]) -> str:
        """One stroke in real time: begin, 60 Hz point batches, end. Returns its id."""
        sid = self.s.new_id(self.author)
        start = time.time()
        t0 = int(start * 1000)
        await self.s.send(self.author, self._begin(sid, t0))
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
            await self.s.sleep(max(0.0, start + due / 1000 - time.time()))
            await self.s.send(self.author, {"t": "stroke_pts", "id": sid, "pts": batch})
        await self.s.send(
            self.author, {"t": "stroke_end", "id": sid, "ts": int(time.time() * 1000)}
        )
        return sid

    async def hand(
        self,
        paths: list[Path_],
        speed: float,
        rng: random.Random,
        wobble: float = 2.0,
        lift: float = 0.1,
    ) -> list[str]:
        """Pen-downs in a row by hand, a pen-up travel (`lift` s + distance) between."""
        ids = []
        for i, p in enumerate(paths):
            if i:
                await self.s.sleep(lift + math.dist(paths[i - 1][-1], p[0]) / 5000)
            ids.append(await self.stroke(_timed(_hand(p, rng, wobble), speed * HAND_TEMPO, rng)))
        return ids

    async def neat(self, paths: list[Path_], speed: float = 2200, lift: float = 0.05) -> list[str]:
        """Pen-downs in a row, the agent's way: even, smooth, quick between strokes."""
        ids = []
        for i, p in enumerate(paths):
            if i:
                await self.s.sleep(lift)
            ids.append(await self.stroke(_neat(p, speed)))
        return ids

    async def put(self, paths: list[Path_], p: float = 0.42) -> list[str]:
        """Whole strokes at once (an animation frame): begin, all points, end, for each."""
        ids = []
        t0 = int(time.time() * 1000)
        for path in paths:
            sid = self.s.new_id(self.author)
            await self.s.send(self.author, self._begin(sid, t0))
            pts = [[round(x / PAGE_W, 5), round(y / PAGE_H, 5), p, t0] for x, y in path]
            await self.s.send(self.author, {"t": "stroke_pts", "id": sid, "pts": pts})
            await self.s.send(self.author, {"t": "stroke_end", "id": sid, "ts": t0})
            ids.append(sid)
        return ids

    async def delete(self, ids: list[str]):
        """Take strokes back for everyone (`stroke_delete`; the router checks we may)."""
        if ids:
            await self.s.send(
                self.author, {"t": "stroke_delete", "ids": list(ids), "ts": int(time.time() * 1000)}
            )

    async def clear(self):
        await self.s.send(self.author, {"t": "clear", "ts": int(time.time() * 1000)})


class Sprite:
    """An animated drawing on one pen: each frame draws the new pose, then deletes the old one."""

    def __init__(self, pen: Pen):
        self.pen = pen
        self.ids: list[str] = []

    async def show(self, paths: list[Path_]):
        new = await self.pen.put(paths)
        old, self.ids = self.ids, new
        await self.pen.delete(old)
        if self.pen.s.dry:
            self.pen.s.frames.append(paths)

    async def hide(self):
        await self.pen.delete(self.ids)
        self.ids = []

    async def play(self, frame: Callable[[float], list[Path_]], seconds: float, fps: float = 14):
        """Animate `frame(u)` for u from 0 to 1 over `seconds`, at `fps` (paced by the clock)."""
        n = max(1, int(seconds * fps))
        t0 = time.time()
        for k in range(n + 1):
            await self.show(frame(k / n))
            await self.pen.s.sleep(max(0.0, t0 + (k + 1) / fps - time.time()))


class Ring:
    """The R1 ring and touchpad, through the simulator's automation API (no-op in a dry run)."""

    def __init__(self, sim: str | None):
        self.sim = sim

    def __call__(self, action: str):
        if not self.sim:
            return
        req = urllib.request.Request(
            f"{self.sim}/api/input",
            data=json.dumps({"action": action}).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        urllib.request.urlopen(req, timeout=5).read()

    async def cycle_view(self, s: Session):
        """The glasses menu's "View: follow / fit / wide" (the sixth entry, glasses/layout.ts)."""
        self("context_menu")
        await s.sleep(0.7)
        for _ in range(5):
            self("down")
            await s.sleep(0.16)
        await s.sleep(0.3)
        self("click")


class Timeline:
    """Marks in s since the show began, for the compositor: scenes, captions, tags, the end."""

    def __init__(self):
        self.t0 = time.time()
        self.marks: list[tuple[float, str, str]] = []

    def mark(self, kind: str, text: str = ""):
        self.marks.append((time.time() - self.t0, kind, text))


@dataclass
class Show:
    """What a scene needs: the session, the four pens, the ring, the timeline, a seeded hand."""

    s: Session
    me: Pen
    ana: Pen
    ben: Pen
    agent: Pen
    ring: Ring
    tl: Timeline
    rng: random.Random
    phone: object | None = None  # the browser phone (Phone), for the finale's timelapse
    tasks: list[asyncio.Task] = field(default_factory=list)
    # The lens's framing. With wide fit on (the simulator starts with wide=1), a ring tap toggles
    # follow ↔ wide fit. Follow suits writing: the loupe shows the pen live and the canvas catches
    # up at each pause (CANVAS_LULL_MS). Wide fit suits animation: with no loupe the canvas is the
    # only view, so it is resent as ink arrives (at most every canvas_ms).
    mode: str = "follow"

    def look(self, mode: str):
        """Tap the ring if the lens is not already in `mode` ("follow" or "wide")."""
        if mode != self.mode:
            self.ring("click")
            self.mode = mode

    def scene(self, n: int, name: str, sub: str):
        self.tl.mark("scene", f"{n}|{name}|{sub}")

    def caption(self, text: str):
        self.tl.mark("caption", text)

    def tag(self, text: str):
        self.tl.mark("tag", text)

    def speed(self, x: float):
        """Play what follows `x` times faster in the video (shown as a badge; 1 = real time)."""
        self.tl.mark("speed", str(x))

    def still(self, label: str, after: float = 0.0):
        """Ask the compositor for a still `showcase-<label>.png`, `after` s from now."""

        async def later():
            await self.s.sleep(after)
            self.tl.mark("still", label)

        self.spawn(later())

    def spawn(self, co: Awaitable):
        """Run `co` alongside (the agent working while the pen writes on)."""
        t = asyncio.ensure_future(co)
        self.tasks.append(t)
        return t

    async def settle(self):
        """Wait for everything spawned in this scene."""
        if self.tasks:
            await asyncio.gather(*self.tasks)
        self.tasks = []

    async def new_page(self):
        """New drawing for everyone (the tablet's pen sends `clear`); the lens back to follow."""
        self.tl.mark("page")  # the previous scene ends here, before its ink is wiped
        await self.me.clear()
        self.look("follow")
        await self.s.sleep(0.25)


# =============================================================================================
# The scenes. Each draws on a fresh page in a band about 1.6 times as wide as it is tall, so the
# phone's Fit view and the glasses' wide fit view both show it large.
# =============================================================================================

NEAT = "futural"


async def scene_proof(c: Show):
    """1. A proof that √2 is irrational, written line by line; the agent checks each line."""
    c.scene(1, "Prove", "√2 is irrational, by contradiction")
    c.caption("the tablet's pen writes a proof, line by line")
    c.speed(3)
    rng = c.rng
    x0 = 210
    title, _ = lay("√2 is irrational", x0, 760, 4.4, rng=rng, slant=0.12)
    await c.me.hand(title, 1700, rng)
    c.tag("simulated agent")
    c.caption("the agent underlines each step in its own ink and ticks it: checked")
    lines = [
        "√2 = p/q (lowest terms)",
        "p² = 2q² ⇒ p even",
        "p = 2k ⇒ q² = 2k²",
        "⇒ q even",
        "both even!",
    ]

    async def check(base: float, w: float):
        await c.s.sleep(0.15)
        await c.agent.neat([line((x0 - 14, base + 44), (x0 + w + 14, base + 40), 20)], 2600)
        tx = x0 + w + 46
        await c.agent.neat(lay("✓", tx, base - 6, 3.4, NEAT)[0], 900)
        await c.agent.neat(lay("checked", tx + 62, base - 8, 1.9, NEAT)[0], 2400, lift=0.02)

    base = 760
    for i, text in enumerate(lines):
        base += 132
        paths, w = lay(text, x0, base, 3.0, rng=rng, slant=0.12)
        await c.me.hand(paths, 1750, rng)
        if i < 4:
            c.spawn(check(base, w))
        await c.s.sleep(
            0.7
        )  # a breath between lines (and the lens's canvas catches up at the pause)
    await c.settle()
    c.look("wide")
    c.speed(1)
    c.caption("both even contradicts lowest terms: the agent circles it and closes the proof")
    w = text_width("both even!", 3.0)
    await c.agent.neat([ellipse(x0 + w / 2, base - 22, w / 2 + 50, 62, 200, 375, 60)], 2400)
    tail, tw = lay("contradiction", x0 + w + 110, base - 6, 2.6, NEAT)
    await c.agent.neat(tail, 3200, lift=0.02)
    qx = x0 + w + 110 + tw + 40
    await c.agent.neat(lay("∎", qx, base - 4, 4.2, NEAT)[0], 1200)
    await c.agent.neat(
        [
            bezier(
                (x0 + w + 100, base + 30),
                (x0 + w + 300, base + 70),
                (qx - 60, base + 50),
                (qx + 70, base - 90),
                40,
            )
        ],
        2600,
    )
    c.still("proof", 0.6)
    await c.s.sleep(1.0)


async def scene_integral(c: Show):
    """2. ∫ x·eˣ dx: the agent works it by parts beside it; a little mathematician cheers."""
    c.scene(2, "Solve", "∫ x eˣ dx, by parts")
    c.caption("a handwritten integral")
    c.speed(2)
    rng = c.rng
    floor = 1420
    c.spawn(c.agent.neat([line((150, floor), (1480, floor), 30)], 3200))
    q, _ = lay("∫ x eˣ dx = ?", 190, 820, 5.2, rng=rng, slant=0.1)
    await c.me.hand(q, 1500, rng)
    await c.settle()
    c.look("wide")
    c.tag("simulated agent")
    c.caption("the agent completes the working steps beside it")
    x = 260
    steps = ["u = x,  dv = eˣ dx", "= x eˣ − ∫ eˣ dx", "= eˣ (x − 1) + C"]
    bases = [985, 1105, 1225]
    for text, b in zip(steps[:2], bases[:2], strict=True):
        await c.agent.neat(lay(text, x, b, 3.0, NEAT)[0], 3000, lift=0.03)
    hero = Sprite(c.agent)
    walk_from, walk_to = 1470.0, 1290.0

    async def walk_in():
        c.speed(1)
        c.caption("…and a mathematician walks in to check the answer")
        await hero.play(
            lambda u: figure(
                walk_from + (walk_to - walk_from) * u,
                floor - 6,
                walk_pose(u * 2.5),
                0.95,
                -1,
                hat=True,
            ),
            2.4,
            14,
        )

    c.spawn(walk_in())
    paths, w = lay(steps[2], x, bases[2], 3.0, NEAT)
    await c.agent.neat(paths, 3000, lift=0.03)
    await c.agent.neat([rect(x - 26, bases[2] - 82, x + w + 26, bases[2] + 30, 18)], 2600)
    await c.settle()
    target = (x + w + 26, bases[2] - 30)
    shoulder = (walk_to, floor - 6 - 2 * 52 * 0.95 - 80 * 0.95)
    d = math.atan2(target[1] - shoulder[1], target[0] - shoulder[0])
    point = (math.cos(d), math.sin(d))
    c.caption("it points at the boxed answer, and celebrates")
    await hero.show(
        figure(
            walk_to, floor - 6, (0, 4, 6, 6, 0, 0), 0.95, -1, hat=True, arms=(point, unit_vec(110))
        )
    )
    await c.s.sleep(0.9)

    def cheer(u: float) -> list[Path_]:
        hop = abs(math.sin(u * 2 * math.pi)) * 70
        wave = 18 * math.sin(u * 8 * math.pi)
        return figure(
            walk_to,
            floor - 6,
            (8, 20, -8, 20, 0, 0),
            0.95,
            -1,
            lift=hop,
            hat=True,
            arms=(unit_vec(-120 - wave), unit_vec(-60 + wave)),
        )

    await hero.play(cheer, 1.6, 14)
    await c.agent.neat(lay("✓", walk_to - 28, floor - 290, 3.6, NEAT)[0], 1200)
    await c.s.sleep(0.5)


async def scene_recognize(c: Show):
    """3. Rough shapes recognized: the agent redraws each cleanly, the pen deletes its sketch."""
    c.scene(3, "Recognize", "rough shapes, redrawn clean")
    c.caption("sloppy shapes from the pen…")
    c.speed(1.5)
    rng = c.rng
    c.tag("scripted recognition · simulated agent")

    async def recognize(rough: list[str], clean: list[Path_], label: str, lx: float, ly: float):
        await c.s.sleep(0.25)
        await c.agent.neat(clean, 3000, lift=0.02)
        await c.me.delete(rough)  # the pen's owner takes its sketch back
        await c.agent.neat(
            lay(label, lx - text_width(label, 2.4, NEAT) / 2, ly, 2.4, NEAT)[0], 3200, lift=0.02
        )

    y = 900
    # circle
    rough = await c.me.hand(
        [ellipse(330 + rng.gauss(0, 6), y, 128, 112, -100, 372, 40)], 1900, rng, wobble=16
    )
    c.caption("…each one recognized: a clean version on the agent's layer, the sketch deleted")
    c.spawn(recognize(rough, [ellipse(330, y, 120, 120, -90, 360, 64)], "circle", 330, y + 190))
    # triangle
    tri = [(780, y - 125), (905, y + 105), (650, y + 100)]
    rough = await c.me.hand(
        [polygon([(778, y - 120), (880, y + 92), (655, y + 110), (790, y - 110)], close=False)],
        1800,
        rng,
        wobble=12,
    )
    c.spawn(recognize(rough, [polygon(tri)], "triangle", 778, y + 190))
    # square
    rough = await c.me.hand(
        [
            polygon(
                [
                    (1090, y - 112),
                    (1318, y - 98),
                    (1300, y + 118),
                    (1080, y + 105),
                    (1098, y - 120),
                ],
                close=False,
            )
        ],
        1900,
        rng,
        wobble=10,
    )
    c.spawn(recognize(rough, [rect(1080, y - 110, 1300, y + 110)], "square", 1190, y + 190))
    await c.settle()
    c.look("wide")
    # a sloppy graph: axes and a parabola
    ox, oy = 300, 1600
    c.caption("a sketched graph: clean axes, and the curve recognized as y = x²")
    axes = await c.me.hand(
        [polygon([(ox, oy - 330), (ox + 4, oy + 6), (ox + 620, oy - 6)], close=False)],
        2000,
        rng,
        wobble=10,
    )
    curve = await c.me.hand(
        [
            [
                (ox + 80, oy - 300),
                (ox + 180, oy - 110),
                (ox + 300, oy - 30),
                (ox + 430, oy - 110),
                (ox + 530, oy - 310),
            ]
        ],
        1800,
        rng,
        wobble=14,
    )
    await c.s.sleep(0.2)
    clean = [*arrow((ox, oy), (ox, oy - 360)), *arrow((ox, oy), (ox + 660, oy))]
    para = [(ox + 305 + u, oy - 24 - 0.0048 * u * u) for u in range(-240, 241, 12)]
    await c.agent.neat([*clean, para], 3200, lift=0.02)
    await c.me.delete(axes + curve)
    await c.agent.neat(lay("y = x²", ox + 560, oy - 300, 3.0, NEAT)[0], 3000, lift=0.02)
    # handwriting, typeset
    c.caption("and handwriting, typeset")
    word = await c.me.hand(
        lay("hello", 1080, 1430, 4.6, rng=rng, slant=0.2)[0], 1500, rng, wobble=5
    )
    await c.s.sleep(0.2)
    await c.agent.neat(lay("hello", 1090, 1430, 4.2, NEAT)[0], 3200, lift=0.02)
    await c.me.delete(word)
    await c.s.sleep(1.0)


async def scene_physics(c: Show):
    """4. A ball on a ramp: the agent adds the forces, then the ball rolls down, frame by frame."""
    c.scene(4, "Physics", "a ball on a ramp")
    c.caption("a ramp and a ball, by hand")
    c.speed(2)
    rng = c.rng
    top, corner, right = (220.0, 900.0), (220.0, 1450.0), (1080.0, 1450.0)
    ground_end = 1500.0
    await c.me.hand(
        [line(top, right, 12), polygon([top, corner, (ground_end, 1450)], close=False)],
        2600,
        rng,
        wobble=3,
    )
    L = math.dist(top, right)
    th = math.atan2(right[1] - top[1], right[0] - top[0])
    d = (math.cos(th), math.sin(th))  # down the slope
    nrm = (math.sin(th), -math.cos(th))  # out of the slope, up and right
    r = 58.0

    def on_slope(s: float) -> Pt:
        return (top[0] + d[0] * s + nrm[0] * r, top[1] + d[1] * s + nrm[1] * r)

    s0 = 130.0
    c0 = on_slope(s0)
    rough = await c.me.hand(
        [ellipse(c0[0] + 4, c0[1] - 3, r + 6, r - 2, -80, 375, 36)], 1500, rng, wobble=8
    )
    c.look("wide")
    c.tag("simulated agent")
    c.caption("the agent draws the forces: weight mg, normal N, friction f")
    ball = Sprite(c.agent)

    def ball_at(cx: float, cy: float, spin: float) -> list[Path_]:
        a = (math.cos(spin) * r * 0.82, math.sin(spin) * r * 0.82)
        b = (-a[1], a[0])
        return [
            ellipse(cx, cy, r, r, 0, 360, 40),
            line((cx - a[0], cy - a[1]), (cx + a[0], cy + a[1]), 4),
            line((cx - b[0], cy - b[1]), (cx + b[0], cy + b[1]), 4),
        ]

    await ball.show(ball_at(*c0, 0.0))
    await c.me.delete(rough)
    forces = [
        (arrow(c0, (c0[0], c0[1] + 190)), "mg", (c0[0] + 18, c0[1] + 200)),
        (
            arrow(c0, (c0[0] + nrm[0] * 170, c0[1] + nrm[1] * 170)),
            "N",
            (c0[0] + nrm[0] * 190 + 6, c0[1] + nrm[1] * 190),
        ),
        (
            arrow(c0, (c0[0] - d[0] * 120 - nrm[0] * 6, c0[1] - d[1] * 120 - nrm[1] * 6)),
            "f",
            (c0[0] - d[0] * 150 - 30, c0[1] - d[1] * 150 - 6),
        ),
    ]
    extra: list[str] = []
    for paths, label, (lx, ly) in forces:
        extra += await c.agent.neat(paths, 2400, lift=0.02)
        extra += await c.agent.neat(lay(label, lx, ly, 2.6, NEAT)[0], 2600, lift=0.02)
    arc = ellipse(right[0], right[1], 150, 150, 180, math.degrees(th), 20)
    await c.agent.neat([arc], 1600)
    await c.agent.neat(lay("θ", right[0] - 230, right[1] - 34, 2.6, NEAT)[0], 1600)
    await c.agent.neat(lay("a = 5/7 g sin θ", 660, 960, 3.0, NEAT)[0], 3200, lift=0.02)
    await c.agent.neat(lay("(rolling, no slip)", 660, 1040, 2.1, NEAT)[0], 3400, lift=0.02)
    await c.s.sleep(0.3)
    await c.agent.delete(extra)
    c.speed(1)
    c.caption(
        "then it rolls: each frame drawn anew and the last one deleted (lens ~3 fps, phone smooth)"
    )
    t_slope = 2.0
    acc = 2 * (L - s0) / t_slope**2
    v_end = acc * t_slope
    floor_c = (right[0] + r * math.tan(th / 2), right[1] - r)
    roll_len = ground_end - 70 - floor_c[0]
    t_floor = 2 * roll_len / v_end  # decelerates evenly to a stop
    total = t_slope + t_floor

    def frame(u: float) -> list[Path_]:
        t = u * total
        if t <= t_slope:
            s = s0 + 0.5 * acc * t * t
            cx, cy = on_slope(s)
            dist = s - s0
        else:
            tt = t - t_slope
            x = v_end * tt - 0.5 * (v_end / t_floor) * tt * tt
            k = min(1.0, tt / 0.15)  # round the corner over the first few frames
            sx, sy = on_slope(L)
            cx = sx + (floor_c[0] + x - sx) * k if k < 1 else floor_c[0] + x
            cy = sy + (floor_c[1] - sy) * k
            dist = (L - s0) + x
        return ball_at(cx, cy, dist / r)

    await ball.play(frame, total, 15)
    await c.s.sleep(0.5)


async def scene_chemistry(c: Show):
    """5. Water, sketched roughly, cleaned up into a labelled ball-and-stick model."""
    c.scene(5, "Chemistry", "a water molecule, sketched and cleaned up")
    c.caption("H₂O, sketched by hand")
    c.speed(2)
    rng = c.rng
    await c.me.hand(lay("H₂O", 200, 800, 5.6, rng=rng, slant=0.1)[0], 1500, rng)
    o = (810.0, 1000.0)
    half = math.radians(104.5 / 2)
    bond = 290.0
    hs = [
        (o[0] - bond * math.sin(half), o[1] + bond * math.cos(half)),
        (o[0] + bond * math.sin(half), o[1] + bond * math.cos(half)),
    ]
    rough: list[str] = []
    rough += await c.me.hand(
        [ellipse(o[0] + 6, o[1] - 4, 92, 84, -95, 370, 36)], 1800, rng, wobble=9
    )
    rough += await c.me.hand(lay("O", o[0] - 26, o[1] + 26, 3.2, rng=rng)[0], 1400, rng)
    for h in hs:
        rough += await c.me.hand(
            [
                line(
                    (o[0] + (h[0] - o[0]) * 0.33, o[1] + (h[1] - o[1]) * 0.33 + 6),
                    (h[0] + (o[0] - h[0]) * 0.2, h[1] + (o[1] - h[1]) * 0.2 - 4),
                )
            ],
            2400,
            rng,
            wobble=6,
        )
        rough += await c.me.hand(
            [ellipse(h[0] + 4, h[1], 52, 48, -90, 370, 28)], 1800, rng, wobble=6
        )
        rough += await c.me.hand(lay("H", h[0] - 18, h[1] + 22, 2.6, rng=rng)[0], 1400, rng)
    c.look("wide")
    c.tag("simulated agent")
    c.caption(
        "the agent redraws it as a model: bonds, lone pairs, the 104.5° angle, partial charges"
    )
    ro, rh = 96.0, 56.0
    clean = [ellipse(*o, ro, ro, -90, 360, 56)]
    for h in hs:
        clean.append(ellipse(*h, rh, rh, -90, 360, 40))
        ux, uy = (h[0] - o[0]) / bond, (h[1] - o[1]) / bond
        clean.append(line((o[0] + ux * ro, o[1] + uy * ro), (h[0] - ux * rh, h[1] - uy * rh), 10))
    await c.agent.neat(clean, 3200, lift=0.02)
    await c.me.delete(rough)
    labels = [
        ("O", o[0] - 20, o[1] + 20, 3.2),
        ("H", hs[0][0] - 16, hs[0][1] + 16, 2.6),
        ("H", hs[1][0] - 16, hs[1][1] + 16, 2.6),
    ]
    for text, lx, ly, u in labels:
        await c.agent.neat(lay(text, lx, ly, u, NEAT)[0], 2600, lift=0.02)
    pairs = []
    for ang in (-130, -50):
        a = math.radians(ang)
        cx, cy = o[0] + math.cos(a) * (ro + 26), o[1] + math.sin(a) * (ro + 26)
        tx, ty = -math.sin(a) * 13, math.cos(a) * 13
        for k in (-1, 1):
            px, py = cx + k * tx, cy + k * ty
            pairs.append(ellipse(px, py, 7, 7, 0, 740, 16))
    await c.agent.neat(pairs, 1400, lift=0.01)
    await c.agent.neat(
        [ellipse(*o, 175, 175, 90 - math.degrees(half), 2 * math.degrees(half), 24)], 1800
    )
    await c.agent.neat(lay("104.5°", o[0] - 92, o[1] + 285, 2.6, NEAT)[0], 3200, lift=0.02)
    await c.agent.neat(lay("δ−", o[0] + 110, o[1] - 100, 2.6, NEAT)[0], 2400, lift=0.02)
    for h, side in zip(hs, (-1, 1), strict=True):
        await c.agent.neat(
            lay("δ+", h[0] + side * 80 - (60 if side < 0 else 0), h[1] + 100, 2.6, NEAT)[0],
            2400,
            lift=0.02,
        )
    mid = ((o[0] + hs[1][0]) / 2 + 60, (o[1] + hs[1][1]) / 2 - 20)
    await c.agent.neat(lay("96 pm", mid[0], mid[1], 2.2, NEAT)[0], 3200, lift=0.02)
    await c.s.sleep(1.8)


async def scene_music(c: Show):
    """6. A staff and the first bar of Ode to Joy; a bouncing ball hops along the notes in time."""
    c.scene(6, "Music", "a melody, and a ball that keeps the beat")
    c.caption("a staff and the first notes of Ode to Joy, by hand")
    c.speed(2)
    rng = c.rng
    x0, x1, top, gap = 170.0, 1470.0, 980.0, 52.0
    staff = [
        [(x0, top + i * gap + rng.gauss(0, 2)), (x1, top + i * gap + rng.gauss(0, 2))]
        for i in range(5)
    ]
    await c.me.hand(staff, 4200, rng, wobble=2.5, lift=0.06)
    bottom = top + 4 * gap
    # a treble clef, as one pen-down: out of the curl round the G line, up to the top loop, down
    # the stem to the hook below the staff (staff gaps from the curl's centre)
    gx, gy = 262.0, bottom - gap
    clef_g = [
        (0.15, 0.0),
        (0.35, -0.3),
        (0.1, -0.55),
        (-0.35, -0.4),
        (-0.45, 0.1),
        (-0.1, 0.55),
        (0.45, 0.5),
        (0.75, 0.0),
        (0.6, -0.65),
        (0.0, -1.3),
        (-0.5, -2.1),
        (-0.4, -2.9),
        (0.0, -3.25),
        (0.25, -2.8),
        (0.1, -2.1),
        (-0.15, -1.0),
        (0.0, 0.5),
        (0.2, 1.8),
        (0.05, 2.3),
        (-0.35, 2.25),
        (-0.4, 1.9),
    ]
    clef = [(gx + u * gap, gy + v * gap) for u, v in clef_g]
    await c.me.hand([clef], 2600, rng, wobble=1.0)
    # E E F G | G F E D: E4 on the bottom line, F4 the space above, G4 the next line, D4 below
    pitch = {"E": bottom, "F": bottom - gap / 2, "G": bottom - gap, "D": bottom + gap / 2}
    melody = "EEFGGFED"
    xs = [430, 550, 670, 790, 960, 1080, 1200, 1320]
    heads: list[Pt] = []
    for i, (n, x) in enumerate(zip(melody, xs, strict=True)):
        y = pitch[n]
        heads.append((x, y))
        await c.me.hand([blob_fill(x, y, 28, 20, turns=3.4)], 3200, rng, wobble=0.5, lift=0.03)
        await c.me.hand([[(x + 26, y - 6), (x + 26, y - 150)]], 3000, rng, wobble=0.8, lift=0.03)
        if i == 3:
            await c.me.hand([[(880, top), (880, bottom)]], 2600, rng, wobble=0.6, lift=0.03)
    await c.me.hand(
        [[(1420, top), (1420, bottom)], [(1440, top), (1440, bottom)]],
        2600,
        rng,
        wobble=0.6,
        lift=0.03,
    )
    c.look("wide")
    c.speed(1)
    c.tag("simulated agent")
    c.caption("a ball hops on the beat, note to note (lens ~3 fps, phone smooth)")
    ball = Sprite(c.agent)
    r = 30.0
    beat = 0.42
    landings = [(x, y - 20 - r) for x, y in heads]
    start = (330.0, top - 40.0)
    pts = [start, *landings, (1495.0, top + 20)]

    def frame(u: float) -> list[Path_]:
        t = u * (len(pts) - 1)
        i = min(int(t), len(pts) - 2)
        f = t - i
        (ax, ay), (bx, by) = pts[i], pts[i + 1]
        apex = min(ay, by) - 120
        x = ax + (bx - ax) * f
        # a parabola through (0, ay), (1, by) peaking near apex
        y = (1 - f) ** 2 * ay + 2 * f * (1 - f) * (2 * apex - (ay + by) / 2) + f * f * by
        squash = 0.9 if f < 0.08 and i > 0 else (-0.35 if 0.2 < f < 0.8 else 0.0)
        return ball_char(x, y, r, squash, 1.0)

    c.still("music", beat * 2.5)
    await ball.play(frame, beat * (len(pts) - 1), 20)
    await c.s.sleep(0.5)


async def scene_flow(c: Show):
    """7. A flowchart sketched in boxes; the agent tidies the arrows; a figure walks the flow."""
    c.scene(7, "Diagram", "a flowchart, tidied and walked through")
    c.caption("a flowchart sketched in boxes")
    c.speed(2.5)
    rng = c.rng
    y = 980.0
    nodes = [
        ("idea", 270.0, "box"),
        ("sketch", 640.0, "box"),
        ("good?", 1010.0, "diamond"),
        ("ship!", 1370.0, "box"),
    ]
    bw, bh, dw, dh = 230.0, 120.0, 250.0, 180.0
    for label, x, kind in nodes:
        if kind == "box":
            await c.me.hand(
                [rect(x - bw / 2, y - bh / 2, x + bw / 2, y + bh / 2, 22)], 2600, rng, wobble=6
            )
        else:
            await c.me.hand(
                [polygon([(x, y - dh / 2), (x + dw / 2, y), (x, y + dh / 2), (x - dw / 2, y)])],
                2600,
                rng,
                wobble=6,
            )
        u = 2.6 if kind == "diamond" else 3.0
        await c.me.hand(
            lay(label, x - text_width(label, u) / 2, y + 16, u, rng=rng, slant=0.1)[0],
            1900,
            rng,
            lift=0.06,
        )
    rough: list[str] = []
    ends = [
        (270 + bw / 2, 640 - bw / 2),
        (640 + bw / 2, 1010 - dw / 2),
        (1010 + dw / 2, 1370 - bw / 2),
    ]
    for a, b in ends:
        head = polygon([(b - 30, y - 18), (b - 4, y + 4), (b - 32, y + 22)], close=False)
        rough += await c.me.hand(
            [[(a + 8, y + 10), ((a + b) / 2, y - 14), (b - 6, y + 4)], head],
            2800,
            rng,
            wobble=7,
            lift=0.05,
        )
    loop = [(1010, y - dh / 2 - 6), (900, y - 230), (720, y - 240), (650, y - bh / 2 - 8)]
    head = polygon(
        [(628, y - bh / 2 - 40), (650, y - bh / 2 - 8), (676, y - bh / 2 - 36)], close=False
    )
    rough += await c.me.hand([loop, head], 2800, rng, wobble=8, lift=0.05)
    rough += await c.me.hand(
        lay("no", 800, y - 262, 2.6, rng=rng)[0] + lay("yes", 1140, y - 46, 2.4, rng=rng)[0],
        1900,
        rng,
        lift=0.05,
    )
    c.look("wide")
    c.tag("simulated agent")
    c.caption("the agent tidies the arrows; the sketchy ones are deleted by their owner")
    clean: list[Path_] = []
    for a, b in ends:
        clean += arrow((a + 8, y), (b - 8, y), 24, 26)
    curve = bezier(
        (1010, y - dh / 2 - 8), (950, y - 300), (700, y - 300), (640, y - bh / 2 - 10), 40
    )
    clean += [curve, [(622, y - bh / 2 - 36), (640, y - bh / 2 - 10), (664, y - bh / 2 - 34)]]
    await c.agent.neat(clean, 3600, lift=0.02)
    await c.me.delete(rough)
    await c.agent.neat(
        lay("no", 810, y - 250, 2.4, NEAT)[0] + lay("yes", 1140, y - 40, 2.0, NEAT)[0],
        3200,
        lift=0.02,
    )
    floor = 1330.0
    await c.agent.neat([line((140, floor), (1500, floor), 30)], 4000)
    c.speed(1)
    c.caption("a figure walks the flow, box to box")
    walker = Sprite(c.agent)
    stops = [180.0, 270.0, 640.0, 1010.0, 1370.0]
    phase = 0.0
    for i in range(1, len(stops)):
        a, b = stops[i - 1], stops[i]
        dur = (b - a) / 520
        p0 = phase
        await walker.play(
            lambda u, a=a, b=b, p0=p0, dur=dur: figure(
                a + (b - a) * u, floor - 4, walk_pose(p0 + u * dur * 1.6), 0.85, 1
            ),
            dur,
            14,
        )
        phase = p0 + dur * 1.6
        look = (unit_vec(-80), unit_vec(110)) if i < 3 else (unit_vec(-110), unit_vec(-70))
        await walker.show(figure(b, floor - 4, (0, 4, 4, 4, 0, 0), 0.85, 1, arms=look))
        await c.s.sleep(0.25 if i < 4 else 0.5)
    await walker.play(
        lambda u: figure(
            1370,
            floor - 4,
            (8, 20, -8, 20, 0, 0),
            0.85,
            1,
            lift=abs(math.sin(u * 2 * math.pi)) * 60,
            arms=(unit_vec(-125), unit_vec(-55)),
        ),
        1.2,
        14,
    )
    await c.s.sleep(0.4)


async def scene_party(c: Show):
    """8. Everyone at once: three people draw while the agent's figure crosses the page."""
    c.scene(8, "Together", "three people and an agent, all at once")
    c.caption("you, Ana (red) and Ben (blue) draw at once; the agent's figure crosses the page")
    c.tag("scripted pens · simulated agent")
    c.speed(2)
    rng = c.rng
    ground = 1640.0

    async def me():
        await c.me.hand(lay("draw together", 360, 760, 5.0, rng=rng, slant=0.12)[0], 1300, rng)
        await c.s.sleep(0.4)
        await c.me.hand(lay("anywhere", 560, 930, 4.2, rng=rng, slant=0.12)[0], 1300, rng)

    async def ana():
        await c.s.sleep(0.6)
        sun = (1340.0, 1060.0)
        await c.ana.hand([ellipse(*sun, 70, 70, -90, 370, 36)], 1500, rng, wobble=3)
        for k in range(8):
            a = math.radians(k * 45 + 10)
            await c.ana.hand(
                [
                    line(
                        (sun[0] + math.cos(a) * 92, sun[1] + math.sin(a) * 92),
                        (sun[0] + math.cos(a) * 140, sun[1] + math.sin(a) * 140),
                        4,
                    )
                ],
                2200,
                rng,
                wobble=1,
                lift=0.05,
            )
        fx = 1150.0
        await c.ana.hand(
            [[(fx, ground), (fx - 10, ground - 120), (fx + 4, ground - 220)]], 1500, rng, wobble=3
        )
        for k in range(6):
            a = math.radians(k * 60)
            await c.ana.hand(
                [
                    ellipse(
                        fx + 4 + math.cos(a) * 34,
                        ground - 220 + math.sin(a) * 34,
                        26,
                        14,
                        0,
                        370,
                        18,
                        rot=k * 60,
                    )
                ],
                1600,
                rng,
                wobble=1,
                lift=0.04,
            )
        await c.ana.hand([heart(780, 1430, 3.2)], 1100, rng, wobble=2)

    async def ben():
        await c.s.sleep(1.0)
        hx, hw, hh = 250.0, 300.0, 230.0
        await c.ben.hand([rect(hx, ground - hh, hx + hw, ground, 14)], 2000, rng, wobble=4)
        await c.ben.hand(
            [
                polygon(
                    [
                        (hx - 30, ground - hh + 4),
                        (hx + hw / 2, ground - hh - 150),
                        (hx + hw + 30, ground - hh + 4),
                    ],
                    close=False,
                )
            ],
            1800,
            rng,
            wobble=4,
        )
        await c.ben.hand(
            [
                polygon(
                    [
                        (hx + 120, ground),
                        (hx + 120, ground - 110),
                        (hx + 180, ground - 110),
                        (hx + 180, ground),
                    ],
                    close=False,
                )
            ],
            1800,
            rng,
            wobble=3,
        )
        await c.ben.hand(
            [rect(hx + 200, ground - 190, hx + 260, ground - 140)], 1800, rng, wobble=2
        )
        cx, cy = 760.0, 1180.0
        cloud = [
            (cx - 120, cy + 30),
            (cx - 130, cy - 10),
            (cx - 80, cy - 50),
            (cx - 30, cy - 80),
            (cx + 40, cy - 70),
            (cx + 90, cy - 40),
            (cx + 130, cy - 10),
            (cx + 120, cy + 30),
            (cx - 120, cy + 30),
        ]
        await c.ben.hand([cloud], 1400, rng, wobble=6)

    wide_on = asyncio.Event()

    async def agent():
        await c.agent.neat([line((120, ground), (1500, ground), 40)], 3000)
        walker = Sprite(c.agent)
        await walker.play(
            lambda u: figure(150 + 1260 * u, ground - 4, walk_pose(u * 7.5), 0.8, 1), 8.0, 14
        )
        await walker.show(
            figure(1410, ground - 4, (0, 4, 4, 4, 0, 0), 0.8, 1, arms=(unit_vec(110), unit_vec(70)))
        )
        await wide_on.wait()  # stand still while the lens is in fit: its canvas waits for a lull
        await walker.play(
            lambda u: figure(
                1410,
                ground - 4,
                (0, 4, 4, 4, 0, 0),
                0.8,
                1,
                lift=abs(math.sin(u * 3 * math.pi)) * 40,
                arms=(unit_vec(110), unit_vec(-60 + 30 * math.sin(u * 8 * math.pi))),
            ),
            2.2,
            14,
        )

    async def lens():
        await c.s.sleep(4.5)
        c.caption("the lens follows your pen (its loupe, live); the phone shows everyone")
        await c.s.sleep(
            5.6
        )  # until everyone has stopped (the fit canvas is sent at a pause in the ink)
        c.speed(1)
        c.caption("glasses menu → View: follow / fit / wide → fit: the whole page in the canvas")
        await c.ring.cycle_view(c.s)
        await c.s.sleep(2.3)
        c.caption(
            "View again → wide fit: the page across the whole lens, the figure waving at ~3 fps"
        )
        await c.ring.cycle_view(c.s)
        c.mode = "wide"
        await c.s.sleep(0.5)
        wide_on.set()
        c.still("together", 1.2)

    await asyncio.gather(me(), ana(), ben(), agent(), lens())
    await c.settle()
    await c.s.sleep(1.2)
    if c.phone is not None:
        c.tag("scripted clicks · real menu")
        c.caption("and the phone joins in: a star drawn with the mouse…")
        await c.phone.doodle_and_undo(c.tl)  # type: ignore[attr-defined]
        c.caption("phone menu ••• → Export timelapse… → 10 s → Record (the app's own exporter)")
        await c.phone.export_timelapse(c.tl, menu_open=True)  # type: ignore[attr-defined]
    c.tl.mark("end")


def heart(cx: float, cy: float, size: float) -> Path_:
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


SCENES = [
    scene_proof,
    scene_integral,
    scene_recognize,
    scene_physics,
    scene_chemistry,
    scene_music,
    scene_flow,
    scene_party,
]


async def show(c: Show, only: list[int] | None = None):
    await c.s.open("tablet", "ana", "ben", "agent")
    try:
        c.tl.t0 = time.time()
        for i, sc in enumerate(SCENES, 1):
            if only and i not in only:
                continue
            await c.new_page()
            await sc(c)
            await c.settle()
            if c.s.dry:
                preview_page(c.s, PREVIEW_DIR / f"scene{i}.png")
        if not any(k == "end" for _, k, _ in c.tl.marks):
            c.tl.mark("end")
    finally:
        await c.s.close()


# =============================================================================================
# Preview: a scene's final page, rendered without a router, for layout work.
# =============================================================================================

PREVIEW_DIR = Path(".")


def preview_page(s: Session, out: Path):
    """The final page (ink in its colours) over every 5th animation frame (pale), cropped."""
    from PIL import Image, ImageDraw

    img = Image.new("RGB", (PAGE_W, PAGE_H), (246, 244, 238))
    d = ImageDraw.Draw(img)
    for paths in s.frames[::5]:
        for p in paths:
            d.line(p, fill=(214, 204, 236), width=2)
    for st in s.page.values():
        col = st["color"] or ("#1d1d1b" if st["layer"] == "user" else "#3a6ea5")
        pts = [(p[0] * PAGE_W, p[1] * PAGE_H) for p in st["pts"]]
        if len(pts) > 1:
            d.line(pts, fill=col, width=4, joint="curve")
    box = (
        Image.eval(img.convert("L"), lambda v: 255 - v)
        .point(lambda v: 255 if v > 12 else 0)
        .getbbox()
    )
    if box:
        img = img.crop(
            (
                max(0, box[0] - 40),
                max(0, box[1] - 40),
                min(PAGE_W, box[2] + 40),
                min(PAGE_H, box[3] + 40),
            )
        )
    img.thumbnail((1100, 1100))
    img.save(out)
    s.frames.clear()
    print("preview", out)


# =============================================================================================
# Recording: the simulator (glasses), a headless browser (the phone stage), screenshot grabbers.
# =============================================================================================


def clear_page(ws_url: str):
    """New drawing for the session, so the router replays nothing to the fresh app."""
    import websockets

    async def go():
        async with websockets.connect(ws_url) as ws:
            await ws.recv()
            await ws.send(json.dumps({"t": "clear", "ts": int(time.time() * 1000)}))
            await asyncio.sleep(0.3)

    asyncio.run(go())


def _simulator_cmd() -> list[str]:
    """
    The simulator's command line. On Windows the npm shim is a .cmd/.ps1, and cmd.exe would cut
    the app URL at its first `&`, so the shim's own target (node + bin/index.js) is run directly.
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
    """
    The glasses: the app in the simulator, starting in follow with wide fit on (so the ring
    toggles follow ↔ wide fit, Show.look), the AI layer shown, and the canvas allowed to refresh
    every 300 ms (`canvas_ms`; the default 1200 suits handwriting, not animation, and an image
    costs ~200 ms on the glasses anyway).
    """
    url = (
        f"{app}/?ws={ws_url}&mode=follow&wide=1&ai=1&highlight=all"
        "&stage=page&theme=paper&view=canvas&canvas_ms=300"
    )
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
    # the status strip counts as "typing" for 15 s after load (hud/render.ts); let it settle
    time.sleep(16)
    return proc


def stop(proc: subprocess.Popen):
    if os.name == "nt":  # take the launcher's whole tree
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


PHONE_VIEW = {"width": 800, "height": 600}  # CSS px: a phone on its side, or a small browser window
PHONE_DPR = 1.55


class Phone:
    """
    The phone stage: the app in a headless Edge (or Chrome), a participant like any other, on the
    paper theme in the Fit view, with no loupe box. Frames come from the DevTools screencast, which
    sends one whenever the page repaints. It also plays the finale's timelapse export by clicking
    the app's own menu.
    """

    def __init__(self, app: str, ws_url: str, out: Path):
        # this phone draws in green (one of the participant palette's colours)
        self.url = f"{app}/?ws={ws_url}&stage=focus&theme=paper&ai=1&loupe=0&color=%23219653"
        self.out = out
        self.video: Path | None = None

    async def start(self):
        from playwright.async_api import async_playwright

        self.pw = await async_playwright().start()
        for channel in ("msedge", "chrome", None):
            try:
                # no scrollbars: they are the browser's, not the app's
                args = ["--hide-scrollbars"]
                self.browser = (
                    await self.pw.chromium.launch(channel=channel, headless=True, args=args)
                    if channel
                    else await self.pw.chromium.launch(headless=True, args=args)
                )
                break
            except Exception:  # noqa: BLE001 - try the next browser
                continue
        self.ctx = await self.browser.new_context(
            viewport=PHONE_VIEW, device_scale_factor=PHONE_DPR, accept_downloads=True
        )
        self.page = await self.ctx.new_page()
        await self.page.goto(self.url)
        await self.page.wait_for_selector("#menuBtn")
        await asyncio.sleep(2.5)
        self.cdp = await self.ctx.new_cdp_session(self.page)
        self.cdp.on("Page.screencastFrame", self._frame)
        w, h = round(PHONE_VIEW["width"] * PHONE_DPR), round(PHONE_VIEW["height"] * PHONE_DPR)
        await self.cdp.send(
            "Page.startScreencast",
            {"format": "jpeg", "quality": 92, "maxWidth": w, "maxHeight": h, "everyNthFrame": 1},
        )

    def _frame(self, p: dict):
        import base64

        (self.out / f"p_{time.time():.3f}.jpg").write_bytes(base64.b64decode(p["data"]))
        asyncio.ensure_future(
            self.cdp.send("Page.screencastFrameAck", {"sessionId": p["sessionId"]})
        )

    async def doodle_and_undo(self, tl: Timeline):
        """
        This phone draws a star with the mouse (the pen button, then a drag on the stage), and
        takes it back with ⋯ → Undo my last stroke: a `stroke_delete` to everyone. The menu stays
        open for the export that follows.
        """
        pg = self.page
        await pg.click("#drawBtn")
        await asyncio.sleep(0.3)
        cx, cy, r = 250.0, 215.0, 38.0
        star = [
            (
                cx + r * (1 if k % 2 == 0 else 0.42) * math.sin(math.pi * k / 5),
                cy - r * (1 if k % 2 == 0 else 0.42) * math.cos(math.pi * k / 5),
            )
            for k in range(11)
        ]
        await pg.mouse.move(*star[0])
        await pg.mouse.down()
        for p in star[1:]:
            await pg.mouse.move(*p, steps=6)
        await pg.mouse.up()
        await pg.click("#drawBtn")  # pen off again
        await asyncio.sleep(0.9)
        tl.mark(
            "caption",
            "the phone takes its star back: ••• → Undo my last stroke (a stroke_delete for all)",
        )
        await pg.click("#menuBtn")
        await asyncio.sleep(0.9)
        await pg.click('[data-act="undo"]')
        await asyncio.sleep(1.1)

    async def export_timelapse(self, tl: Timeline, menu_open: bool = False):
        """⋯ → Export timelapse… → 10 s → Record, then keep the file the app saves."""
        pg = self.page
        if not menu_open:
            await pg.click("#menuBtn")
            await asyncio.sleep(0.7)
        await pg.click('[data-act="tl"]')
        await asyncio.sleep(0.7)
        await pg.click('[data-len="10"]')
        await asyncio.sleep(0.5)
        async with pg.expect_download(timeout=60_000) as dl:
            await pg.click('[data-act="tl-go"]')
            tl.mark("recording")
            await asyncio.sleep(1.8)
            tl.mark("skip")  # the compositor cuts the rest of the real-time recording
        d = await dl.value
        self.video = self.out.parent / ("timelapse" + Path(d.suggested_filename).suffix)
        await d.save_as(str(self.video))
        tl.mark("unskip")
        tl.mark("timelapse", str(self.video))
        await asyncio.sleep(0.5)

    async def stop(self):
        try:
            await self.cdp.send("Page.stopScreencast")
        except Exception:  # noqa: BLE001
            pass
        await self.browser.close()
        await self.pw.stop()


# =============================================================================================
# Compositing: the lens (1:1, in a dark bezel) and the phone side by side on paper, a header
# with the scene and its honesty tag, a caption, title cards between scenes; then MP4 and GIF.
# =============================================================================================

W, H = 1280, 640
PAPER = (241, 237, 228)
INK = (38, 36, 33)
MUTED = (128, 122, 112)
RULE = (222, 216, 204)
LENS_GREEN = (64, 255, 120)
VIOLET = (0x7B, 0x3F, 0xD6)


def _fonts() -> dict:
    from PIL import ImageFont

    def f(names: tuple[str, ...], size: int):
        for n in names:
            try:
                return ImageFont.truetype(n, size)
            except OSError:
                pass
        return ImageFont.load_default()

    regular = ("segoeui.ttf", "Inter-Regular.ttf", "DejaVuSans.ttf")
    semibold = ("seguisb.ttf", "Inter-SemiBold.ttf", "DejaVuSans-Bold.ttf")
    return {
        "label": f(semibold, 13),
        "caption": f(regular, 21),
        "badge": f(semibold, 15),
        "tag": f(semibold, 13),
        "foot": f(regular, 14),
        "sub": f(regular, 23),
        "big": f(semibold, 50),
        "url": f(semibold, 38),
        "small": f(regular, 18),
    }


def logo(size: int):
    """logo.svg drawn with Pillow at 1024 px (tile, stroke, dot, faint plus), then reduced."""
    from PIL import Image, ImageDraw

    s = 1024
    ramp = Image.linear_gradient("L").resize((s, s))
    diag = Image.blend(ramp, ramp.rotate(90), 0.5)
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
    curve = bezier((750, 300), (600, 150), (300, 150), (250, 450), 60) + bezier(
        (250, 450), (200, 750), (550, 850), (750, 700), 60
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
    """Lays out one frame: the lens 1:1 in a lens-shaped bezel, the phone in a minimal frame."""

    def __init__(self):
        from PIL import Image, ImageDraw

        self.Image, self.Draw = Image, ImageDraw
        self.f = _fonts()
        self.logo_big, self.logo_small = logo(96), logo(48)
        self.pw, self.ph = 600, 450  # the 800 x 600 browser at 0.75 CSS px
        self.phone_xy = (W - 16 - (self.pw + 18), 62)
        self.pad, self.radius = 16, 26
        self.lens_mask = Image.new("L", (576, 288), 0)
        ImageDraw.Draw(self.lens_mask).rounded_rectangle(
            (0, 0, 575, 287), radius=self.radius, fill=255
        )
        self.lens_xy = (16, 62 + (self.ph + 18 - (288 + 2 * self.pad)) // 2)

    def lens(self, png: bytes):
        """The simulator keeps the lens image in the alpha channel; light it green on black."""
        Image = self.Image
        alpha = Image.open(io.BytesIO(png)).convert("RGBA").getchannel("A")
        return Image.composite(
            Image.new("RGB", alpha.size, LENS_GREEN), Image.new("RGB", alpha.size, (0, 0, 0)), alpha
        )

    def phone(self, data: bytes):
        return (
            self.Image.open(io.BytesIO(data))
            .convert("RGB")
            .resize((self.pw, self.ph), self.Image.Resampling.LANCZOS)
        )

    def frame(
        self,
        lens,
        phone,
        caption: str,
        scene: str,
        tag: str,
        phone_label: str = "PHONE STAGE · THE APP IN A BROWSER",
        speed: float = 1.0,
    ):
        f = self.Image.new("RGB", (W, H), PAPER)
        d = self.Draw.Draw(f)
        # header: the scene's badge and title (and the playback speed when not real time), the
        # honesty tag on the right
        x = 16
        if scene:
            num, name, sub = scene.split("|")
            badge = f"{num}  {name.upper()}"
            tw = int(d.textlength(badge, font=self.f["badge"]))
            d.rounded_rectangle((x, 16, x + tw + 24, 44), radius=14, fill=INK)
            d.text((x + 12, 30), badge, font=self.f["badge"], fill=PAPER, anchor="lm")
            d.text((x + tw + 38, 30), sub, font=self.f["small"], fill=MUTED, anchor="lm")
            if speed != 1.0:
                sx = x + tw + 38 + int(d.textlength(sub, font=self.f["small"])) + 14
                label = f"{speed:g}× SPEED"
                lw_ = int(d.textlength(label, font=self.f["tag"]))
                d.rounded_rectangle((sx, 18, sx + lw_ + 20, 42), radius=12, fill=RULE)
                d.text((sx + 10, 30), label, font=self.f["tag"], fill=INK, anchor="lm")
        if tag:
            tw = int(d.textlength(tag.upper(), font=self.f["tag"]))
            x1 = W - 16
            d.rounded_rectangle(
                (x1 - tw - 40, 17, x1, 43), radius=13, outline=VIOLET, width=2, fill=PAPER
            )
            d.ellipse((x1 - tw - 28, 26, x1 - tw - 20, 34), fill=VIOLET)
            d.text((x1 - 12, 30), tag.upper(), font=self.f["tag"], fill=VIOLET, anchor="rm")
        # the lens
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
        d.text(
            (lx + lw // 2, ly + lh + 14),
            "EVEN G2 GLASSES · SIMULATOR",
            font=self.f["label"],
            fill=MUTED,
            anchor="mt",
        )
        # the phone
        px, py = self.phone_xy
        d.rounded_rectangle(
            (px, py, px + self.pw + 17, py + self.ph + 17), radius=22, fill=(28, 28, 30)
        )
        f.paste(phone, (px + 9, py + 9))
        d.text(
            (px + 9 + self.pw // 2, py + self.ph + 28),
            phone_label,
            font=self.f["label"],
            fill=MUTED,
            anchor="mt",
        )
        # caption and footer
        cy = 574
        d.line((16, cy - 18, W - 16, cy - 18), fill=RULE)
        if caption:
            d.text((16, cy + 4), caption, font=self.f["caption"], fill=INK, anchor="lm")
        d.text(
            (16, H - 22),
            "simulated: scripted pens and agent · real app, real router, real protocol",
            font=self.f["foot"],
            fill=MUTED,
            anchor="lm",
        )
        d.text((W - 16, H - 22), "codrawer", font=self.f["foot"], fill=MUTED, anchor="rm")
        return f

    def card(self, title: str, sub: str, number: str = "", url: bool = False, note: str = ""):
        f = self.Image.new("RGB", (W, H), PAPER)
        d = self.Draw.Draw(f)
        if number:
            f.paste(self.logo_small, (W // 2 - 24, 176), self.logo_small)
            d.text((W // 2, 290), f"{number} · {title}", font=self.f["big"], fill=INK, anchor="mm")
            d.text((W // 2, 348), sub, font=self.f["sub"], fill=MUTED, anchor="mm")
        else:
            f.paste(self.logo_big, (W // 2 - 48, 140), self.logo_big)
            d.text(
                (W // 2, 300), title, font=self.f["url" if url else "big"], fill=INK, anchor="mm"
            )
            d.text((W // 2, 356), sub, font=self.f["sub"], fill=MUTED, anchor="mm")
        if note:
            tw = int(d.textlength(note.upper(), font=self.f["tag"]))
            d.rounded_rectangle(
                (W // 2 - tw // 2 - 20, 410, W // 2 + tw // 2 + 20, 438),
                radius=14,
                outline=VIOLET,
                width=2,
            )
            d.text((W // 2, 424), note.upper(), font=self.f["tag"], fill=VIOLET, anchor="mm")
        return f


def _palette(frames: Path, out: Path):
    """
    The GIF's one 256-colour palette, as a 16 x 16 swatch: sampled frames plus gradients from paper
    to each ink and from black to lens green, so thin coloured strokes do not turn muddy.
    """
    from PIL import Image, ImageDraw

    picks = sorted(frames.glob("f*.png"))[::20]
    tiles = [Image.open(p).convert("RGB").reduce(2) for p in picks]
    tw, th = tiles[0].size
    inks = [
        (PAPER, (0xD6, 0x48, 0x2A)),
        (PAPER, (0x2A, 0x6F, 0xD6)),
        (PAPER, INK),
        (PAPER, VIOLET),
        ((0, 0, 0), LENS_GREEN),
        ((246, 244, 238), (0x1D, 0x1D, 0x1B)),
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
            k = x / (tw - 1)
            d.line(
                (x, y0, x, y0 + band - 1),
                fill=tuple(int(a[i] + (b[i] - a[i]) * k) for i in range(3)),
            )
    q = sample.quantize(colors=256, method=Image.Quantize.MEDIANCUT)
    flat = (q.getpalette() or [])[: 256 * 3]
    flat += [0] * (256 * 3 - len(flat))
    swatch = Image.new("RGB", (16, 16))
    swatch.putdata([(flat[3 * i], flat[3 * i + 1], flat[3 * i + 2]) for i in range(256)])
    swatch.save(out)


def _video_frames(video: Path, out: Path, fps: int) -> list[Path]:
    """Decode the app's exported timelapse into PNG frames at `fps` (ffmpeg)."""
    out.mkdir(exist_ok=True)
    subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-loglevel",
            "error",
            "-i",
            str(video),
            "-vf",
            f"fps={fps}",
            str(out / "v%04d.png"),
        ],
        check=True,
    )
    return sorted(out.glob("v*.png"))


def compose(
    work: Path,
    mp4: str | None,
    gif: str | None,
    stills: str | None,
    fps: int = 20,
    gif_fps: int = 10,
    gif_width: int = 960,
):
    """Turn a take's screenshots and timeline into frames, then the MP4, the GIF and the stills."""
    from PIL import Image

    tl = json.loads((work / "timeline.json").read_text())
    t0, marks = tl["t0"], tl["marks"]

    def shots(prefix: str, ext: str) -> list[tuple[float, Path]]:
        return sorted(
            (float(p.stem.split("_", 1)[1]), p) for p in (work / "shots").glob(f"{prefix}_*.{ext}")
        )

    gl, ph = shots("g", "png"), shots("p", "jpg")
    c = Composer()
    frames = work / "frames"
    shutil.rmtree(frames, ignore_errors=True)
    frames.mkdir()
    n = 0
    still_at: dict[str, int] = {}

    def emit(img, seconds: float = 0.0, count: int = 1):
        nonlocal n
        for _ in range(max(count, int(round(seconds * fps)))):
            img.save(frames / f"f{n:05d}.png")
            n += 1

    def fade(a, b, k: int = 6):
        for i in range(1, k + 1):
            emit(Image.blend(a, b, _smooth(i / (k + 1))))

    def latest(seq: list[tuple[float, Path]], wall: float) -> Path:
        lo, hi = 0, len(seq) - 1
        best = seq[0][1]
        while lo <= hi:
            mid = (lo + hi) // 2
            if seq[mid][0] <= wall:
                best = seq[mid][1]
                lo = mid + 1
            else:
                hi = mid - 1
        return best

    cache: dict[Path, object] = {}

    def load(p: Path, kind: str):
        if p not in cache:
            if len(cache) > 400:
                cache.clear()
            cache[p] = c.lens(p.read_bytes()) if kind == "g" else c.phone(p.read_bytes())
        return cache[p]

    scenes = [(t, txt) for t, k, txt in marks if k == "scene"]
    end = next(t for t, k, _ in marks if k == "end")
    # cuts: stretches of real time left out (the rest of the timelapse's real-time recording)
    cut_from = [t for t, k, _ in marks if k == "skip"]
    cut_to = [t for t, k, _ in marks if k == "unskip"]
    cuts = list(zip(cut_from, cut_to, strict=False))
    stills_wanted = [(t, txt) for t, k, txt in marks if k == "still"]
    tl_video = next((txt for _, k, txt in marks if k == "timelapse"), None)
    intro = c.card(
        "codrawer showcase",
        "eight scenes: math, recognition, physics, chemistry, music, diagrams, play",
        note="simulated: scripted pens and agent, real app",
    )
    outro = c.card(
        "github.com/Caerii/codrawer-bridge",
        "stroke-native co-drawing for tablet, glasses, phone and agents",
        url=True,
        note="scripted simulation · stroke_delete powers the animation",
    )
    emit(intro, 2.5)
    last = intro
    for i, (start, sc) in enumerate(scenes):
        stop_t = scenes[i + 1][0] if i + 1 < len(scenes) else end
        # a scene ends where the next one's new page was asked for, before its ink is wiped
        # (timelines without "page" marks: 0.3 s before the next scene, the clear's length)
        wipes = [t for t, k, _ in marks if k == "page" and start < t <= stop_t]
        if i + 1 < len(scenes):
            stop_t = wipes[-1] if wipes else stop_t - 0.3
        num, name, sub = sc.split("|")
        card = c.card(name, sub, num)
        fade(last, card, 5)
        emit(card, 0.6)
        t = start
        first = True
        while t < stop_t:
            for a, b in cuts:
                if a <= t < b:
                    t = b
            caption, tag, speed = "", "", 1.0
            for mt, kind, txt in marks:
                if start <= mt <= t:
                    if kind == "caption":
                        caption = txt
                    elif kind == "tag":
                        tag = txt
                    elif kind == "speed":
                        speed = float(txt)
            img = c.frame(
                load(latest(gl, t0 + t), "g"),
                load(latest(ph, t0 + t), "p"),
                caption,
                sc,
                tag,
                speed=speed,
            )
            if first:
                fade(card, img, 5)
                first = False
            emit(img)
            last = img
            for st, label in stills_wanted:
                if label not in still_at and t >= st:
                    still_at[label] = n - 1
            t += speed / fps  # sped-up stretches advance real time faster, and say so
    # the timelapse as the app exported it, in the phone's place at 2.5x (decoded at 1/2.5 the rate)
    if tl_video and Path(tl_video).exists() and shutil.which("ffmpeg"):
        vframes = _video_frames(Path(tl_video), work / "tlframes", round(fps / 2.5))
        lens_now = load(latest(gl, t0 + end), "g")
        for vp in vframes:
            v = Image.open(vp).convert("RGB")
            vh = c.ph
            vw = round(v.width * vh / v.height)
            panel = Image.new("RGB", (c.pw, c.ph), (28, 28, 30))
            panel.paste(v.resize((vw, vh), Image.Resampling.LANCZOS), ((c.pw - vw) // 2, 0))
            img = c.frame(
                lens_now,
                panel,
                "the exported timelapse, as the app saved it (played at 2.5×)",
                scenes[-1][1],
                "",
                "THE APP'S EXPORTED TIMELAPSE VIDEO FILE",
            )
            emit(img)
            last = img
    emit(last, 0.6)
    fade(last, outro, 8)
    emit(outro, 2.2)
    print(f"{n} frames at {fps} fps ({n / fps:.1f} s)")
    ff = shutil.which("ffmpeg")
    src = ["-framerate", str(fps), "-i", str(frames / "f%05d.png")]
    if mp4 and ff:
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
                "16",
                "-pix_fmt",
                "yuv420p",
                "-movflags",
                "+faststart",
                mp4,
            ],
            check=True,
        )
        print(f"wrote {mp4}: {os.path.getsize(mp4) / 1e6:.2f} MB")
    if gif and ff:
        pal = work / "palette.png"
        _palette(frames, pal)
        gh = round(H * gif_width / W / 2) * 2
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
                f"fps={gif_fps},scale={gif_width}:{gh}:flags=lanczos[v];[v][1:v]paletteuse=dither=sierra2_4a:diff_mode=rectangle",
                "-loop",
                "0",
                gif,
            ],
            check=True,
        )
        print(f"wrote {gif}: {os.path.getsize(gif) / 1e6:.2f} MB")
    if stills:
        for label, idx in still_at.items():
            dst = Path(stills) / f"showcase-{label}.png"
            shutil.copy(frames / f"f{idx:05d}.png", dst)
            print("still", dst)


# =============================================================================================


async def run(a, work: Path) -> Timeline:
    tl = Timeline()
    dry = bool(a.preview)
    s = Session(a.ws, dry=dry)
    rng = random.Random(a.seed)
    sim = None if dry else f"http://127.0.0.1:{a.sim_port}"
    phone = None
    if not dry and a.record:
        phone = Phone(a.app, a.ws.replace("127.0.0.1", "localhost"), work / "shots")
        await phone.start()
    c = Show(
        s,
        Pen(s, "tablet", "user"),
        Pen(s, "ana", "peer", ANA_COLOR),
        Pen(s, "ben", "peer", BEN_COLOR),
        Pen(s, "agent", "ai", AGENT_COLOR),
        Ring(sim),
        tl,
        rng,
        phone,
    )
    try:
        await show(c, a.only)
    finally:
        if phone:
            await asyncio.sleep(0.5)
            await phone.stop()
    return tl


def main():
    global PREVIEW_DIR
    ap = argparse.ArgumentParser(description=(__doc__ or "").strip().splitlines()[0])
    ap.add_argument("--ws", default="ws://127.0.0.1:8580/ws/showcase")
    ap.add_argument("--app", default="http://localhost:5194", help="the glasses app's dev server")
    ap.add_argument("--sim-port", type=int, default=9902, help="simulator automation port")
    ap.add_argument(
        "--no-launch", action="store_true", help="use a simulator that is already running"
    )
    ap.add_argument("--mp4", help="write the recording as this MP4 (needs ffmpeg)")
    ap.add_argument("--gif", help="and/or this GIF (needs ffmpeg)")
    ap.add_argument("--stills", help="and three stills, showcase-*.png, in this directory")
    ap.add_argument("--fps", type=int, default=20)
    ap.add_argument("--work", help="keep screenshots and frames here (default: a temp dir)")
    ap.add_argument("--compose", metavar="WORK", help="only re-render a kept --work dir")
    ap.add_argument(
        "--preview", metavar="DIR", help="render each scene's final page here, no router"
    )
    ap.add_argument("--only", type=int, nargs="*", help="play only these scenes (1-8)")
    ap.add_argument("--seed", type=int, default=7, help="the hands' randomness")
    a = ap.parse_args()
    if a.compose:
        compose(Path(a.compose), a.mp4, a.gif, a.stills, a.fps)
        return
    if a.preview:
        PREVIEW_DIR = Path(a.preview)
        PREVIEW_DIR.mkdir(parents=True, exist_ok=True)
        a.record = False
        asyncio.run(run(a, PREVIEW_DIR))
        return
    if a.ws.rstrip("/").endswith("/session1"):
        raise SystemExit("refusing session1: that is the real tablet's page")
    a.record = bool(a.gif or a.mp4 or a.stills)
    work = Path(a.work or tempfile.mkdtemp(prefix="codrawer-showcase-"))
    (work / "shots").mkdir(parents=True, exist_ok=True)
    for old in (work / "shots").iterdir():
        old.unlink()
    sim = f"http://127.0.0.1:{a.sim_port}"
    clear_page(a.ws)
    proc = (
        None
        if a.no_launch
        else launch_simulator(a.app, a.ws.replace("127.0.0.1", "localhost"), a.sim_port)
    )
    grabber = Grabber(f"{sim}/api/screenshot/glasses", work / "shots", "g") if a.record else None
    try:
        if grabber:
            grabber.start()
        tl = asyncio.run(run(a, work))
    finally:
        if grabber:
            grabber.stopped = True
            grabber.join()
        if proc:
            stop(proc)
    (work / "timeline.json").write_text(json.dumps({"t0": tl.t0, "marks": tl.marks}, indent=1))
    if a.record:
        compose(work, a.mp4, a.gif, a.stills, a.fps)
        print(f"screenshots and frames kept in {work}")


if __name__ == "__main__":
    main()
