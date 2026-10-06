/**
 * In-betweening: the frames between two key frames, from the keys' strokes alone.
 *
 * An animator draws the extremes (keys) and an assistant fills the drawings between them. For a
 * stroke-native tool the assistant's job has two parts, and this module does both with no model:
 *
 * 1. **Correspondence.** Which stroke of key B is which stroke of key A? Strokes are resampled to
 *    the same number of points by arc length and compared point by point, forwards and reversed
 *    (a person may draw the same arm from the hand or from the shoulder). The cost is the mean
 *    distance between corresponding points, in page widths. The optimal one-to-one assignment
 *    is the Hungarian method (Kuhn 1955; Munkres 1957), O(n³), instant for the tens of strokes a
 *    character has. A pair costing more than `maxCost` is not a match: that stroke **vanishes**
 *    (A only) or **appears** (B only).
 * 2. **Interpolation.** A matched pair moves as a near-rigid body plus a shape blend: its centroid
 *    moves linearly, its chord (first to last point) turns through the smaller angle between the
 *    keys, and the shape, expressed in the chord's frame, blends linearly. Plain point-wise
 *    linear interpolation shortens a swinging limb in the middle of its swing (the chord of an
 *    arc is shorter than the arc); turning the frame keeps its length. Closed or nearly closed
 *    strokes (a head) have no meaningful chord and only translate and blend. Appearing strokes
 *    write themselves on (the first t of their length); vanishing ones retract.
 *
 * Progress through the gap is spaced by an easing function (ease.ts), lognormal by default.
 *
 * What it cannot do, by design: invent occluded parts, follow a stroke that a person redrew
 * split in two, or arc a motion (a thrown ball's path between two keys is a straight line here;
 * motion.ts gives paths and physics). Those are where a learned model or the animator's own
 * breakdown key earns its place (docs/investigations/codrawer-animate.md, "Intelligence").
 *
 * Coordinates are normalised page coordinates; distances are computed in page widths after
 * scaling y by the page's aspect (2160 / 1620 on the Paper Pro), so a match does not prefer
 * vertical over horizontal offsets.
 */

import type { Anim, AnimStroke, Frame, Pt } from './model'
import { insertFrame } from './model'
import { lognormalEase, type Ease } from './ease'

export const PAPER_PRO_ASPECT = 2160 / 1620

export interface InbetweenOptions {
  /** spacing of the in-betweens; default lognormal (σ 0.25) */
  ease?: Ease
  /** page height / width */
  aspect?: number
  /** mean point distance (page widths) above which two strokes are not the same stroke */
  maxCost?: number
  /** `rigid` (default) turns each stroke's frame; `linear` blends points only */
  mode?: 'rigid' | 'linear'
}

const DEFAULT_MAX_COST = 0.3
/** points per stroke when comparing strokes */
const MATCH_N = 24

// ------------------------------------------------------------------------------------------------
// Resampling
// ------------------------------------------------------------------------------------------------

type V = [number, number, number]

function toV(pts: Pt[], aspect: number): V[] {
  return pts.map(([x, y, p]) => [x, y * aspect, p])
}

function fromV(v: V[], aspect: number): Pt[] {
  return v.map(([x, y, p]) => [x, y / aspect, p])
}

function arcLengths(v: V[]): number[] {
  const out = [0]
  for (let i = 1; i < v.length; i++) out.push(out[i - 1] + Math.hypot(v[i][0] - v[i - 1][0], v[i][1] - v[i - 1][1]))
  return out
}

/** `n` points evenly spaced along the polyline by arc length (pressure interpolated). */
export function resample<T extends number[]>(pts: T[], n: number): T[] {
  if (pts.length === 0) return []
  if (pts.length === 1 || n === 1) return Array.from({ length: n }, () => [...pts[0]] as T)
  const L = arcLengths(pts as unknown as V[])
  const total = L[L.length - 1]
  if (total === 0) return Array.from({ length: n }, () => [...pts[0]] as T)
  const out: T[] = []
  let j = 1
  for (let k = 0; k < n; k++) {
    const s = (total * k) / (n - 1)
    while (j < L.length - 1 && L[j] < s) j++
    const seg = L[j] - L[j - 1]
    const u = seg > 0 ? Math.min(1, Math.max(0, (s - L[j - 1]) / seg)) : 0
    const a = pts[j - 1]
    const b = pts[j]
    out.push(a.map((av, d) => av + (b[d] - av) * u) as T)
  }
  return out
}

/** The first `f` (0..1) of a polyline's length. */
export function trim<T extends number[]>(pts: T[], f: number): T[] {
  if (f >= 1 || pts.length < 2) return pts.map((p) => [...p] as T)
  const L = arcLengths(pts as unknown as V[])
  const s = L[L.length - 1] * Math.max(0, f)
  const out: T[] = [[...pts[0]] as T]
  for (let i = 1; i < pts.length; i++) {
    if (L[i] <= s) {
      out.push([...pts[i]] as T)
      continue
    }
    const seg = L[i] - L[i - 1]
    const u = seg > 0 ? (s - L[i - 1]) / seg : 0
    out.push(pts[i - 1].map((av, d) => av + (pts[i][d] - av) * u) as T)
    break
  }
  return out
}

// ------------------------------------------------------------------------------------------------
// Correspondence
// ------------------------------------------------------------------------------------------------

/** Mean point distance of two strokes resampled alike, and whether B matches better reversed. */
export function strokeCost(a: Pt[], b: Pt[], aspect = PAPER_PRO_ASPECT): { cost: number; reversed: boolean } {
  const ra = resample(toV(a, aspect), MATCH_N)
  const rb = resample(toV(b, aspect), MATCH_N)
  let fwd = 0
  let rev = 0
  for (let k = 0; k < MATCH_N; k++) {
    fwd += Math.hypot(ra[k][0] - rb[k][0], ra[k][1] - rb[k][1])
    rev += Math.hypot(ra[k][0] - rb[MATCH_N - 1 - k][0], ra[k][1] - rb[MATCH_N - 1 - k][1])
  }
  return rev < fwd ? { cost: rev / MATCH_N, reversed: true } : { cost: fwd / MATCH_N, reversed: false }
}

/**
 * The minimum-cost assignment for a square cost matrix: `rowToCol[i]` is the column of row i.
 * The Hungarian method with potentials (Jonker–Volgenant style shortest augmenting paths).
 */
export function hungarian(cost: number[][]): number[] {
  const n = cost.length
  const INF = Number.POSITIVE_INFINITY
  const u = new Array<number>(n + 1).fill(0)
  const v = new Array<number>(n + 1).fill(0)
  const p = new Array<number>(n + 1).fill(0) // p[j]: row matched to column j (1-based)
  const way = new Array<number>(n + 1).fill(0)
  for (let i = 1; i <= n; i++) {
    p[0] = i
    let j0 = 0
    const minv = new Array<number>(n + 1).fill(INF)
    const used = new Array<boolean>(n + 1).fill(false)
    do {
      used[j0] = true
      const i0 = p[j0]
      let delta = INF
      let j1 = 0
      for (let j = 1; j <= n; j++) {
        if (used[j]) continue
        const cur = cost[i0 - 1][j - 1] - u[i0] - v[j]
        if (cur < minv[j]) {
          minv[j] = cur
          way[j] = j0
        }
        if (minv[j] < delta) {
          delta = minv[j]
          j1 = j
        }
      }
      for (let j = 0; j <= n; j++) {
        if (used[j]) {
          u[p[j]] += delta
          v[j] -= delta
        } else {
          minv[j] -= delta
        }
      }
      j0 = j1
    } while (p[j0] !== 0)
    do {
      const j1 = way[j0]
      p[j0] = p[j1]
      j0 = j1
    } while (j0)
  }
  const rowToCol = new Array<number>(n).fill(-1)
  for (let j = 1; j <= n; j++) if (p[j]) rowToCol[p[j] - 1] = j - 1
  return rowToCol
}

export interface Pair {
  a: number
  b: number
  reversed: boolean
  cost: number
}

export interface Correspondence {
  pairs: Pair[]
  /** strokes of A with no partner in B */
  vanish: number[]
  /** strokes of B with no partner in A */
  appear: number[]
}

/**
 * Match the strokes of key A to those of key B. Each stroke may also stay unmatched, at cost
 * `maxCost`: the matrix is padded to (nA + nB) square with "unmatched" slots, so the optimum
 * trades a poor match against a vanish plus an appear.
 */
export function correspond(a: AnimStroke[], b: AnimStroke[], o: InbetweenOptions = {}): Correspondence {
  const aspect = o.aspect ?? PAPER_PRO_ASPECT
  const maxCost = o.maxCost ?? DEFAULT_MAX_COST
  const nA = a.length
  const nB = b.length
  const n = nA + nB
  const BIG = 1e6
  const info: { cost: number; reversed: boolean }[][] = a.map((sa) => b.map((sb) => strokeCost(sa.pts, sb.pts, aspect)))
  const m: number[][] = []
  for (let i = 0; i < n; i++) {
    const row: number[] = []
    for (let j = 0; j < n; j++) {
      if (i < nA && j < nB) row.push(info[i][j].cost <= maxCost ? info[i][j].cost : BIG)
      else if (i < nA) row.push(j - nB === i ? maxCost : BIG) // A_i unmatched
      else if (j < nB) row.push(i - nA === j ? maxCost : BIG) // B_j unmatched
      else row.push(0) // dummy to dummy
    }
    m.push(row)
  }
  const assign = hungarian(m)
  const pairs: Pair[] = []
  const matchedB = new Set<number>()
  const vanish: number[] = []
  for (let i = 0; i < nA; i++) {
    const j = assign[i]
    if (j < nB) {
      pairs.push({ a: i, b: j, reversed: info[i][j].reversed, cost: info[i][j].cost })
      matchedB.add(j)
    } else {
      vanish.push(i)
    }
  }
  const appear = b.map((_, j) => j).filter((j) => !matchedB.has(j))
  return { pairs, vanish, appear }
}

// ------------------------------------------------------------------------------------------------
// Interpolation
// ------------------------------------------------------------------------------------------------

interface Posed {
  c: [number, number]
  theta: number
  /** whether the chord is long enough to define a direction */
  directed: boolean
  local: V[]
}

function pose(v: V[]): Posed {
  let cx = 0
  let cy = 0
  for (const q of v) {
    cx += q[0]
    cy += q[1]
  }
  cx /= v.length
  cy /= v.length
  const first = v[0]
  const last = v[v.length - 1]
  const chord = Math.hypot(last[0] - first[0], last[1] - first[1])
  const L = arcLengths(v)
  const directed = chord > 0.25 * L[L.length - 1] && chord > 1e-6
  const theta = directed ? Math.atan2(last[1] - first[1], last[0] - first[0]) : 0
  const cs = Math.cos(-theta)
  const sn = Math.sin(-theta)
  const local = v.map(([x, y, p]) => {
    const dx = x - cx
    const dy = y - cy
    return [dx * cs - dy * sn, dx * sn + dy * cs, p] as V
  })
  return { c: [cx, cy], theta, directed, local }
}

function wrapAngle(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a))
}

/** Stroke A turned into stroke B by `t` (0 = A, 1 = B). Both already resampled to equal length. */
function blendPair(a: V[], b: V[], t: number, mode: 'rigid' | 'linear'): V[] {
  if (mode === 'linear') return a.map((qa, k) => qa.map((x, d) => x + (b[k][d] - x) * t) as V)
  const A = pose(a)
  const B = pose(b)
  const turn = A.directed && B.directed
  // without a direction on both ends, keep each stroke's own frame and blend only translation and shape
  const thA = turn ? A.theta : 0
  const thB = turn ? A.theta + wrapAngle(B.theta - A.theta) : 0
  const la = turn ? A.local : pose0(a, A.c)
  const lb = turn ? B.local : pose0(b, B.c)
  const th = thA + (thB - thA) * t
  const cx = A.c[0] + (B.c[0] - A.c[0]) * t
  const cy = A.c[1] + (B.c[1] - A.c[1]) * t
  const cs = Math.cos(th)
  const sn = Math.sin(th)
  return la.map((qa, k) => {
    const qb = lb[k]
    const x = qa[0] + (qb[0] - qa[0]) * t
    const y = qa[1] + (qb[1] - qa[1]) * t
    const p = qa[2] + (qb[2] - qa[2]) * t
    return [cx + x * cs - y * sn, cy + x * sn + y * cs, p] as V
  })
}

function pose0(v: V[], c: [number, number]): V[] {
  return v.map(([x, y, p]) => [x - c[0], y - c[1], p] as V)
}

/**
 * `count` in-between stroke sets from key `a` to key `b`, in order. The k-th sits at progress
 * ease(k / (count + 1)). Generated strokes carry `provenance: 'agent'` and ids `<prefix><k>/<n>`.
 */
export function inbetween(a: AnimStroke[], b: AnimStroke[], count: number, prefix: string, o: InbetweenOptions = {}): AnimStroke[][] {
  const aspect = o.aspect ?? PAPER_PRO_ASPECT
  const ease = o.ease ?? lognormalEase()
  const mode = o.mode ?? 'rigid'
  const corr = correspond(a, b, o)
  const prepared = corr.pairs.map((pr) => {
    const va = toV(a[pr.a].pts, aspect)
    let vb = toV(b[pr.b].pts, aspect)
    if (pr.reversed) vb = vb.slice().reverse()
    const n = Math.max(8, Math.min(128, Math.max(va.length, vb.length)))
    return { pr, ra: resample(va, n), rb: resample(vb, n) }
  })
  const out: AnimStroke[][] = []
  for (let k = 1; k <= count; k++) {
    const t = ease(k / (count + 1))
    const id = (n: number) => `${prefix}${k}/${n}`
    const strokes: AnimStroke[] = []
    for (const { pr, ra, rb } of prepared) {
      const src = a[pr.a]
      strokes.push({ ...src, id: id(strokes.length), provenance: 'agent', pts: fromV(blendPair(ra, rb, t, mode), aspect) })
    }
    for (const i of corr.vanish) {
      const pts = trim(a[i].pts, 1 - t)
      if (pts.length > 1) strokes.push({ ...a[i], id: id(strokes.length), provenance: 'agent', pts })
    }
    for (const j of corr.appear) {
      const pts = trim(b[j].pts, t)
      if (pts.length > 1) strokes.push({ ...b[j], id: id(strokes.length), provenance: 'agent', pts })
    }
    out.push(strokes)
  }
  return out
}

/**
 * Insert `count` generated in-betweens after frame `i`, between it and frame i + 1 (both keys).
 * New frames are not keys, hold 1, and have ids `<prefix><k>`.
 */
export function fillBetween(anim: Anim, i: number, count: number, prefix: string, o: InbetweenOptions = {}): Anim {
  if (i < 0 || i + 1 >= anim.frames.length) throw new RangeError(`no gap after frame ${i}`)
  const sets = inbetween(anim.frames[i].strokes, anim.frames[i + 1].strokes, count, prefix, o)
  let next = anim
  sets.forEach((strokes, k) => {
    const frame: Frame = { id: `${prefix}${k + 1}`, hold: 1, key: false, strokes }
    next = insertFrame(next, i + k, frame)
  })
  return next
}
