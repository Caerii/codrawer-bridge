/**
 * Synthetic personal marks and synthetic handwriting, for the tests, the evaluation and the
 * rendered sequence.
 *
 * A person who invents a glyph does not draw it the same way twice. Each instance here is the
 * glyph's template (mm) put through the variation a hand brings to a redrawn symbol, then written
 * by one of packages/hand's biomechanical personas (lognormal strokes, a damped arm, tremor):
 *
 * - size × 0.85–1.18, rotation ±10°, shear ±0.08, aspect ±8% (the page's angle, the moment);
 * - every control point moved by about 3.5% of the glyph's size, and dense curves warped by a
 *   smooth random field of the same amplitude (a loop drawn rounder or flatter);
 * - for multi-stroke glyphs, the strokes drawn in another order one time in three, and a stroke
 *   drawn backwards one time in five ($P is meant to be indifferent to both).
 *
 * Seeds make every instance reproducible: `instance(glyph, persona, seed)`.
 *
 * The glyphs are invented, as a user's would be. None is a letter, and none is one of the
 * built-in grammar's shapes (a lone circle, tick, line or cross), which cannot be taught
 * (grammar.ts); `circle` and `tick` are here only to test that refusal.
 */

import { simulate, Rng, sketcher, elder, archivist, mathematician, calligrapher, type Persona } from 'hand'
import type { Pt } from 'delegate'

export const PERSONAS: Persona[] = [sketcher, elder, archivist, mathematician, calligrapher]

const arc = (cx: number, cy: number, r: number, a0: number, a1: number, n = 24): Pt[] =>
  Array.from({ length: n + 1 }, (_, i) => { const a = a0 + ((a1 - a0) * i) / n; return [cx + r * Math.cos(a), cy + r * Math.sin(a)] as Pt })

/** Glyph templates: strokes of mm points, drawn in this order, about 9 mm across. */
export const GLYPHS: Record<string, Pt[][]> = {
  /** a lightning bolt, one stroke */
  bolt: [[[5.5, 0], [1, 5], [5.5, 4.6], [1.5, 10]]],
  /** a lemniscate, one stroke */
  infinity: [Array.from({ length: 49 }, (_, i) => {
    const t = (i / 48) * 2 * Math.PI
    const d = 1 + Math.sin(t) ** 2
    return [6 + (6 * Math.cos(t)) / d, 3 + (6 * Math.sin(t) * Math.cos(t)) / d] as Pt
  })],
  /** a spiral out from the centre, one stroke */
  spiral: [Array.from({ length: 49 }, (_, i) => {
    const t = (i / 48) * 3.5 * Math.PI
    const r = 0.4 + (4.4 * i) / 48
    return [5 + r * Math.cos(t), 5 + r * Math.sin(t)] as Pt
  })],
  /** a five-pointed star, one stroke */
  star: [Array.from({ length: 6 }, (_, i) => {
    const a = -Math.PI / 2 + (i * 4 * Math.PI) / 5
    return [5 + 5 * Math.cos(a), 5 + 5 * Math.sin(a)] as Pt
  })],
  /** an asterisk, three strokes */
  asterisk: [[[5, 0], [5, 10]], [[0.7, 2.5], [9.3, 7.5]], [[9.3, 2.5], [0.7, 7.5]]],
  /** a flag on a pole, two strokes */
  flag: [[[1, 0], [1, 11]], [[1, 0.3], [7.5, 2.6], [1, 5]]],
}

/** Built-in shapes, for the refusal test only. */
export const BUILTIN_SHAPES: Record<string, Pt[][]> = {
  circle: [arc(5, 5, 5, -2.4, -2.4 + 2 * Math.PI + 0.3)],
  tick: [[[0, 3], [2.5, 6], [8, 0]]],
}

/** A dense curve's points get a smooth warp; a sparse polyline's corners get independent jitter. */
function vary(paths: Pt[][], rng: Rng, amount = 0.035): Pt[][] {
  const all = paths.flat()
  const xs = all.map((p) => p[0]), ys = all.map((p) => p[1])
  const size = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys))
  const cx = (Math.max(...xs) + Math.min(...xs)) / 2, cy = (Math.max(...ys) + Math.min(...ys)) / 2
  const s = rng.range(0.85, 1.18), rot = (rng.range(-10, 10) * Math.PI) / 180, shear = rng.range(-0.08, 0.08), asp = rng.range(0.92, 1.08)
  const f = [rng.range(0, 6.28), rng.range(0, 6.28), rng.range(0.6, 1.4), rng.range(0.6, 1.4)]
  const warp = (p: Pt): Pt => [
    p[0] + amount * size * Math.sin((f[2] * 2 * Math.PI * (p[1] - cy)) / size + f[0]),
    p[1] + amount * size * Math.sin((f[3] * 2 * Math.PI * (p[0] - cx)) / size + f[1]),
  ]
  let out = paths.map((path) => path.map((p) => {
    const q: Pt = path.length > 8 ? warp(p) : [p[0] + rng.gauss(amount * size), p[1] + rng.gauss(amount * size)]
    const x = (q[0] - cx) * s, y = (q[1] - cy) * s * asp
    const xr = x * Math.cos(rot) - y * Math.sin(rot) + shear * y, yr = x * Math.sin(rot) + y * Math.cos(rot)
    return [xr, yr] as Pt
  }))
  if (out.length > 1 && rng.next() < 1 / 3) out = [...out].sort(() => rng.next() - 0.5)
  out = out.map((p) => (out.length > 1 && rng.next() < 0.2 ? [...p].reverse() : p))
  return out
}

let n = 0

/** A stroke as the engine takes it: id, mm points, times. */
export interface TestStroke {
  id: string
  pts: Pt[]
  t0: number
  t1: number
  author: string
  page?: string
}

/** One instance of `glyph` by `persona`, its box's top left at `at` (mm), starting at `t0` (Unix ms). */
export function instance(glyph: Pt[][], persona: Persona, seed: number, at: Pt = [0, 0], t0 = 0, author = 'alif'): TestStroke[] {
  const rng = new Rng(seed * 7919 + 17)
  const v = vary(glyph, rng)
  const all = v.flat()
  const x0 = Math.min(...all.map((p) => p[0])), y0 = Math.min(...all.map((p) => p[1]))
  const placed = v.map((p) => p.map(([x, y]) => [at[0] + x - x0, at[1] + y - y0] as Pt))
  const r = simulate({ paths: placed }, persona, { seed })
  return r.strokes.map((s) => ({ id: `s${++n}`, pts: s.pts.map((p) => [p[0], p[1]] as Pt), t0: t0 + s.down, t1: t0 + s.up, author }))
}

/** Handwriting: `text` by `persona` with its first baseline at `at` (mm). Strokes carry their word index. */
export function writing(text: string, persona: Persona, seed: number, at: Pt, t0 = 0, scale = 1, author = 'alif'): (TestStroke & { word: number })[] {
  const r = simulate(text, persona, { seed })
  return r.strokes.map((s) => ({
    id: `w${++n}`, word: s.word, pts: s.pts.map((p) => [at[0] + p[0] * scale, at[1] + p[1] * scale] as Pt), t0: t0 + s.down, t1: t0 + s.up, author,
  }))
}

/** Words for the rejection tests: common short words, single letters and digits, never one of the glyphs. */
export const WORDS = ['the', 'and', 'to', 'of', 'a', 'I', 'is', 'in', 'it', 'we', 'ok', 'yes', 'no', 'x', 'y', 'z', 'N', 'M', 'S', 'e', 'g', 'f', 'k', 'W', 'Z', '8', '3', '5', '7', 'm', 'so', 'go', 'by', 'up', 'if', 'or']

/**
 * Held-out words: never looked at while the constants were set (test/evaluate.ts reports them
 * separately), written larger, and including the cursive pairs that turned out to be the hard case.
 */
export const HELD_OUT = ['tea', 'hat', 'xy', 'wq', 'v', 'u', 'j', 'h', 'b', 'd', 'A', 'B', 'E', 'F', 'H', 'K', 'R', 'X', 'Y', '4', '9', '0', 'as', 'be', 'me', 'he', 'at', 'on', 'my', 'do', 'zz', 'ww', 'mm', 'vs', 'ex', 'fx']

/** Sentences for inline context. */
export const LINES = [
  'notes for the panel order',
  'ask about the refresh rate',
  'two boards by November',
  'check the proof of lemma 3',
  'call Sam about the budget',
]
