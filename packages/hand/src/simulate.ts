/**
 * simulate(): text in, a hand's strokes out.
 *
 * The pipeline, in the order the modules are best read:
 *
 *     compose   words → gestures, with pauses, hesitation and corrections   (compose.ts)
 *     layout    gestures' intended paths in mm                               (layout.ts)
 *     plan      paths → lognormal impulses + flights, summed to a 1 kHz plan (planner.ts)
 *     warp      each pen-down re-timed toward the two-thirds power law      (planner.ts)
 *     rehearse  the plan run on the arm (no tremor) twice, and the warp aimed
 *               further by what the arm's inertia smoothed away            (here)
 *     arm       a damped shoulder–elbow–wrist–finger body tracks the plan   (arm.ts)
 *     tremor    8–12 Hz band noise rides on the wrist and fingers           (tremor.ts)
 *     pressure  from direction, speed, contact ramps (and a nib)            (pressure.ts)
 *     sample    pen-down samples at `sampleHz` with their times             (here)
 *
 * The result is a list of strokes, each a list of points `[x, y, p, t]` (x, y in mm from the
 * start of the first baseline, y down; p 0..1; t in ms from the start of the performance), with
 * the pen-up flights between them. protocol.ts turns it into codrawer messages, perform.ts plays
 * it in real time.
 *
 * Everything random draws from named streams of one seed (rng.ts), so a persona writing the same
 * text with the same seed and options produces identical strokes.
 */

import { RELOCATE_MM, runArm, type ArmFrame, type WordPen } from './arm'
import { compose, composePaths, type ComposeOptions, type Phrase, type WordInfo } from './compose'
import { chord, type Impulse } from './lognormal'
import type { Pt } from './layout'
import type { Persona } from './persona'
import { cloneTrajectory, componentSpeeds, impulseDuration, integrate, planFlight, planPath, powerLawWarp, PLAN_HZ, type PlannedImpulse } from './planner'
import { pressure } from './pressure'
import { Rng } from './rng'
import { powerLaw } from './stats'

/** A point of ink: x, y (mm), pressure (0..1), t (ms from the start). */
export type Point = [number, number, number, number]

/** One pen-down. */
export interface Stroke {
  pts: Point[]
  /** `strike`: crossing out a word being taken back */
  kind: 'ink' | 'strike'
  /** index into {@link HandResult.words} */
  word: number
  /** touchdown and lift, ms from the start */
  down: number
  up: number
}

/** A pen-up between two strokes. */
export interface Flight {
  /** stroke indices */
  from: number
  to: number
  /** lift and touchdown, ms */
  lift: number
  land: number
  /** straight-line distance, mm */
  distance: number
}

/** The velocity profile of one stroke, for plots: what the plan asked for and what the tip did. */
export interface StrokeProfile {
  /** sample times, ms (every 5 ms through the pen-down, with 60 ms either side) */
  t: number[]
  /** pen-tip speed after the arm, mm/s */
  tip: number[]
  /** planned speed (sum of impulses, after the power-law warp), mm/s */
  plan: number[]
  /** each ink impulse's speed, mm/s, on the same clock */
  components: number[][]
}

/** Extra output for the lab. */
export interface Trace {
  /** arm poses at 60 Hz */
  arm: ArmFrame[]
  /** one profile per stroke */
  profiles: StrokeProfile[]
  /** every impulse of the plan (s, mm) */
  impulses: PlannedImpulse[]
  /** the motor plan under each stroke: [x, y] (mm) at the stroke's own point times */
  intended: [number, number][][]
}

/** What a simulation produced. */
export interface HandResult {
  strokes: Stroke[]
  flights: Flight[]
  words: WordInfo[]
  /** from the start to the last lift, ms */
  duration: number
  persona: string
  seed: number
  trace?: Trace
}

/** Options for {@link simulate}. */
export interface SimulateOptions extends ComposeOptions {
  /** random seed (default 1) */
  seed?: number
  /** output point rate while the pen is down, Hz (default 125: two points per 60 Hz batch) */
  sampleHz?: number
  /** also return arm poses and velocity profiles (for the lab) */
  trace?: boolean
}

/** Input: text, phrases with confidence, or raw paths in mm (a drawing). */
export type SimulateInput = string | Phrase[] | { paths: Pt[][] }

/** The pen hovers this long over the first point before touching down, s. */
const LEAD_IN = 0.12

/** After a carriage return (a flight longer than RELOCATE_MM), the pen hovers this long, s. */
const RELOCATE_LAND = 0.1

/** Rehearsals of the plan on the arm, to pre-compensate its smoothing of the power law. */
const REHEARSALS = 2

/** Write `input` as `persona` would. See the overview for the pipeline. */
export function simulate(input: SimulateInput, persona: Persona, opts: SimulateOptions = {}): HandResult {
  const seed = opts.seed ?? 1
  const root = new Rng(seed)
  const comp = typeof input === 'object' && !Array.isArray(input) ? composePaths(input.paths) : compose(input, persona, root, opts)
  const motor = persona.motor
  const T = persona.timing
  const rMotor = root.fork('motor')
  const rLand = root.fork('landing')

  // --- the plan: impulses for every gesture, flights between them
  const impulses: PlannedImpulse[] = []
  const pens: WordPen[] = []
  const kinds: ('ink' | 'strike')[] = []
  const gs = comp.gestures
  if (gs.length === 0) return { strokes: [], flights: [], words: comp.words, duration: 0, persona: persona.id, seed }
  const origin: Pt = [gs[0].pts[0][0], gs[0].pts[0][1]]
  let at: Pt = [origin[0], origin[1]] // where the plan has the pen now
  let prevUp = 0
  const d: [number, number] = [0, 0]
  gs.forEach((g, i) => {
    let land: number
    const start = g.pts[0]
    if (i === 0) land = LEAD_IN + g.hover
    else {
      // lift, think, travel, hover, touch down; the hand lands a little off its aim
      const aim: Pt = [start[0] + rLand.gauss(0.08), start[1] + rLand.gauss(0.08)]
      const dist = Math.hypot(aim[0] - at[0], aim[1] - at[1])
      const fs = prevUp + T.lift / 2 + g.think
      const dur = (T.flightBase + T.flightPerRootMm * Math.sqrt(dist)) / Math.sqrt(motor.tempo)
      const f = planFlight(at, aim, fs, dur, 0.28, rMotor, i)
      impulses.push(f)
      at = aim
      // touch down while the flight is still settling (a landing hook), unless hovering first;
      // after a carriage return the hand arrives first and settles (arm.ts carriageFilter), or
      // the next line's first letter is written by a hand still travelling
      const settle = dist > RELOCATE_MM ? dur + Math.max(g.hover, RELOCATE_LAND) : g.hover > 0 ? dur + g.hover : 0.9 * dur
      land = fs + settle + T.lift / 2
    }
    const slow = (k: number) => g.slow * (k < 3 ? 1 + (g.slowFirst - 1) * (1 - k / 3) : 1)
    const pts = g.pts.map((p) => [p[0] - start[0] + at[0], p[1] - start[1] + at[1]] as Pt)
    const { impulses: ks, up } = planPath(pts, motor, rMotor, land, i, slow)
    for (const k of ks) {
      impulses.push(k)
      chord(k, d)
      at = [at[0] + d[0], at[1] + d[1]]
    }
    pens.push({ down: land, up: Math.max(up, land + 0.02), word: g.word })
    kinds.push(g.kind)
    prevUp = pens[pens.length - 1].up
  })
  const end = prevUp + 0.25
  const raw = integrate(origin, impulses, end)
  let plan = cloneTrajectory(raw)
  powerLawWarp(plan, pens, motor.powerLaw)
  // The writer knows their own arm (an internal model: Wolpert, Ghahramani & Jordan 1995,
  // Science 269, 1880–1882): rehearse the plan on it without tremor, see how much of the
  // speed–curvature relation the body's inertia smooths away, and aim that much further.
  const goal = powerLaw(penSamples(plan.x, plan.y, pens)).beta
  let bias = 0
  for (let r = 0; r < REHEARSALS && motor.powerLaw > 0 && Number.isFinite(goal); r++) {
    const rehearsal = runArm(plan, pens, persona.arm, { ...persona.tremor, amplitude: 0 }, persona.hand, root.fork('tremor'))
    const got = powerLaw(penSamples(rehearsal.x, rehearsal.y, pens)).beta
    if (!Number.isFinite(got)) break
    bias = Math.max(-0.3, Math.min(0.3, bias + (goal - got) / motor.powerLaw))
    plan = cloneTrajectory(raw)
    powerLawWarp(plan, pens, motor.powerLaw, bias)
  }

  // --- the body
  const arm = runArm(plan, pens, persona.arm, persona.tremor, persona.hand, root.fork('tremor'), opts.trace ? 60 : 0)
  const p = pressure(arm.x, arm.y, plan.dt, pens, persona.pressure, root.fork('pressure'))

  // --- sampling: pen-down points at sampleHz, the touchdown and the lift included
  const hz = opts.sampleHz ?? 125
  const dtOut = 1 / hz
  const n = arm.x.length
  const at1k = (arr: Float64Array, t: number) => {
    const f = Math.min(n - 1, Math.max(0, t * PLAN_HZ))
    const i = Math.floor(f), u = f - i
    return i + 1 < n ? arr[i] + (arr[i + 1] - arr[i]) * u : arr[i]
  }
  const strokes: Stroke[] = pens.map((pen, s) => {
    const pts: Point[] = []
    const r3 = (v: number) => Math.round(v * 1000) / 1000
    for (let t = pen.down; ; t += dtOut) {
      const tt = Math.min(t, pen.up)
      pts.push([r3(at1k(arm.x, tt)), r3(at1k(arm.y, tt)), r3(at1k(p, tt)), Math.round(tt * 1000)])
      if (tt >= pen.up) break
    }
    // two samples rounding to the same ms (a very short tap) keep time strictly increasing
    for (let k = 1; k < pts.length; k++) if (pts[k][3] <= pts[k - 1][3]) pts[k][3] = pts[k - 1][3] + 1
    return { pts, kind: kinds[s], word: pens[s].word, down: pts[0][3], up: pts[pts.length - 1][3] }
  })
  const flights: Flight[] = []
  for (let s = 1; s < strokes.length; s++) {
    const a = strokes[s - 1].pts[strokes[s - 1].pts.length - 1], b = strokes[s].pts[0]
    flights.push({ from: s - 1, to: s, lift: strokes[s - 1].up, land: strokes[s].down, distance: Math.hypot(b[0] - a[0], b[1] - a[1]) })
  }
  const result: HandResult = { strokes, flights, words: comp.words, duration: strokes.length ? strokes[strokes.length - 1].up : 0, persona: persona.id, seed }

  if (opts.trace) {
    const profiles: StrokeProfile[] = pens.map((pen, s) => {
      const i0 = Math.max(0, Math.round((pen.down - 0.06) * PLAN_HZ))
      const i1 = Math.min(n - 1, Math.round((pen.up + 0.06) * PLAN_HZ))
      const step = 5
      const t: number[] = [], tip: number[] = [], pl: number[] = []
      for (let i = i0; i < i1; i += step) {
        const j = Math.min(n - 2, i)
        t.push(i)
        tip.push(Math.hypot(arm.x[j + 1] - arm.x[j], arm.y[j + 1] - arm.y[j]) * PLAN_HZ)
        pl.push(Math.hypot(plan.x[j + 1] - plan.x[j], plan.y[j + 1] - plan.y[j]) * PLAN_HZ)
      }
      const own = impulses.filter((k) => k.kind === 'ink' && k.stroke === s) as Impulse[]
      return { t, tip, plan: pl, components: componentSpeeds(plan, own, i0, i1, step) }
    })
    const intended = strokes.map((s) => s.pts.map((q) => [at1k(plan.x, q[3] / 1000), at1k(plan.y, q[3] / 1000)] as [number, number]))
    result.trace = { arm: arm.frames, profiles, impulses, intended }
  }
  return result
}

/** Pen-down samples of a 1 kHz trajectory at 200 Hz, as points (for power-law fits). */
function penSamples(x: Float64Array, y: Float64Array, pens: { down: number; up: number }[]): { pts: Point[] }[] {
  return pens.map((pen) => {
    const pts: Point[] = []
    for (let t = pen.down; t <= pen.up; t += 0.005) {
      const i = Math.min(x.length - 1, Math.round(t * PLAN_HZ))
      pts.push([x[i], y[i], 0, Math.round(t * 1000)])
    }
    return { pts }
  })
}

/** The duration a single impulse of amplitude `D` mm takes for `persona`, ms (for UIs). */
export function strokeMs(persona: Persona, D = 3): number {
  return impulseDuration(D, persona.motor) * 1000
}
