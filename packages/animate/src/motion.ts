/**
 * Motion: moving a drawing (a lasso selection, a whole frame) along a path or under simple
 * physics, frame by frame. "Animate this" on a selection is {@link animateStrokes} with one of
 * the motions below.
 *
 * A motion is a function from time (ms since it began) to a 2-D affine transform in page
 * coordinates. The bounce is the classic first animation exercise and the twelve principles'
 * squash and stretch (Thomas & Johnston, 1981): a ball under gravity, losing a fixed fraction of
 * its speed at each impact (the coefficient of restitution), squashed against the ground for a
 * few ms on contact and stretched along its velocity in flight, with its area (sx × sy) kept
 * constant so it reads as the same ball.
 *
 * Units: page units are normalised (0..1 of the page width for x, of the height for y; y grows
 * down); time is ms; gravity is in page heights per s².
 */

import type { AnimStroke, Pt } from './model'
import type { Ease } from './ease'

/** x' = a x + c y + e, y' = b x + d y + f (the canvas convention). */
export interface Affine {
  a: number
  b: number
  c: number
  d: number
  e: number
  f: number
}

export const IDENTITY: Affine = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }

export function translate(dx: number, dy: number): Affine {
  return { a: 1, b: 0, c: 0, d: 1, e: dx, f: dy }
}

/** Scale by (sx, sy) about the point (px, py). */
export function scaleAbout(sx: number, sy: number, px: number, py: number): Affine {
  return { a: sx, b: 0, c: 0, d: sy, e: px - sx * px, f: py - sy * py }
}

/** m2 after m1. */
export function compose(m2: Affine, m1: Affine): Affine {
  return {
    a: m2.a * m1.a + m2.c * m1.b,
    b: m2.b * m1.a + m2.d * m1.b,
    c: m2.a * m1.c + m2.c * m1.d,
    d: m2.b * m1.c + m2.d * m1.d,
    e: m2.a * m1.e + m2.c * m1.f + m2.e,
    f: m2.b * m1.e + m2.d * m1.f + m2.f,
  }
}

export function applyAffine(m: Affine, strokes: AnimStroke[], idSuffix = ''): AnimStroke[] {
  return strokes.map((s) => ({
    ...s,
    id: s.id + idSuffix,
    pts: s.pts.map(([x, y, p]) => [m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f, p] as Pt),
  }))
}

export type Motion = (ms: number) => Affine

/** The bounding box [x0, y0, x1, y1] of some strokes. */
export function bbox(strokes: AnimStroke[]): [number, number, number, number] {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const s of strokes)
    for (const [x, y] of s.pts) {
      x0 = Math.min(x0, x)
      y0 = Math.min(y0, y)
      x1 = Math.max(x1, x)
      y1 = Math.max(y1, y)
    }
  return [x0, y0, x1, y1]
}

export interface BounceOptions {
  /** the y (page units) of the ground the drawing lands on: its bbox bottom touches it */
  ground: number
  /** where the drawing's bottom starts, page units above the ground */
  drop: number
  /** horizontal drift, page widths per second */
  vx?: number
  /** fraction of speed kept at each impact, 0..1 */
  restitution?: number
  /** page heights per s² */
  gravity?: number
  /** how much the drawing flattens on impact (0.3 = 30 % shorter at the hardest impact) */
  squash?: number
  /** contact time, ms */
  contactMs?: number
  /** stretch per unit of speed (page heights per s) in flight */
  stretch?: number
}

/**
 * A bounce for a drawing whose bounding box is `box`: it falls from `drop` above `ground`,
 * bounces with decreasing height, and rests. Squash is anchored at the ground contact point;
 * stretch is anchored at the drawing's centre.
 */
export function bounce(box: [number, number, number, number], o: BounceOptions): Motion {
  const g = o.gravity ?? 2.4
  const e = o.restitution ?? 0.62
  const squash = o.squash ?? 0.32
  const contact = o.contactMs ?? 70
  const stretchK = o.stretch ?? 0.12
  const vx = o.vx ?? 0
  const [x0, y0, x1, y1] = box
  const cx = (x0 + x1) / 2
  const cy = (y0 + y1) / 2
  // the flights: first a fall from rest, then rising and falling arcs with speed scaled by e
  const v0 = Math.sqrt(2 * g * o.drop) // impact speed, page heights / s
  const phases: { kind: 'fall' | 'arc' | 'contact'; ms: number; v: number }[] = [{ kind: 'fall', ms: (v0 / g) * 1000, v: v0 }]
  let v = v0
  while (v * e > 0.08) {
    phases.push({ kind: 'contact', ms: contact, v })
    v *= e
    phases.push({ kind: 'arc', ms: ((2 * v) / g) * 1000, v })
  }
  phases.push({ kind: 'contact', ms: contact * 1.5, v })
  return (ms: number) => {
    let t = Math.max(0, ms)
    const dx = vx * Math.min(t, phases.reduce((s, p) => s + p.ms, 0)) / 1000
    for (const ph of phases) {
      if (t > ph.ms) {
        t -= ph.ms
        continue
      }
      const s = t / 1000
      if (ph.kind === 'contact') {
        // a half sine of squash, deepest mid-contact, scaled by the impact speed
        const k = squash * Math.min(1, ph.v / v0) * Math.sin((Math.PI * t) / ph.ms)
        const sy = 1 - k
        const sx = 1 / sy
        return compose(translate(dx, o.ground - y1), scaleAbout(sx, sy, cx, y1))
      }
      // height of the bottom above the ground, and vertical speed (+ is up)
      const h = ph.kind === 'fall' ? o.drop - 0.5 * g * s * s : ph.v * s - 0.5 * g * s * s
      const vy = ph.kind === 'fall' ? -g * s : ph.v - g * s
      const k = Math.min(0.35, stretchK * Math.abs(vy))
      const sy = 1 + k
      const sx = 1 / sy
      const bottom = o.ground - Math.max(0, h)
      // stretched about its centre, then placed so its (stretched) bottom is at `bottom`
      return compose(translate(dx, bottom - (cy + sy * (y1 - cy))), scaleAbout(sx, sy, cx, cy))
    }
    return translate(dx, o.ground - y1)
  }
}

/** A straight move by (dx, dy) over `ms`, spaced by `ease`. */
export function moveBy(dx: number, dy: number, ms: number, ease: Ease): Motion {
  return (t) => {
    const u = ease(Math.min(1, Math.max(0, t / ms)))
    return translate(dx * u, dy * u)
  }
}

/**
 * Frames of `strokes` under `motion`, sampled at `fps` for `ms`: the stroke sets of the frames an
 * "Animate this" would insert. Ids get a `#<frame>` suffix.
 */
export function animateStrokes(strokes: AnimStroke[], motion: Motion, fps: number, ms: number): AnimStroke[][] {
  const n = Math.max(1, Math.round((ms * fps) / 1000))
  return Array.from({ length: n }, (_, k) => applyAffine(motion((k * 1000) / fps), strokes, `#${k}`))
}
