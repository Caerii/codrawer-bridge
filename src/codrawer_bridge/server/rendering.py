from __future__ import annotations

import base64
import io

from PIL import Image, ImageDraw


def render_context_patch_png_b64(
    *,
    strokes: list[dict[str, object]],
    center_xy: tuple[float, float],
    window: float,
    px: int,
) -> str:
    """
    Render a simple context patch as a PNG (base64, no data-url prefix).

    - **strokes**: [{"pts": [[x,y,p],...], ...}, ...] in normalized [0,1]
    - **center_xy**: patch center in normalized coords
    - **window**: normalized width/height of the region to render (square)
    - **px**: output image size (px x px)
    """
    cx, cy = center_xy
    half = max(1e-6, window * 0.5)
    x0, x1 = cx - half, cx + half
    y0, y1 = cy - half, cy + half

    img = Image.new("L", (px, px), 0)  # black bg
    draw = ImageDraw.Draw(img)

    def to_px(x: float, y: float) -> tuple[float, float]:
        u = (x - x0) / (x1 - x0)
        v = (y - y0) / (y1 - y0)
        return (u * (px - 1), v * (px - 1))

    take = strokes[-8:]
    n = max(1, len(take))
    for i, s in enumerate(take):
        pts = s.get("pts")
        if not isinstance(pts, list) or len(pts) < 2:
            continue
        alpha = 0.35 + 0.65 * ((i + 1) / n)
        col = int(255 * alpha)
        prev = None
        for p in pts:
            if not isinstance(p, list) or len(p) < 2:
                continue
            x = float(p[0])
            y = float(p[1])
            pr = float(p[2]) if len(p) >= 3 else 0.6
            if x < x0 or x > x1 or y < y0 or y > y1:
                prev = None
                continue
            cur = to_px(x, y)
            w = max(1, int(1 + 5 * pr))
            if prev is not None:
                draw.line([prev, cur], fill=col, width=w)
            prev = cur

    bio = io.BytesIO()
    img.save(bio, format="PNG", optimize=True)
    return base64.b64encode(bio.getvalue()).decode("ascii")



