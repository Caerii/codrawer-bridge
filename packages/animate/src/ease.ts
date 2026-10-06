/**
 * Easing: how an in-between's progress t ∈ [0, 1] is spaced in time.
 *
 * Animators call this "spacing": in-betweens bunched near the keys make a motion ease in and
 * out. The default, {@link lognormalEase}, is the speed profile of a human movement: Plamondon's
 * sigma-lognormal impulse, which packages/hand already uses to drive its simulated hand
 * (docs/investigations/hand-simulator.md). Its cumulative distribution is an ease-in-out with a
 * slightly faster start than end, the asymmetry a real reach has, and σ sets how asymmetric.
 *
 * Every function here maps [0, 1] onto [0, 1] monotonically with e(0) = 0 and e(1) = 1.
 */

import { lognormalCdf, timing } from 'hand'

export type Ease = (t: number) => number

const clamp01 = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t)

export const linear: Ease = (t) => clamp01(t)

/** Cubic ease-in-out (smoothstep). */
export const smooth: Ease = (t) => {
  const u = clamp01(t)
  return u * u * (3 - 2 * u)
}

export const easeIn: Ease = (t) => clamp01(t) ** 2
export const easeOut: Ease = (t) => 1 - (1 - clamp01(t)) ** 2

/**
 * The fraction of a sigma-lognormal movement completed at t, with the movement's effective
 * support (its 0.5 % to 99.5 % quantiles, hand's `timing`) stretched over [0, 1] and the result
 * renormalised so the ends are exact. σ ≈ 0.2–0.3 is a brisk reach; larger σ skews the peak
 * speed earlier.
 */
export function lognormalEase(sigma = 0.25): Ease {
  const { mu, t0 } = timing(0, 1, sigma)
  const a = lognormalCdf(0, t0, mu, sigma)
  const b = lognormalCdf(1, t0, mu, sigma)
  return (t) => {
    const u = clamp01(t)
    if (u === 0 || u === 1) return u
    return (lognormalCdf(u, t0, mu, sigma) - a) / (b - a)
  }
}

export const EASES = { linear, smooth, easeIn, easeOut, lognormal: lognormalEase() } as const
export type EaseName = keyof typeof EASES
