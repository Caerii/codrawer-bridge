/**
 * The measure behind linestart.test.ts: how much the first word of each wrapped line differs in
 * shape from the same word written on its own (the first word of a fresh text, which the hand
 * writes after a calm lead-in).
 *
 * Shape, not place: each word's strokes are moved so its first point is the origin, every stroke
 * is resampled to 24 points by arc length, and the deviation is the largest mean point distance
 * over the word's strokes, in mm. Two writings of a word by one hand differ a little (tremor,
 * motor noise); a carriage return that disturbs the hand shows up as millimetres.
 */

import type { Persona } from '../src/persona'
import { simulate, type Stroke } from '../src/simulate'

type P = [number, number]

function resample(pts: P[], n = 24): P[] {
  const cum = [0]
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]))
  const total = cum[cum.length - 1]
  if (total < 1e-9) return Array.from({ length: n }, () => [pts[0][0], pts[0][1]] as P)
  const out: P[] = []
  let j = 0
  for (let k = 0; k < n; k++) {
    const s = (total * k) / (n - 1)
    while (j < cum.length - 2 && cum[j + 1] < s) j++
    const u = (s - cum[j]) / Math.max(1e-9, cum[j + 1] - cum[j])
    out.push([pts[j][0] + (pts[j + 1][0] - pts[j][0]) * u, pts[j][1] + (pts[j + 1][1] - pts[j][1]) * u])
  }
  return out
}

function wordStrokes(strokes: Stroke[], word: number): P[][] {
  const ss = strokes.filter((s) => s.word === word && s.kind === 'ink')
  if (!ss.length) return []
  const [x0, y0] = ss[0].pts[0]
  return ss.map((s) => s.pts.map((p) => [p[0] - x0, p[1] - y0] as P))
}

/** Deviation in mm of the first word of every line after the first (see above). */
export function lineStartDeviation(text: string, persona: Persona, width: number, seed: number, every = false): { word: string; mm: number }[] {
  const r = simulate(text, persona, { seed, width })
  const out: { word: string; mm: number }[] = []
  let line = 0
  r.words.forEach((w, i) => {
    if ((!every && w.line === line) || w.struck) return
    line = w.line
    const bare = w.text.replace(/[^A-Za-z]/g, '')
    if (!bare || bare !== w.text) return // punctuation changes the glyph sequence; skip
    const alone = simulate(w.text, persona, { seed })
    const a = wordStrokes(r.strokes, i)
    const b = wordStrokes(alone.strokes, 0)
    if (!a.length || a.length !== b.length) {
      out.push({ word: w.text, mm: Infinity })
      return
    }
    let worst = 0
    for (let k = 0; k < a.length; k++) {
      const ra = resample(a[k]), rb = resample(b[k])
      const mean = ra.reduce((acc, p, m) => acc + Math.hypot(p[0] - rb[m][0], p[1] - rb[m][1]), 0) / ra.length
      worst = Math.max(worst, mean)
    }
    out.push({ word: w.text, mm: worst })
  })
  return out
}
