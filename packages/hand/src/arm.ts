/**
 * The arm: a planar shoulder–elbow linkage carrying a hand that pivots at the wrist and extends
 * its fingers, every joint a damped spring driven by a pair of muscles.
 *
 * **Why a body at all.** The motor plan (planner.ts) says where the pen should be; a real hand
 * gets there through mass, springs and delays. Inertia smooths the corners the plan asks for and
 * overshoots the sharp ones; a hand that rests on its wrist and writes a long word by rotating
 * about it draws an arc-shaped baseline unless the forearm slides along; tremor rides on the
 * joints' own resonance. This layer supplies exactly those effects and nothing more.
 *
 * **Geometry** (right hand; a left hand is the mirror image). Page frame, mm, x right, y down.
 * The heel of the hand rests at the wrist pivot W, about 72 mm below and to the right of the pen
 * tip; the shoulder S sits ~390 mm further down and right. Upper arm 310 mm, forearm 255 mm (adult
 * anthropometry, Winter 2009, "Biomechanics and Motor Control of Human Movement", table 4.1).
 *
 * - Shoulder q1 and elbow q2 (rad) place W: the *carriage* that moves the hand along the line.
 * - Wrist q3 (rad) rotates the hand about W (abduction/adduction: the side-to-side of writing).
 * - Fingers q4 (mm) extend and flex the pen along the hand's axis (the up-and-down of writing).
 *
 * **Who does what** (redundancy resolution). Four joints, two coordinates: the arm takes the slow
 * part of the plan and the hand the fast part, as in real writing (Meulenbroek, Rosenbaum,
 * Thomassen, Loukopoulos & Vaughan 1996, "Adaptation of a reaching model to handwriting",
 * Psychol. Res. 59, 64–74). The forearm's target W* follows a zero-phase low-pass of the plan
 * (`carriage` seconds; or, in `word` mode, holds each word's centre and moves between words).
 * What remains, the letter-scale residual, is handed to the wrist and fingers *linearly*: its
 * component across the hand's axis becomes a wrist angle (arc length / hand length) and its
 * component along the axis a finger extension. The linear mapping is the point: a hand that
 * covers a long word by rotating its wrist moves the pen on a circle about the pivot, so the
 * baseline sags into an arc (sagitta ≈ residual² / 2 · 72 mm), the arcs writers are told to
 * avoid by moving the forearm. A short `carriage` keeps the residual, and the arc, small.
 *
 * **Joints.** Each joint is a second-order system, I q̈ = τ − b q̇, driven by an agonist and an
 * antagonist modelled as springs pulling toward the ends of the joint's range with stiffness
 * proportional to activation (the equilibrium-point picture: Feldman 1966; Bizzi, Accornero,
 * Chapple & Hogan 1984, J. Neurosci. 4, 2738–2744). With activations a+ and a−:
 *
 *     τ = k (a+ (q_max − q) + a− (q_min − q)) = k (a+ + a−) (λ − q),
 *     λ = (a+ q_max + a− q_min) / (a+ + a−),
 *
 * so co-contraction a+ + a− sets the stiffness and their balance the equilibrium λ. Activations
 * follow neural commands through first-order dynamics (time constant `activation`, 10–40 ms;
 * Zajac 1989, Crit. Rev. Biomed. Eng. 17, 359–411). The commands place λ on the planned joint
 * angle plus a feedforward of the planned velocity and acceleration (`anticipation`), issued
 * that much early to cover the activation delay. Normalized by inertia, each joint is set by its
 * natural frequency (shoulder 2.5, elbow 3.5, wrist 9, fingers 11 Hz, × `stiffness`) and damping
 * ratio ζ (`damping`); below ζ = 1 the pen overshoots.
 *
 * **Tremor** (tremor.ts) enters the wrist and finger equilibria, scaled by the inverse of each
 * joint's gain at the tremor frequency so that `tremor.amplitude` is the RMS at the pen tip.
 *
 * **Integration.** Semi-implicit (symplectic) Euler at the plan's 1 kHz: velocity first, then
 * position with the new velocity. For a damped oscillator it is stable while ω·dt < 2 − 2ζω·dt
 * roughly; at 1 kHz the stiffest joint (11 Hz × 3) has ω·dt ≈ 0.2, far inside.
 */

import { PLAN_HZ, type PenDown, type Trajectory } from './planner'
import type { ArmParams, TremorParams } from './persona'
import type { Rng } from './rng'
import { BandNoise } from './tremor'

/** Arm segment lengths and the rest pose, mm, right hand. */
export const GEOMETRY = {
  upperArm: 310,
  forearm: 255,
  /** pen tip relative to the wrist pivot at rest */
  tipFromPivot: [-40, -60] as [number, number],
  /** shoulder relative to the wrist pivot at rest */
  shoulderFromPivot: [150, 360] as [number, number],
  /** the knuckles, as a fraction of the pivot-to-tip distance (for drawing the hand) */
  knuckle: 0.55,
}

/**
 * How much of the forearm's swing along a line the wrist undoes to keep the hand's orientation
 * on the page (1 = all of it). The rest slowly rotates the letters as the arm travels, one source
 * of the drifting baselines of unruled writing.
 */
const HAND_COMPENSATION = 0.9

/** Natural frequencies of shoulder, elbow, wrist and fingers at stiffness 1, Hz. */
export const JOINT_HZ = [2.5, 3.5, 9, 11]
/** Joint ranges [min, max] about the rest pose: rad, rad, rad, mm. */
const RANGE: [number, number][] = [
  [-1.5, 1.5],
  [-1.5, 1.5],
  [-0.8, 0.8],
  [-35, 35],
]

/** A pose of the arm for drawing, page mm. */
export interface ArmFrame {
  /** time, s */
  t: number
  shoulder: [number, number]
  elbow: [number, number]
  wrist: [number, number]
  knuckle: [number, number]
  tip: [number, number]
  /** pen on the paper */
  down: boolean
}

/** What the arm did. */
export interface ArmResult {
  /** pen-tip trajectory at the plan rate, mm */
  x: Float64Array
  y: Float64Array
  /** poses at `frameHz`, when asked for */
  frames: ArmFrame[]
}

/** A pen-down with the word it belongs to (for the `word` carriage). */
export interface WordPen extends PenDown {
  word: number
}

/** Zero-phase first-order low-pass (forward, then backward), time constant tau samples. */
function zeroPhase(src: Float64Array, tau: number): Float64Array {
  const out = Float64Array.from(src)
  if (tau <= 0) return out
  const a = 1 / (1 + tau)
  for (let i = 1; i < out.length; i++) out[i] = out[i - 1] + a * (out[i] - out[i - 1])
  for (let i = out.length - 2; i >= 0; i--) out[i] = out[i + 1] + a * (out[i] - out[i + 1])
  return out
}

/**
 * A pen-up travel longer than this (mm) is a carriage return or a jump across the page, not the
 * gap between letters or words (a word space is 3–8 mm): the forearm relocates during it.
 */
export const RELOCATE_MM = 25

/** How long before touchdown a relocating forearm has arrived, s (it then holds still). */
const RELOCATE_SETTLE = 0.12

/** The pen-ups during which the forearm relocates: sample indices [lift, land). */
export function relocations(plan: Trajectory, pens: PenDown[]): [number, number][] {
  const n = plan.x.length, dt = plan.dt
  const out: [number, number][] = []
  for (let k = 1; k < pens.length; k++) {
    const lift = Math.min(n - 1, Math.max(0, Math.round(pens[k - 1].up / dt)))
    const land = Math.min(n - 1, Math.max(0, Math.round(pens[k].down / dt)))
    if (land <= lift + 1) continue
    if (Math.hypot(plan.x[land] - plan.x[lift], plan.y[land] - plan.y[lift]) > RELOCATE_MM) out.push([lift, land])
  }
  return out
}

/**
 * The carriage filter, line by line. A zero-phase low-pass over the whole plan would smear a
 * carriage return over ± the filter's time constant: the forearm would still be travelling back
 * when the next line starts, and the wrist and fingers, which take the remainder linearly (an
 * arc about the pivot), would write that line's first letters at a large, changing wrist angle,
 * skewed by millimetres. A writer instead moves the forearm to the new line while the pen is up
 * and starts writing with the hand at rest. So: each stretch between relocations is filtered on
 * its own, and across a relocation the target moves smoothly (smoothstep) from where the last
 * stretch ended to where the next begins, arriving RELOCATE_SETTLE s before touchdown.
 */
function carriageFilter(src: Float64Array, tau: number, moves: [number, number][], dt: number): Float64Array {
  if (!moves.length) return zeroPhase(src, tau)
  const out = new Float64Array(src.length)
  let from = 0
  const spans: [number, number][] = []
  for (const [lift, land] of moves) {
    spans.push([from, lift + 1])
    from = land
  }
  spans.push([from, src.length])
  for (const [a, b] of spans) if (b > a) out.set(zeroPhase(src.subarray(a, b), tau), a)
  for (const [lift, land] of moves) {
    const a = out[lift], b = out[land]
    const arrive = Math.max(lift + 1, land - Math.round(RELOCATE_SETTLE / dt))
    for (let i = lift + 1; i < land; i++) {
      const u = Math.min(1, (i - lift) / (arrive - lift))
      out[i] = a + (b - a) * u * u * (3 - 2 * u)
    }
  }
  return out
}

/** Gain of a joint (λ → q) at angular frequency w: ω² / |ω² − w² + 2iζωw|. */
function jointGain(omega: number, zeta: number, w: number): number {
  return (omega * omega) / Math.hypot(omega * omega - w * w, 2 * zeta * omega * w)
}

/**
 * Drive the arm along a planned trajectory. `pens` are the pen-downs (with their words, for the
 * `word` carriage); `rng` feeds the tremor. Returns the tip's actual path, and poses at
 * `frameHz` when `frameHz` > 0.
 */
export function runArm(
  plan: Trajectory,
  pens: WordPen[],
  arm: ArmParams,
  tremor: TremorParams,
  hand: 'right' | 'left',
  rng: Rng,
  frameHz = 0,
): ArmResult {
  const n = plan.x.length
  const dt = plan.dt
  const mx = hand === 'left' ? -1 : 1 // mirror x for a left hand
  const G = GEOMETRY
  const L1 = G.upperArm, L2 = G.forearm
  const r0: [number, number] = [mx * G.tipFromPivot[0], G.tipFromPivot[1]]
  const l0 = Math.hypot(r0[0], r0[1])

  // --- the carriage target W*(t): the slow part of the plan, offset from tip to pivot, line by
  // line (carriageFilter: the forearm relocates while the pen is up, not into the next line)
  const moves = relocations(plan, pens)
  let cx: Float64Array
  if (arm.carriageMode === 'word' && pens.length) {
    // hold each word's centre while it is written; glide between words
    const step = new Float64Array(n)
    const centre = new Map<number, { s: number; c: number }>()
    for (const p of pens) {
      const i0 = Math.max(0, Math.round(p.down / dt)), i1 = Math.min(n - 1, Math.round(p.up / dt))
      const e = centre.get(p.word) ?? { s: 0, c: 0 }
      for (let i = i0; i <= i1; i += 5) (e.s += plan.x[i]), e.c++
      centre.set(p.word, e)
    }
    let k = 0
    let cur = pens[0] ? centre.get(pens[0].word)! : { s: plan.x[0], c: 1 }
    for (let i = 0; i < n; i++) {
      while (k < pens.length && pens[k].down / dt <= i + 0.15 * PLAN_HZ) cur = centre.get(pens[k++].word) ?? cur
      step[i] = cur.c ? cur.s / cur.c : plan.x[i]
    }
    cx = carriageFilter(step, 0.12 * PLAN_HZ, moves, dt)
  } else {
    cx = carriageFilter(plan.x, arm.carriage * PLAN_HZ, moves, dt)
  }
  const cy = carriageFilter(plan.y, 0.5 * arm.carriage * PLAN_HZ, moves, dt)

  // --- the rest pose: pivot under the first point; shoulder fixed relative to it
  const W0: [number, number] = [cx[0] - r0[0], cy[0] - r0[1]]
  const S: [number, number] = [W0[0] + mx * G.shoulderFromPivot[0], W0[1] + G.shoulderFromPivot[1]]
  const ik = (wx: number, wy: number, out: number[]) => {
    const dx = wx - S[0], dy = wy - S[1]
    const d2 = dx * dx + dy * dy
    const c2 = Math.max(-1, Math.min(1, (d2 - L1 * L1 - L2 * L2) / (2 * L1 * L2)))
    // the elbow bends outward: away from the body (to the right for a right hand)
    const q2 = -mx * Math.acos(c2)
    const q1 = Math.atan2(dy, dx) - Math.atan2(L2 * Math.sin(q2), L1 + L2 * Math.cos(q2))
    out[0] = q1
    out[1] = q2
  }
  const q0 = [0, 0]
  ik(W0[0], W0[1], q0)
  const phi0 = q0[0] + q0[1] // forearm direction at rest
  const gamma0 = Math.atan2(r0[1], r0[0]) - phi0 // the hand's axis relative to the forearm

  // --- joint targets q*(t)
  const qs = [new Float64Array(n), new Float64Array(n), new Float64Array(n), new Float64Array(n)]
  const tmp = [0, 0]
  for (let i = 0; i < n; i++) {
    const wx = cx[i] - r0[0], wy = cy[i] - r0[1]
    ik(wx, wy, tmp)
    const phi = tmp[0] + tmp[1]
    // the hand's resting axis on the page: the wrist undoes most of the forearm's swing, so
    // letters keep their orientation along the line (HAND_COMPENSATION)
    const ax = phi0 + gamma0 + (1 - HAND_COMPENSATION) * (phi - phi0)
    const ur = [Math.cos(ax), Math.sin(ax)]
    const ut = [-ur[1], ur[0]]
    // what is left for the wrist and fingers: the plan minus the resting tip, mapped linearly
    const rx = plan.x[i] - (wx + l0 * ur[0]), ry = plan.y[i] - (wy + l0 * ur[1])
    qs[0][i] = tmp[0]
    qs[1][i] = tmp[1]
    qs[2][i] = ax - (phi + gamma0) + (rx * ut[0] + ry * ut[1]) / l0
    qs[3][i] = rx * ur[0] + ry * ur[1]
  }

  // --- dynamics
  const zeta = Math.max(0.05, arm.damping)
  const omega = JOINT_HZ.map((f) => 2 * Math.PI * f * Math.max(0.05, arm.stiffness))
  const tauA = Math.max(0.002, arm.activation)
  const lead = Math.round((arm.anticipation * tauA) / dt)
  const h = 5 // samples either side for the planned derivatives
  const deriv = (q: Float64Array, i: number) => {
    const a = Math.max(0, i - h), b = Math.min(n - 1, i + h)
    const c = Math.min(n - 1, Math.max(0, i))
    const v = (q[b] - q[a]) / ((b - a) * dt || dt)
    const acc = a < c && c < b ? (q[b] - 2 * q[c] + q[a]) / (h * h * dt * dt) : 0
    return [v, acc]
  }
  const COCON = 0.5 // co-contraction a+ + a− (sets stiffness; the normalization absorbs its value)
  const q = qs.map((s) => s[0])
  const qd = [0, 0, 0, 0]
  // each joint's range about its rest value (the shoulder and elbow rest at their IK angles)
  const range = RANGE.map(([lo, hi], j) => [lo + (j < 2 ? q0[j] : 0), hi + (j < 2 ? q0[j] : 0)])
  const ap = qs.map((s, j) => (COCON * (s[0] - range[j][0])) / (range[j][1] - range[j][0]))
  const am = ap.map((a) => COCON - a)

  // tremor, scaled to millimetres RMS at the tip, split between wrist (across) and fingers (along)
  const wT = 2 * Math.PI * tremor.frequency
  const tw = new BandNoise(tremor.frequency, tremor.bandwidth, PLAN_HZ, rng.fork('wrist'))
  const tf = new BandNoise(tremor.frequency, tremor.bandwidth, PLAN_HZ, rng.fork('fingers'))
  const share = tremor.amplitude / Math.SQRT2
  const gW = Math.max(0.2, jointGain(omega[2], zeta, wT))
  const gF = Math.max(0.2, jointGain(omega[3], zeta, wT))

  const x = new Float64Array(n)
  const y = new Float64Array(n)
  const frames: ArmFrame[] = []
  const frameEvery = frameHz > 0 ? Math.max(1, Math.round(PLAN_HZ / frameHz)) : 0
  let pen = 0
  for (let i = 0; i < n; i++) {
    const trem = [0, 0, (share * tw.next()) / gW / l0, (share * tf.next()) / gF]
    for (let j = 0; j < 4; j++) {
      const k = Math.min(n - 1, i + lead)
      const [v, acc] = deriv(qs[j], k)
      const w = omega[j]
      const lam = qs[j][k] + arm.anticipation * (acc / (w * w) + (2 * zeta * v) / w)
      const [lo, hi] = range[j]
      const up = Math.min(COCON, Math.max(0, (COCON * (lam - lo)) / (hi - lo)))
      ap[j] += (dt * (up - ap[j])) / tauA
      am[j] += (dt * (COCON - up - am[j])) / tauA
      const lamEff = (ap[j] * hi + am[j] * lo) / Math.max(1e-9, ap[j] + am[j]) + trem[j]
      const a = w * w * (lamEff - q[j]) - 2 * zeta * w * qd[j]
      qd[j] += dt * a
      q[j] += dt * qd[j]    }
    // forward kinematics
    const ex = S[0] + L1 * Math.cos(q[0]), ey = S[1] + L1 * Math.sin(q[0])
    const phi = q[0] + q[1]
    const wx = ex + L2 * Math.cos(phi), wy = ey + L2 * Math.sin(phi)
    const ax = phi + gamma0 + q[2]
    const len = l0 + q[3]
    x[i] = wx + len * Math.cos(ax)
    y[i] = wy + len * Math.sin(ax)
    if (frameEvery && i % frameEvery === 0) {
      const t = i * dt
      while (pen < pens.length && pens[pen].up < t) pen++
      const kn = l0 * G.knuckle
      const kx = wx + kn * Math.cos(phi + gamma0 + q[2] - mx * 0.35), ky = wy + kn * Math.sin(phi + gamma0 + q[2] - mx * 0.35)
      frames.push({
        t,
        shoulder: [S[0], S[1]],
        elbow: [ex, ey],
        wrist: [wx, wy],
        knuckle: [kx, ky],
        tip: [x[i], y[i]],
        down: pen < pens.length && pens[pen].down <= t && t <= pens[pen].up,
      })
    }
  }
  return { x, y, frames }
}
