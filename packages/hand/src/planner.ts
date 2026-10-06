/**
 * The motor plan: from intended paths to a sum of lognormal impulses, and from impulses to the
 * trajectory the arm is asked to follow.
 *
 * **Virtual targets.** In the Kinematic Theory a stroke is produced by a chain of commands, each
 * aimed at a *virtual target* the pen never quite reaches because the next command starts first
 * (Plamondon & Djioua 2006; the "sigma-lognormal" extraction of O'Reilly & Plamondon 2009,
 * Pattern Recognition 42, 3324–3337, inverts the same picture). This planner works forward and
 * simply: it walks the skeleton and places a target at
 *
 * - each end of the path,
 * - each vertex that turns more than `cornerAngle` (a cusp or corner: the pen must slow there),
 * - each point where the curve has turned `maxSweep` since the last target, and
 * - each inflection between two well-turned arcs (one circular arc cannot bend both ways).
 *
 * Between consecutive targets one impulse carries the pen along a circular arc whose sweep is
 * the change of the skeleton's tangent across the segment, and whose D makes the arc land exactly
 * on the next target ({@link arcThrough}).
 *
 * **Timing.** An impulse's duration grows sublinearly with its amplitude (bigger movements are
 * faster: the isochrony principle, Viviani & Terzuolo 1982, Neuroscience 7, 431–437):
 * T = strokeTime · (D / 3 mm)^sizeExponent / tempo. Each command is issued `overlap` of the way
 * before the previous impulse ends, less at sharp corners, where a hand must nearly stop (at a
 * 180° cusp the overlap all but vanishes and the speed falls to zero). Neuromotor noise perturbs
 * every parameter of every impulse, so no two repetitions of a letter are the same.
 *
 * **Pen-up flights** are impulses too: one straight-ish lognormal from where the pen lifted to
 * where the next stroke lands, with a duration that grows with the square root of the distance.
 * The hand may hover before landing (hesitation; compose.ts decides). Landing happens while the
 * flight is still decelerating, so strokes start with the small hooks real ones have.
 *
 * **The two-thirds power law.** Drawing movements obey v = K · (R / (1 + αR))^β with β ≈ 1/3
 * (Lacquaniti, Terzuolo & Viviani 1983, Acta Psychologica 54, 115–130; the α term is from
 * Viviani & Schneider 1991, J. Exp. Psychol. HPP 17, 198–218): speed falls where the path curves.
 * Summed lognormals produce a relation of this kind but not reliably its exponent: measured on
 * this planner's output it ranges from about 0.1 (print, mostly straight strokes) to 0.35–0.45
 * (ellipses), so each pen-down is re-timed ({@link powerLawWarp}). The warp regresses the
 * stroke's log speed on log curvature, then stretches time just enough to move the slope `w` of
 * the way to −1/3 (w = `powerLaw`), keeping the stroke's duration. Geometry is untouched, and
 * the part of the speed that curvature does not explain, the lognormal bumps, is kept as it was.
 *
 * Units: mm, s; the trajectory is sampled at {@link PLAN_HZ}.
 */

import { arcThrough, chord, displacement, support, timing, velocity, type Impulse } from './lognormal'
import type { MotorParams } from './persona'
import type { Pt } from './layout'
import type { Rng } from './rng'

/** Internal sampling rate of the plan and of the arm, Hz (the arm integrates at this rate). */
export const PLAN_HZ = 1000

/**
 * Where a curve merely continues (a target placed by `maxSweep` or at an inflection, not at a
 * corner), the next command comes earlier: this fraction of the way from the persona's overlap
 * to 0.75. Smooth arcs are one continuous movement; only corners and cusps stop the pen.
 */
const SMOOTH_JOIN = 0.5

/** An impulse and what it belongs to. */
export interface PlannedImpulse extends Impulse {
  /** index of the pen-down it draws, or of the pen-down it travels to (flights) */
  stroke: number
  kind: 'ink' | 'flight'
}

/** A pen-down in the plan: when the pen touches and leaves the paper, s. */
export interface PenDown {
  down: number
  up: number
}

/** Wrap an angle to (−π, π]. */
export function wrap(a: number): number {
  while (a > Math.PI) a -= 2 * Math.PI
  while (a <= -Math.PI) a += 2 * Math.PI
  return a
}

/** Drop consecutive duplicates and vertices closer than `eps` mm to the previous one. */
function clean(path: Pt[], eps = 1e-3): Pt[] {
  const out: Pt[] = []
  for (const p of path) {
    const q = out[out.length - 1]
    if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) > eps) out.push(p)
  }
  return out
}

/**
 * Indices of the virtual targets along `path` (see the overview), always including the first
 * and last vertex. Exported for the lab, which marks them.
 */
export function virtualTargets(path: Pt[], m: Pick<MotorParams, 'cornerAngle' | 'maxSweep'>): number[] {
  const n = path.length
  if (n <= 2) return n === 2 ? [0, 1] : [0]
  const dir: number[] = []
  for (let i = 0; i + 1 < n; i++) dir.push(Math.atan2(path[i + 1][1] - path[i][1], path[i + 1][0] - path[i][0]))
  const targets = [0]
  let cum = 0 // signed turning since the last target
  for (let i = 1; i + 1 < n; i++) {
    const turn = wrap(dir[i] - dir[i - 1])
    if (Math.abs(turn) > m.cornerAngle) {
      targets.push(i)
      cum = 0
      continue
    }
    // an inflection after a well-turned arc: one circular arc cannot bend both ways
    if (Math.abs(cum) > 0.45 && Math.sign(turn) !== Math.sign(cum) && Math.abs(turn) > 0.02) {
      targets.push(i)
      cum = 0
    }
    cum += turn
    if (Math.abs(cum) >= m.maxSweep) {
      targets.push(i)
      cum = 0
    }
  }
  targets.push(n - 1)
  return targets
}

/** Tangent direction leaving vertex i (a corner or the start uses the outgoing segment alone). */
function tangentOut(path: Pt[], i: number, corner: boolean): number {
  const a = path[i], b = path[i + 1]
  const out = Math.atan2(b[1] - a[1], b[0] - a[0])
  if (corner || i === 0) return out
  const z = path[i - 1]
  const inn = Math.atan2(a[1] - z[1], a[0] - z[0])
  return inn + wrap(out - inn) / 2
}

/** Tangent direction arriving at vertex i. */
function tangentIn(path: Pt[], i: number, corner: boolean): number {
  const z = path[i - 1], a = path[i]
  const inn = Math.atan2(a[1] - z[1], a[0] - z[0])
  if (corner || i === path.length - 1) return inn
  const b = path[i + 1]
  const out = Math.atan2(b[1] - a[1], b[0] - a[0])
  return inn + wrap(out - inn) / 2
}

/** An impulse's support duration for amplitude D at this persona's tempo, s. */
export function impulseDuration(D: number, m: MotorParams, slow = 1): number {
  return Math.max(0.05, (m.strokeTime * Math.pow(Math.max(D, 0.2) / 3, m.sizeExponent) * slow) / m.tempo)
}

/** Perturb an impulse with the persona's neuromotor noise (in place). */
function jitter(k: Impulse, m: MotorParams, rng: Rng, span: number): void {
  const nz = m.noise
  k.D *= Math.max(0.5, 1 + rng.gauss(nz.D))
  k.thetaS += rng.gauss(nz.theta)
  k.thetaE += rng.gauss(nz.theta)
  k.t0 += rng.gauss(nz.t0 * span)
  k.mu += rng.gauss(nz.mu)
  k.sigma = Math.max(0.08, k.sigma * (1 + rng.gauss(nz.sigma)))
}

/**
 * The impulses that draw `path`, the first one starting at `start` (s). `slow(i)` multiplies
 * the i-th impulse's duration (hesitant first strokes). Returns the impulses and the time the
 * pen should lift (when the last impulse is 97 % done; the rest is the lift-off tail).
 */
export function planPath(
  path: Pt[],
  m: MotorParams,
  rng: Rng,
  start: number,
  stroke: number,
  slow: (i: number) => number = () => 1,
): { impulses: PlannedImpulse[]; up: number } {
  const pts = clean(path)
  if (pts.length < 2) {
    // a tap: a tiny impulse so the pen touches down for a moment
    const dur = impulseDuration(0.3, m, slow(0))
    const sigma = m.sigma
    const { mu, t0 } = timing(start, dur, sigma)
    const k: PlannedImpulse = { D: 0.05, t0, mu, sigma, thetaS: Math.PI / 4, thetaE: Math.PI / 4, stroke, kind: 'ink' }
    return { impulses: [k], up: start + dur * 0.9 }
  }
  const idx = virtualTargets(pts, m)
  const corner = new Set<number>()
  const turnAt = new Map<number, number>()
  for (const i of idx) {
    if (i <= 0 || i >= pts.length - 1) continue
    const a = Math.atan2(pts[i][1] - pts[i - 1][1], pts[i][0] - pts[i - 1][0])
    const b = Math.atan2(pts[i + 1][1] - pts[i][1], pts[i + 1][0] - pts[i][0])
    const t = Math.abs(wrap(b - a))
    turnAt.set(i, t)
    if (t > m.cornerAngle) corner.add(i)
  }
  const impulses: PlannedImpulse[] = []
  let onset = start
  let up = start
  for (let s = 0; s + 1 < idx.length; s++) {
    const a = idx[s], b = idx[s + 1]
    const P = pts[a], Q = pts[b]
    const L = Math.hypot(Q[0] - P[0], Q[1] - P[1])
    if (L < 1e-4) continue
    const alpha = Math.atan2(Q[1] - P[1], Q[0] - P[0])
    let sweep = b - a === 1 ? 0 : wrap(tangentIn(pts, b, corner.has(b)) - tangentOut(pts, a, corner.has(a)))
    sweep = Math.max(-0.95 * Math.PI, Math.min(0.95 * Math.PI, sweep))
    const arc = arcThrough(L, alpha, sweep)
    const dur = impulseDuration(arc.D, m, slow(impulses.length))
    const sigma = m.sigma
    const { mu, t0 } = timing(onset, dur, sigma)
    const k: PlannedImpulse = { ...arc, t0, mu, sigma, stroke, kind: 'ink' }
    jitter(k, m, rng, dur)
    impulses.push(k)
    up = Math.max(up, k.t0 + Math.exp(k.mu + 1.88 * k.sigma)) // 97 % done
    // the next command: earlier when the path flows on, almost none at a cusp
    const turn = turnAt.get(b) ?? 0
    const ov = corner.has(b) ? m.overlap * Math.max(0.12, Math.cos(Math.min(Math.PI, turn) / 2)) : m.overlap + SMOOTH_JOIN * (0.75 - m.overlap)
    onset += (1 - ov) * dur
  }
  return { impulses, up }
}

/**
 * A pen-up flight from `from` to `to`, starting at `start` and lasting `dur` s: one lognormal
 * with a slight random bow (pens arc through the air).
 */
export function planFlight(from: Pt, to: Pt, start: number, dur: number, sigma: number, rng: Rng, stroke: number): PlannedImpulse {
  const L = Math.hypot(to[0] - from[0], to[1] - from[1])
  const alpha = Math.atan2(to[1] - from[1], to[0] - from[0])
  const arc = arcThrough(Math.max(L, 1e-6), alpha, rng.gauss(0.25))
  const { mu, t0 } = timing(start, dur, sigma)
  return { ...arc, t0, mu, sigma, stroke, kind: 'flight' }
}

/** The planned trajectory, uniformly sampled. */
export interface Trajectory {
  /** sample interval, s */
  dt: number
  x: Float64Array
  y: Float64Array
  /** for each sample, the local time-warp factor dt_new/dt_old (1 outside pen-downs) */
  warp: Float64Array
  /** for each sample, the impulse-clock time (s) it was taken from before the warp */
  tau: Float64Array
}

/**
 * Sum the impulses from `origin` into a trajectory sampled at {@link PLAN_HZ} over [0, end] s.
 * Each impulse is evaluated only inside its support (±3.5σ, beyond which less than 0.03 % of D
 * remains); its full chord is added to every later sample through a running sum.
 */
export function integrate(origin: Pt, impulses: Impulse[], end: number): Trajectory {
  const dt = 1 / PLAN_HZ
  const n = Math.max(2, Math.ceil(end / dt) + 1)
  const x = new Float64Array(n).fill(origin[0])
  const y = new Float64Array(n).fill(origin[1])
  const tailX = new Float64Array(n + 1)
  const tailY = new Float64Array(n + 1)
  const d: [number, number] = [0, 0]
  for (const k of impulses) {
    const [a, b] = support(k, 3.5)
    const i0 = Math.max(0, Math.floor(a / dt))
    const i1 = Math.min(n, Math.ceil(b / dt) + 1)
    for (let i = i0; i < i1; i++) {
      displacement(k, i * dt, d)
      x[i] += d[0]
      y[i] += d[1]
    }
    if (i1 < n) {
      chord(k, d)
      tailX[i1] += d[0]
      tailY[i1] += d[1]
    }
  }
  let cx = 0, cy = 0
  for (let i = 0; i < n; i++) {
    cx += tailX[i]
    cy += tailY[i]
    x[i] += cx
    y[i] += cy
  }
  const tau = new Float64Array(n)
  for (let i = 0; i < n; i++) tau[i] = i * dt
  return { dt, x, y, warp: new Float64Array(n).fill(1), tau }
}

/** A copy of a trajectory (the warp works in place). */
export function cloneTrajectory(tr: Trajectory): Trajectory {
  return { dt: tr.dt, x: tr.x.slice(), y: tr.y.slice(), warp: tr.warp.slice(), tau: tr.tau.slice() }
}

/** Log curvature (regularized) of every sample in [i0, i1) and the stroke's speed–curvature fit. */
function speedCurvature(tr: Trajectory, i0: number, i1: number): { lk: Float64Array; beta: number; meanK: number } | null {
  const { dt, x, y } = tr
  const h = 4 // samples either side for derivatives (4 ms)
  let vmax = 0
  for (let i = i0; i < i1; i++) vmax = Math.max(vmax, Math.hypot(x[i + 1] - x[i], y[i + 1] - y[i]) / dt)
  if (vmax <= 0) return null
  const m = i1 - i0
  // the same 12 ms Gaussian low-pass within the stroke that stats.powerLaw applies, so the
  // exponent aimed at here is the exponent measured there
  const X = new Float64Array(m), Y = new Float64Array(m)
  const sd = 0.012 / dt, reach = Math.ceil(3 * sd)
  for (let k = 0; k < m; k++) {
    let sw = 0, ax = 0, ay = 0
    for (let j = Math.max(0, k - reach); j <= Math.min(m - 1, k + reach); j++) {
      const w = Math.exp(-0.5 * ((j - k) / sd) ** 2)
      sw += w; ax += w * x[i0 + j]; ay += w * y[i0 + j]
    }
    X[k] = ax / sw
    Y[k] = ay / sw
  }
  const lk = new Float64Array(m)
  const lv = new Float64Array(m)
  const moving: number[] = []
  for (let k = h; k < m - h; k++) {
    const xd = (X[k + h] - X[k - h]) / (2 * h * dt), yd = (Y[k + h] - Y[k - h]) / (2 * h * dt)
    const xdd = (X[k + h] - 2 * X[k] + X[k - h]) / (h * h * dt * dt), ydd = (Y[k + h] - 2 * Y[k] + Y[k - h]) / (h * h * dt * dt)
    const sp = Math.hypot(xd, yd)
    const kappa = Math.abs(xd * ydd - yd * xdd) / Math.max(1e-9, sp * sp * sp)
    lk[k] = Math.log(kappa + CURVATURE_FLOOR)
    lv[k] = Math.log(Math.max(1e-9, sp))
    // the fit uses moving samples only: at a near-stop, direction and curvature are noise
    if (sp > 1) moving.push(k)
  }
  for (let k = 0; k < h; k++) lk[k] = lk[h]
  for (let k = m - h; k < m; k++) lk[k] = lk[m - h - 1]
  // and leaves out the stroke's curvature extremes (inflections, cusps), as stats.ts does;
  // outside that range the stretch is held at its value at the edge
  const sorted = moving.map((k) => lk[k]).sort((a, b) => a - b)
  if (sorted.length < 10) return null
  const lo = sorted[Math.floor(sorted.length * 0.05)], hi = sorted[Math.ceil(sorted.length * 0.95) - 1]
  let sx = 0, sy = 0, sxx = 0, sxy = 0, cnt = 0
  for (const k of moving) {
    const L = lk[k]
    if (L < lo || L > hi) continue
    sx += L; sy += lv[k]; sxx += L * L; sxy += L * lv[k]; cnt++
  }
  const varK = cnt > 8 ? sxx / cnt - (sx / cnt) ** 2 : 0
  if (varK < 1e-3) return null
  for (let k = 0; k < lk.length; k++) lk[k] = Math.min(hi, Math.max(lo, lk[k]))
  return { lk, beta: -(sxy / cnt - (sx / cnt) * (sy / cnt)) / varK, meanK: sx / cnt }
}

/** Curvature below this (1/mm, a 200 mm radius) counts as straight: it keeps log κ finite. */
const CURVATURE_FLOOR = 1 / 200

/**
 * Re-time each pen-down toward the two-thirds power law (see the overview), in place. Geometry
 * is kept and each pen-down keeps its duration; inside it, time stretches where the path curves
 * more than the stroke's average: log(dt_new/dt) = (β* − β̂)(log κ − mean), which turns a
 * stroke whose speed scales as κ^−β̂ into one scaling as κ^−β*, β* = β̂₀ + w (1/3 − β̂₀) with β̂₀
 * the stroke's own exponent (plus `w · bias`: simulate.ts uses it to pre-compensate what the
 * arm's dynamics will take off). Whatever of the speed the curvature does not explain (the
 * lognormal bumps) is left as it was. Stretching changes how samples weight the fit, so the estimate is
 * repeated over `passes` passes; stretch factors are bounded to [1/4, 4].
 */
export function powerLawWarp(tr: Trajectory, pens: PenDown[], w: number, bias = 0, passes = 3): void {
  if (w <= 0) return
  const n = tr.x.length
  const h = 4
  const spans = pens
    .map((pen) => [Math.max(h, Math.round(pen.down / tr.dt)), Math.min(n - 1 - h, Math.round(pen.up / tr.dt))])
    .filter(([i0, i1]) => i1 - i0 >= 3 * h)
  const target = new Map<number, number>()
  for (let pass = 0; pass < passes; pass++) {
    const f = new Float64Array(n).fill(1)
    spans.forEach(([i0, i1], s) => {
      const fit = speedCurvature(tr, i0, i1)
      if (!fit) return
      if (!target.has(s)) target.set(s, fit.beta + w * (1 / 3 - fit.beta) + w * bias)
      const gain = target.get(s)! - fit.beta
      let sum = 0
      for (let i = i0; i < i1; i++) sum += f[i] = Math.min(4, Math.max(0.25, Math.exp(gain * (fit.lk[i - i0] - fit.meanK))))
      const mean = sum / (i1 - i0)
      for (let i = i0; i < i1; i++) f[i] /= mean
    })
    retime(tr, f)
  }
}

/** Stretch each sample interval i by f[i] and resample the trajectory onto its uniform grid. */
function retime(tr: Trajectory, f: Float64Array): void {
  const { dt, x, y } = tr
  const n = x.length
  const tNew = new Float64Array(n)
  for (let i = 1; i < n; i++) tNew[i] = tNew[i - 1] + dt * f[i - 1]
  const nx = new Float64Array(n), ny = new Float64Array(n), nw = new Float64Array(n), nt = new Float64Array(n)
  let j = 0
  for (let i = 0; i < n; i++) {
    const t = i * dt
    while (j + 1 < n - 1 && tNew[j + 1] < t) j++
    const span = tNew[j + 1] - tNew[j]
    const u = span > 0 ? Math.min(1, Math.max(0, (t - tNew[j]) / span)) : 0
    nx[i] = x[j] + (x[j + 1] - x[j]) * u
    ny[i] = y[j] + (y[j + 1] - y[j]) * u
    nw[i] = tr.warp[j] * f[j]
    nt[i] = tr.tau[j] + (tr.tau[j + 1] - tr.tau[j]) * u
  }
  x.set(nx)
  y.set(ny)
  tr.warp.set(nw)
  tr.tau.set(nt)
}

/**
 * Each impulse's speed at plan samples i0, i0 + step, … < i1, on the warped clock: its speed at
 * the impulse-clock time the sample came from, divided by the warp factor there, so the
 * components still sum (as vectors) to the planned velocity. For velocity-profile plots.
 */
export function componentSpeeds(tr: Trajectory, impulses: Impulse[], i0: number, i1: number, step: number): number[][] {
  const v: [number, number] = [0, 0]
  return impulses.map((k) => {
    const out: number[] = []
    for (let i = i0; i < i1; i += step) out.push(Math.hypot(...velocity(k, tr.tau[i], v)) / Math.max(1e-6, tr.warp[i]))
    return out
  })
}
