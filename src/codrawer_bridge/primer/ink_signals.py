"""
Ink signals: what the timing and shape of the strokes say beyond the words they spell.

**The problem.** A transcription says *what* the learner wrote. The pen says *how*: a long pause
before step 4, a line written at half the learner's usual speed, a claim erased and rewritten
twice, a line struck through. The Primer uses these as evidence in two places: the learner model
(a correct step written after long hesitation is weaker evidence of mastery than a fluent one,
learner.py) and the policy (the Primer does not speak while the learner is mid-thought, and
offers help where the pen hesitated, policy.py). The vision site puts it as "stroke timing and
pauses as signal"; writing research has long read pauses as planning and difficulty (Alamargot,
Chesnet, Dansac & Ros 2006, "Eye and pen", *Written Language & Literacy* 9(2); Wengelin 2006 on
pause analysis), and pen interfaces as a window on cognitive load (Oviatt 2006, "Human-centered
design meets cognitive load theory", ACM Multimedia). The thresholds below are starting values to
be calibrated per learner, not results from that literature.

**Facts it rests on** (docs/protocol.md). Strokes arrive as ``stroke_begin`` (id, layer, brush,
``ts`` in ms), ``stroke_pts`` with points ``[x, y, p, t]`` (normalized page coordinates, pressure
0..1, ms on the sender's clock) and ``stroke_end``. The tablet's eraser end arrives as a stroke
with ``brush: "eraser"`` whose path cuts earlier user ink; ``stroke_delete`` takes strokes back;
``clear`` empties the page; a ``page`` message replaces the page with the tablet's saved strokes,
which carry no timestamps (so they segment into lines but give no timing evidence).

**How data flows.**

    protocol messages ──InkLog.observe──▶ strokes (with timing) ──segment_lines──▶ Line[]
                                                         └──line_features──▶ LineSignals[]
    arrival times ──LullDetector──▶ "mid-thought" or "lull" (when the Primer may speak)

Two clocks: features use the sender's timestamps (consistent within one pen's stream); the lull
detector uses the arrival clock of this process, because "has the learner stopped?" is a question
about now, and the tablet's clock is not ours.
"""

from __future__ import annotations

import math
import statistics
from dataclasses import dataclass, field

# =============================================================================================
# The stroke log
# =============================================================================================


@dataclass
class InkStroke:
    """
    One stroke as the Primer keeps it. ``pts`` are ``[x, y, p, t]`` (``t`` may be absent for
    strokes from a ``page`` snapshot). ``t0``/``t1`` are the begin and end times in sender ms
    (``None`` when unknown). ``deleted`` marks a stroke taken back (``stroke_delete``) or wholly
    cut by the eraser; ``order`` is arrival order.
    """

    id: str
    layer: str = "user"
    brush: str = "pen"
    pts: list[list[float]] = field(default_factory=list)
    t0: float | None = None
    t1: float | None = None
    order: int = 0
    deleted: bool = False
    ended: bool = False

    @property
    def is_eraser(self) -> bool:
        return self.brush == "eraser"

    def bbox(self) -> tuple[float, float, float, float]:
        xs = [p[0] for p in self.pts] or [0.0]
        ys = [p[1] for p in self.pts] or [0.0]
        return (min(xs), min(ys), max(xs), max(ys))

    def length(self) -> float:
        """Path length in page-width units (y scaled by the page's 4:3 aspect so units agree)."""
        total = 0.0
        for a, b in zip(self.pts, self.pts[1:], strict=False):
            total += math.hypot(b[0] - a[0], (b[1] - a[1]) * PAGE_H_OVER_W)
        return total

    def straightness(self) -> float:
        """Chord over path length, 0..1: 1 for a ruler-straight stroke."""
        if len(self.pts) < 2:
            return 0.0
        a, b = self.pts[0], self.pts[-1]
        chord = math.hypot(b[0] - a[0], (b[1] - a[1]) * PAGE_H_OVER_W)
        return chord / (self.length() or 1e-9)


#: The Paper Pro page is 1620 × 2160: one unit of normalized y is 4/3 of one unit of x.
PAGE_H_OVER_W = 2160 / 1620


class InkLog:
    """
    The page's strokes, built from protocol messages in arrival order.

    Only what the Primer needs: user ink (``layer`` ``user`` or ``peer``; the ``ai`` layer is
    the agent's and is ignored), eraser paths, deletions, and the arrival time of the latest pen
    or key activity (for the lull detector). ``observe`` returns True when the message changed
    the ink.
    """

    def __init__(self) -> None:
        self.strokes: dict[str, InkStroke] = {}
        self._order = 0
        self.last_activity_ms: float | None = None  # arrival clock
        self.pen_down: set[str] = set()
        self.ink_version = 0  # bumps on every change to user ink
        self._page_ids: set[str] = set()  # strokes that came from the latest `page` snapshot
        self.page_key = ""  # "<doc>/<page>" of the page on screen, from `page` messages

    def observe(self, msg: dict, arrival_ms: float | None = None) -> bool:
        t = msg.get("t")
        if t in ("stroke_begin", "stroke_pts", "stroke_end", "key") and arrival_ms is not None:
            self.last_activity_ms = arrival_ms
        if t == "stroke_begin":
            sid = msg.get("id")
            layer = msg.get("layer") or "user"
            if not isinstance(sid, str) or layer == "ai":
                return False
            self._order += 1
            ts = msg.get("ts")
            self.strokes[sid] = InkStroke(
                id=sid,
                layer=str(layer),
                brush=str(msg.get("brush") or "pen"),
                t0=float(ts) if isinstance(ts, (int, float)) else None,
                order=self._order,
            )
            self.pen_down.add(sid)
            self.ink_version += 1
            return True
        if t == "stroke_pts":
            s = self.strokes.get(str(msg.get("id")))
            if s is None or s.deleted:
                return False
            for p in msg.get("pts") or []:
                if isinstance(p, list) and len(p) >= 2:
                    s.pts.append([float(v) for v in p[:4]])
                    if len(p) >= 4 and s.t0 is None:
                        s.t0 = float(p[3])
            self.ink_version += 1
            return True
        if t == "stroke_end":
            s = self.strokes.get(str(msg.get("id")))
            if s is None:
                return False
            ts = msg.get("ts")
            last_t = s.pts[-1][3] if s.pts and len(s.pts[-1]) >= 4 else None
            s.t1 = float(ts) if isinstance(ts, (int, float)) else last_t
            s.ended = True
            self.pen_down.discard(s.id)
            if s.is_eraser:
                self._apply_eraser(s)
            self.ink_version += 1
            return True
        if t == "stroke_delete":
            changed = False
            for sid in msg.get("ids") or []:
                s = self.strokes.get(str(sid))
                if s is not None and not s.deleted:
                    s.deleted = True
                    changed = True
            if changed:
                self.ink_version += 1
            return changed
        if t == "clear":
            self.strokes.clear()
            self.pen_down.clear()
            self.ink_version += 1
            return True
        if t == "page":
            # The tablet's saved page replaces earlier snapshot strokes; live strokes stay, unless
            # this is a different page or document: then the view starts over, as clients do.
            # Ids are kept as the page gives them, so clients can highlight the same strokes.
            key = f"{msg.get('doc', '')}/{msg.get('page', '')}"
            if self.page_key and key != self.page_key:
                self.strokes.clear()
            self.page_key = key
            for sid in self._page_ids:
                self.strokes.pop(sid, None)
            self._page_ids = set()
            for i, st in enumerate(msg.get("strokes") or []):
                tool = str(st.get("tool") or "pen")
                if tool in ("eraser", "erase_area"):
                    continue
                self._order += 1
                pts = [
                    [float(v) for v in p[:3]]
                    for p in st.get("pts") or []
                    if isinstance(p, list) and len(p) >= 2
                ]
                sid = str(st.get("id", f"page_{i}"))
                self.strokes[sid] = InkStroke(
                    id=sid, brush=tool, pts=pts, order=self._order, ended=True
                )
                self._page_ids.add(sid)
            self.ink_version += 1
            return True
        return False

    def _apply_eraser(self, eraser: InkStroke, radius: float = 0.02) -> None:
        """
        Mark earlier user strokes the eraser passed over as erased. A coarse stand-in for the
        clients' exact cutting (apps/even-g2/src/erase.ts): a stroke counts as erased when most
        of its points lie within ``radius`` (page widths, ~32 px) of the eraser's path. Partial
        cuts are recorded as an erasure signal on the line but leave the stroke in place.
        """
        path = eraser.pts
        if not path:
            return
        for s in self.strokes.values():
            if s is eraser or s.is_eraser or s.deleted or s.order > eraser.order:
                continue
            near = 0
            for p in s.pts:
                if any(
                    math.hypot(p[0] - q[0], (p[1] - q[1]) * PAGE_H_OVER_W) < radius
                    for q in path[::2]
                ):
                    near += 1
            if s.pts and near / len(s.pts) > 0.6:
                s.deleted = True

    # ── Views ────────────────────────────────────────────────────────────────────────────────

    def ink(self) -> list[InkStroke]:
        """Live user ink (not erased, not deleted, not eraser paths), in arrival order."""
        return sorted(
            (s for s in self.strokes.values() if not s.deleted and not s.is_eraser and s.pts),
            key=lambda s: s.order,
        )

    def erasers(self) -> list[InkStroke]:
        return sorted(
            (s for s in self.strokes.values() if s.is_eraser and s.pts), key=lambda s: s.order
        )

    def removed(self) -> list[InkStroke]:
        """Strokes that were drawn and later taken back or erased."""
        return sorted(
            (s for s in self.strokes.values() if s.deleted and not s.is_eraser and s.pts),
            key=lambda s: s.order,
        )

    def as_render_strokes(self) -> list[dict]:
        """The live ink as server/rendering.py draws it: ``{"id", "brush", "pts": [[x,y,p]]}``."""
        return [
            {
                "id": s.id,
                "brush": s.brush,
                "pts": [p[:3] if len(p) >= 3 else [p[0], p[1], 0.6] for p in s.pts],
            }
            for s in self.ink()
        ]


# =============================================================================================
# Lines
# =============================================================================================


@dataclass
class Line:
    """
    A line of handwriting: the strokes whose vertical centres fall in one band, left to right.
    ``n`` is 1-based from the top. ``bbox`` is normalized ``[x0, y0, x1, y1]``.
    """

    n: int
    strokes: list[str]
    bbox: list[float]


def segment_lines(strokes: list[InkStroke], gap: float = 0.022) -> list[Line]:
    """
    Group strokes into lines by their vertical centres.

    Strokes are sorted by centre y; a stroke starts a new line when its centre is more than
    ``gap`` below the running mean centre of the current line (``gap`` in page heights: 0.022 is
    ~48 px on the Paper Pro, about a third of a comfortable 130–140 px line pitch, and more than
    the drift of a hand's baseline across one line). Tiny marks (dots, the bar of a √) join the
    line their centre falls in. Lines are numbered top to bottom.
    """
    items = []
    for s in strokes:
        x0, y0, x1, y1 = s.bbox()
        items.append(((y0 + y1) / 2, s, (x0, y0, x1, y1)))
    items.sort(key=lambda it: it[0])
    groups: list[list[tuple[float, InkStroke, tuple[float, float, float, float]]]] = []
    for it in items:
        if groups:
            cur = groups[-1]
            mean = sum(c[0] for c in cur) / len(cur)
            if it[0] - mean <= gap:
                cur.append(it)
                continue
        groups.append([it])
    lines = []
    for i, g in enumerate(groups, start=1):
        g.sort(key=lambda it: it[2][0])
        bb = [
            min(it[2][0] for it in g),
            min(it[2][1] for it in g),
            max(it[2][2] for it in g),
            max(it[2][3] for it in g),
        ]
        lines.append(Line(n=i, strokes=[it[1].id for it in g], bbox=[round(v, 5) for v in bb]))
    return lines


# =============================================================================================
# Per-line signals
# =============================================================================================


@dataclass
class LineSignals:
    """
    The pen's evidence for one line. Times in ms (sender clock), speeds in page widths per
    second. ``None`` where the strokes carry no timing (a ``page`` snapshot).

    - ``pause_before_ms``: from the end of the stroke written just before this line (in time) to
      the line's first stroke: thinking time before committing the step.
    - ``max_gap_ms``: the longest pause between strokes inside the line (a stall mid-step).
    - ``speed``: ink length over pen-down time; ``slowdown`` is the learner's median line speed
      on this page divided by this line's (2.0 = written at half the usual speed).
    - ``erasures``: eraser strokes that touched the line's box; ``removed``: strokes in the box
      that were deleted or erased; ``rewrites``: ink drawn in the box after an erasure there.
    - ``crossouts``: long, nearly straight strokes over other ink on the line (a strike-through).
    - ``hesitation``: 0..1 summary used by the learner model and the policy (see
      :func:`hesitation_score`).
    """

    line: int
    pause_before_ms: float | None = None
    max_gap_ms: float | None = None
    duration_ms: float | None = None
    speed: float | None = None
    slowdown: float | None = None
    erasures: int = 0
    removed: int = 0
    rewrites: int = 0
    crossouts: int = 0
    hesitation: float = 0.0


def _overlaps(
    a: list[float] | tuple[float, ...], b: list[float] | tuple[float, ...], pad: float = 0.0
) -> bool:
    return not (a[2] + pad < b[0] or b[2] + pad < a[0] or a[3] + pad < b[1] or b[3] + pad < a[1])


def _is_crossout(s: InkStroke, others: list[InkStroke]) -> bool:
    """
    A strike-through: at least 0.08 page widths long, chord/path ≥ 0.92, and crossing the boxes
    of two or more other strokes on the line. Underlines sit below the ink and fraction bars are
    usually short, but both can trip it: this is a heuristic and is reported as one.
    """
    if s.length() < 0.08 or s.straightness() < 0.92:
        return False
    bb = s.bbox()
    hits = sum(1 for o in others if o is not s and _overlaps(bb, o.bbox()))
    return hits >= 2


def line_features(log: InkLog, lines: list[Line]) -> list[LineSignals]:
    """Compute :class:`LineSignals` for each line from the log's timing, erasers and deletions."""
    by_id = log.strokes
    timed = sorted(
        (s for s in log.ink() if s.t0 is not None and s.t1 is not None), key=lambda s: s.t0 or 0.0
    )
    ends_before: dict[str, float] = {}
    prev_end: float | None = None
    for s in timed:
        if prev_end is not None:
            ends_before[s.id] = prev_end
        prev_end = max(prev_end or 0.0, s.t1 or 0.0)

    out: list[LineSignals] = []
    for ln in lines:
        strokes = [by_id[sid] for sid in ln.strokes if sid in by_id]
        sig = LineSignals(line=ln.n)
        ts = sorted(
            (s for s in strokes if s.t0 is not None and s.t1 is not None), key=lambda s: s.t0 or 0.0
        )
        if ts:
            first = ts[0]
            if first.id in ends_before:
                sig.pause_before_ms = max(0.0, (first.t0 or 0.0) - ends_before[first.id])
            gaps = [
                max(0.0, (b.t0 or 0.0) - (a.t1 or 0.0)) for a, b in zip(ts, ts[1:], strict=False)
            ]
            sig.max_gap_ms = max(gaps) if gaps else 0.0
            down = sum(max(1.0, (s.t1 or 0.0) - (s.t0 or 0.0)) for s in ts)
            sig.duration_ms = (ts[-1].t1 or 0.0) - (ts[0].t0 or 0.0)
            sig.speed = sum(s.length() for s in ts) / (down / 1000.0)
        # Erased ink is no longer part of any line, so erasures and removals are matched to the
        # line's horizontal band (its y-range across the page), not its current box.
        band = [0.0, ln.bbox[1], 1.0, ln.bbox[3]]
        erasers = [e for e in log.erasers() if _overlaps(e.bbox(), band, pad=0.005)]
        sig.erasures = len(erasers)
        sig.removed = sum(1 for r in log.removed() if _overlaps(r.bbox(), band, pad=0.0))
        if erasers:
            first_erase = min(e.order for e in erasers)
            sig.rewrites = sum(1 for s in strokes if s.order > first_erase)
            sig.rewrites = min(sig.rewrites, 1 + len(erasers)) if sig.rewrites else 0
        sig.crossouts = sum(1 for s in strokes if _is_crossout(s, strokes))
        out.append(sig)

    speeds = [s.speed for s in out if s.speed]
    pauses = [s.pause_before_ms for s in out if s.pause_before_ms is not None]
    med_speed = statistics.median(speeds) if speeds else None
    base_pause = sorted(pauses)[int(0.25 * (len(pauses) - 1))] if pauses else None
    for s in out:
        if s.speed and med_speed:
            s.slowdown = med_speed / s.speed
        s.hesitation = hesitation_score(s, base_pause)
    return out


def hesitation_score(sig: LineSignals, baseline_pause_ms: float | None) -> float:
    """
    One 0..1 number for "the pen hesitated here", a logistic of a weighted sum:

    - the pause before the line, relative to this writer's ordinary line break on the page
      (``baseline_pause_ms``, the lower quartile of the page's line pauses) and in absolute
      terms above 4 s, each counted per doubling (log₂), so 2× and 4× add equal steps;
    - a stall inside the line beyond 4 s;
    - writing at under 70 % of the page's median speed;
    - each erasure (1.1), rewrite (0.6) and crossing-out (1.0).

    Weights are hand-set starting values (ADR 010, "Ink signals"), to be fitted per learner once
    there is data. A fluent line scores about 0.1; 0.5 means "noticeably hesitant", above 0.8
    "struggled here".
    """
    z = -2.0
    if sig.pause_before_ms is not None:
        pause = max(sig.pause_before_ms, 1.0)
        if baseline_pause_ms:
            z += 0.7 * max(0.0, math.log2(pause / max(baseline_pause_ms, 1.0)))
        z += 0.9 * max(0.0, math.log2(pause / 4000.0))
    if sig.max_gap_ms is not None and sig.max_gap_ms > 4000:
        z += 0.7
    if sig.slowdown is not None and sig.slowdown > 1 / 0.7:
        z += 0.8 * min(2.0, sig.slowdown - 1 / 0.7 + 0.5)
    z += 1.1 * sig.erasures + 0.6 * sig.rewrites + 1.0 * sig.crossouts
    return round(1 / (1 + math.exp(-z)), 3)


# =============================================================================================
# The lull detector
# =============================================================================================


class LullDetector:
    """
    Decides whether the learner is mid-thought (the Primer stays silent) or has paused long
    enough that a response would not talk over them.

    The threshold adapts to the writer: three times the 90th percentile of their recent gaps
    between strokes, clamped to ``[min_ms, max_ms]``. A brisk writer whose longest ordinary gap is
    1.5 s gets a 4.5 s lull; someone who habitually stops for 3 s between symbols gets 9 s. While
    the pen is down, or a key was pressed within the threshold, there is no lull. Times are on
    the arrival clock (ms).
    """

    def __init__(self, min_ms: float = 4000.0, max_ms: float = 15000.0, window: int = 40) -> None:
        self.min_ms = min_ms
        self.max_ms = max_ms
        self.window = window
        self._gaps: list[float] = []
        self._last_end: float | None = None

    def stroke_begin(self, arrival_ms: float) -> None:
        if self._last_end is not None:
            gap = arrival_ms - self._last_end
            if 0 <= gap < 60_000:  # longer gaps are breaks, not rhythm
                self._gaps.append(gap)
                self._gaps = self._gaps[-self.window :]

    def stroke_end(self, arrival_ms: float) -> None:
        self._last_end = arrival_ms

    def threshold_ms(self) -> float:
        if len(self._gaps) < 5:
            return self.min_ms * 1.5
        g = sorted(self._gaps)
        p90 = g[min(len(g) - 1, int(0.9 * len(g)))]
        return max(self.min_ms, min(self.max_ms, 3.0 * p90))

    def state(self, log: InkLog, now_ms: float) -> str:
        """``"writing"`` (pen down), ``"mid_thought"`` (recent activity) or ``"lull"``."""
        if log.pen_down:
            return "writing"
        if log.last_activity_ms is None:
            return "lull"
        return "lull" if now_ms - log.last_activity_ms >= self.threshold_ms() else "mid_thought"
