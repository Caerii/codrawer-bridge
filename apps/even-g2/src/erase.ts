/**
 * Erasing as the tablet erases: the eraser cuts ink out of the strokes it passes over.
 *
 * ## The problem
 *
 * The tablet's bridge streams the eraser's motion live (a stroke with brush `eraser`, from the
 * Marker's eraser end), but the page's true result reaches us only when xochitl saves the page's
 * `.rm` file, seconds to a minute later (14–70 s apart in one session, 2026-10-05). Until then the
 * clients must predict what the eraser did, and the prediction is only as good as its model.
 *
 * ## What xochitl does (docs/investigations/native-erase.md)
 *
 * - **It cuts lines; it never stores the eraser.** In a v6 `.rm` an erase shows up as the original
 *   line tombstoned and its surviving pieces inserted as new lines at the original's place in the
 *   drawing order (CRDT `left`/`right` pointing at the deleted line's neighbours). No line with the
 *   eraser tool is ever written. A line wholly inside the eraser's path is simply deleted. Seen in
 *   rmc's `erasers.rm` fixture (bridge/remarkable/native/rmlines/testdata) and in the user's
 *   notebook "Test" erased on 2026-10-05.
 * - **It applies the cut when the pen lifts.** xochitl's DocumentView QML calls
 *   `controller.eraseWithLine(stroke)` from `onStrokeCompleted`; while the eraser moves, the
 *   tablet only paints the swept path out of its framebuffer. Either way the user sees ink vanish
 *   under the eraser as it moves, which is what we show.
 * - **The swept width does not depend on pressure.** The eraser's thickness is the eraser size
 *   squared (`calculateEraserThickness`), and the Marker's eraser end has a fixed one,
 *   `2.4² = 5.76` (`eraserThickness: calculateEraserThickness(2.4) / root.penScale`).
 * - **Radius ≈ 5 page px per unit of thickness.** Measured on `erasers.rm` (a Paper Pro page with
 *   the eraser end and the three eraser-tool sizes, each swept once through hatching): the gap the
 *   eraser left between surviving centrelines is ~14, ~47, ~94 and ~61 page px for thickness 1, 4,
 *   9 and 5.76, which fits `gap ≈ 10 × thickness + ink width` (ink ~4.25 px wide). So a point of a
 *   line goes when its centre is within `5 × thickness + its half width` of the eraser's centre
 *   line; for the eraser end that is 28.8 px plus the ink's half width (Paper Pro page px,
 *   1620 × 2160, ~0.11 mm each; `penScale` is 1 at the default zoom).
 *
 * ## The model here
 *
 * Erasing is data, not pixels: each point a cut removes is marked `gone` on its stroke (a mask
 * parallel to `pts`), so every renderer (glasses raster, phone stage, exports) draws the same
 * survivors, the fit view's ink bounds shrink, and the AI's and other participants' ink is never
 * touched (it is not on the tablet). Only the tablet's own ink (layer `user`) drawn before the
 * eraser is cut, as on the tablet. When the saved page arrives, its strokes replace ours and any
 * eraser drawn after the save is applied to them again (strokes.ts `applyPage`).
 *
 * ## Speed
 *
 * The cut runs on every batch of eraser points (~60 Hz), against a page that may hold thousands of
 * strokes. {@link EraseIndex} keeps a uniform grid over the page: each cell lists the runs of
 * consecutive points of each stroke that fall in it, so an eraser segment tests only the points
 * near it. The index is built once per page (lazily, at the first erase) and extended as strokes
 * finish. Measured in test/erase.test.ts.
 *
 * Pure: no DOM, no configuration; strokes.ts owns the store and calls in here.
 */
import type { Stroke } from './strokes'

/** The Paper Pro page in page px (the `.rm` scene's units); normalized x is of the width, y of the height. */
export const PAGE_W = 1620
export const PAGE_H = 2160

/** Erase radius per unit of xochitl eraser thickness, page px (calibrated on erasers.rm, above). */
export const RADIUS_PER_THICKNESS = 5

/** The Marker's eraser end: xochitl's fixed eraser thickness, 2.4 squared. */
export const RUBBER_THICKNESS = 2.4 * 2.4

/** The eraser tool's three sizes as thicknesses (size squared), for reference and calibration. */
export const ERASER_TOOL_THICKNESS = [1, 4, 9] as const

/** The eraser end's radius at the default zoom, page px (28.8): what live `eraser` strokes use. */
export const DEFAULT_ERASE_RADIUS = RADIUS_PER_THICKNESS * RUBBER_THICKNESS

/**
 * Half the width of live ink, page px. Live points carry no width; the median width of tablet ink
 * in erasers.rm is 4.25 px. Saved-page points carry their own (`[x, y, p, w]`, w a fraction of the
 * page width).
 */
export const LIVE_INK_HALF_WIDTH = 2

/** A rectangle in normalized page coords [x0, y0, x1, y1]. */
export type Box = [number, number, number, number]

/** Half a point's ink width in page px: its own for saved-page points, else {@link LIVE_INK_HALF_WIDTH}. */
export function halfWidth(p: number[], pageW = PAGE_W): number {
  return p.length >= 4 && p[3] > 0 ? (p[3] * pageW) / 2 : LIVE_INK_HALF_WIDTH
}

/**
 * The runs of points that survive on a stroke, as [start, end) index pairs, in order. An uncut
 * stroke is one run. A cut stroke drops runs of a single point: a lone point has no length to
 * draw (xochitl's surviving pieces in the files have two points or more).
 */
export function keptRuns(s: Stroke): Array<[number, number]> {
  const n = s.pts.length
  if (!s.gone || !s.goneCount) return n ? [[0, n]] : []
  const out: Array<[number, number]> = []
  let i = 0
  while (i < n) {
    while (i < n && s.gone[i]) i++
    const a = i
    while (i < n && !s.gone[i]) i++
    if (i - a >= 2) out.push([a, i])
  }
  return out
}

/** True when the eraser removed every point of the stroke. */
export function fullyErased(s: Stroke): boolean {
  return !!s.goneCount && s.goneCount >= s.pts.length
}

/** One run of a stroke's points [i0, i1) that falls in one grid cell. */
class Entry {
  constructor(
    readonly s: Stroke,
    readonly i0: number,
    readonly i1: number,
  ) {}
}

/**
 * A uniform grid over the page for finding the points near an eraser segment.
 *
 * Invariants: a stroke is added once, finished (its points no longer change); each of its points
 * belongs to exactly one entry; the index is rebuilt (by the store) whenever strokes are replaced,
 * restarted or dropped. Coordinates are page px; cells are `cell` page px square.
 */
export class EraseIndex {
  private cells = new Map<number, Entry[]>()
  private indexed = new Set<Stroke>()
  /** the widest ink half width added so far, page px: how far beyond the radius a centre may count */
  private maxHalf = LIVE_INK_HALF_WIDTH

  constructor(
    public pageW = PAGE_W,
    public pageH = PAGE_H,
    private cell = 64,
  ) {}

  /** Forget everything (a new page, or strokes replaced). */
  reset(pageW = this.pageW, pageH = this.pageH) {
    this.cells.clear()
    this.indexed.clear()
    this.maxHalf = LIVE_INK_HALF_WIDTH
    this.pageW = pageW
    this.pageH = pageH
  }

  has(s: Stroke): boolean {
    return this.indexed.has(s)
  }

  get size(): number {
    return this.indexed.size
  }

  // Cell keys pack two signed cell indices into one number; pages scrolled past their edges give
  // negative or large coordinates, so the offset leaves room on both sides.
  private key(cx: number, cy: number): number {
    return (cx + 32768) * 65536 + (cy + 32768)
  }

  /** Index a finished stroke's points. */
  add(s: Stroke) {
    if (this.indexed.has(s)) return
    this.indexed.add(s)
    const { pts } = s
    const W = this.pageW
    const H = this.pageH
    const c = this.cell
    let run0 = 0
    let key = NaN
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i]
      const hw = halfWidth(p, W)
      if (hw > this.maxHalf) this.maxHalf = hw
      const k = this.key(Math.floor((p[0] * W) / c), Math.floor((p[1] * H) / c))
      if (k !== key) {
        if (i > run0) this.push(key, new Entry(s, run0, i))
        key = k
        run0 = i
      }
    }
    if (pts.length > run0) this.push(key, new Entry(s, run0, pts.length))
  }

  private push(key: number, e: Entry) {
    const list = this.cells.get(key)
    if (list) list.push(e)
    else this.cells.set(key, [e])
  }

  /**
   * Cut along the eraser segment a→b (normalized page coords; a = b for a single point) with
   * radius `r` (page px): every point of an accepted stroke whose centre lies within
   * `r + its half width` of the segment is marked gone. Grows `dirty` (normalized, covering the
   * removed ink) and returns how many points went.
   */
  cutSegment(ax: number, ay: number, bx: number, by: number, r: number, accept: (s: Stroke) => boolean, dirty: Box): number {
    const W = this.pageW
    const H = this.pageH
    const Ax = ax * W
    const Ay = ay * H
    const Bx = bx * W
    const By = by * H
    const reach = r + this.maxHalf
    const c = this.cell
    const cx0 = Math.floor((Math.min(Ax, Bx) - reach) / c)
    const cx1 = Math.floor((Math.max(Ax, Bx) + reach) / c)
    const cy0 = Math.floor((Math.min(Ay, By) - reach) / c)
    const cy1 = Math.floor((Math.max(Ay, By) + reach) / c)
    const dx = Bx - Ax
    const dy = By - Ay
    const len2 = dx * dx + dy * dy
    let removed = 0
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cy = cy0; cy <= cy1; cy++) {
        const list = this.cells.get(this.key(cx, cy))
        if (!list) continue
        for (const e of list) {
          const s = e.s
          if (s.goneCount !== undefined && s.goneCount >= s.pts.length) continue
          if (!accept(s)) continue
          const pts = s.pts
          for (let i = e.i0; i < e.i1; i++) {
            if (s.gone && s.gone[i]) continue
            const p = pts[i]
            const Px = p[0] * W
            const Py = p[1] * H
            // distance² from the point to the segment (to a when it has no length)
            let t = len2 > 0 ? ((Px - Ax) * dx + (Py - Ay) * dy) / len2 : 0
            t = t < 0 ? 0 : t > 1 ? 1 : t
            const qx = Ax + t * dx - Px
            const qy = Ay + t * dy - Py
            const hw = halfWidth(p, W)
            const lim = r + hw
            if (qx * qx + qy * qy > lim * lim) continue
            if (!s.gone || s.gone.length < pts.length) {
              const g = new Uint8Array(pts.length)
              if (s.gone) g.set(s.gone)
              s.gone = g
            }
            s.gone[i] = 1
            s.goneCount = (s.goneCount ?? 0) + 1
            removed++
            // the ink that vanished: this point and the segments to its neighbours, with width
            const ex = hw / W
            const ey = hw / H
            for (let j = Math.max(0, i - 1); j <= Math.min(pts.length - 1, i + 1); j++) {
              const q = pts[j]
              if (q[0] - ex < dirty[0]) dirty[0] = q[0] - ex
              if (q[1] - ey < dirty[1]) dirty[1] = q[1] - ey
              if (q[0] + ex > dirty[2]) dirty[2] = q[0] + ex
              if (q[1] + ey > dirty[3]) dirty[3] = q[1] + ey
            }
          }
        }
      }
    }
    return removed
  }
}

/** An empty dirty box (grows with {@link EraseIndex.cutSegment}; empty while x0 > x1). */
export function emptyBox(): Box {
  return [Infinity, Infinity, -Infinity, -Infinity]
}
