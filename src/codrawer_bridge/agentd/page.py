"""
The page as agentd knows it: the tablet's last saved snapshot plus the strokes drawn since.

**Sources** (docs/protocol.md). A ``page`` message is the tablet's saved page: every stroke on
it, erases and undos applied, with agent-layer strokes labelled ``"layer":"ai"``. xochitl saves
6–10 s after a pause, so the strokes drawn since arrive live as ``stroke_begin`` /
``stroke_pts`` / ``stroke_end``; the tablet's router replays both to a joiner. A new snapshot
replaces the old one and covers every live stroke begun before its ``rev``; a different page or
document starts over.

**What is kept.** For each stroke: its layer (``user``, ``peer`` or ``ai``), its tool, and its
points as normalized page coordinates ``[x, y, p]`` (``x = (x_rm + w/2) / w``, ``y = y_rm / h``;
points on a scrolled page can fall outside 0..1). Eraser paths are not ink: they are dropped
(their effect reaches us with the next snapshot). Pen activity on the user's layers is tracked
so the hand can yield while the user writes (ADR 009 §2, the write-back guard).

**Selections.** ``ask_selection`` carries the lasso's ``bbox`` in xochitl's scene units (x
centred on the page, y down from the top); :meth:`PageModel.selection_box` converts it with the
page size. A box whose coordinates all lie in [-0.5, 1.5] is taken as already normalized (the
rule primer/agent.py uses).

**Live pen strokes are in screen coordinates, not page coordinates.** The bridge reads the
digitizer (bridge/remarkable/rust/src/pen.rs) and normalizes it to the screen; it does not know
xochitl's zoom or scroll. At the default view the two coincide, which is why live ink and
snapshots agree on the glasses. On a zoomed or scrolled page they do not: request 6 of the first
live day (2026-10-06) lassoed fresh writing at page y 0.92–0.96 on a view zoomed to 0.75, its
live strokes sat at screen y 0.69–0.72, and the selection came out empty. The dock tells us the
view: next to the page ``bbox`` it sends ``view_bbox``, the same rectangle in screen pixels
(1620 × 2160), and the two give the zoom and the offset (:class:`View`). The tablet's own
strokes that arrived live (layer ``user``, not yet in a snapshot) are kept in screen coordinates
and mapped through the latest view on every read; strokes from snapshots, agents and our own
ink are page coordinates already.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any

#: Paper Pro page size in page units (px at 229 ppi), when a snapshot does not say.
PAGE_W, PAGE_H = 1620.0, 2160.0

#: Tools whose strokes are not ink (their effect is already in the snapshot).
ERASERS = ("eraser", "erase_area")

Box = tuple[float, float, float, float]


@dataclass(frozen=True)
class View:
    """
    xochitl's view of the page: screen pixel = ``zoom`` · page pixel (x from the page's left
    edge) + ``(dx, dy)``. The screen is ``screen_w`` × ``screen_h`` pixels (Paper Pro portrait).
    """

    zoom: float = 1.0
    dx: float = 0.0
    dy: float = 0.0
    screen_w: float = PAGE_W
    screen_h: float = PAGE_H

    @staticmethod
    def from_boxes(
        bbox: list[float], view_bbox: list[float], page_w: float = PAGE_W
    ) -> View | None:
        """The view that maps the dock's page ``bbox`` (scene units) onto its ``view_bbox``."""
        try:
            bx0, by0, bx1, by1 = (float(v) for v in bbox)
            vx0, vy0, vx1, vy1 = (float(v) for v in view_bbox)
        except (TypeError, ValueError):
            return None
        if abs(bx1 - bx0) > 1e-3:
            zoom = (vx1 - vx0) / (bx1 - bx0)
        elif abs(by1 - by0) > 1e-3:
            zoom = (vy1 - vy0) / (by1 - by0)
        else:
            return None
        if not 0.05 < zoom < 20:
            return None
        return View(zoom, vx0 - zoom * (bx0 + page_w / 2), vy0 - zoom * by0)

    def to_page(self, u: float, v: float, page_w: float, page_h: float) -> tuple[float, float]:
        """A screen-normalized point as a normalized page point."""
        x = (u * self.screen_w - self.dx) / self.zoom
        y = (v * self.screen_h - self.dy) / self.zoom
        return x / page_w, y / page_h


def _now_ms() -> float:
    return time.time() * 1000


@dataclass
class Stroke:
    """One stroke. ``pts`` are normalized ``[x, y, p]``; ``live`` means not from a snapshot."""

    id: str
    layer: str = "user"
    tool: str = "pen"
    pts: list[list[float]] = field(default_factory=list)
    live: bool = False
    begin_ts: float | None = None
    ended: bool = True
    screen: bool = False  # pts are screen-normalized (the tablet's pen, live): map through a View
    widths: list[float] | None = None  # per point, xochitl's drawn width as a fraction of the
    #                                    page width (snapshots only: their 4th point value)

    def bbox(self) -> Box:
        xs = [p[0] for p in self.pts] or [0.0]
        ys = [p[1] for p in self.pts] or [0.0]
        return (min(xs), min(ys), max(xs), max(ys))


class PageModel:
    """The page on screen (module docstring). Feed every message to :meth:`observe`."""

    def __init__(self, own_prefix: str = "agentd_", clock=_now_ms) -> None:
        self.own_prefix = own_prefix
        self.clock = clock
        self.doc = ""
        self.page = ""
        self.title = ""
        self.rev = 0.0
        self.w, self.h = PAGE_W, PAGE_H
        self.strokes: dict[str, Stroke] = {}
        self.has_snapshot = False
        self.pen_down: set[str] = set()  # user-layer strokes begun and not ended
        self.last_user_ink_ms = 0.0  # local clock, last user point or begin
        self.version = 0  # bumps on every page change (for waiters)
        self.view = View()  # the latest view the dock told us about (identity until then)

    # ── Input ──────────────────────────────────────────────────────────────────────────────

    def observe(self, msg: dict[str, Any]) -> None:
        t = msg.get("t")
        if t == "page":
            self._on_page(msg)
        elif t == "stroke_begin":
            sid = msg.get("id")
            if not isinstance(sid, str) or sid.startswith(self.own_prefix):
                return
            tool = str(msg.get("brush") or msg.get("tool") or "pen")
            if tool in ERASERS or msg.get("tool") == "eraser":
                return
            layer = str(msg.get("layer") or "user")
            ts = msg.get("ts")
            self.strokes[sid] = Stroke(
                id=sid,
                layer=layer,
                tool=tool,
                live=True,
                begin_ts=float(ts) if isinstance(ts, (int, float)) else None,
                ended=False,
                screen=layer == "user",
            )
            if layer != "ai":
                self.pen_down.add(sid)
                self.last_user_ink_ms = self.clock()
        elif t == "stroke_pts":
            s = self.strokes.get(str(msg.get("id")))
            if s is None:
                return
            for p in msg.get("pts") or []:
                if isinstance(p, list) and len(p) >= 2:
                    s.pts.append([float(p[0]), float(p[1]), float(p[2]) if len(p) >= 3 else 0.5])
            if s.layer != "ai":
                self.last_user_ink_ms = self.clock()
        elif t == "stroke_end":
            s = self.strokes.get(str(msg.get("id")))
            if s is not None:
                s.ended = True
                self.pen_down.discard(s.id)
        elif t == "stroke_delete":
            for sid in msg.get("ids") or []:
                self.strokes.pop(str(sid), None)
                self.pen_down.discard(str(sid))
        elif t == "clear":
            self.strokes.clear()
            self.pen_down.clear()
            self.version += 1

    def _on_page(self, msg: dict[str, Any]) -> None:
        doc, page = str(msg.get("doc") or ""), str(msg.get("page") or "")
        if (doc, page) != (self.doc, self.page):
            self.strokes.clear()
            self.pen_down.clear()
        else:
            rev = float(msg.get("rev") or 0)
            # the snapshot covers its own strokes and every live stroke begun before it
            self.strokes = {
                k: s
                for k, s in self.strokes.items()
                if s.live and (s.begin_ts is None or s.begin_ts > rev or not s.ended)
            }
        self.doc, self.page = doc, page
        self.title = str(msg.get("title") or "")
        self.rev = float(msg.get("rev") or 0)
        self.w = float(msg.get("w") or PAGE_W)
        self.h = float(msg.get("h") or PAGE_H)
        for i, st in enumerate(msg.get("strokes") or []):
            tool = str(st.get("tool") or "pen")
            if tool in ERASERS:
                continue
            pts = [
                [float(p[0]), float(p[1]), float(p[2]) if len(p) >= 3 else 0.5]
                for p in st.get("pts") or []
                if isinstance(p, list) and len(p) >= 2
            ]
            if not pts:
                continue
            layer = "ai" if st.get("layer") == "ai" else "user"
            sid = str(st.get("id", f"page_{i}"))
            raw = [p for p in st.get("pts") or [] if isinstance(p, list) and len(p) >= 2]
            widths = [float(p[3]) for p in raw] if all(len(p) >= 4 for p in raw) else None
            self.strokes[f"snap:{sid}"] = Stroke(
                id=sid, layer=layer, tool=tool, pts=pts, widths=widths
            )
        self.has_snapshot = True
        self.version += 1

    def add_own(self, sid: str, pts: list[list[float]]) -> None:
        """Our own agent ink, so later placements avoid it before the next snapshot holds it."""
        self.strokes[sid] = Stroke(id=sid, layer="ai", tool="pen", pts=pts, live=True)

    # ── Views ──────────────────────────────────────────────────────────────────────────────

    def set_view(self, msg: dict[str, Any]) -> None:
        """Take the view from a ``dock_action`` that carries ``bbox`` and ``view_bbox``."""
        if isinstance(msg.get("bbox"), list) and isinstance(msg.get("view_bbox"), list):
            v = View.from_boxes(msg["bbox"], msg["view_bbox"], self.w)
            if v is not None:
                self.view = v

    def _in_page(self, s: Stroke) -> Stroke:
        if not s.screen:
            return s
        pts = []
        for p in s.pts:
            x, y = self.view.to_page(p[0], p[1], self.w, self.h)
            pts.append([x, y, p[2] if len(p) >= 3 else 0.5])
        return Stroke(
            id=s.id,
            layer=s.layer,
            tool=s.tool,
            pts=pts,
            live=True,
            begin_ts=s.begin_ts,
            ended=s.ended,
        )

    def ink(self, include_ai: bool = True) -> list[Stroke]:
        """Every stroke with points, in page coordinates; the agent layer only if ``include_ai``."""
        return [
            self._in_page(s)
            for s in self.strokes.values()
            if s.pts and (include_ai or s.layer != "ai")
        ]

    def live_user(self) -> int:
        """Strokes from the tablet's pen not yet in a snapshot."""
        return sum(1 for s in self.strokes.values() if s.screen and s.pts)

    def user_active(self, now_ms: float | None = None, quiet_ms: float = 300.0) -> bool:
        """The user's pen is down, or drew within ``quiet_ms``."""
        now = self.clock() if now_ms is None else now_ms
        return bool(self.pen_down) or now - self.last_user_ink_ms < quiet_ms

    def to_norm(self, box: list[float] | tuple[float, ...]) -> Box:
        """A ``bbox`` from a ``dock_action`` (scene units, x centred) as normalized coordinates."""
        b = [float(v) for v in box]
        if all(-0.5 <= v <= 1.5 for v in b):
            x0, y0, x1, y1 = b
        else:
            x0, x1 = (b[0] + self.w / 2) / self.w, (b[2] + self.w / 2) / self.w
            y0, y1 = b[1] / self.h, b[3] / self.h
        return (min(x0, x1), min(y0, y1), max(x0, x1), max(y0, y1))

    def selection_box(self, msg: dict[str, Any]) -> Box | None:
        box = msg.get("bbox")
        if isinstance(box, list) and len(box) == 4:
            try:
                return self.to_norm(box)
            except (TypeError, ValueError):
                return None
        return None

    def selected(self, box: Box, slack: float = 0.01, share: float = 0.8) -> list[Stroke]:
        """
        The user's strokes inside ``box``: at least ``share`` of their points within it, grown by
        ``slack`` (normalized) on every side, since xochitl's box is the selection's tight bounds.
        """
        x0, y0, x1, y1 = box[0] - slack, box[1] - slack, box[2] + slack, box[3] + slack
        out = []
        for s in self.ink(include_ai=False):
            inside = sum(1 for p in s.pts if x0 <= p[0] <= x1 and y0 <= p[1] <= y1)
            if inside >= share * len(s.pts):
                out.append(s)
        return out

    def ink_box(self, include_ai: bool = False) -> Box | None:
        """Bounds of the ink on the page (normalized), or None for an empty page."""
        ss = self.ink(include_ai=include_ai)
        if not ss:
            return None
        bs = [s.bbox() for s in ss]
        return (
            min(b[0] for b in bs),
            min(b[1] for b in bs),
            max(b[2] for b in bs),
            max(b[3] for b in bs),
        )
