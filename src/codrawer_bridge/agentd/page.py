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
            self.strokes[f"snap:{sid}"] = Stroke(id=sid, layer=layer, tool=tool, pts=pts)
        self.has_snapshot = True
        self.version += 1

    def add_own(self, sid: str, pts: list[list[float]]) -> None:
        """Our own agent ink, so later placements avoid it before the next snapshot holds it."""
        self.strokes[sid] = Stroke(id=sid, layer="ai", tool="pen", pts=pts, live=True)

    # ── Views ──────────────────────────────────────────────────────────────────────────────

    def ink(self, include_ai: bool = True) -> list[Stroke]:
        """Every stroke with points; the agent layer only when ``include_ai``."""
        return [s for s in self.strokes.values() if s.pts and (include_ai or s.layer != "ai")]

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
