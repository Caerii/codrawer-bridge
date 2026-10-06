"""
Generate the Primer's fixture recordings: three handwritten proofs as stroke messages.

The Primer's tests and its offline demo need proofs *as the tablet sends them*: ``stroke_begin``
/ ``stroke_pts`` / ``stroke_end`` with real pen timing, so that line segmentation, ink signals
(pauses, erasures, rewrites) and the stroke-id matching of offline recognition are exercised on
the same messages a live session carries. This script writes them with the showcase's simulated
hand (scripts/dev/showcase.py: Hershey "scripts" cursive, public domain, smoothed with a wobble
and tremor and paced like a pen), one handwriting line per proof line:

- ``sqrt2_correct``: √2 is irrational, with p/q in lowest terms: a complete proof.
- ``sqrt2_flawed``: the same argument without the lowest-terms assumption, so the closing
  "both even, contradiction" contradicts nothing. The writer pauses 14 s before that line and
  erases and rewrites a word on line 5: ink signals the Primer should see.
- ``odd_sum``: 1 + 3 + ⋯ + (2n−1) = n² by induction: complete, with a long pause before the
  inductive step.

Output: ``src/codrawer_bridge/primer/fixtures/<name>.jsonl``, one ``{"ts": <ms>, "msg": {...}}``
per line (the replay tools' format, docs: apps/even-g2/src/recording.ts). The transcriptions
(``<name>.transcript.json``), expectations (``<name>.expected.json``) and Lean files beside them
are written by hand; their ``lines`` refer to the lines below, top to bottom.

    uv run --with Hershey-Fonts python scripts/dev/primer_fixtures.py

Deterministic: each fixture has its own seed. Stroke ids are ``<prefix>_<n>`` so a replayed
fixture is recognized by id (recognize.OfflineRecognizer).
"""

from __future__ import annotations

import json
import random
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import showcase as sc  # noqa: E402  (the simulated hand)

OUT = HERE.parent.parent / "src" / "codrawer_bridge" / "primer" / "fixtures"
PAGE_W, PAGE_H = sc.PAGE_W, sc.PAGE_H
T0 = 1_759_750_000_000  # a fixed Unix ms start, so files are reproducible

FIXTURES: dict[str, dict] = {
    "sqrt2_correct": {
        "seed": 11,
        "prefix": "sc",
        "lines": [
            "Claim: √2 is irrational.",
            "Suppose √2 = p/q, p, q integers, q > 0,",
            "in lowest terms: gcd(p, q) = 1.",
            "Then p² = 2q².",
            "p² is even, so p is even (odd² is odd).",
            "p = 2k ⇒ 4k² = 2q² ⇒ q² = 2k²,",
            "so q² is even, and q is even.",
            "Both even contradicts gcd = 1. ∎",
        ],
        "pauses": {},
    },
    "sqrt2_flawed": {
        "seed": 23,
        "prefix": "sf",
        "lines": [
            "Claim: √2 is irrational.",
            "Suppose √2 = p/q, p, q integers, q > 0.",
            "Then p² = 2q², so p² is even,",
            "hence p is even: p = 2k.",
            "4k² = 2q² ⇒ q² = 2k², so q is even.",
            "p and q are both even. Contradiction! ∎",
        ],
        "pauses": {5: 14.0},  # seconds before line index 5 (the last line)
        "rewrite": 4,  # erase and rewrite the last word of line index 4
    },
    "odd_sum": {
        "seed": 37,
        "prefix": "os",
        "lines": [
            "Claim: 1+3+...+(2n−1) = n²",
            "Base case n = 1: 1 = 1².",
            "Assume 1+3+...+(2k−1) = k².",
            "Then 1+3+...+(2k−1)+(2k+1)",
            "= k² + 2k + 1 by the hypothesis",
            "= (k + 1)². So true for k + 1. ∎",
        ],
        "pauses": {3: 9.0},
    },
}

X0, Y0, PITCH, UNIT = 120.0, 330.0, 140.0, 2.2


class Pen:
    """Writes paths as timed protocol messages: 60 Hz point batches, sender-clock ms."""

    def __init__(self, prefix: str, rng: random.Random) -> None:
        self.prefix = prefix
        self.rng = rng
        self.t = float(T0)
        self.n = 0
        self.out: list[dict] = []

    def emit(self, msg: dict) -> None:
        self.out.append({"ts": int(self.t), "msg": msg})

    def stroke(
        self, path: list[tuple[float, float]], brush: str = "pen", speed: float = 900.0
    ) -> str:
        sid = f"{self.prefix}_{self.n}"
        self.n += 1
        samples = sc._timed(
            sc._hand(path, self.rng, wobble=2.2, tremor=0.5) if brush == "pen" else path,
            speed,
            self.rng,
        )
        start = self.t
        self.emit(
            {"t": "stroke_begin", "id": sid, "layer": "user", "brush": brush, "ts": int(start)}
        )
        batch: list[list[float]] = []
        next_flush = sc.BATCH_MS
        for x, y, p, ms in samples[::2] + samples[-1:]:  # 120 Hz keeps the files small
            batch.append([round(x / PAGE_W, 4), round(y / PAGE_H, 4), round(p, 3), int(start + ms)])
            if ms >= next_flush:
                self.t = start + ms
                self.emit({"t": "stroke_pts", "id": sid, "pts": batch})
                batch = []
                next_flush += sc.BATCH_MS
        self.t = start + (samples[-1][3] if samples else 0)
        if batch:
            self.emit({"t": "stroke_pts", "id": sid, "pts": batch})
        self.emit({"t": "stroke_end", "id": sid, "ts": int(self.t)})
        return sid

    def wait(self, seconds: float) -> None:
        self.t += seconds * 1000


def write_line(
    pen: Pen, text: str, base: float
) -> list[tuple[list[list[tuple[float, float]]], float]]:
    """Write one line word by word; returns each word's paths and x offset (for rewrites)."""
    words = []
    x = X0
    space = sc.text_width(" ", UNIT) or 10 * UNIT
    for i, word in enumerate(text.split(" ")):
        paths, w = sc.lay(word, x, base, UNIT, rng=pen.rng, slant=0.1)
        for j, path in enumerate(paths):
            pen.stroke(path)
            if j < len(paths) - 1:
                pen.wait(pen.rng.uniform(0.08, 0.22))
        words.append((paths, x))
        x += w + space
        if i < len(text.split(" ")) - 1:
            pen.wait(pen.rng.uniform(0.3, 0.6))
    return words


def eraser_zigzag(x0: float, x1: float, base: float) -> list[tuple[float, float]]:
    """A scrubbing path over a word: back and forth across its box."""
    pts = []
    top, bottom = base - 26 * UNIT, base + 8 * UNIT
    steps = 7
    for i in range(steps + 1):
        y = top + (bottom - top) * i / steps
        pts.append((x0 - 10, y) if i % 2 == 0 else (x1 + 10, y))
    return pts


def build(name: str, spec: dict) -> list[dict]:
    rng = random.Random(spec["seed"])
    pen = Pen(spec["prefix"], rng)
    for i, text in enumerate(spec["lines"]):
        if sc.text_width(text, UNIT) > PAGE_W - 2 * X0:
            raise SystemExit(f"{name}: line {i + 1} is too wide: {text!r}")
        pen.wait(spec["pauses"].get(i, rng.uniform(1.2, 2.4)))
        base = Y0 + i * PITCH
        words = write_line(pen, text, base)
        if spec.get("rewrite") == i:
            paths, x = words[-1]
            last_word = text.split(" ")[-1]
            width = sc.text_width(last_word, UNIT)
            pen.wait(2.5)
            pen.stroke(eraser_zigzag(x, x + width, base), brush="eraser", speed=1400.0)
            pen.wait(3.0)
            again, _ = sc.lay(last_word, x, base, UNIT, rng=rng, slant=0.1)
            for path in again:
                pen.stroke(path)
                pen.wait(rng.uniform(0.08, 0.2))
    return pen.out


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for name, spec in FIXTURES.items():
        msgs = build(name, spec)
        path = OUT / f"{name}.jsonl"
        with path.open("w", encoding="utf-8", newline="\n") as f:
            for m in msgs:
                f.write(json.dumps(m, separators=(",", ":")) + "\n")
        strokes = sum(1 for m in msgs if m["msg"]["t"] == "stroke_begin")
        secs = (msgs[-1]["ts"] - msgs[0]["ts"]) / 1000
        print(f"{path.name}: {strokes} strokes, {len(msgs)} messages, {secs:.0f} s of writing")


if __name__ == "__main__":
    main()
