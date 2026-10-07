"""
The answer in handwriting: ``packages/hand`` writes it, agentd places and paces it.

**Why a layout request.** Where an answer fits depends on its block's size, and the size on the
wrap width. ``packages/hand/scripts/layouts.ts`` simulates the text once per requested width and
returns the strokes in millimetres from the start of the first baseline, with the hand's own
timing (ms). The persona's motor plan, tremor and pressure are its business
(packages/hand/README.md); a calm one suits an answer: ``archivist`` (upright print) by
default, ``sketcher`` (cursive) on request.

**A warm worker.** Starting Node and compiling the TypeScript costs ~0.8 s, and agentd used to
pay it on every answer (with three widths, 4–5 s before the first stroke on 2026-10-06).
:class:`HandWorker` keeps one ``layouts.ts --serve`` process running (node with tsx's CLI
directly, so stopping it stops Node too), one request per line, restarted if it dies; the
one-shot :func:`layouts` (via pnpm) remains for scripts. :meth:`HandWorker.metrics` measures
the persona once (millimetres per character, line pitch), so a block can be sized before the
text exists.

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

from .aio import within
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
    lines: list[int] | None = None  # each stroke's line (0 first), when the hand said
    shift_mm: float = 0.0  # added below the last line by separate_lines

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
    return _parse(json.loads(r.stdout))


def _parse(data: dict) -> list[Layout]:
    if "error" in data:
        raise HandUnavailable(str(data["error"])[:300])
    return [
        Layout(
            width_mm=float(lay["width"]),
            bbox_mm=tuple(lay["bbox"]),  # type: ignore[arg-type]
            duration_ms=float(lay["duration"]),
            strokes=[(float(s["down"]), float(s["up"]), s["pts"]) for s in lay["strokes"]],
            lines=[int(s.get("line") or 0) for s in lay["strokes"]],
        )
        for lay in data["layouts"]
    ]


def line_bands(layout: Layout) -> dict[int, tuple[float, float]]:
    """Each line's ink from top to bottom, mm (glyph extents: ascenders to descenders)."""
    bands: dict[int, tuple[float, float]] = {}
    for (_, _, pts), line in zip(
        layout.strokes, layout.lines or [0] * len(layout.strokes), strict=True
    ):
        ys = [p[1] for p in pts]
        if ys:
            lo, hi = bands.get(line, (min(ys), max(ys)))
            bands[line] = (min(lo, min(ys)), max(hi, max(ys)))
    return bands


def separate_lines(layout: Layout, gap_mm: float) -> Layout:
    """
    The layout with every line at least ``gap_mm`` below the ink of the line above: a compact
    pitch can bring a line's descenders onto the next line's ascenders, and then that line and
    all after it move down just enough. Timing is unchanged (only the pen-up travel lengthens).
    """
    bands = line_bands(layout)
    shift: dict[int, float] = {}
    total = 0.0
    prev_bottom = None
    for line in sorted(bands):
        top, bottom = bands[line]
        if prev_bottom is not None and top + total < prev_bottom + gap_mm:
            total = prev_bottom + gap_mm - top
        shift[line] = total
        prev_bottom = bottom + total
    if total == 0.0:
        return layout
    lines = layout.lines or [0] * len(layout.strokes)
    strokes = [
        (d, u, [[p[0], p[1] + shift.get(ln, 0.0), *p[2:]] for p in pts])
        for (d, u, pts), ln in zip(layout.strokes, lines, strict=True)
    ]
    x0, y0, x1, y1 = layout.bbox_mm
    last = max(shift)
    return Layout(
        layout.width_mm,
        (x0, y0, x1, y1 + shift[last]),
        layout.duration_ms,
        strokes,
        layout.lines,
        layout.shift_mm + shift[last],
    )


@dataclass(frozen=True)
class Metrics:
    """
    A persona's writing at scale 1, in mm: advance per character, line pitch, and the ink above
    and below the baseline (``ascent`` negative, since the layout's y grows down the page).
    """

    mm_per_char: float
    pitch: float
    ascent: float
    descent: float
    x_height: float = 0.0  # lowercase height (0: not measured)


class HandWorker:
    """One warm ``layouts.ts --serve`` process (module docstring)."""

    def __init__(self, repo: Path = REPO, timeout_s: float = 30.0) -> None:
        self.repo = repo
        self.timeout_s = timeout_s
        self._proc: asyncio.subprocess.Process | None = None
        self._lock = asyncio.Lock()
        self._metrics: dict[str, Metrics] = {}

    def _cmd(self) -> list[str]:
        cli = self.repo / "packages" / "hand" / "node_modules" / "tsx" / "dist" / "cli.mjs"
        node = shutil.which("node")
        if not node or not cli.exists():
            raise HandUnavailable("node or packages/hand/node_modules/tsx missing (pnpm install)")
        return [node, str(cli), "scripts/layouts.ts", "--serve"]

    async def start(self) -> None:
        if self._proc is not None and self._proc.returncode is None:
            return
        self._proc = await asyncio.create_subprocess_exec(
            *self._cmd(),
            cwd=self.repo / "packages" / "hand",
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
            limit=2**26,
        )
        assert self._proc.stdout is not None
        line = await within(self._proc.stdout.readline(), self.timeout_s)
        if not line or not json.loads(line).get("ready"):
            raise HandUnavailable("layouts.ts --serve did not start")

    async def close(self) -> None:
        if self._proc is not None and self._proc.returncode is None:
            self._proc.kill()
            await self._proc.wait()
        self._proc = None

    async def layouts(
        self,
        text: str,
        persona: str = "archivist",
        widths: tuple[float, ...] = (80.0,),
        seed: int = 7,
        pitch: float | None = None,
    ) -> list[Layout]:
        """
        As :func:`layouts`, through the warm process (started, or restarted once, as needed).
        ``pitch``: baseline to baseline, mm (default the persona's own line spacing).
        """
        body = {"text": text, "persona": persona, "seed": seed, "widths": list(widths)}
        if pitch:
            body["pitch"] = pitch
        req = json.dumps(body)
        async with self._lock:
            for attempt in range(2):
                try:
                    await self.start()
                    assert self._proc is not None and self._proc.stdin and self._proc.stdout
                    self._proc.stdin.write(req.encode("utf-8") + b"\n")
                    await self._proc.stdin.drain()
                    line = await within(self._proc.stdout.readline(), self.timeout_s)
                    if not line:
                        raise HandUnavailable("layouts.ts --serve exited")
                    return _parse(json.loads(line))
                except (TimeoutError, OSError, ValueError, HandUnavailable) as e:
                    await self.close()
                    if attempt:
                        raise HandUnavailable(f"worker: {e}") from e
        raise HandUnavailable("unreachable")

    async def metrics(self, persona: str) -> Metrics:
        """The persona's character advance and line pitch, measured once (three short layouts)."""
        if persona in self._metrics:
            return self._metrics[persona]
        sample = "the quick brown fox jumps over the lazy dog"
        one = (await self.layouts(sample, persona, (1000.0,)))[0]
        x1 = (await self.layouts("x", persona, (1000.0,)))[0]
        x2 = (await self.layouts("x\nx", persona, (1000.0,)))[0]
        m = Metrics(
            mm_per_char=(one.bbox_mm[2] - min(one.bbox_mm[0], 0.0)) / len(sample),
            pitch=max(1.0, x2.bbox_mm[3] - x1.bbox_mm[3]),
            ascent=one.bbox_mm[1],
            descent=one.bbox_mm[3],
            x_height=-(await self.layouts("xxxx", persona, (1000.0,)))[0].bbox_mm[1],
        )
        self._metrics[persona] = m
        return m


def lines_in(layout: Layout, pitch: float) -> int:
    """How many lines a layout holds: the hand's line numbers, else its depth / ``pitch``."""
    if not layout.strokes:
        return 0
    if layout.lines:
        return max(layout.lines) + 1
    return 1 + max(0, round(layout.bbox_mm[3] / pitch))


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
