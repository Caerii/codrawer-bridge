/**
 * Pen pressure, from the movement that produced the ink.
 *
 * The protocol carries pressure per point (0..1) and clients draw width from it, so pressure is
 * how a persona's ink gets its weight and contrast. The model is a small set of regularities
 * visible in pressure-tablet recordings of handwriting, not a fit to data:
 *
 * - **downstrokes press harder**: pulling the pen toward the body loads the tip, upstrokes
 *   unload it (the classic shading of copperplate, and visible on any pressure tablet);
 * - **speed sheds pressure**: fast connecting strokes are lighter than slow, deliberate ones;
 * - **landing and lifting ramp**: the tip loads over the first tens of milliseconds of contact
 *   and unloads before it leaves;
 * - some writers **swell** slowly along a stroke;
 * - a **broad nib** makes width depend on direction: thin when moving along the nib's edge, full
 *   across it, |sin(direction − nib angle)| (the Calligrapher; ink width is what a client draws
 *   from pressure, so the nib is expressed as pressure).
 *
 * The raw profile is low-passed (8 ms) so direction changes never step, then multiplied by the
 * ramps and clamped to [0.02, 1]. Units: mm, s; output 0..1 per plan sample.
 */

import type { PenDown } from './planner'
import type { PressureParams } from './persona'
import type { Rng } from './rng'

/** Hermite smoothstep on [0, 1]. */
const smooth = (u: number) => (u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u))

/**
 * Pressure at every plan sample of the tip path (x, y at interval dt s) inside each pen-down;
 * zero outside. `rng` sets each stroke's swell phase.
 */
export function pressure(x: Float64Array, y: Float64Array, dt: number, pens: PenDown[], p: PressureParams, rng: Rng): Float64Array {
  const n = x.length
  const out = new Float64Array(n)
  const h = 3
  const tauLp = 0.008
  const a = dt / (tauLp + dt)
  for (const pen of pens) {
    const i0 = Math.max(0, Math.round(pen.down / dt))
    const i1 = Math.min(n - 1, Math.round(pen.up / dt))
    const phase = rng.range(0, 2 * Math.PI)
    let lp = NaN
    for (let i = i0; i <= i1; i++) {
      const ia = Math.max(0, i - h), ib = Math.min(n - 1, i + h)
      const span = (ib - ia) * dt || dt
      const vx = (x[ib] - x[ia]) / span, vy = (y[ib] - y[ia]) / span
      const v = Math.hypot(vx, vy)
      const dir = Math.atan2(vy, vx)
      const down = v > 1 ? Math.max(0, vy / v) : 0
      let raw = p.base + p.downstroke * (down - 0.3) - p.speedDrop * (Math.tanh(v / 60) - 0.5)
      raw += p.swell * Math.sin(2 * Math.PI * p.swellHz * (i - i0) * dt + phase)
      if (p.nibAngle !== null && v > 1) raw += p.nibContrast * (Math.abs(Math.sin(dir - p.nibAngle)) - 0.5)
      lp = Number.isNaN(lp) ? raw : lp + a * (raw - lp)
      const t = i * dt
      const ramp = smooth((t - pen.down) / Math.max(1e-3, p.rampIn)) * smooth((pen.up - t) / Math.max(1e-3, p.rampOut))
      out[i] = Math.min(1, Math.max(0.02, p.gain * lp * (0.15 + 0.85 * ramp)))
    }
  }
  return out
}
