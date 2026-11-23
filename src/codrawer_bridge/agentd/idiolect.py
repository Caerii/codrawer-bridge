"""
Geometric idiolect / symbol recognition from raw user pen strokes.

Recognizes intentional hand-drawn gestures in normalized page coordinates:
- ``lasso``: a closed loop or box drawn around earlier ink to focus on that region.
- ``star``: two short crossing strokes marking a spot for attention or verification.
- ``question``: a compact ``?`` (curved hook + dot beneath) asking for a hint at that spot.
"""

from __future__ import annotations

import math
import time
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .page import Box, Stroke


def _stroke_pts_pu(stroke: Stroke, page_w: float, page_h: float) -> list[tuple[float, float]]:
    return [(p[0] * page_w - page_w / 2.0, p[1] * page_h) for p in stroke.pts]


def _bbox(pts: list[tuple[float, float]]) -> tuple[float, float, float, float]:
    xs = [p[0] for p in pts]
    ys = [p[1] for p in pts]
    return min(xs), min(ys), max(xs), max(ys)


def _perimeter(pts: list[tuple[float, float]]) -> float:
    return sum(
        math.hypot(b[0] - a[0], b[1] - a[1]) for a, b in zip(pts, pts[1:], strict=False)
    )


def _recognize_lasso(
    strokes: list[Stroke], page_w: float, page_h: float
) -> tuple[str, tuple[float, float, float, float]] | None:
    if len(strokes) < 2:
        return None
    pts = _stroke_pts_pu(strokes[-1], page_w, page_h)
    if len(pts) < 8:
        return None
    x0, y0, x1, y1 = _bbox(pts)
    if (x1 - x0) < 70.0 or (y1 - y0) < 50.0:
        return None
    perim = _perimeter(pts)
    if perim <= 0.0:
        return None
    gap = math.hypot(pts[-1][0] - pts[0][0], pts[-1][1] - pts[0][1])
    if gap > 0.35 * perim:
        return None
    enclosed: list[tuple[float, float]] = []
    for st in strokes[:-1]:
        s_pts = _stroke_pts_pu(st, page_w, page_h)
        if not s_pts:
            continue
        sx0, sy0, sx1, sy1 = _bbox(s_pts)
        cx, cy = (sx0 + sx1) * 0.5, (sy0 + sy1) * 0.5
        if x0 <= cx <= x1 and y0 <= cy <= y1:
            enclosed.extend(s_pts)
    if not enclosed:
        return None
    return "lasso", _bbox(enclosed)


def _recognize_star(
    strokes: list[Stroke], page_w: float, page_h: float
) -> tuple[str, tuple[float, float, float, float]] | None:
    if len(strokes) < 2:
        return None
    p1 = _stroke_pts_pu(strokes[-2], page_w, page_h)
    p2 = _stroke_pts_pu(strokes[-1], page_w, page_h)
    if len(p1) < 2 or len(p2) < 2:
        return None
    b1, b2 = _bbox(p1), _bbox(p2)
    if max(b1[2] - b1[0], b1[3] - b1[1]) > 65.0 or max(b2[2] - b2[0], b2[3] - b2[1]) > 65.0:
        return None
    c1 = ((b1[0] + b1[2]) * 0.5, (b1[1] + b1[3]) * 0.5)
    c2 = ((b2[0] + b2[2]) * 0.5, (b2[1] + b2[3]) * 0.5)
    if math.hypot(c2[0] - c1[0], c2[1] - c1[1]) > 30.0:
        return None
    v1 = (p1[-1][0] - p1[0][0], p1[-1][1] - p1[0][1])
    v2 = (p2[-1][0] - p2[0][0], p2[-1][1] - p2[0][1])
    n1, n2 = math.hypot(*v1), math.hypot(*v2)
    if n1 < 12.0 or n2 < 12.0:
        return None
    cos_a = abs((v1[0] * v2[0] + v1[1] * v2[1]) / (n1 * n2))
    if cos_a > 0.45:
        return None
    return "star", _bbox(p1 + p2)


def _recognize_question(
    strokes: list[Stroke], page_w: float, page_h: float
) -> tuple[str, tuple[float, float, float, float]] | None:
    if len(strokes) < 2:
        return None
    hook = _stroke_pts_pu(strokes[-2], page_w, page_h)
    dot = _stroke_pts_pu(strokes[-1], page_w, page_h)
    if len(hook) < 5 or not dot:
        return None
    hb, db = _bbox(hook), _bbox(dot)
    hw, hh = hb[2] - hb[0], hb[3] - hb[1]
    dw, dh = db[2] - db[0], db[3] - db[1]
    if not (25.0 <= hh <= 120.0 and hw <= 90.0):
        return None
    if max(dw, dh) > 16.0:
        return None
    dcx, dcy = (db[0] + db[2]) * 0.5, (db[1] + db[3]) * 0.5
    hcx = (hb[0] + hb[2]) * 0.5
    if abs(dcx - hcx) > 35.0 or not (hb[3] - 8.0 <= dcy <= hb[3] + 40.0):
        return None
    return "question", _bbox(hook + dot)


def recognize_idiolect(
    strokes: list[Stroke], page_w: float, page_h: float
) -> tuple[str, tuple[float, float, float, float]] | None:
    """Return ``(kind, bbox_pu)`` if the newest user strokes form a recognized idiolect."""
    if not strokes:
        return None
    for recognizer in (_recognize_lasso, _recognize_star, _recognize_question):
        hit = recognizer(strokes, page_w, page_h)
        if hit is not None:
            return hit
    return None


def ack_messages(
    kind: str,
    region_pu: Box,
    page_w: float,
    page_h: float,
    run: str,
    color: str = "#1e6091",
    author: str = "agentd:ack",
) -> list[tuple[float, dict]]:
    """
    Build a subtle 1-stroke ink acknowledgement near a recognized idiolect so the user sees
    immediately that their drawn symbol was understood.
    """
    rx0, ry0, rx1, _ = region_pu
    half = page_w / 2.0
    ax = rx1 + half + 14.0
    ay = ry0 + 6.0
    if kind == "lasso":
        pts_pu = [(ax, ay + 10.0), (ax + 8.0, ay), (ax + 16.0, ay + 4.0)]
    elif kind == "star":
        pts_pu = [(ax, ay), (ax + 5.0, ay - 6.0), (ax + 10.0, ay), (ax + 5.0, ay + 6.0), (ax, ay)]
    else:
        pts_pu = [(ax, ay + 4.0), (ax + 6.0, ay - 2.0), (ax + 12.0, ay + 4.0)]
    t0 = time.time() * 1000 + 15.0
    pts = [
        [round(px / page_w, 5), round(py / page_h, 5), 0.55, int(t0 + i * 25.0)]
        for i, (px, py) in enumerate(pts_pu)
    ]
    sid = f"agentd_{run}ack"
    t1 = pts[-1][3]
    return [
        (
            t0,
            {
                "t": "stroke_begin",
                "id": sid,
                "layer": "ai",
                "brush": "pen",
                "color": color,
                "author": author,
                "ts": int(t0),
            },
        ),
        (t0 + 15.0, {"t": "stroke_pts", "id": sid, "pts": pts}),
        (t1, {"t": "stroke_end", "id": sid}),
    ]
