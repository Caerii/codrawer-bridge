"""
Where the answer goes: free space near what the user asked about, never across existing ink.

**The rule** (ADR 009 §1, "Placement"): a reply is written under the ink it answers, keeping
clear of every stroke already on the page (the user's and earlier agent ink alike); never across
ink, never above it ("replies should probably be below, not above, the selected area", the user,
2026-10-07). This module turns that into a search.

**Occupancy.** The page is rasterised into square cells (``cell`` page units, 12 by default:
about 1.3 mm on a Paper Pro, whose page is 1620 × 2160 units over 179.6 × 239.5 mm). Every
segment of every stroke marks the cells it passes through, so a long thin stroke blocks only its
own path, not its bounding box (a circle drawn around a word leaves its inside free, which a
bounding-box test would not). A summed-area table answers "is this rectangle, grown by the
clearance, free?" in constant time.

**Candidates.** The caller offers blocks: the answer laid out at a few wrap widths and scales
(hand.py), each a ``(w, h)`` in page units, tried largest scale first (writing should be its true
size when it can), then shortest. :func:`place` takes the first that is free, in three tiers:

1. **below**: the block's top ``BELOW_GAP`` under the anchor's bottom (the selection, or the
   page's ink for ``ask_page``), its left edge on the anchor's, or shifted sideways within that
   band when ink is in the way (the only "left" there is);
2. **right**, tops aligned, when ink lies just below and the whole block fits beside the anchor;
3. the first free band **further down**, scanning past the ink in between, left-aligned again.
   The page grows downward (to the bridge's ``max_page_y``), so there is always room below.
   :func:`leader` then draws a short curved arrow from the selection to the block.

Never above, never left of the anchor. A block that overlaps the anchor is never a candidate,
even where the lasso's box is empty. ``prefer`` (a spot chosen already) and :func:`place_at` (the
tablet's proposed spot) are tried as-is first, under the same rules. Units: page units throughout
(x from the left edge, not centred), converted to normalized coordinates only at the edges
(:func:`to_pu`, :class:`Placement` ``norm``).
"""

from __future__ import annotations

import math
from dataclasses import dataclass

from .geometry import GEOMETRY
from .page import Box

#: Physical conversion for the configured tablet; shared with the transmitted handwriting.
MM_PER_PU = GEOMETRY.mm_per_pu


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


def fill_strokes(
    rect: Box, page_w: float, page_h: float, step: float = 8.0
) -> list[list[list[float]]]:
    """
    A rectangle (page units) as horizontal 'strokes' (normalized points) close enough together to
    mark every Occupancy cell inside it: how a block reserved for an answer still being thought
    about counts as occupied for other answers.
    """
    x0, y0, x1, y1 = rect
    rows = []
    y = y0
    while y <= y1:
        rows.append([[x0 / page_w, y / page_h], [x1 / page_w, y / page_h]])
        y += step
    return rows


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


#: The gap between the anchor's right edge and a block beside it (tier 2), page units.
RIGHT_GAP = 48.0

#: The gap between the anchor's ink bottom and the first line's glyph tops (the block's top: its
#: height starts at the hand's ascent), page units: 36 is 4 mm, about half a ruled line. It was 80
#: (9 mm) until the user found answers "a little too much lower down" (2026-10-07).
BELOW_GAP = 36.0


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


def _size_order(blocks: list[Block]) -> list[Block]:
    """Largest scale first, then the shortest (widest) block: true size and few lines."""
    return sorted(blocks, key=lambda b: ((1.0 - b.scale) * 300.0 + b.h * 0.25, -b.w))


def place(
    occ: Occupancy,
    blocks: list[Block],
    anchor: Box,
    *,
    prefer: tuple[float, float] | None = None,
    clearance: float = 24.0,
    margins: tuple[float, float, float, float] = (150.0, 70.0, 60.0, 70.0),
    step: float = 18.0,
    page_bottom: float | None = None,
    max_gap: float | None = None,
    page_top: float = 0.0,
) -> Placement | None:
    """
    The first free position for any of ``blocks``, by the tiers of the module docstring, or None
    when none fits.

    ``anchor`` is in page units. ``margins`` are left, top, right, bottom in page units (the left
    one is wide: xochitl's toolbar covers the page's left edge while it is open). The block's
    bottom edge stays above ``page_bottom`` (default the page's height) less the bottom margin:
    the caller passes how far the page may grow (service.py, the bridge's ``max_page_y``).
    ``page_top`` (page units) keeps the block below the top of the screen when the user has
    scrolled down. With ``max_gap``, tier 3 looks no farther than that below the anchor.
    """
    ml, mt, mr, mb = margins
    mt += page_top
    W = occ.page_w
    bottom = (page_bottom if page_bottom is not None else occ.page_h) - mb
    ax0, ay0, ax1, ay1 = anchor
    order = [b for b in _size_order(blocks) if b.w <= W - ml - mr]

    def fits(b: Block, x: float, y: float) -> bool:
        if x < ml or y < mt or x + b.w > W - mr or y + b.h > bottom:
            return False
        return _side((x, y, x + b.w, y + b.h), anchor)[0] != "inside" and occ.free(
            (x, y, x + b.w, y + b.h), clearance
        )

    def at(b: Block, x: float, y: float, side: str) -> Placement:
        return Placement(b, x, y, side, 0.0, occ.page_w, occ.page_h)

    def band(y: float) -> Placement | None:
        """
        A block at height ``y``: any block left-aligned with the anchor first (a narrower one
        beats a wider one pushed sideways), else the nearest sideways shift that fits.
        """
        home = max(ax0, ml)
        for b in order:
            if fits(b, home, y):
                return at(b, home, y, "below")
        for b in order:
            xs = sorted(_steps(ml, W - mr - b.w, step), key=lambda x: abs(x - home))
            for x in [min(home, W - mr - b.w), *xs]:
                if fits(b, x, y):
                    return at(b, x, y, "below")
        return None

    if prefer is not None:  # a spot chosen already, by these same rules: stay there if it holds
        px, py = prefer
        for b in order:
            side = _side((px, py, px + b.w, py + b.h), anchor)[0]
            if side in ("below", "right") and fits(b, px, py):
                return at(b, px, py, side)
    # 1. directly below, at the gap
    y1 = max(ay1 + BELOW_GAP, mt)
    if (p := band(y1)) is not None:
        return p
    # 2. right of the anchor, tops aligned, the whole block beside it
    for b in order:
        x, y = ax1 + RIGHT_GAP, max(ay0, mt)
        if fits(b, x, y):
            return at(b, x, y, "right")
    # 3. the first free band further down, past the ink in between
    reach = bottom if max_gap is None else min(bottom, ay1 + max_gap)  # the block's top, at most
    y = y1 + step
    while y <= reach:
        if (p := band(y)) is not None:
            return p
        y += step
    return None


def place_at(
    occ: Occupancy,
    blocks: list[Block],
    anchor: Box,
    at: tuple[float, float],
    *,
    clearance: float = 24.0,
    margins: tuple[float, float, float, float] = (150.0, 70.0, 60.0, 70.0),
    page_bottom: float | None = None,
    max_gap: float | None = None,
    page_top: float = 0.0,
) -> Placement | None:
    """
    The first of ``blocks`` (in :func:`place`'s size order) whose top-left at ``at`` (page units)
    obeys every rule :func:`place` applies: free of ink by ``clearance``, inside the margins and
    the page, below the anchor or right of it (never over it, above it or left of it), within
    ``max_gap`` of it. None when none does: the caller then lets :func:`place` choose. This is how
    the tablet's proposed spot (where its thinking doodle already is) is honoured, so the answer
    starts where the user is already looking.
    """
    ml, mt, mr, mb = margins
    mt += page_top
    bottom = (page_bottom if page_bottom is not None else occ.page_h) - mb
    x, y = at
    for b in _size_order(blocks):
        rect = (x, y, x + b.w, y + b.h)
        if x < ml or y < mt or rect[2] > occ.page_w - mr or rect[3] > bottom:
            continue
        side, gap, _ = _side(rect, anchor)
        if side not in ("below", "right") or (max_gap is not None and gap > max_gap):
            continue
        if occ.free(rect, clearance):
            return Placement(b, x, y, side, 0.0, occ.page_w, occ.page_h)
    return None


def leader(
    occ: Occupancy, anchor: Box, rect: Box, line_pu: float, clearance: float = 8.0
) -> list[tuple[float, float]] | None:
    """
    A short curved arrow from under ``anchor`` to the block ``rect`` (page units), when the block
    sits more than two lines (``line_pu``) below the anchor: tier 3 put it past other ink, and
    the eye needs the way. The curve runs down the left of both, bowing out, and returns its
    points (the shaft, then the head's two barbs as one stroke: shaft end, barb, end, barb).
    None when no arrow is needed, or when its path would cross ink (then the gap speaks alone).
    """
    ax0, _, _, ay1 = anchor
    bx0, by0 = rect[0], rect[1]
    if by0 - ay1 <= 2 * line_pu:
        return None
    sx, sy = ax0 - 16, ay1 + 10
    ex, ey = bx0 - 18, by0 + min(line_pu, rect[3] - by0) * 0.5
    cx, cy = min(sx, ex) - 50, (sy + ey) / 2
    pts = []
    n = max(8, int(abs(ey - sy) / 24))
    for k in range(n + 1):
        t = k / n
        pts.append(
            (
                (1 - t) ** 2 * sx + 2 * (1 - t) * t * cx + t * t * ex,
                (1 - t) ** 2 * sy + 2 * (1 - t) * t * cy + t * t * ey,
            )
        )
    if min(p[0] for p in pts) < 20:
        return None
    for px, py in pts[1:-1]:
        if not occ.free((px, py, px, py), clearance):
            return None
    # the head: two barbs 16 units long, 30 degrees either side of the final tangent
    tx, ty = ex - pts[-2][0], ey - pts[-2][1]
    norm = math.hypot(tx, ty) or 1.0
    tx, ty = tx / norm, ty / norm
    barbs = []
    for sgn in (1, -1):
        c, s_ = math.cos(math.radians(150)), sgn * math.sin(math.radians(150))
        barbs.append((ex + 16 * (tx * c - ty * s_), ey + 16 * (tx * s_ + ty * c)))
    return pts + [barbs[0], (ex, ey), barbs[1]]


def _steps(lo: float, hi: float, step: float):
    v = lo
    while v <= hi:
        yield v
        v += step
