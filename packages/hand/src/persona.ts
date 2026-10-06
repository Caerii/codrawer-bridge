/**
 * Personas: who is holding the pen.
 *
 * A persona is nothing but numbers over the model: which skeletons the hand follows, how big and
 * slanted it writes, how fast and how smoothly its motor commands overlap, how stiff and damped
 * its arm is, how much it trembles, how hard it presses and how long it pauses to think. Every
 * field below names its unit and the part of the pipeline that reads it, so a new persona is a
 * new object literal (or JSON file) and nothing else. `docs/investigations/hand-simulator.md`
 * describes the model behind each group.
 *
 * Typical values are anchored in the handwriting literature where it gives numbers: adult
 * cursive moves at roughly 20–60 mm/s with stroke durations of 100–250 ms (Plamondon & Djioua
 * 2006); lognormal σ fitted to handwriting strokes mostly falls in 0.1–0.5; physiological
 * tremor is 8–12 Hz at a few tens of micrometres at the fingertip (Elble & Koller 1990,
 * "Tremor"; McAuley & Marsden 2000, Brain 123, 1545–1567), larger and slower with age; pen-up
 * movements between letters take 100–250 ms. The Elder's tremor is deliberately well above
 * physiological so that it is visible on a page; it is a portrait, not a diagnosis.
 *
 * Units: mm, s, rad, Hz; pressure is the protocol's normalized 0..1.
 */

import type { Face } from './glyphs'

/** Letterforms and layout: read by layout.ts. */
export interface LetterParams {
  /** skeleton face: `futural` (sans print), `scripts` (cursive), `rowmans` (serif print) */
  face: Face
  /** join a word's letters into one pen-down where their ends meet (cursive) */
  join: boolean
  /** capital height, mm (the Paper Pro page is 179.6 mm wide) */
  capHeight: number
  /** forward lean as a shear, tan(angle): x += -y · slant (0 = upright, 0.3 ≈ 17°) */
  slant: number
  /** letter advance multiplier (1 = the face's own spacing) */
  letterSpacing: number
  /** word space multiplier (1 = the face's space) */
  wordSpacing: number
  /** baseline-to-baseline distance, in cap heights */
  lineSpacing: number
  /** per-letter scale variability, standard deviation as a fraction */
  sizeJitter: number
  /** per-letter slant variability, standard deviation (tan units) */
  slantJitter: number
  /** slow vertical drift of the planned baseline, mm (amplitude) */
  baselineWander: number
  /** i/j dots and t/x crosses are written after the word, as in cursive, instead of in place */
  delayDots: boolean
}

/** The sigma-lognormal motor plan: read by planner.ts. */
export interface MotorParams {
  /** overall speed multiplier (1 = an unhurried adult); impulse durations scale by 1/tempo */
  tempo: number
  /** duration of the effective support of a 3 mm impulse at tempo 1, s */
  strokeTime: number
  /** impulse duration ∝ D^sizeExponent: bigger movements are faster (isochrony), 0.3–0.5 */
  sizeExponent: number
  /** lognormal σ: smaller is a more symmetric, more abrupt bump (0.15–0.45) */
  sigma: number
  /**
   * how early the next command is issued, as a fraction of the current impulse's support:
   * 0 = one command after another (stop-and-go), 0.5 = smooth, coarticulated writing
   */
  overlap: number
  /** most turning one impulse may carry before the planner splits the curve, rad */
  maxSweep: number
  /** a skeleton vertex that turns more than this is a virtual target (a cusp or corner), rad */
  cornerAngle: number
  /**
   * pull toward the two-thirds power law (speed ∝ curvature^-1/3, Lacquaniti, Terzuolo & Viviani
   * 1983): the fraction of the gap between a stroke's own speed–curvature exponent and 1/3 that
   * its re-timing closes (0 = pure lognormal timing, 1 = exactly 1/3 in the plan)
   */
  powerLaw: number
  /** neuromotor variability between repetitions, standard deviations */
  noise: {
    /** amplitude, relative */
    D: number
    /** start and end directions, rad */
    theta: number
    /** command time, as a fraction of the impulse's support */
    t0: number
    /** log time delay, ln units */
    mu: number
    /** log response time, relative */
    sigma: number
  }
}

/** The biophysical arm and hand: read by arm.ts. */
export interface ArmParams {
  /** multiplier on every joint's natural frequency (shoulder 2.5, elbow 3.5, wrist 9, fingers 11 Hz) */
  stiffness: number
  /** damping ratio ζ of every joint (1 = critical; below it, the pen overshoots corners) */
  damping: number
  /** muscle activation time constant, s (excitation → force; 10–40 ms) */
  activation: number
  /** 0..1: how much of the planned acceleration and velocity the commands anticipate */
  anticipation: number
  /** time constant of the forearm following the writing along the line, s (long = wrist arcs) */
  carriage: number
  /** `glide`: the forearm drifts continuously; `word`: it repositions between words */
  carriageMode: 'glide' | 'word'
}

/** Physiological tremor: read by tremor.ts and arm.ts. */
export interface TremorParams {
  /** RMS of the tremor at the pen tip, mm (physiological ≈ 0.01–0.05) */
  amplitude: number
  /** centre frequency, Hz (8–12) */
  frequency: number
  /** −3 dB bandwidth, Hz */
  bandwidth: number
}

/** Pen pressure: read by pressure.ts. Results are clamped to [0.02, 1]. */
export interface PressureParams {
  /** resting pressure while writing, 0..1 */
  base: number
  /** multiplier on the whole profile */
  gain: number
  /** extra pressure on downstrokes (motion down the page), 0..1 */
  downstroke: number
  /** pressure shed at speed, 0..1 (saturating with speed) */
  speedDrop: number
  /** slow swells along a stroke, 0..1 amplitude */
  swell: number
  /** swell frequency, Hz */
  swellHz: number
  /**
   * broad-nib angle, rad from the x axis, or null for a round tip: with a nib the profile follows
   * |sin(direction − nib)|, thin along the nib and full across it
   */
  nibAngle: number | null
  /** how strongly the nib modulates, 0..1 */
  nibContrast: number
  /** pressure ramp after landing, s */
  rampIn: number
  /** pressure ramp before lifting, s */
  rampOut: number
}

/** Cognitive timing: read by compose.ts. Times are seconds of pen-up. */
export interface TimingParams {
  /** pen lift and touchdown overhead per pen-up, s */
  lift: number
  /** the pen-up movement's duration: base + perRootMm · √distance, s */
  flightBase: number
  flightPerRootMm: number
  /** extra pause between words, s */
  word: number
  /** after , ; : and dashes, s */
  phrase: number
  /** after . ? !, s */
  sentence: number
  /** before starting a new line, s */
  line: number
  /** extra pause before writing these symbols, s (the Mathematician's "=") */
  beforeSymbol: Record<string, number>
  /** pause after the result that follows an "=", s */
  afterResult: number
  /** pre-word hesitation at confidence 0, s (scaled by (1 − confidence)) */
  hesitation: number
  /** slowdown at confidence 0: impulse durations × (1 + doubt), easing in over the word */
  doubt: number
  /** chance of a self-correction (strike-through and rewrite) on a word of confidence 0 */
  correction: number
  /** variability of every pause, relative standard deviation */
  jitter: number
}

/** A writer. Every built-in persona below is one of these; so is anything the lab exports. */
export interface Persona {
  id: string
  name: string
  /** one line for the lab's picker */
  blurb: string
  /** which hand: a left hand mirrors the arm about the pen */
  hand: 'right' | 'left'
  letters: LetterParams
  motor: MotorParams
  arm: ArmParams
  tremor: TremorParams
  pressure: PressureParams
  timing: TimingParams
}

const deg = Math.PI / 180

/** Shared defaults; personas override what makes them themselves. */
const BASE: Omit<Persona, 'id' | 'name' | 'blurb'> = {
  hand: 'right',
  letters: {
    face: 'scripts',
    join: true,
    capHeight: 6,
    slant: 0.2,
    letterSpacing: 1,
    wordSpacing: 1,
    lineSpacing: 2.1,
    sizeJitter: 0.04,
    slantJitter: 0.03,
    baselineWander: 0.35,
    delayDots: true,
  },
  motor: {
    tempo: 1,
    strokeTime: 0.14,
    sizeExponent: 0.4,
    sigma: 0.3,
    overlap: 0.4,
    maxSweep: 75 * deg,
    cornerAngle: 55 * deg,
    powerLaw: 0.9,
    noise: { D: 0.05, theta: 0.06, t0: 0.03, mu: 0.04, sigma: 0.05 },
  },
  arm: { stiffness: 1, damping: 0.75, activation: 0.02, anticipation: 0.9, carriage: 0.6, carriageMode: 'glide' },
  tremor: { amplitude: 0.02, frequency: 10, bandwidth: 2.5 },
  pressure: {
    base: 0.5,
    gain: 1,
    downstroke: 0.15,
    speedDrop: 0.15,
    swell: 0.05,
    swellHz: 0.7,
    nibAngle: null,
    nibContrast: 0,
    rampIn: 0.025,
    rampOut: 0.035,
  },
  timing: {
    lift: 0.04,
    flightBase: 0.07,
    flightPerRootMm: 0.024,
    word: 0.18,
    phrase: 0.45,
    sentence: 0.8,
    line: 0.35,
    beforeSymbol: {},
    afterResult: 0,
    hesitation: 0.9,
    doubt: 0.7,
    correction: 0.08,
    jitter: 0.25,
  },
}

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] }

/** A persona from the shared defaults plus overrides (one level of nesting is merged). */
export function definePersona(p: { id: string; name: string; blurb: string } & DeepPartial<Omit<Persona, 'id' | 'name' | 'blurb'>>): Persona {
  return {
    id: p.id,
    name: p.name,
    blurb: p.blurb,
    hand: p.hand ?? BASE.hand,
    letters: { ...BASE.letters, ...p.letters } as LetterParams,
    motor: { ...BASE.motor, ...p.motor, noise: { ...BASE.motor.noise, ...p.motor?.noise } } as MotorParams,
    arm: { ...BASE.arm, ...p.arm } as ArmParams,
    tremor: { ...BASE.tremor, ...p.tremor } as TremorParams,
    pressure: { ...BASE.pressure, ...p.pressure } as PressureParams,
    timing: { ...BASE.timing, ...p.timing, beforeSymbol: { ...BASE.timing.beforeSymbol, ...p.timing?.beforeSymbol } } as TimingParams,
  }
}

/**
 * The Archivist: slow, upright print, light even pressure, low tremor. Distinct strokes (low
 * overlap), a well-damped arm that glides with the line, so baselines stay straight.
 */
export const archivist = definePersona({
  id: 'archivist',
  name: 'Archivist',
  blurb: 'slow upright print, light even pressure, steady hand',
  letters: { face: 'futural', join: false, capHeight: 5.4, slant: 0.03, letterSpacing: 1.1, wordSpacing: 1.1, sizeJitter: 0.035, slantJitter: 0.025, baselineWander: 0.25, delayDots: false },
  motor: { tempo: 0.8, sigma: 0.26, overlap: 0.2, powerLaw: 0.9, noise: { D: 0.045, theta: 0.05, t0: 0.03, mu: 0.03, sigma: 0.04 } },
  arm: { stiffness: 1.15, damping: 0.95, carriage: 0.3 },
  tremor: { amplitude: 0.012, frequency: 10.5 },
  pressure: { base: 0.36, downstroke: 0.06, speedDrop: 0.06, swell: 0.015 },
  timing: { word: 0.28, phrase: 0.55, hesitation: 0.7, doubt: 0.5, correction: 0.04, jitter: 0.15 },
})

/**
 * The Sketcher: fast, loose, slanted cursive with pressure swells. Heavily overlapped commands,
 * a light, underdamped arm that overshoots into loops, and a lazy forearm, so long words arc.
 */
export const sketcher = definePersona({
  id: 'sketcher',
  name: 'Sketcher',
  blurb: 'fast loose slanted cursive, pressure swells',
  letters: { face: 'scripts', join: true, capHeight: 6.6, slant: 0.38, letterSpacing: 0.94, wordSpacing: 0.95, sizeJitter: 0.07, slantJitter: 0.05, baselineWander: 0.6 },
  motor: { tempo: 1.65, sigma: 0.3, overlap: 0.42, powerLaw: 0.9, noise: { D: 0.08, theta: 0.09, t0: 0.04, mu: 0.06, sigma: 0.07 } },
  arm: { stiffness: 0.9, damping: 0.5, carriage: 1.4, anticipation: 0.85 },
  tremor: { amplitude: 0.02, frequency: 10 },
  pressure: { base: 0.42, downstroke: 0.28, speedDrop: 0.3, swell: 0.22, swellHz: 0.9 },
  timing: { lift: 0.03, flightBase: 0.05, word: 0.1, phrase: 0.3, sentence: 0.5, hesitation: 0.6, doubt: 0.5, correction: 0.12 },
})

/**
 * The Elder: perceptible tremor, hesitations, generous spacing, slower. A softer arm, larger and
 * slower tremor (age raises tremor amplitude and lowers its frequency), more variability between
 * repetitions, heavier pressure, and long pauses that grow with doubt.
 */
export const elder = definePersona({
  id: 'elder',
  name: 'Elder',
  blurb: 'perceptible tremor, hesitant, generous spacing',
  letters: { face: 'scripts', join: true, capHeight: 7, slant: 0.14, letterSpacing: 1.14, wordSpacing: 1.55, lineSpacing: 2.5, sizeJitter: 0.07, slantJitter: 0.05, baselineWander: 0.7 },
  motor: { tempo: 0.55, sigma: 0.32, overlap: 0.32, powerLaw: 0.9, noise: { D: 0.09, theta: 0.1, t0: 0.05, mu: 0.07, sigma: 0.08 } },
  arm: { stiffness: 0.75, damping: 0.7, activation: 0.03, anticipation: 0.75, carriage: 0.9, carriageMode: 'word' },
  tremor: { amplitude: 0.085, frequency: 9.2, bandwidth: 2 },
  pressure: { base: 0.58, downstroke: 0.18, speedDrop: 0.1, swell: 0.1, swellHz: 0.5, rampIn: 0.045 },
  timing: { lift: 0.07, flightBase: 0.12, word: 0.5, phrase: 0.9, sentence: 1.4, line: 0.7, hesitation: 1.8, doubt: 1.1, correction: 0.22, jitter: 0.35 },
})

/**
 * The Mathematician: crisp symbols, a pause before "=" and after the result, a tidy baseline.
 * Stiff, well-damped joints and short commands give sharp corners; the forearm follows closely.
 */
export const mathematician = definePersona({
  id: 'mathematician',
  name: 'Mathematician',
  blurb: 'crisp symbols, pauses before = and after results',
  letters: { face: 'futural', join: false, capHeight: 4.6, slant: 0.12, letterSpacing: 0.98, wordSpacing: 1.1, sizeJitter: 0.035, slantJitter: 0.03, baselineWander: 0.08, delayDots: false },
  motor: { tempo: 1.1, sigma: 0.24, overlap: 0.25, cornerAngle: 45 * deg, powerLaw: 0.9, noise: { D: 0.045, theta: 0.05, t0: 0.025, mu: 0.03, sigma: 0.035 } },
  arm: { stiffness: 1.25, damping: 0.9, carriage: 0.25 },
  tremor: { amplitude: 0.012, frequency: 10.8 },
  pressure: { base: 0.52, downstroke: 0.1, speedDrop: 0.12, swell: 0.02 },
  timing: { word: 0.16, beforeSymbol: { '=': 0.65, '⇒': 0.6, '→': 0.4, '≈': 0.6 }, afterResult: 0.55, hesitation: 0.8, correction: 0.06 },
})

/**
 * The Calligrapher: a broad nib at 40°, so width follows the stroke's direction; strong pressure
 * contrast; a deliberate tempo with smooth, well-overlapped commands and a steady hand.
 */
export const calligrapher = definePersona({
  id: 'calligrapher',
  name: 'Calligrapher',
  blurb: 'broad-nib contrast, deliberate tempo',
  letters: { face: 'scripts', join: true, capHeight: 8.5, slant: 0.24, letterSpacing: 1.05, wordSpacing: 1.15, lineSpacing: 2.3, sizeJitter: 0.025, slantJitter: 0.015, baselineWander: 0.2 },
  motor: { tempo: 0.6, sigma: 0.28, overlap: 0.42, powerLaw: 1, noise: { D: 0.03, theta: 0.03, t0: 0.02, mu: 0.025, sigma: 0.03 } },
  arm: { stiffness: 1, damping: 0.85, carriage: 0.45 },
  tremor: { amplitude: 0.01, frequency: 10 },
  pressure: { base: 0.3, gain: 1.15, downstroke: 0.25, speedDrop: 0.08, swell: 0.04, nibAngle: 40 * deg, nibContrast: 0.75, rampIn: 0.05, rampOut: 0.06 },
  timing: { lift: 0.06, flightBase: 0.1, word: 0.35, phrase: 0.7, hesitation: 0.9, doubt: 0.4, correction: 0.03 },
})

/** The built-in personas, in the lab's order. */
export const PERSONAS: Persona[] = [archivist, sketcher, elder, mathematician, calligrapher]

/** A built-in persona by id (`mirror` needs {@link mirror}). */
export function persona(id: string): Persona | undefined {
  return PERSONAS.find((p) => p.id === id)
}

/**
 * What the Mirror needs to know about the person writing: measured from their recent strokes
 * (stats.ts {@link userStats}). Any field may be missing.
 */
export interface UserStats {
  /** median pen speed while writing, mm/s */
  speed?: number
  /** typical stroke height (a proxy for x-height), mm */
  height?: number
  /** median pressure, 0..1 */
  pressure?: number
  /** forward lean, tan units */
  slant?: number
}

/**
 * The Mirror: a persona that adapts its tempo, size, pressure and lean to the user's recent
 * strokes, so the agent answers at the user's own pace and scale. Starts from `base` (the
 * Sketcher by default) and moves each parameter `follow` of the way toward the user's.
 */
export function mirror(stats: UserStats, base: Persona = sketcher, follow = 0.7): Persona {
  const p = definePersona({ ...base, id: 'mirror', name: 'Mirror', blurb: 'adapts tempo and size to your recent strokes' })
  const lerp = (a: number, b: number) => a + (b - a) * follow
  // an unhurried adult writes at ~35 mm/s at tempo 1 (persona notes above)
  if (stats.speed && stats.speed > 0) p.motor.tempo = lerp(base.motor.tempo, Math.min(3, Math.max(0.3, stats.speed / 35)))
  // a stroke's height is about the x-height; the cap height is ~1.6× that in these faces
  if (stats.height && stats.height > 0) p.letters.capHeight = lerp(base.letters.capHeight, Math.min(20, Math.max(2, stats.height * 1.6)))
  if (stats.pressure !== undefined) p.pressure.base = lerp(base.pressure.base, Math.min(0.9, Math.max(0.1, stats.pressure)))
  if (stats.slant !== undefined) p.letters.slant = lerp(base.letters.slant, Math.min(0.6, Math.max(-0.3, stats.slant)))
  return p
}
