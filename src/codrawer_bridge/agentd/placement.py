"""
Where the answer goes: free space near what the user asked about, never across existing ink.

**The rule** (ADR 009 §1, "Placement"): a reply is written beside the ink it answers, in the
margin or below it, keeping clear of every stroke already on the page (the user's and earlier
agent ink alike); never across ink. This module turns that into a search.

**Occupancy.** The page is rasterised into square cells (``cell`` page units, 12 by default:
about 1.3 mm on a Paper Pro, whose page is 1620 × 2160 units over 179.6 × 239.5 mm). Every
segment of every stroke marks the cells it passes through, so a long thin stroke blocks only its
own path, not its bounding box (a circle drawn around a word leaves its inside free, which a
bounding-box test would not). A summed-area table answers "is this rectangle, grown by the
clearance, free?" in constant time.

**Candidates.** The caller offers blocks: the answer laid out at a few wrap widths and scales
(hand.py), each a ``(w, h)`` in page units. Every block is tried at every position on a coarse
grid inside the page's margins, and each free position gets a cost:

- the gap between the block and the anchor (the selection, or the page's ink for ``ask_page``);
- where it sits: directly **below** the anchor first, as the user asked on 2026-10-06 ("the
  response should be underneath the selection"); then right of it, left of it, above it. A
  block that overlaps the anchor is never a candidate, even where the lasso's box is empty;
- below, its left edge should meet the anchor's left edge, about one line (``below_gap``)
  under the anchor's bottom; to the right or left, its top should meet the anchor's top;
- a smaller scale costs a little (writing should be its true size when it can);
- with ``prefer`` (the pending mark's spot), the distance from it, so the answer starts there.

The block never leaves the page (``page_bottom``, :func:`place`), and never sits farther than
``max_gap`` from the anchor. The cheapest wins. Units: page units throughout (x from the left
edge, not centred), converted to normalized coordinates only at the edges (:func:`to_pu`,
:class:`Placement` ``norm``).
"""

from __future__ import annotations

import math
from dataclasses import dataclass

from .page import Box

#: Millimetres per page unit on a Paper Pro (179.6 mm over 1620 units).
MM_PER_PU = 179.6 / 1620


@dataclass(frozen=True)
class Block:
    """A candidate block of writing: its size in page units, and what produced it."""

    w: float
    h: float
    layout: int = 0  # index into the caller's layouts
    scale: float = 1.0


@dataclass(frozen=True)
class Placement:
    """A block placed at ``(x, y)``, its top-left corner in page units."""

    block: Block
    x: float
    y: float
    side: str  # right | below | above | left | inside
    cost: float
    page_w: float
    page_h: float

    @property
    def rect(self) -> Box:
        return (self.x, self.y, self.x + self.block.w, self.y + self.block.h)

    @property
    def norm(self) -> Box:
        """The block's rectangle in normalized page coordinates."""
        x0, y0, x1, y1 = self.rect
        return (x0 / self.page_w, y0 / self.page_h, x1 / self.page_w, y1 / self.page_h)


def to_pu(box: Box, page_w: float, page_h: float) -> Box:
    return (box[0] * page_w, box[1] * page_h, box[2] * page_w, box[3] * page_h)


class Occupancy:
    """
    Which cells of the page hold ink. ``strokes`` are lists of normalized ``[x, y, …]`` points;
    ``height`` (page units) may exceed the page's for a scrolled page.
    """

    def __init__(
        self,
        strokes: list[list[list[float]]],
        page_w: float = 1620.0,
        page_h: float = 2160.0,
        height: float | None = None,
        cell: float = 12.0,
    ) -> None:
        self.page_w, self.page_h, self.cell = page_w, page_h, cell
        self.height = max(page_h, height or page_h)
        self.nx = int(math.ceil(page_w / cell))
        self.ny = int(math.ceil(self.height / cell))
        grid = [[0] * self.nx for _ in range(self.ny)]
        for pts in strokes:
            prev = None
            for p in pts:
                cur = (p[0] * page_w, p[1] * page_h)
                if prev is None:
                    self._mark(grid, cur)
                else:
                    d = math.hypot(cur[0] - prev[0], cur[1] - prev[1])
                    n = max(1, int(d / (cell / 2)))
                    for k in range(1, n + 1):
                        self._mark(
                            grid,
                            (
                                prev[0] + (cur[0] - prev[0]) * k / n,
                                prev[1] + (cur[1] - prev[1]) * k / n,
                            ),
                        )
                prev = cur
        # summed-area table, one row and column of zeros in front
        sat = [[0] * (self.nx + 1) for _ in range(self.ny + 1)]
        for j in range(self.ny):
            run = 0
            row, above, out = grid[j], sat[j], sat[j + 1]
            for i in range(self.nx):
                run += row[i]
                out[i + 1] = above[i + 1] + run
        self.sat = sat

    def _mark(self, grid: list[list[int]], xy: tuple[float, float]) -> None:
        i, j = int(xy[0] // self.cell), int(xy[1] // self.cell)
        if 0 <= i < self.nx and 0 <= j < self.ny:
            grid[j][i] = 1

    def count(self, x0: float, y0: float, x1: float, y1: float) -> int:
        """Inked cells touching the rectangle (page units; clipped to the grid)."""
        i0 = max(0, int(x0 // self.cell))
        j0 = max(0, int(y0 // self.cell))
        i1 = min(self.nx, int(math.ceil(x1 / self.cell)))
        j1 = min(self.ny, int(math.ceil(y1 / self.cell)))
        if i1 <= i0 or j1 <= j0:
            return 0
        s = self.sat
        return s[j1][i1] - s[j0][i1] - s[j1][i0] + s[j0][i0]

    def free(self, rect: Box, clearance: float) -> bool:
        x0, y0, x1, y1 = rect
        return self.count(x0 - clearance, y0 - clearance, x1 + clearance, y1 + clearance) == 0


#: Extra cost by side (page units): a reply is looked for under the question first.
SIDE_COST = {"below": 0.0, "right": 120.0, "left": 280.0, "above": 320.0}

#: The gap under the anchor a block below it keeps, page units (about one written line).
BELOW_GAP = 80.0


def _side(rect: Box, anchor: Box) -> tuple[str, float, float]:
    """
    Which side of ``anchor`` the block is on (``inside`` when they overlap), the gap between
    them, and the misalignment. A block below the anchor's bottom edge is ``below`` wherever it
    sits across, so the answer goes under the selection rather than beside it whenever it can.
    """
    x0, y0, x1, y1 = rect
    ax0, ay0, ax1, ay1 = anchor
    dx = max(ax0 - x1, x0 - ax1, 0.0)
    dy = max(ay0 - y1, y0 - ay1, 0.0)
    gap = math.hypot(dx, dy)
    if y0 >= ay1 - 1e-6:
        return "below", gap, abs(x0 - ax0) + abs(dy - BELOW_GAP)
    if x0 >= ax1 - 1e-6:
        return "right", gap, abs(y0 - ay0)
    if x1 <= ax0 + 1e-6:
        return "left", gap, abs(y0 - ay0)
    if y1 <= ay0 + 1e-6:
        return "above", gap, abs(x0 - ax0)
    return "inside", gap, 0.0


def place(
    occ: Occupancy,
    blocks: list[Block],
    anchor: Box,
    *,
    prefer: tuple[float, float] | None = None,
    clearance: float = 36.0,
    margins: tuple[float, float, float, float] = (150.0, 70.0, 60.0, 70.0),
    step: float = 18.0,
    page_bottom: float | None = None,
    max_gap: float | None = None,
    page_top: float = 0.0,
) -> Placement | None:
    """
    The cheapest free position for any of ``blocks`` (module docstring), or None when none fits.

    ``anchor`` is in page units. ``margins`` are left, top, right, bottom in page units (the left
    one is wide: xochitl's toolbar covers the page's left edge while it is open). The block stays
    on the page: its bottom edge at most ``page_bottom`` (default the page's height; a page the
    user has already extended by writing further down passes that extent) less the bottom margin.
    Never past it, since a reply below the page's end would be off screen or would grow the page.
    So a selection at the bottom edge gets its answer beside it (right, then left), above it, or
    smaller, before anywhere else. With ``max_gap``, a block farther than that from the anchor
    counts as not fitting (the caller then answers on the glasses only). ``page_top`` (page
    units) keeps the block below the top of the screen when the user has scrolled down; the
    caller passes the screen's bottom as ``page_bottom`` then (xochitl grows the page there).
    """
    ml, mt, mr, mb = margins
    mt += page_top
    W = occ.page_w
    bottom = (page_bottom if page_bottom is not None else occ.page_h) - mb
    best: Placement | None = None
    for b in blocks:
        if b.w > W - ml - mr or b.h > bottom - mt:
            continue
        scale_cost = (1.0 - b.scale) * 300.0 + b.h * 0.25
        # the ideal spot first (under the anchor, left edges aligned, one line down), then a grid
        ideal = (min(max(anchor[0], ml), W - mr - b.w), anchor[3] + BELOW_GAP)
        grid = (
            (x, y) for y in _steps(mt, bottom - b.h, step) for x in _steps(ml, W - mr - b.w, step)
        )
        for x, y in [ideal, *grid]:
            if y < mt or y + b.h > bottom or x < ml or x + b.w > W - mr:
                continue
            rect = (x, y, x + b.w, y + b.h)
            side, gap, misalign = _side(rect, anchor)
            if side == "inside" or (side == "below" and y - anchor[3] < BELOW_GAP * 0.6):
                continue  # never over the selection; below, at least most of a line clear
            if max_gap is not None and gap > max_gap:
                continue
            cost = gap + SIDE_COST[side] + (1.0 if side == "below" else 0.35) * misalign
            cost += scale_cost
            if prefer is not None:
                # the spot was chosen already (by these same rules, when it was reserved): stay
                cost = scale_cost + 3.0 * math.hypot(x - prefer[0], y - prefer[1])
            if (best is None or cost < best.cost) and occ.free(rect, clearance):
                best = Placement(b, x, y, side, cost, occ.page_w, occ.page_h)
    return best


def _steps(lo: float, hi: float, step: float):
    v = lo
    while v <= hi:
        yield v
        v += step
