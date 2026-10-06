/**
 * Synthetic user marks for the tests and the rendered sequence, written by packages/hand's
 * biomechanical hand so they carry real-looking imperfection: lognormal strokes that round the
 * corners, tremor, a loop that does not quite close, a tick whose legs are not straight.
 *
 * Every helper takes the intended path in page mm and returns what a persona's pen would leave:
 * an {@link InkStroke} (mm points, start and end times) plus its pressures.
 */

import { simulate, sketcher, elder, archivist, type Persona } from 'hand'
import type { Pt, Rect } from '../src/geometry'
import type { ProvenancedStroke } from '../src/consent'

export const HANDS: Persona[] = [sketcher, elder, archivist]

let n = 0

/** The pen's version of `paths` (mm), starting at `t0` (Unix ms). One stroke per path. */
export function pen(paths: Pt[][], persona: Persona, seed: number, t0: number): ProvenancedStroke[] {
  const r = simulate({ paths }, persona, { seed })
  return r.strokes.map((s) => ({
    id: `u_${++n}`,
    pts: s.pts.map((p) => [p[0], p[1]] as Pt),
    pressure: s.pts.map((p) => p[2]),
    t0: t0 + s.down,
    t1: t0 + s.up,
    layer: 'user',
    origin: 'pen' as const,
    device: 'paperpro-01',
    author: 'p_alif',
  }))
}

/** Handwritten text with its first baseline at `at` (mm), at `scale`. */
export function written(text: string, at: Pt, persona: Persona, seed: number, t0: number, scale = 1): ProvenancedStroke[] {
  const r = simulate(text, persona, { seed })
  return r.strokes.map((s) => ({
    id: `u_${++n}`,
    pts: s.pts.map((p) => [at[0] + p[0] * scale, at[1] + p[1] * scale] as Pt),
    pressure: s.pts.map((p) => p[2]),
    t0: t0 + s.down,
    t1: t0 + s.up,
    layer: 'user',
    origin: 'pen' as const,
    device: 'paperpro-01',
    author: 'p_alif',
  }))
}

/** An ellipse around `r`, starting at the upper left and overshooting its start a little. */
export function circlePath(r: Rect, slack = 3, overshoot = 0.35): Pt[] {
  const cx = (r.x0 + r.x1) / 2, cy = (r.y0 + r.y1) / 2
  const rx = (r.x1 - r.x0) / 2 + slack, ry = (r.y1 - r.y0) / 2 + slack * 0.8
  const pts: Pt[] = []
  const a0 = -2.4
  for (let a = a0; a <= a0 + 2 * Math.PI + overshoot; a += 0.18) pts.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)])
  return pts
}

/** A tick whose vertex is at `v`: a short leg down to it, a long leg up and to the right. */
export function tickPath(v: Pt, size = 5): Pt[] {
  return [[v[0] - size * 0.45, v[1] - size * 0.45], v, [v[0] + size * 0.7, v[1] - size * 1.1]]
}

/** A strike through `r`, a little past both ends, with a slight slope. */
export function strikePath(r: Rect): Pt[] {
  const y = (r.y0 + r.y1) / 2
  return [[r.x0 - 2, y + 0.6], [r.x1 + 2, y - 0.6]]
}

/** An arrow from `a` to `b`: the shaft, then a two-legged head as a second stroke. */
export function arrowPaths(a: Pt, b: Pt): Pt[][] {
  const ang = Math.atan2(b[1] - a[1], b[0] - a[0])
  const h = 3.5
  const l: Pt = [b[0] - h * Math.cos(ang - 0.5), b[1] - h * Math.sin(ang - 0.5)]
  const r: Pt = [b[0] - h * Math.cos(ang + 0.5), b[1] - h * Math.sin(ang + 0.5)]
  return [[a, b], [l, b, r]]
}
