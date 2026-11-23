"""
Expressive hand-drawn visual marks (circle, underline, arrow) parsed from ``MARK:`` lines.

Allows the responder to optionally emit up to 2 lightweight ``MARK: <kind> x0 y0 x1 y1`` lines
(normalized ``0..1`` coordinates within the selection or page region) so it can circle,
underline, or point at parts of the user's ink with organic, pressure-tapered strokes.
"""

from __future__ import annotations

import math
import re
import time

from .page import Box

MARK_COLOR = "#b3261e"  # warm editorial crimson
_MARK_RE = re.compile(
    r"^\s*MARK:\s*(circle|underline|arrow|bracket|star)\s+"
    r"([01](?:\.\d+)?)\s+([01](?:\.\d+)?)\s+([01](?:\.\d+)?)\s+([01](?:\.\d+)?)\s*$",
    re.MULTILINE,
)


def extract_marks(text: str) -> tuple[list[tuple[str, Box]], str]:
    """Return ``(marks, prose)`` where ``marks`` is ``[(kind, (x0,y0,x1,y1))]`` (<= 2)."""
    marks: list[tuple[str, Box]] = []
    for m in _MARK_RE.finditer(text):
        if len(marks) >= 2:
            break
        kind = m.group(1)
        coords = tuple(max(0.0, min(1.0, float(m.group(i)))) for i in range(2, 6))
        marks.append((kind, coords))  # type: ignore[arg-type]
    prose = _MARK_RE.sub("", text).strip()
    return marks, prose


def _tapered_pts(
    pts: list[tuple[float, float]],
    page_w: float,
    page_h: float,
    t0_ms: float,
    dur_ms: float = 240.0,
) -> list[list[float]]:
    n = len(pts)
    out: list[list[float]] = []
    for i, (x, y) in enumerate(pts):
        u = i / max(1, n - 1)
        p = 0.35 + 0.55 * math.sin(math.pi * u)
        out.append(
            [round(x / page_w, 5), round(y / page_h, 5), round(p, 3), round(t0_ms + u * dur_ms)]
        )
    return out


def _mark_circle(x0: float, y0: float, x1: float, y1: float) -> list[tuple[float, float]]:
    cx, cy = (x0 + x1) * 0.5, (y0 + y1) * 0.5
    ax, ay = max(12.0, abs(x1 - x0) * 0.55), max(10.0, abs(y1 - y0) * 0.55)
    steps = 28
    out: list[tuple[float, float]] = []
    for i in range(steps + 1):
        th = -0.25 + (2.0 * math.pi + 0.28) * (i / steps)
        wobble = 1.0 + 0.04 * math.sin(3.0 * th)
        out.append((cx + ax * wobble * math.cos(th), cy + ay * wobble * math.sin(th)))
    return out


def _mark_underline(x0: float, y0: float, x1: float, y1: float) -> list[tuple[float, float]]:
    y_mid = max(y0, y1)
    return [
        (x0 + (x1 - x0) * (i / 16), y_mid + 2.5 * math.sin(math.pi * i / 16))
        for i in range(17)
    ]


def _mark_bracket(x0: float, y0: float, x1: float, y1: float) -> list[tuple[float, float]]:
    del x1
    ym = (y0 + y1) * 0.5
    dx = max(10.0, min(18.0, abs(y1 - y0) * 0.12))
    out: list[tuple[float, float]] = []
    for i in range(21):
        u = i / 20
        if u < 0.5:
            t = u * 2.0
            out.append((x0 + dx * (1.0 - math.sin(t * math.pi * 0.5)), y0 + (ym - y0) * t))
        else:
            t = (u - 0.5) * 2.0
            out.append((x0 + dx * math.sin(t * math.pi * 0.5), ym + (y1 - ym) * t))
    return out


def _mark_star(x0: float, y0: float, x1: float, y1: float) -> list[tuple[float, float]]:
    del x1, y1
    r = 12.0
    out: list[tuple[float, float]] = []
    for a in (0.0, math.pi / 2.0, math.pi / 4.0, -math.pi / 4.0):
        dx, dy = r * math.cos(a), r * math.sin(a)
        out.extend([(x0 - dx, y0 - dy), (x0 + dx, y0 + dy), (x0, y0)])
    return out


def _mark_arrow(x0: float, y0: float, x1: float, y1: float) -> list[tuple[float, float]]:
    out = [
        (x0 + (x1 - x0) * (i / 12), y0 + (y1 - y0) * (i / 12) - 6.0 * math.sin(math.pi * i / 12))
        for i in range(13)
    ]
    ang = math.atan2(y1 - y0, x1 - x0)
    head = 16.0
    for side in (0.45, -0.45):
        out.extend([(x1, y1), (x1 - head * math.cos(ang + side), y1 - head * math.sin(ang + side))])
    return out


_MARK_BUILDERS = {
    "circle": _mark_circle,
    "underline": _mark_underline,
    "bracket": _mark_bracket,
    "star": _mark_star,
    "arrow": _mark_arrow,
}

_SKETCH_LINE = re.compile(r"^\s*SKETCH:\s*(.+)$", re.MULTILINE)


def _hand_pts(
    pts: list[tuple[float, float]], wobble: float = 1.2
) -> list[tuple[float, float]]:
    """Add subtle organic hand-drawn micro-jitter along multi-point sketch strokes."""
    if len(pts) < 3:
        return pts
    out: list[tuple[float, float]] = [pts[0]]
    for i, (x, y) in enumerate(pts[1:-1], 1):
        out.append((x + wobble * math.sin(i * 1.9), y + wobble * math.cos(i * 2.3)))
    out.append(pts[-1])
    return out


def _parse_xy_pairs(tokens: list[str]) -> list[tuple[float, float]]:
    pts: list[tuple[float, float]] = []
    for tok in tokens:
        if "," not in tok:
            continue
        a, _, b = tok.partition(",")
        try:
            nx = max(0.0, min(1.0, float(a)))
            ny = max(0.0, min(1.0, float(b)))
            pts.append((nx, ny))
        except ValueError:
            continue
    return pts


def extract_sketches(text: str) -> list[tuple[str, list[tuple[float, float]], str | None]]:
    """
    Parse up to 8 ``SKETCH:`` primitives from a reply:
    - ``SKETCH: box|circle|arrow x0 y0 x1 y1 [#rrggbb]``
    - ``SKETCH: curve x0,y0 cx,cy x1,y1 [#rrggbb]``
    - ``SKETCH: poly x0,y0 x1,y1 ... [#rrggbb]``
    """
    out: list[tuple[str, list[tuple[float, float]], str | None]] = []
    for m in _SKETCH_LINE.finditer(text or ""):
        if len(out) >= 8:
            break
        parts = m.group(1).strip().split()
        if not parts:
            continue
        kind = parts[0].lower()
        color: str | None = None
        if parts[-1].startswith("#") and len(parts[-1]) == 7:
            color = parts.pop()
        args = parts[1:]
        if kind in ("box", "circle", "arrow") and len(args) >= 4:
            try:
                coords = [max(0.0, min(1.0, float(args[i]))) for i in range(4)]
                out.append((kind, [(coords[0], coords[1]), (coords[2], coords[3])], color))
            except ValueError:
                continue
        elif kind in ("curve", "poly"):
            pts = _parse_xy_pairs(args)
            if len(pts) >= 2:
                out.append((kind, pts, color))
    return out


def sketch_messages(
    sketches: list[tuple[str, list[tuple[float, float]], str | None]],
    region_pu: Box,
    page_w: float,
    page_h: float,
    run: str,
    default_color: str = "#1f6fe0",
    author: str = "agentd:sketch",
) -> list[tuple[float, dict]]:
    """Build ``stroke_begin`` / ``stroke_pts`` / ``stroke_end`` messages for ``SKETCH:`` items."""
    rx0, ry0, rx1, ry1 = region_pu
    rw, rh = max(40.0, rx1 - rx0), max(40.0, ry1 - ry0)
    t_base = time.time() * 1000 + 25.0
    msgs: list[tuple[float, dict]] = []

    for idx, (kind, npts, col) in enumerate(sketches):
        pu = [(rx0 + nx * rw, ry0 + ny * rh) for nx, ny in npts]
        raw: list[tuple[float, float]] = []
        if kind == "box" and len(pu) >= 2:
            (x0, y0), (x1, y1) = pu[0], pu[1]
            raw = _hand_pts(
                [(x0 - 3, y0), (x1 + 2, y0), (x1, y1 + 2), (x0 - 2, y1), (x0, y0 - 2)]
            )
        elif kind == "circle" and len(pu) >= 2:
            raw = _mark_circle(pu[0][0], pu[0][1], pu[1][0], pu[1][1])
        elif kind == "arrow" and len(pu) >= 2:
            raw = _mark_arrow(pu[0][0], pu[0][1], pu[1][0], pu[1][1])
        elif kind == "curve" and len(pu) >= 3:
            (x0, y0), (cx, cy), (x1, y1) = pu[0], pu[1], pu[2]
            for i in range(17):
                u = i / 16
                raw.append(
                    (
                        (1 - u) ** 2 * x0 + 2 * (1 - u) * u * cx + u**2 * x1,
                        (1 - u) ** 2 * y0 + 2 * (1 - u) * u * cy + u**2 * y1,
                    )
                )
        else:
            raw = _hand_pts(pu, wobble=0.9)
        if len(raw) < 2:
            continue
        pts = _tapered_pts(raw, page_w, page_h, t_base + idx * 190.0, dur_ms=260.0)
        sid = f"agentd_{run}s{idx}"
        t0, t1 = pts[0][3], pts[-1][3]
        msgs.append(
            (
                t0,
                {
                    "t": "stroke_begin",
                    "id": sid,
                    "layer": "ai",
                    "brush": "pen",
                    "color": col or default_color,
                    "author": author,
                    "ts": int(t0),
                },
            )
        )
        msgs.append((t0 + 20.0, {"t": "stroke_pts", "id": sid, "pts": pts}))
        msgs.append((t1, {"t": "stroke_end", "id": sid}))
    return msgs


def mark_messages(
    marks: list[tuple[str, Box]],
    region_pu: Box,
    page_w: float,
    page_h: float,
    run: str,
    author: str = "agentd:mark",
) -> list[tuple[float, dict]]:
    """Build ``stroke_start`` / ``stroke_pts`` / ``stroke_end`` messages for each mark."""
    rx0, ry0, rx1, ry1 = region_pu
    rw, rh = max(20.0, rx1 - rx0), max(20.0, ry1 - ry0)
    t_base = time.time() * 1000 + 20.0
    msgs: list[tuple[float, dict]] = []

    for idx, (kind, (nx0, ny0, nx1, ny1)) in enumerate(marks):
        builder = _MARK_BUILDERS.get(kind, _mark_arrow)
        raw = builder(rx0 + nx0 * rw, ry0 + ny0 * rh, rx0 + nx1 * rw, ry0 + ny1 * rh)
        pts = _tapered_pts(raw, page_w, page_h, t_base + idx * 280.0)
        sid = f"agentd_{run}m{idx}"
        t0, t1 = pts[0][3], pts[-1][3]
        msgs.append(
            (
                t0,
                {
                    "t": "stroke_begin",
                    "id": sid,
                    "layer": "ai",
                    "brush": "pen",
                    "color": MARK_COLOR,
                    "author": author,
                    "ts": int(t0),
                },
            )
        )
        msgs.append((t0 + 20.0, {"t": "stroke_pts", "id": sid, "pts": pts}))
        msgs.append((t1, {"t": "stroke_end", "id": sid}))
    return msgs
