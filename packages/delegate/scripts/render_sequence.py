"""Render the delegation sequence (scripts/sequence.ts) to PNG frames and a GIF in docs/media.

Each frame is the Paper Pro page (179.6 x 239.5 mm) on warm paper, the strokes drawn with a
width from their pressure, the lasso as a dashed UI overlay, and beneath the page two strips:
the caption (what happened, including what the classifier and the consent check concluded) and
the Even G2 glance line, green on black as the glasses show it.

    uv run --with pillow python scripts/render_sequence.py
    uv run --with pillow python ../delegate/scripts/render_sequence.py --src out/marks-sequence.json --prefix marks

The second form is packages/marks' sequence: the same renderer for any `{page, frames}` file.
"""

import argparse
import json
import pathlib

from PIL import Image, ImageDraw, ImageFont

HERE = pathlib.Path(__file__).resolve().parent
SRC = HERE.parent / "out" / "delegate-sequence.json"
OUT = HERE.parents[2] / "docs" / "media"

PX = 4  # px per mm in the output
SS = 2  # supersampling for anti-aliasing
PAPER = (247, 245, 240)
CAPTION_H = 92
GLASSES_H = 46


def font(size):
    for name in ("segoeui.ttf", "arial.ttf", "DejaVuSans.ttf"):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            pass
    return ImageFont.load_default(size=size)


def mono(size):
    for name in ("consola.ttf", "cour.ttf", "DejaVuSansMono.ttf"):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            pass
    return ImageFont.load_default(size=size)


def hex_rgb(h):
    h = h.lstrip("#")
    return tuple(int(h[i : i + 2], 16) for i in (0, 2, 4))


def wrap(draw, text, f, width):
    words, lines, line = text.split(), [], ""
    for w in words:
        t = f"{line} {w}".strip()
        if draw.textlength(t, font=f) > width and line:
            lines.append(line)
            line = w
        else:
            line = t
    if line:
        lines.append(line)
    return lines


def render(frame, page, index):
    W, H = round(page[0] * PX), round(page[1] * PX)
    k = PX * SS
    img = Image.new("RGB", (W * SS, H * SS), PAPER)
    d = ImageDraw.Draw(img)
    for s in frame["ink"]:
        col = hex_rgb(s["color"])
        pts = s["pts"]
        if len(pts) == 1:
            x, y, _ = pts[0]
            d.ellipse([x * k - 2, y * k - 2, x * k + 2, y * k + 2], fill=col)
        for a, b in zip(pts, pts[1:]):
            p = (a[2] + b[2]) / 2
            w = max(1, round((s["w"] * (0.55 + 0.9 * p)) * k))
            d.line([(a[0] * k, a[1] * k), (b[0] * k, b[1] * k)], fill=col, width=w, joint="curve")
    for o in frame["overlay"]:
        pts = o["pts"]
        for i, (a, b) in enumerate(zip(pts, pts[1:])):
            if o["dashed"] and i % 2:
                continue
            d.line([(a[0] * k, a[1] * k), (b[0] * k, b[1] * k)], fill=(120, 120, 120), width=2 * SS)
    img = img.resize((W, H), Image.LANCZOS)

    out = Image.new("RGB", (W, H + CAPTION_H + GLASSES_H), (255, 255, 255))
    out.paste(img, (0, 0))
    d = ImageDraw.Draw(out)
    d.line([(0, H), (W, H)], fill=(200, 200, 200), width=1)
    f = font(17)
    y = H + 10
    d.text((14, y), f"{index}. {frame['name']}", font=font(15), fill=(110, 110, 110))
    y += 22
    for line in wrap(d, frame["caption"], f, W - 28)[:3]:
        d.text((14, y), line, font=f, fill=(30, 30, 30))
        y += 21
    gy = H + CAPTION_H
    d.rectangle([0, gy, W, gy + GLASSES_H], fill=(8, 8, 8))
    d.text((14, gy + 12), "G2", font=font(14), fill=(80, 140, 90))
    d.text((52, gy + 10), frame["glasses"] or "(nothing: no interruption)", font=mono(19), fill=(60, 255, 110) if frame["glasses"] else (60, 110, 70))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", type=pathlib.Path, default=SRC, help="the sequence JSON (default: delegate's)")
    ap.add_argument("--prefix", default="delegate", help="file name prefix in docs/media")
    args = ap.parse_args()
    data = json.loads(args.src.read_text(encoding="utf8"))
    OUT.mkdir(parents=True, exist_ok=True)
    frames = []
    for i, fr in enumerate(data["frames"], 1):
        im = render(fr, data["page"], i)
        im.save(OUT / f"{args.prefix}-{i}-{fr['name']}.png", optimize=True)
        frames.append(im.convert("P", palette=Image.ADAPTIVE, colors=64))
    frames[0].save(OUT / f"{args.prefix}-sequence.gif", save_all=True, append_images=frames[1:], duration=2600, loop=0, optimize=True)
    print(f"{len(frames)} frames -> {OUT}")


if __name__ == "__main__":
    main()
