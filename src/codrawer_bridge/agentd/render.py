"""
The page, or the lassoed part of it, as the picture the model reads (ADR 002).

Two pictures:

- :func:`render_page`: the whole page through the router's own renderer
  (server/rendering.py ``render_page_png``, 1024 px on the long side), every user stroke black.
  The agent layer is left out by default, so an earlier reply cannot pass for the user's writing
  (the rule primer/recognize.py follows).
- :func:`render_region`: the selection's box grown by a margin, cropped, drawn as the tablet drew
  it. The selected strokes are black; other ink that falls in the margin is light grey, context
  the model can tell apart.

**Resolution** (the user, 2026-10-07: "the image resolution is getting too small for it to
properly read our nuanced handwriting"). The region is drawn at twice the page's resolution or
more: small selections are scaled up until a typical stroke is :data:`TARGET_STROKE_PX` tall
(a stroke's height is about a letter's x-height in print; the median over the selection is the
measure), never beyond :data:`MAX_UPSCALE`, and the long side is capped at :data:`MAX_SIDE`
(1568 px, beyond which Claude downsamples images anyway). With warm processes the larger image
costs little: see ``scale_for`` and the measurements in the commit that introduced them.

**Ink as drawn.** A page snapshot carries each point's drawn width (xochitl's own, a fraction of
the page width); the pen is drawn with it, so a fineliner looks thin and a marker broad, with the
pressure shape the user made. Strokes without widths (seen only live) fall back to a pressure
estimate. Lines are drawn at :data:`SUPERSAMPLE` times the size and reduced with a Lanczos
filter: grey, antialiased edges, which keep the shape of fine handwriting better than hard-edged
or 1-bit ink.

Coordinates are normalized page coordinates; the page is ``page_w`` × ``page_h`` page units.
"""

from __future__ import annotations

import io
from statistics import median

from PIL import Image, ImageDraw

from ..server.rendering import render_page_png
from .page import Box, Stroke

#: The long side's cap in px (Claude's own downsampling threshold).
MAX_SIDE = 1568
#: The height a typical stroke should reach in the picture, px.
TARGET_STROKE_PX = 40.0
#: The least and largest magnification of the page's own resolution. Joined-up handwriting makes
#: long, tall strokes, so the stroke-height measure alone can leave it near 1x: twice the page's
#: resolution is the floor (2026-10-07: cursive rendered at 1x lost detail).
MIN_UPSCALE = 2.0
MAX_UPSCALE = 4.0
#: Drawn this many times larger, then reduced: antialiasing.
SUPERSAMPLE = 2


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


def scale_for(
    selected: list[Stroke],
    region: Box,
    page_w: float = 1620.0,
    page_h: float = 2160.0,
    max_side: int = MAX_SIDE,
) -> float:
    """
    Picture pixels per page unit for ``region`` (module docstring): at least MIN_UPSCALE, enough
    for a typical stroke to be TARGET_STROKE_PX tall, at most MAX_UPSCALE, within ``max_side``.
    """
    x0, y0, x1, y1 = region
    w_pu, h_pu = max(1.0, (x1 - x0) * page_w), max(1.0, (y1 - y0) * page_h)
    fit = min(max_side / w_pu, max_side / h_pu)
    heights = [(s.bbox()[3] - s.bbox()[1]) * page_h for s in selected if s.pts]
    typical = median([h for h in heights if h > 2]) if any(h > 2 for h in heights) else 0.0
    want = TARGET_STROKE_PX / typical if typical else 1.0
    return min(fit, max(MIN_UPSCALE, min(want, MAX_UPSCALE)))


def render_region(
    selected: list[Stroke],
    context: list[Stroke],
    region: Box,
    page_w: float = 1620.0,
    page_h: float = 2160.0,
    max_side: int = MAX_SIDE,
    width_cap: float | None = None,
) -> bytes:
    """
    The ``region`` (normalized) cropped: ``selected`` black on white, ``context`` light grey.
    ``width_cap``: draw no line wider than this fraction of the estimated x-height (the median
    height of the selected strokes), which keeps a heavy calligraphy pen's letters open.
    """
    x0, y0, x1, y1 = region
    w_pu, h_pu = max(1.0, (x1 - x0) * page_w), max(1.0, (y1 - y0) * page_h)
    scale = scale_for(selected, region, page_w, page_h, max_side)
    cap_px = None
    if width_cap:
        heights = [(s.bbox()[3] - s.bbox()[1]) * page_h for s in selected if s.pts]
        tall = [h for h in heights if h > 2]
        if tall:
            cap_px = width_cap * median(tall) * scale * SUPERSAMPLE
    W, H = max(32, round(w_pu * scale)), max(32, round(h_pu * scale))
    k = scale * SUPERSAMPLE
    img = Image.new("L", (W * SUPERSAMPLE, H * SUPERSAMPLE), 255)
    draw = ImageDraw.Draw(img)

    def px(p: list[float]) -> tuple[float, float]:
        return ((p[0] - x0) * page_w * k, (p[1] - y0) * page_h * k)

    for strokes, ink in ((context, 185), (selected, 0)):
        for s in strokes:
            widths = s.widths if s.widths and len(s.widths) == len(s.pts) else None
            prev = None
            for i, p in enumerate(s.pts):
                cur = px(p)
                if widths is not None:
                    wd = widths[i] * page_w * k  # xochitl's drawn width, page units → px
                else:
                    pr = p[2] if len(p) >= 3 else 0.5
                    wd = (1.5 + 3.5 * pr) * k
                if cap_px is not None:
                    wd = min(wd, cap_px)
                wd = max(1.5 * SUPERSAMPLE, wd)
                if prev is not None:
                    draw.line([prev, cur], fill=ink, width=round(wd))
                r = wd / 2  # round joints: no notches where the direction turns
                draw.ellipse([cur[0] - r, cur[1] - r, cur[0] + r, cur[1] + r], fill=ink)
                prev = cur
    img = img.resize((W, H), Image.LANCZOS)
    bio = io.BytesIO()
    img.save(bio, format="PNG", optimize=True)
    return bio.getvalue()


def intersects(s: Stroke, region: Box) -> bool:
    x0, y0, x1, y1 = s.bbox()
    return not (x1 < region[0] or x0 > region[2] or y1 < region[1] or y0 > region[3])
