/**
 * Point clouds: the shape half of personal mark recognition.
 *
 * A personal mark is a glyph the user invented (a bolt, a spiral, a starred dot) and taught from
 * one to five examples. Nothing about it is known in advance: not its stroke count, not the order
 * or direction its strokes are drawn in, not its size. The recogniser that fits those facts is
 * the **$P point-cloud recogniser** (R.-D. Vatavu, L. Anthony, J. O. Wobbrock, "Gestures as point
 * clouds: a $P recognizer for user interface prototypes", ICMI 2012): a gesture is a set of points,
 * with stroke order and direction thrown away, compared by a greedy approximation of the optimal
 * matching between two clouds. It needs no training beyond storing the examples, works from one
 * example, and handles multi-stroke glyphs drawn in any order, which is how people redraw their
 * own symbols (a cross first down then across, the next time the other way).
 *
 * From **$Q** (Vatavu, Anthony, Wobbrock, "$Q: a super-quick, articulation-invariant stroke-gesture
 * recognizer for low-resource devices", MobileHCI 2018) we take early abandoning: a cloud distance
 * stops summing once it exceeds the best distance found so far, which is what keeps comparing
 * every occurrence against every example of every mark cheap enough for the phone.
 *
 * Normalisation, in order:
 *
 * 1. **Resample** the gesture to {@link N} points spaced equally along its inked length, never
 *    interpolating across a pen-up (each point keeps its stroke index, as in $P).
 * 2. **Scale** uniformly so the larger side of the bounding box is 1. Uniform, not per axis: a
 *    tall glyph and a wide one stay different. Size itself is not lost; it is a gate in
 *    recognizer.ts, because people draw their marks at a steady size and handwriting is larger.
 * 3. **Translate** the centroid to the origin.
 * 4. **Rotate** within a tolerance. $P is not rotation invariant, and full invariance would merge
 *    marks that differ only in orientation (an arrow up and an arrow right). People tilt their
 *    marks a little, by the page's angle on the desk and the writing lean, so the match searches
 *    rotations within ±{@link ROTATION_DEG} degrees by golden-section search, as $1 does (J. O.
 *    Wobbrock, A. D. Wilson, Y. Li, "Gestures without libraries, toolkits or training", UIST 2007).
 *    A mark taught as orientation-free (`rotation: 180`) searches the whole circle.
 *
 * Distances are reported as the **mean matched-point distance in units of the glyph's size**:
 * the $P sum divided by the sum of its weights. 0.05 means the matched points sit, on average, 5%
 * of the glyph's size apart. That makes thresholds readable, and comparable between glyphs.
 *
 * Units: input points are page millimetres (packages/delegate geometry); clouds are unitless.
 */

import { type Pt, bounds, dist, pathLength } from 'delegate'

/** Points in a normalised cloud. $P's recommended 32. */
export const N = 32

/** Default rotation tolerance, degrees either way. */
export const ROTATION_DEG = 25

/** A cloud point: x, y (unitless, centroid at 0, larger side 1) and the stroke it came from. */
export interface CloudPt {
  x: number
  y: number
  stroke: number
}

/** A normalised gesture. */
export interface Cloud {
  pts: CloudPt[]
  /** the bounding box's larger side before scaling, mm (the size gate's input) */
  size: number
  /** height / width of the bounding box, before scaling (both clamped to 0.5 mm) */
  aspect: number
  strokes: number
}

// --- normalisation -----------------------------------------------------------------------------

/**
 * Resample strokes (mm polylines, drawing order) to `n` points equally spaced along their total
 * inked length. Pen-ups are not interpolated: the spacing carries over from one stroke's end to
 * the next stroke's start. A stroke too short to receive a point (a dot) still contributes one.
 */
export function resampleStrokes(strokes: Pt[][], n = N): CloudPt[] {
  const live = strokes.filter((s) => s.length > 0)
  const total = live.reduce((a, s) => a + pathLength(s), 0)
  const out: CloudPt[] = []
  if (total < 1e-6) {
    // all dots: one point per stroke, repeated to fill
    for (let i = 0; i < n; i++) {
      const k = i % Math.max(1, live.length)
      out.push({ x: live[k]?.[0][0] ?? 0, y: live[k]?.[0][1] ?? 0, stroke: k })
    }
    return out
  }
  const step = total / (n - 1)
  let carry = 0 // distance travelled since the last emitted point
  live.forEach((s, k) => {
    if (out.length === 0 || pathLength(s) < step / 2) {
      out.push({ x: s[0][0], y: s[0][1], stroke: k })
      if (out.length === 1) carry = 0
    }
    for (let i = 1; i < s.length; i++) {
      const a = s[i - 1], b = s[i]
      const seg = dist(a, b)
      let t = step - carry
      while (t <= seg + 1e-9 && out.length < n) {
        out.push({ x: a[0] + ((b[0] - a[0]) * t) / seg, y: a[1] + ((b[1] - a[1]) * t) / seg, stroke: k })
        t += step
      }
      carry = seg - (t - step)
    }
  })
  const last = live[live.length - 1]
  while (out.length < n) out.push({ x: last[last.length - 1][0], y: last[last.length - 1][1], stroke: live.length - 1 })
  return out.slice(0, n)
}

/** Strokes (mm, drawing order) → a normalised cloud. */
export function toCloud(strokes: Pt[][], n = N): Cloud {
  const all = strokes.flat()
  const b = bounds(all)
  const w = Math.max(b.x1 - b.x0, 0.5), h = Math.max(b.y1 - b.y0, 0.5)
  const size = Math.max(w, h)
  const raw = resampleStrokes(strokes, n)
  const cx = raw.reduce((a, p) => a + p.x, 0) / raw.length
  const cy = raw.reduce((a, p) => a + p.y, 0) / raw.length
  return {
    pts: raw.map((p) => ({ x: (p.x - cx) / size, y: (p.y - cy) / size, stroke: p.stroke })),
    size,
    aspect: h / w,
    strokes: strokes.filter((s) => s.length > 0).length,
  }
}

/** The cloud rotated by `theta` radians about its centroid (the origin). */
export function rotate(c: CloudPt[], theta: number): CloudPt[] {
  const cos = Math.cos(theta), sin = Math.sin(theta)
  return c.map((p) => ({ x: p.x * cos - p.y * sin, y: p.x * sin + p.y * cos, stroke: p.stroke }))
}

// --- matching ----------------------------------------------------------------------------------

/**
 * $P's cloud distance from `a` to `b`, starting the greedy match at `a[start]`. Each point of `a`
 * in turn takes its nearest unmatched point of `b`; earlier matches weigh more (weight
 * 1 − i/n), because they had more choice. Stops early once the sum passes `abandon` ($Q).
 */
function cloudDistance(a: CloudPt[], b: CloudPt[], start: number, abandon: number): number {
  const n = a.length
  const matched = new Uint8Array(n)
  let sum = 0
  let i = start
  let k = 0
  do {
    let best = Infinity, index = -1
    const ax = a[i].x, ay = a[i].y
    for (let j = 0; j < n; j++) {
      if (matched[j]) continue
      const dx = ax - b[j].x, dy = ay - b[j].y
      const d = dx * dx + dy * dy
      if (d < best) { best = d; index = j }
    }
    matched[index] = 1
    sum += (1 - k / n) * Math.sqrt(best)
    if (sum >= abandon) return sum
    i = (i + 1) % n
    k++
  } while (i !== start)
  return sum
}

/** The sum of $P's weights for `n` points: the divisor that makes a distance a mean. */
const weightSum = (n: number) => (n + 1) / 2

/**
 * $P's greedy cloud match: the least cloud distance over √n evenly spaced starting points, in both
 * directions, as a mean point distance (module overview). `abandon` is a mean distance beyond
 * which the caller no longer cares ($Q early abandoning).
 */
export function greedyMatch(a: CloudPt[], b: CloudPt[], abandon = Infinity): number {
  const n = a.length
  const step = Math.max(1, Math.floor(Math.sqrt(n)))
  let min = abandon * weightSum(n)
  for (let i = 0; i < n; i += step) {
    min = Math.min(min, cloudDistance(a, b, i, min), cloudDistance(b, a, i, min))
  }
  return min / weightSum(n)
}

const PHI = 0.5 * (-1 + Math.sqrt(5))

/**
 * The match of `a` to `b` over rotations of `a` within ±`maxDeg`: θ = 0 always, then a golden-
 * section search to 2° (Wobbrock et al. 2007). Returns the distance and the angle that gave it
 * (radians). A full-circle tolerance first tries twelve evenly spaced angles and refines the best.
 */
export function rotationMatch(a: CloudPt[], b: CloudPt[], maxDeg = ROTATION_DEG, abandon = Infinity): { d: number; theta: number } {
  const at = (t: number) => greedyMatch(rotate(a, t), b, abandon)
  let best = { d: at(0), theta: 0 }
  if (maxDeg <= 0) return best
  let lo = (-maxDeg * Math.PI) / 180, hi = (maxDeg * Math.PI) / 180
  if (maxDeg >= 180) {
    for (let k = 1; k < 12; k++) {
      const t = (k * Math.PI) / 6
      const d = at(t)
      if (d < best.d) best = { d, theta: t }
    }
    lo = best.theta - Math.PI / 6
    hi = best.theta + Math.PI / 6
  }
  const tol = (2 * Math.PI) / 180
  let x1 = PHI * lo + (1 - PHI) * hi, f1 = at(x1)
  let x2 = (1 - PHI) * lo + PHI * hi, f2 = at(x2)
  while (Math.abs(hi - lo) > tol) {
    if (f1 < f2) { hi = x2; x2 = x1; f2 = f1; x1 = PHI * lo + (1 - PHI) * hi; f1 = at(x1) }
    else { lo = x1; x1 = x2; f1 = f2; x2 = (1 - PHI) * lo + PHI * hi; f2 = at(x2) }
  }
  for (const [d, theta] of [[f1, x1], [f2, x2]]) if (d < best.d) best = { d, theta }
  return best
}
