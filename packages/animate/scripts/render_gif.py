"""
Render the animate spike's demos (scripts/demo.ts output) to GIFs for the investigation.

Each GIF frame has two panels on paper-white: on the left, the **editing view** of the frame
being shown, as the animator would see it while drawing it (the frame in ink over its onion
skin: two frames back in red, one ahead in blue, fading with distance; generated in-between ink
in violet, key ink in black); on the right, **playback**, the same frame alone. Both step through
the animation at its own fps, one GIF frame per tick.

Strokes are drawn at 2x and downsampled for smooth edges. Pressure sets the width a little.

    uv run --with pillow python packages/animate/scripts/render_gif.py <demo-dir> docs/media
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

PANEL = 300  # px per panel side (output)
SS = 2  # supersampling
PAPER = (246, 244, 238)
INK = (24, 24, 24)
AGENT = (110, 64, 200)


def hex_rgb(h: str) -> tuple[int, int, int]:
    h = h.lstrip("#")
    return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))


def mix(c: tuple[int, int, int], a: float) -> tuple[int, int, int]:
    return tuple(round(p + (x - p) * a) for x, p in zip(c, PAPER, strict=True))  # type: ignore[return-value]


def draw_strokes(d: ImageDraw.ImageDraw, strokes, view, size, color=None, alpha=1.0, base_w=2.6):
    x0, y0, x1, y1 = view
    sx = size / (x1 - x0)
    # keep the page's aspect: one page width unit = sx px, one page height unit = sx * 2160/1620 px
    sy = sx * 2160 / 1620
    for s in strokes:
        c = color or (hex_rgb(s["color"]) if s.get("color") else (AGENT if s.get("agent") else INK))
        c = mix(c, alpha)
        pts = [((x - x0) * sx, (y - y0) * sy, p) for x, y, p in s["pts"]]
        for (ax, ay, ap), (bx, by, bp) in zip(pts, pts[1:], strict=False):
            w = base_w * SS * (0.7 + 0.6 * (ap + bp) / 2)
            d.line([(ax, ay), (bx, by)], fill=c, width=max(1, round(w)))
            r = w / 2
            d.ellipse([bx - r, by - r, bx + r, by + r], fill=c)


def render(demo: dict, out: Path):
    view = demo["view"]
    vw, vh = view[2] - view[0], (view[3] - view[1]) * 2160 / 1620
    size = PANEL * SS
    ph = round(size * vh / vw)
    try:
        font = ImageFont.truetype("arial.ttf", 13 * SS)
    except OSError:
        font = ImageFont.load_default()
    images = []
    for tick, fi in enumerate(demo["play"]):
        frame = demo["frames"][fi]
        img = Image.new("RGB", (size * 2 + 12 * SS, ph + 26 * SS), PAPER)
        d = ImageDraw.Draw(img)
        left = Image.new("RGB", (size, ph), PAPER)
        ld = ImageDraw.Draw(left)
        for g in demo["onion"][fi]:
            draw_strokes(ld, demo["frames"][g["frame"]]["strokes"], view, size, hex_rgb(g["color"]), g["opacity"], 2.2)
        draw_strokes(ld, frame["strokes"], view, size)
        right = Image.new("RGB", (size, ph), PAPER)
        draw_strokes(ImageDraw.Draw(right), frame["strokes"], view, size, INK)
        img.paste(left, (0, 26 * SS))
        img.paste(right, (size + 12 * SS, 26 * SS))
        d.line([(size + 6 * SS, 30 * SS), (size + 6 * SS, ph + 22 * SS)], fill=(200, 196, 188), width=SS)
        kind = "key" if frame["key"] else "in-between"
        d.text((8 * SS, 6 * SS), f"edit: frame {fi + 1}/{len(demo['frames'])} ({kind}), onion 2 back / 1 ahead", fill=(90, 90, 90), font=font)
        d.text((size + 20 * SS, 6 * SS), f"playback {demo['fps']} fps", fill=(90, 90, 90), font=font)
        images.append(img.resize((img.width // SS, img.height // SS), Image.LANCZOS).quantize(colors=64, dither=Image.Dither.NONE))
    ms = round(1000 / demo["fps"])
    images[0].save(out, save_all=True, append_images=images[1:], duration=ms, loop=0, optimize=True, disposal=1)
    print(f"{out}: {len(images)} frames, {out.stat().st_size // 1024} KB")


def main():
    src, dst = Path(sys.argv[1]), Path(sys.argv[2])
    dst.mkdir(parents=True, exist_ok=True)
    for f in sorted(src.glob("*.json")):
        demo = json.loads(f.read_text())
        render(demo, dst / f"animate-{demo['name']}.gif")


if __name__ == "__main__":
    main()
