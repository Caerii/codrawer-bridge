/**
 * Plane geometry for task cards and the marks that answer them.
 *
 * Everything in this package works in **page millimetres**, y down, origin at the page's top
 * left: the Paper Pro page is 179.6 × 239.5 mm (1620 × 2160 px at 229 ppi; `PAPER_PRO_MM` in
 * packages/hand). Millimetres, not the protocol's normalized coordinates, because the thresholds
 * that matter are physical: a circle drawn around a 5 mm word, a tick in a 6 mm box, a strike
 * that has to cross most of a label. `fromNormalized` / `toNormalized` convert at the boundary
 * (protocol.md, "Normalization rules"; a `page` snapshot's points are normalized the same way).
 *
 * Reading order: points and rectangles; conversions; measures of a path (length, chord, signed
 * area, turning, corners); containment (point in polygon, how much of a rectangle a loop
 * encloses).
 */

import { PAPER_PRO_MM } from 'hand'

/** A point, mm. */
export type Pt = [number, number]

/** An axis-aligned rectangle, mm: left, top, right, bottom (x0 ≤ x1, y0 ≤ y1). */
export interface Rect {
  x0: number
  y0: number
  x1: number
  y1: number
}

export const rect = (x0: number, y0: number, x1: number, y1: number): Rect => ({ x0, y0, x1, y1 })
export const width = (r: Rect) => r.x1 - r.x0
export const height = (r: Rect) => r.y1 - r.y0
export const area = (r: Rect) => Math.max(0, width(r)) * Math.max(0, height(r))
export const center = (r: Rect): Pt => [(r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2]

/** `r` grown by `m` mm on every side (negative shrinks). */
export const inflate = (r: Rect, m: number): Rect => rect(r.x0 - m, r.y0 - m, r.x1 + m, r.y1 + m)

/** The overlap of two rectangles, mm² (0 when disjoint). */
export function overlap(a: Rect, b: Rect): number {
  return area(rect(Math.max(a.x0, b.x0), Math.max(a.y0, b.y0), Math.min(a.x1, b.x1), Math.min(a.y1, b.y1)))
}

export const contains = (r: Rect, p: Pt) => p[0] >= r.x0 && p[0] <= r.x1 && p[1] >= r.y0 && p[1] <= r.y1

/** The bounding box of points (a degenerate rectangle for one point). */
export function bounds(pts: Pt[]): Rect {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const [x, y] of pts) {
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y)
  }
  return rect(x0, y0, x1, y1)
}

/** Distance from `p` to rectangle `r`, mm (0 inside). */
export function distToRect(p: Pt, r: Rect): number {
  const dx = Math.max(r.x0 - p[0], 0, p[0] - r.x1)
  const dy = Math.max(r.y0 - p[1], 0, p[1] - r.y1)
  return Math.hypot(dx, dy)
}

// --- conversions -------------------------------------------------------------------------------

/** Normalized page point (protocol.md) → mm. */
export const fromNormalized = (p: readonly number[], page: Pt = PAPER_PRO_MM): Pt => [p[0] * page[0], p[1] * page[1]]

/** mm → normalized page point. */
export const toNormalized = (p: Pt, page: Pt = PAPER_PRO_MM): Pt => [p[0] / page[0], p[1] / page[1]]

// --- measures of a path ------------------------------------------------------------------------

export const dist = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1])

/** Arc length of a polyline, mm. */
export function pathLength(pts: Pt[]): number {
  let L = 0
  for (let i = 1; i < pts.length; i++) L += dist(pts[i - 1], pts[i])
  return L
}

/**
 * The polyline resampled to points `step` mm apart along its length. Pen samples bunch where the
 * hand slows (corners, the ends), which would bias every angle-based measure towards the slow
 * parts; resampling by arc length removes the bias.
 */
export function resample(pts: Pt[], step: number): Pt[] {
  if (pts.length < 2) return pts.slice()
  const out: Pt[] = [pts[0]]
  let carry = 0
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i]
    const seg = dist(a, b)
    let t = step - carry
    while (t <= seg) {
      out.push([a[0] + ((b[0] - a[0]) * t) / seg, a[1] + ((b[1] - a[1]) * t) / seg])
      t += step
    }
    carry = seg - (t - step)
  }
  const last = pts[pts.length - 1]
  if (dist(out[out.length - 1], last) > step / 4) out.push(last)
  return out
}

/** Signed area of the polygon the path closes (shoelace), mm². Positive is clockwise on a y-down page. */
export function signedArea(pts: Pt[]): number {
  let s = 0
  for (let i = 0; i < pts.length; i++) {
    const [x0, y0] = pts[i], [x1, y1] = pts[(i + 1) % pts.length]
    s += x0 * y1 - x1 * y0
  }
  return s / 2
}

/** Heading of each segment, radians. */
function headings(pts: Pt[]): number[] {
  const h: number[] = []
  for (let i = 1; i < pts.length; i++) h.push(Math.atan2(pts[i][1] - pts[i - 1][1], pts[i][0] - pts[i - 1][0]))
  return h
}

const wrapPi = (a: number) => Math.atan2(Math.sin(a), Math.cos(a))

/** Total signed turning along the path, radians (≈ ±2π for one loop). Expects a resampled path. */
export function turning(pts: Pt[]): number {
  const h = headings(pts)
  let t = 0
  for (let i = 1; i < h.length; i++) t += wrapPi(h[i] - h[i - 1])
  return t
}

/**
 * Indices of sharp corners: points where the heading over a ±`span` window changes by more than
 * `minAngle` radians, keeping only the sharpest point of each run. Expects a resampled path.
 */
export function corners(pts: Pt[], minAngle = 1.2, span = 2): number[] {
  const out: { i: number; a: number }[] = []
  for (let i = span; i < pts.length - span; i++) {
    const a1 = Math.atan2(pts[i][1] - pts[i - span][1], pts[i][0] - pts[i - span][0])
    const a2 = Math.atan2(pts[i + span][1] - pts[i][1], pts[i + span][0] - pts[i][0])
    const a = Math.abs(wrapPi(a2 - a1))
    if (a < minAngle) continue
    const prev = out[out.length - 1]
    if (prev && i - prev.i <= span) {
      if (a > prev.a) out[out.length - 1] = { i, a }
    } else out.push({ i, a })
  }
  return out.map((c) => c.i)
}

// --- containment -------------------------------------------------------------------------------

/** Even-odd point-in-polygon. The polygon is closed implicitly. */
export function inPolygon(p: Pt, poly: Pt[]): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j]
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

/** Fraction (0..1) of rectangle `r` inside the closed loop `poly`, by sampling an n × n grid. */
export function enclosed(r: Rect, poly: Pt[], n = 9): number {
  let k = 0
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++) {
      const p: Pt = [r.x0 + ((i + 0.5) * width(r)) / n, r.y0 + ((j + 0.5) * height(r)) / n]
      if (inPolygon(p, poly)) k++
    }
  return k / (n * n)
}

/** Length (mm) of the part of a polyline inside `r`, sampled at `step` mm. */
export function lengthInside(pts: Pt[], r: Rect, step = 0.5): number {
  const rs = resample(pts, step)
  let L = 0
  for (let i = 1; i < rs.length; i++) if (contains(r, rs[i - 1]) && contains(r, rs[i])) L += dist(rs[i - 1], rs[i])
  return L
}
