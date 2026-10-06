"""
The answer in handwriting: ``packages/hand`` writes it, agentd places and paces it.

**Why a layout request.** Where an answer fits depends on its block's size, and the size on the
wrap width. ``packages/hand/scripts/layouts.ts`` simulates the text once per requested width in
one Node process (~0.8 s to start, ~0.6 s per width for 100 characters), and returns the strokes
in millimetres from the start of the first baseline, with the hand's own timing (ms). The
persona's motor plan, tremor and pressure are its business (packages/hand/README.md); a calm one
suits an answer: ``archivist`` (upright print) by default, ``sketcher`` (cursive) on request.

**From millimetres to the page** (packages/hand/src/protocol.ts, the same mapping): a Paper Pro
page is 179.6 × 239.5 mm, so ``x_norm = origin_x + scale · x_mm / 179.6`` and likewise for y over
239.5; ``scale`` magnifies (1 is true size on the tablet). Block sizes for placement.py are in
page units (1620 per page width).

**Timing.** Each point keeps the time the simulated hand drew it, divided by ``speed`` (> 1 is a
faster hand), on the Unix clock from the moment the performance starts; ``stroke_pts`` batches
gather ``batch_ms`` of points (the tablet commits each stroke when it ends, so finer batches
would only add Wi-Fi traffic). service.py sends each message when it falls due.
"""

from __future__ import annotations

import asyncio
import json
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path

from .placement import MM_PER_PU, Block

#: The Paper Pro page in millimetres (packages/hand/src/protocol.ts PAPER_PRO_MM).
PAGE_MM = (179.6, 239.5)

#: The repository root, where ``packages/hand`` lives in a checkout.
REPO = Path(__file__).resolve().parents[3]


@dataclass
class Layout:
    """The text written at one wrap width: strokes ``(down_ms, up_ms, [[x_mm, y_mm, p, t_ms]])``."""

    width_mm: float
    bbox_mm: tuple[float, float, float, float]
    duration_ms: float
    strokes: list[tuple[float, float, list[list[float]]]]

    def block(self, index: int, scale: float) -> Block:
        x0, y0, x1, y1 = self.bbox_mm
        return Block(
            w=(x1 - min(x0, 0.0)) * scale / MM_PER_PU,
            h=(y1 - y0) * scale / MM_PER_PU,
            layout=index,
            scale=scale,
        )

    def origin_for(
        self, top_left_pu: tuple[float, float], scale: float, page_w: float, page_h: float
    ) -> tuple[float, float]:
        """The baseline origin (normalized) that puts the block's corner at ``top_left_pu``."""
        x0, y0 = min(self.bbox_mm[0], 0.0), self.bbox_mm[1]
        ox = top_left_pu[0] / page_w - scale * x0 / PAGE_MM[0]
        oy = top_left_pu[1] / page_h - scale * y0 / PAGE_MM[1]
        return ox, oy


class HandUnavailable(RuntimeError):
    """No Node, pnpm or packages/hand, or the simulation failed (the message says which)."""


def layouts(
    text: str,
    persona: str = "archivist",
    widths: tuple[float, ...] = (55.0, 80.0, 110.0),
    seed: int = 7,
    repo: Path = REPO,
    timeout_s: float = 45.0,
) -> list[Layout]:
    """``text`` laid out by ``persona`` at each wrap width (mm). Raises :class:`HandUnavailable`."""
    pnpm = shutil.which("pnpm")
    if not pnpm or not (repo / "packages" / "hand" / "scripts" / "layouts.ts").exists():
        raise HandUnavailable("pnpm or packages/hand/scripts/layouts.ts not found")
    req = {"text": text, "persona": persona, "seed": seed, "widths": list(widths)}
    try:
        r = subprocess.run(
            [pnpm, "--filter", "hand", "exec", "tsx", "scripts/layouts.ts"],
            input=json.dumps(req),
            capture_output=True,
            text=True,
            encoding="utf-8",
            cwd=repo,
            timeout=timeout_s,
        )
    except (OSError, subprocess.SubprocessError) as e:
        raise HandUnavailable(str(e)) from e
    if r.returncode != 0:
        raise HandUnavailable((r.stderr or r.stdout or "layouts.ts failed").strip()[-300:])
    data = json.loads(r.stdout)
    return [
        Layout(
            width_mm=float(lay["width"]),
            bbox_mm=tuple(lay["bbox"]),  # type: ignore[arg-type]
            duration_ms=float(lay["duration"]),
            strokes=[(float(s["down"]), float(s["up"]), s["pts"]) for s in lay["strokes"]],
        )
        for lay in data["layouts"]
    ]


async def layouts_async(text: str, **kw) -> list[Layout]:
    return await asyncio.to_thread(layouts, text, **kw)


def to_messages(
    layout: Layout,
    origin: tuple[float, float],
    scale: float,
    start_ms: float,
    *,
    speed: float = 1.0,
    run: str = "0",
    id_prefix: str = "agentd_",
    color: str | None = None,
    author: str | None = None,
    batch_ms: float = 50.0,
) -> list[tuple[float, dict]]:
    """``(due_ms, message)`` pairs for every stroke: begin, point batches, end."""
    ox, oy = origin
    out: list[tuple[float, dict]] = []
    k = 1.0 / max(speed, 0.05)
    for n, (down, up, pts) in enumerate(layout.strokes):
        sid = f"{id_prefix}{run}_{n}"
        t_down = start_ms + down * k
        begin = {"t": "stroke_begin", "id": sid, "layer": "ai", "brush": "pen", "ts": int(t_down)}
        if color:
            begin["color"] = color
        if author:
            begin["author"] = author
        out.append((t_down, begin))
        batch: list[list[float]] = []
        due = None
        for x, y, p, t in pts:
            ts = start_ms + t * k
            if due is not None and ts >= due and batch:
                out.append((batch[-1][3], {"t": "stroke_pts", "id": sid, "pts": batch}))
                batch = []
            if not batch:
                due = ts + batch_ms
            batch.append(
                [
                    round(ox + scale * x / PAGE_MM[0], 5),
                    round(oy + scale * y / PAGE_MM[1], 5),
                    round(min(1.0, max(0.0, p)), 3),
                    int(ts),
                ]
            )
        if batch:
            out.append((batch[-1][3], {"t": "stroke_pts", "id": sid, "pts": batch}))
        t_up = start_ms + up * k
        out.append((t_up, {"t": "stroke_end", "id": sid, "ts": int(t_up)}))
    return out


def dots(
    x: float,
    y: float,
    page_w: float,
    page_h: float,
    start_ms: float,
    run: str,
    id_prefix: str = "agentd_",
    color: str | None = None,
    author: str | None = None,
) -> list[tuple[float, dict]]:
    """
    The pending mark: three small dots ("…") starting at ``(x, y)`` (page units, the dots'
    vertical centre), one short stroke each, 180 ms apart, as a hand would tap them.
    """
    out: list[tuple[float, dict]] = []
    for i in range(3):
        sid = f"{id_prefix}{run}_dot{i}"
        cx, cy = x + 6 + i * 22, y
        t = start_ms + i * 180
        ring = [
            [cx + 3.0 * dx, cy + 3.0 * dy] for dx, dy in ((-1, 0), (0, -1), (1, 0), (0, 1), (-1, 0))
        ]
        pts = [
            [round(px / page_w, 5), round(py / page_h, 5), 0.6, int(t + 15 * j)]
            for j, (px, py) in enumerate(ring)
        ]
        begin = {"t": "stroke_begin", "id": sid, "layer": "ai", "brush": "pen", "ts": int(t)}
        if color:
            begin["color"] = color
        if author:
            begin["author"] = author
        out += [
            (t, begin),
            (t + 75, {"t": "stroke_pts", "id": sid, "pts": pts}),
            (t + 90, {"t": "stroke_end", "id": sid, "ts": int(t + 90)}),
        ]
    return out


#: Width of the pending mark in page units: three dots 22 apart (53 units of ink) and a gap
#: wider than placement's 30-unit clearance, so the answer can start right after them.
DOTS_W = 90.0
