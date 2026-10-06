/**
 * The sigma-lognormal impulse: the unit of movement in Plamondon's Kinematic Theory.
 *
 * Plamondon's Kinematic Theory of rapid human movements (Plamondon 1995, "A kinematic theory of
 * rapid human movements. Part I: Movement representation and generation", Biol. Cybern. 72,
 * 295–307; Part II: "Movement time and control", 72, 309–320; the sigma-lognormal form in
 * Plamondon & Djioua 2006, "A multi-level representation paradigm for handwriting stroke
 * generation", Hum. Mov. Sci. 25, 586–607) models a neuromuscular system as a large number of coupled subsystems whose impulse
 * responses compound; by the central limit theorem their combined response converges to a
 * *lognormal* in time. One command produces one lognormal speed profile:
 *
 *     |v(t)| = D · Λ(t; t0, μ, σ),
 *     Λ(t) = exp(-(ln(t - t0) - μ)² / 2σ²) / (σ √(2π) (t - t0)),   t > t0,
 *
 * where D is the amplitude (the distance travelled, mm), t0 the time the command is issued (s),
 * μ the log time delay and σ the log response time of the neuromuscular system (dimensionless).
 * The direction sweeps along a circular arc from θs to θe in proportion to the distance covered:
 *
 *     φ(t) = θs + (θe - θs) · Φ(t),   Φ(t) = ½ (1 + erf((ln(t - t0) - μ) / (σ √2))).
 *
 * A pen stroke is a *sum* of such impulses, overlapping in time (each command is issued before
 * the previous one has finished), which is what gives handwriting its smooth, asymmetric,
 * bell-shaped velocity bumps.
 *
 * Because φ advances in proportion to the distance travelled (dφ/ds = (θe - θs)/D, a circle),
 * the displacement has a closed form, used here instead of numerical integration:
 *
 *     Δx(t) = D/Δθ · (sin φ(t) - sin θs),   Δy(t) = D/Δθ · (cos θs - cos φ(t)),   Δθ = θe - θs,
 *
 * which reduces to a straight line, D · Φ(t) · (cos θs, sin θs), as Δθ → 0. Differentiating it
 * gives back D · Λ(t) · (cos φ, sin φ); the test suite checks the two against each other.
 *
 * Units: time in seconds, distance in millimetres, angles in radians in the page frame
 * (x right, y down, so a positive Δθ turns clockwise on the page).
 */

/** One neuromotor command. */
export interface Impulse {
  /** amplitude: the arc length the command moves the pen, mm (> 0) */
  D: number
  /** time of occurrence: when the command is issued, s */
  t0: number
  /** log time delay (ln s) */
  mu: number
  /** log response time (dimensionless, > 0; handwriting fits are mostly 0.1–0.5) */
  sigma: number
  /** starting direction of the arc, rad */
  thetaS: number
  /** ending direction of the arc, rad */
  thetaE: number
}

const SQRT2 = Math.SQRT2
const SQRT2PI = Math.sqrt(2 * Math.PI)
/** z of the 0.5 % / 99.5 % quantiles: an impulse's effective support is exp(μ ± Z·σ) after t0 */
export const Z_SUPPORT = 2.5758

/**
 * The error function, to about 1.2e-7 everywhere (Numerical Recipes' erfc Chebyshev fit,
 * Press et al. 2007, §6.2). Pure and allocation-free: it runs a few million times per text.
 */
export function erf(x: number): number {
  const z = Math.abs(x)
  const t = 1 / (1 + 0.5 * z)
  const r =
    t *
    Math.exp(
      -z * z -
        1.26551223 +
        t *
          (1.00002368 +
            t *
              (0.37409196 +
                t *
                  (0.09678418 +
                    t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))),
    )
  return x >= 0 ? 1 - r : r - 1
}

/** The lognormal speed profile Λ(t; t0, μ, σ), 1/s; 0 before t0. Integrates to 1. */
export function lognormal(t: number, t0: number, mu: number, sigma: number): number {
  const dt = t - t0
  if (dt <= 0) return 0
  const z = (Math.log(dt) - mu) / sigma
  return Math.exp(-0.5 * z * z) / (sigma * SQRT2PI * dt)
}

/** The lognormal's cumulative distribution Φ(t): the fraction of D covered by time t. */
export function lognormalCdf(t: number, t0: number, mu: number, sigma: number): number {
  const dt = t - t0
  if (dt <= 0) return 0
  return 0.5 * (1 + erf((Math.log(dt) - mu) / (sigma * SQRT2)))
}

/** The pen velocity an impulse contributes at time t, mm/s, written into `out` ([vx, vy]). */
export function velocity(k: Impulse, t: number, out: [number, number] = [0, 0]): [number, number] {
  const s = k.D * lognormal(t, k.t0, k.mu, k.sigma)
  if (s === 0) {
    out[0] = out[1] = 0
    return out
  }
  const phi = k.thetaS + (k.thetaE - k.thetaS) * lognormalCdf(t, k.t0, k.mu, k.sigma)
  out[0] = s * Math.cos(phi)
  out[1] = s * Math.sin(phi)
  return out
}

/**
 * The displacement an impulse has produced by time t, mm, in closed form (see the overview),
 * written into `out`. Tends to the impulse's chord ({@link chord}) as t → ∞.
 */
export function displacement(k: Impulse, t: number, out: [number, number] = [0, 0]): [number, number] {
  const F = lognormalCdf(t, k.t0, k.mu, k.sigma)
  return arcAt(k, F, out)
}

/** The full displacement of an impulse once it has run its course, mm. */
export function chord(k: Impulse, out: [number, number] = [0, 0]): [number, number] {
  return arcAt(k, 1, out)
}

function arcAt(k: Impulse, F: number, out: [number, number]): [number, number] {
  const dth = k.thetaE - k.thetaS
  if (Math.abs(dth) < 1e-6) {
    out[0] = k.D * F * Math.cos(k.thetaS)
    out[1] = k.D * F * Math.sin(k.thetaS)
  } else {
    const phi = k.thetaS + dth * F
    const r = k.D / dth
    out[0] = r * (Math.sin(phi) - Math.sin(k.thetaS))
    out[1] = r * (Math.cos(k.thetaS) - Math.cos(phi))
  }
  return out
}

/** When an impulse's motion effectively starts and ends (its 0.5 % and 99.5 % quantiles), s. */
export function support(k: Impulse, z = Z_SUPPORT): [number, number] {
  return [k.t0 + Math.exp(k.mu - z * k.sigma), k.t0 + Math.exp(k.mu + z * k.sigma)]
}

/** The time of an impulse's peak speed (the lognormal's mode), s. */
export function peakTime(k: Impulse): number {
  return k.t0 + Math.exp(k.mu - k.sigma * k.sigma)
}

/**
 * The (μ, t0) that make an impulse's effective support run from `start` for `duration` seconds,
 * for a given σ: the inverse of {@link support}. The planner thinks in onsets and durations;
 * the model wants μ and t0.
 */
export function timing(start: number, duration: number, sigma: number, z = Z_SUPPORT): { mu: number; t0: number } {
  const scale = duration / (2 * Math.sinh(z * sigma)) // = exp(μ)
  return { mu: Math.log(scale), t0: start - scale * Math.exp(-z * sigma) }
}

/**
 * The circular arc through a chord: for a chord of length `L` (mm) in direction `alpha` (rad)
 * that the pen sweeps through `sweep` radians of turning, the impulse's D, θs and θe. The arc
 * is symmetric about the chord, so integrating the impulse lands exactly on the chord's end.
 */
export function arcThrough(L: number, alpha: number, sweep: number): { D: number; thetaS: number; thetaE: number } {
  const h = sweep / 2
  const D = Math.abs(h) < 1e-6 ? L : (L * h) / Math.sin(h)
  return { D, thetaS: alpha - h, thetaE: alpha + h }
}
