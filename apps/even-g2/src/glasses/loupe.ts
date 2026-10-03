/**
 * Loupe geometry: how wide the loupe's window is, and what writing it should keep in view.
 *
 * The loupe is the small image container that follows the pen; it is the only view that updates
 * while you write (glasses/scheduler.ts explains why). Its camera (LoupeCamera in strokes.ts)
 * glides, zooms with pen speed and widens to hold the word being written; this module supplies
 * its inputs. Pure functions of their arguments, so they can be tested without a page.
 *
 * Units: windows are widths as a fraction of the page width; boxes are normalized page
 * coordinates [x0, y0, x1, y1] (0..1 of the page's width and height); times are ms.
 */
import type { Stroke } from '../strokes'

/**
 * The loupe's base window at zoom 1: 0.45 of the canvas's follow window for a 128-px-wide loupe,
 * scaled with the loupe's width so a wider loupe shows more page at the same detail, then by the
 * user's zoom (set by dragging the loupe box on the phone).
 */
export function loupeBaseWindow(viewWindow: number, loupeW: number, zoom: number): number {
  return viewWindow * 0.45 * (loupeW / 128) * zoom
}

/**
 * The new loupe zoom after the phone's loupe box was dragged to `boxWidth`: the box width over
 * the base window at zoom 1 (`unzoomedBase`), clamped to 0.15..6, so the base window lands at the
 * dragged width whatever the zoom was before. (The box shows the camera's window, which may also
 * carry a transient speed/context widening; that settles back once the pen slows.)
 */
export function zoomForBoxWidth(boxWidth: number, unzoomedBase: number): number {
  return Math.min(6, Math.max(0.15, boxWidth / unzoomedBase))
}

/**
 * The writing the loupe should keep in view: the recent user strokes near the pen, as one
 * bounding box, or null when there are none. "Recent" is the last dozen user strokes, stopping at
 * the first finished more than 12 s ago (older than the current burst of writing); "near" is
 * within 2.5 base windows of the pen horizontally (×1.5 vertically). Erasers and empty strokes do
 * not count.
 */
export function writingContext(strokes: readonly Stroke[], pen: [number, number] | null, base: number, now: number): [number, number, number, number] | null {
  if (!pen) return null
  const reach = base * 2.5 // anything farther is a different place on the page
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  let seen = 0
  for (let i = strokes.length - 1; i >= 0 && seen < 12; i--) {
    const s = strokes[i]
    if (s.layer !== 'user' || s.pts.length === 0 || s.brush === 'eraser') continue
    seen++
    if (s.done && now - s.endedAt > 12_000) break // older than the current burst of writing
    const cx = (s.box[0] + s.box[2]) / 2
    const cy = (s.box[1] + s.box[3]) / 2
    if (Math.abs(cx - pen[0]) > reach || Math.abs(cy - pen[1]) > reach * 1.5) continue
    x0 = Math.min(x0, s.box[0])
    y0 = Math.min(y0, s.box[1])
    x1 = Math.max(x1, s.box[2])
    y1 = Math.max(y1, s.box[3])
  }
  return isFinite(x0) ? [x0, y0, x1, y1] : null
}
