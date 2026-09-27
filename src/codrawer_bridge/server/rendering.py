from __future__ import annotations

import base64
import io

from PIL import Image, ImageDraw


PAGE_ASPECT = 1620 / 2160  # Paper Pro portrait, w/h


def render_page_png(
    *,
    page_strokes: list[dict[str, object]],
    turn_ids: set[str],
    long_side: int = 1024,
    page_aspect: float = PAGE_ASPECT,
) -> bytes:
    """
    Render the whole page for a multimodal model (ADR 002): white paper with a thin
    frame, this turn's strokes black, earlier ink light grey, so the model can tell
    what was just added. Coordinates are normalized page coordinates.
    """
    if page_aspect >= 1:
        w, h = long_side, max(1, int(long_side / page_aspect))
    else:
        w, h = max(1, int(long_side * page_aspect)), long_side
    img = Image.new("L", (w, h), 255)
    draw = ImageDraw.Draw(img)
    draw.rectangle([0, 0, w - 1, h - 1], outline=200, width=2)

    def to_px(x: float, y: float) -> tuple[float, float]:
        return (x * (w - 1), y * (h - 1))

    # earlier ink first, this turn on top
    ordered = sorted(page_strokes, key=lambda s: 1 if str(s.get("id")) in turn_ids else 0)
    for s in ordered:
        pts = s.get("pts")
        if not isinstance(pts, list) or len(pts) < 2:
            continue
        is_turn = str(s.get("id")) in turn_ids
        is_eraser = s.get("brush") == "eraser"
        col = 255 if is_eraser else (0 if is_turn else 170)
        prev = None
        for p in pts:
            if not isinstance(p, list) or len(p) < 2:
                continue
            pr = float(p[2]) if len(p) >= 3 else 0.6
            cur = to_px(float(p[0]), float(p[1]))
            width = max(2, int(2 + 5 * pr)) if not is_eraser else 14
            if prev is not None:
                draw.line([prev, cur], fill=col, width=width)
            prev = cur

    bio = io.BytesIO()
    img.save(bio, format="PNG", optimize=True)
    return bio.getvalue()


def simplify_polylines(strokes: list[dict[str, object]], tolerance: float = 0.002) -> list[dict[str, object]]:
    """Douglas-Peucker on normalized [x,y,p] points; keeps ids and brush."""

    def dp(pts: list[list[float]]) -> list[list[float]]:
        if len(pts) < 3:
            return pts
        (x0, y0), (x1, y1) = pts[0][:2], pts[-1][:2]
        dx, dy = x1 - x0, y1 - y0
        norm = (dx * dx + dy * dy) ** 0.5 or 1e-9
        best_i, best_d = 0, -1.0
        for i in range(1, len(pts) - 1):
            px, py = pts[i][:2]
            d = abs(dy * px - dx * py + x1 * y0 - y1 * x0) / norm
            if d > best_d:
                best_i, best_d = i, d
        if best_d > tolerance:
            return dp(pts[: best_i + 1])[:-1] + dp(pts[best_i:])
        return [pts[0], pts[-1]]

    out = []
    for s in strokes:
        pts = s.get("pts")
        if not isinstance(pts, list) or len(pts) < 2:
            continue
        clean = [
            [round(float(p[0]), 4), round(float(p[1]), 4), round(float(p[2]) if len(p) >= 3 else 0.6, 2)]
            for p in pts
            if isinstance(p, list) and len(p) >= 2
        ]
        out.append({"id": s.get("id"), "brush": s.get("brush"), "pts": dp(clean)})
    return out


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



