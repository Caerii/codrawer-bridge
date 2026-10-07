"""
The page, or the lassoed part of it, as the PNG the model Reads (ADR 002).

Two pictures:

- :func:`render_page`: the whole page through the router's own renderer
  (server/rendering.py ``render_page_png``, 1024 px on the long side), every user stroke black.
  The agent layer is left out by default, so an earlier reply cannot pass for the user's writing
  (the rule primer/recognize.py follows).
- :func:`render_region`: the selection's box grown by a margin, cropped. The selected strokes are
  black; other ink that falls in the margin is light grey, context the model can tell apart.
  Pen width follows pressure, as in primer/recognize.py's renderer, at a scale of at most 1.5 px
  per page unit and 1000 px on the long side (grey ink on white compresses well; the image is
  most of an ask's bytes and input tokens).

Coordinates are normalized page coordinates; the page is ``page_w`` × ``page_h`` page units.
"""

from __future__ import annotations

import io

from PIL import Image, ImageDraw

from ..server.rendering import render_page_png
from .page import Box, Stroke


def render_page(strokes: list[Stroke], page_w: float = 1620.0, page_h: float = 2160.0) -> bytes:
    """The whole page, every given stroke black (server/rendering.py)."""
    data = [{"id": s.id, "pts": s.pts} for s in strokes]
    return render_page_png(
        page_strokes=data, turn_ids={s.id for s in strokes}, page_aspect=page_w / page_h
    )


def region_with_margin(
    box: Box, margin: float = 0.04, page_w: float = 1620.0, page_h: float = 2160.0
) -> Box:
    """``box`` grown by ``margin`` page widths on every side (the same length in x and y)."""
    my = margin * page_w / page_h
    return (box[0] - margin, box[1] - my, box[2] + margin, box[3] + my)


def render_region(
    selected: list[Stroke],
    context: list[Stroke],
    region: Box,
    page_w: float = 1620.0,
    page_h: float = 2160.0,
    max_side: int = 1000,
) -> bytes:
    """The ``region`` (normalized) cropped: ``selected`` black on white, ``context`` light grey."""
    x0, y0, x1, y1 = region
    w_pu, h_pu = max(1.0, (x1 - x0) * page_w), max(1.0, (y1 - y0) * page_h)
    scale = min(max_side / w_pu, max_side / h_pu, 1.5)
    W, H = max(32, int(w_pu * scale)), max(32, int(h_pu * scale))
    img = Image.new("L", (W, H), 255)
    draw = ImageDraw.Draw(img)

    def px(p: list[float]) -> tuple[float, float]:
        return ((p[0] - x0) * page_w * scale, (p[1] - y0) * page_h * scale)

    for strokes, ink in ((context, 185), (selected, 0)):
        for s in strokes:
            prev = None
            for p in s.pts:
                cur = px(p)
                pr = p[2] if len(p) >= 3 else 0.5
                if prev is not None:
                    draw.line([prev, cur], fill=ink, width=max(2, int((1.5 + 3.5 * pr) * scale)))
                prev = cur
    bio = io.BytesIO()
    img.save(bio, format="PNG", optimize=True)
    return bio.getvalue()


def intersects(s: Stroke, region: Box) -> bool:
    x0, y0, x1, y1 = s.bbox()
    return not (x1 < region[0] or x0 > region[2] or y1 < region[1] or y0 > region[3])
