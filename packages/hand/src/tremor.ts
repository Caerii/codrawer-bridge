/**
 * Physiological tremor: the 8–12 Hz shiver every hand has.
 *
 * Normal (physiological) tremor has two components (Elble & Koller 1990, "Tremor", Johns
 * Hopkins; McAuley & Marsden 2000, "Physiological and pathological tremors and rhythmic central
 * motor control", Brain 123, 1545–1567; Elble 1996, "Central mechanisms of tremor", J. Clin.
 * Neurophysiol. 13, 133–144): a mechanical-reflex resonance whose frequency depends on the limb's
 * inertia and stiffness, and a central 8–12 Hz component that does not. Its amplitude at the
 * fingertip is tens of micrometres; it grows with age, fatigue and caffeine, and its frequency
 * drifts lower in older hands.
 *
 * Here the central component is band-limited Gaussian noise: white noise through a two-pole
 * resonator (the RBJ audio-cookbook band-pass, 0 dB at the peak) centred on the persona's
 * frequency with its bandwidth. The arm (arm.ts) feeds it into the wrist and finger commands,
 * where the joints' own resonance supplies the mechanical-reflex part. Its output is normalized
 * to unit RMS using the resonator's equivalent noise bandwidth (π/2 · bandwidth for a two-pole
 * band-pass), so the persona's `amplitude` means millimetres RMS.
 */

import type { Rng } from './rng'

/** A stream of band-limited noise with unit RMS, one sample per call. */
export class BandNoise {
  private b0: number
  private b2: number
  private a1: number
  private a2: number
  private x1 = 0
  private x2 = 0
  private y1 = 0
  private y2 = 0
  private readonly norm: number

  /**
   * `f0` centre frequency (Hz), `bw` −3 dB bandwidth (Hz), `fs` sample rate (Hz). Draws its
   * white noise from `rng`.
   */
  constructor(f0: number, bw: number, fs: number, private readonly rng: Rng) {
    const w0 = (2 * Math.PI * f0) / fs
    const q = f0 / Math.max(0.1, bw)
    const alpha = Math.sin(w0) / (2 * q)
    const a0 = 1 + alpha
    this.b0 = alpha / a0
    this.b2 = -alpha / a0
    this.a1 = (-2 * Math.cos(w0)) / a0
    this.a2 = (1 - alpha) / a0
    // white noise of unit variance has a one-sided PSD of 2/fs per Hz; the filter passes an
    // equivalent noise bandwidth of π/2 · bw at unit gain
    this.norm = 1 / Math.sqrt((2 / fs) * (Math.PI / 2) * Math.max(0.1, bw))
    // settle the filter so the first samples are not a ramp from silence
    for (let i = 0; i < Math.ceil((4 * fs) / Math.max(0.1, bw)); i++) this.next()
  }

  /** The next sample (dimensionless, RMS ≈ 1). */
  next(): number {
    const x = this.rng.gauss(1)
    const y = this.b0 * x + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2
    this.x2 = this.x1
    this.x1 = x
    this.y2 = this.y1
    this.y1 = y
    return y * this.norm
  }
}

/** `n` samples of band-limited unit-RMS noise (for tests and plots). */
export function bandNoise(n: number, f0: number, bw: number, fs: number, rng: Rng): Float64Array {
  const g = new BandNoise(f0, bw, fs, rng)
  const out = new Float64Array(n)
  for (let i = 0; i < n; i++) out[i] = g.next()
  return out
}
