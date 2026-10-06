"""
Glyph skeletons for the hand simulator, extracted from A. V. Hershey's single-line fonts.

The simulator (packages/hand) plans a writing movement along a *skeleton*: the centre line a
pen follows, with no outline or fill. Hershey's 1967 fonts for the U.S. Naval Weapons Laboratory
are exactly that, drawn as polylines on an integer grid, and they are public domain. This
script reads three of them through the `HersheyFonts` package and writes the compact JSON the
TypeScript side imports (`src/glyphs.json`), so the browser and Node never need Python.

Faces kept, by the persona that uses them:

- `futural`: simplex sans ("Futura light"), the upright print of the Archivist and the
  Mathematician;
- `scripts`: simplex script, one connected cursive line per lowercase letter, for the Sketcher,
  the Elder and the Calligrapher;
- `rowmans`: simplex roman, a single-line serif print kept for personas yet to come;
- `greek`: simplex Greek, re-keyed from Hershey's Latin positions (a→α, p→π, …) to Unicode, for
  the Mathematician's symbols.

Coordinates are Hershey units: x from the glyph's left edge, y down, baseline at 0, capitals
reaching -21 (21 units per cap height in all four faces). Each glyph is `[advance, strokes]`,
a stroke being a flat list `[x0, y0, x1, y1, ...]` of integers, in Hershey's drawing order.

Run (from the repo root):  uv run --with Hershey-Fonts python packages/hand/scripts/gen_glyphs.py
"""

from __future__ import annotations

import json
from pathlib import Path

from HersheyFonts import HersheyFonts

OUT = Path(__file__).resolve().parent.parent / "src" / "glyphs.json"
FACES = ["futural", "scripts", "rowmans"]
ASCII = [chr(c) for c in range(32, 127)]
# Hershey's Greek font sits on the Latin keys in this order (Hershey's own table).
GREEK = dict(zip("abgdezhqiklmnxoprstufcywABGDEZHQIKLMNXOPRSTUFCYW",
                 "αβγδεζηθικλμνξοπρστυφχψωΑΒΓΔΕΖΗΘΙΚΛΜΝΞΟΠΡΣΤΥΦΧΨΩ"))
BASELINE = 9  # Hershey's baseline in the package's coordinates (capitals span -12..9)


def glyph(f: HersheyFonts, ch: str) -> list | None:
    g = next(iter(f.glyphs_for_text(ch)), None)
    if g is None:
        return None
    strokes = []
    for s in g.strokes:
        flat: list[int] = []
        for x, y in s:
            flat += [int(x - g.left_offset), int(y - BASELINE)]
        if flat:
            strokes.append(flat)
    return [int(g.char_width), strokes]


def main() -> None:
    f = HersheyFonts()
    out: dict = {"unitsPerCap": 21, "faces": {}}
    for name in FACES:
        f.load_default_font(name)
        out["faces"][name] = {ch: g for ch in ASCII if (g := glyph(f, ch)) is not None}
    f.load_default_font("greek")
    out["faces"]["greek"] = {uni: g for lat, uni in GREEK.items() if (g := glyph(f, lat))}
    OUT.write_text(json.dumps(out, separators=(",", ":"), ensure_ascii=False) + "\n", encoding="utf-8")
    n = sum(len(v) for v in out["faces"].values())
    print(f"{OUT}: {n} glyphs, {OUT.stat().st_size} bytes")


if __name__ == "__main__":
    main()
