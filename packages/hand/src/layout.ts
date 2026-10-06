/**
 * Layout: from words to the pen-down paths a hand intends, in millimetres on the page.
 *
 * This is the *intention* only: where the writer means the letters to go. Everything that makes
 * the ink human (velocity, overshoot, arcs, tremor, pressure, pauses) happens downstream. What
 * the layout does contribute is the variability a writer plans rather than executes: each letter
 * gets its own small size and slant drift, and the baseline wanders slowly, as it does on
 * unruled paper (persona `letters`).
 *
 * Writing order follows a hand, not a font file:
 *
 * - In a cursive persona (`join`) the strokes of a word whose ends nearly meet are joined into a
 *   single pen-down, so "travel" is one continuous movement. Hershey's script face is built for
 *   this: each lowercase letter enters and leaves at the joining height.
 * - With `delayDots`, the i and j dots and the t and x crosses (a lowercase letter's extra
 *   strokes) wait until the word is finished, as cursive writers do.
 * - A dot is a tap, not a circle: Hershey's tiny dot polygons become a short flick.
 *
 * Coordinates: mm, x right and y down, origin at the start of the first baseline. Each new line
 * starts `lineSpacing` cap heights lower.
 */

import { glyph, UNITS_PER_CAP, type GPt } from './glyphs'
import type { LetterParams } from './persona'
import type { Rng } from './rng'

/** A point on the page, mm. */
export type Pt = [number, number]

/** One planned pen-down. */
export interface LaidStroke {
  /** the intended path, mm, in writing order */
  pts: Pt[]
  /** a dot or cross written after its word */
  delayed: boolean
}

/** A word as laid out: its strokes and where it sits. */
export interface LaidWord {
  text: string
  strokes: LaidStroke[]
  /** bounding box of the intended ink, mm: [x0, y0, x1, y1] */
  box: [number, number, number, number]
  /** the baseline the word sits on, mm */
  baseline: number
  line: number
}

const isLowerJoinable = (ch: string) => /\p{Ll}/u.test(ch)
const isLetter = (ch: string) => /\p{L}/u.test(ch)

/** Lays out words one at a time at a moving cursor (a pen moving along lines). */
export class Writer {
  /** cursor: x of the next letter, mm */
  x = 0
  line = 0
  private readonly unit: number
  private readonly phase: number

  constructor(
    private readonly p: LetterParams,
    private readonly rng: Rng,
    /** wrap width, mm (Infinity: one line) */
    private readonly width = Infinity,
  ) {
    this.unit = p.capHeight / UNITS_PER_CAP
    this.phase = rng.range(0, 2 * Math.PI)
  }

  /** The baseline of the current line, mm. */
  get baseline(): number {
    return this.line * this.p.lineSpacing * this.p.capHeight
  }

  /** The planned baseline's slow wander at x, mm (two incommensurate sines: no visible period). */
  private wander(x: number): number {
    const a = this.p.baselineWander
    return a * (0.7 * Math.sin(x / 23 + this.phase) + 0.3 * Math.sin(x / 9.7 + 2.1 * this.phase))
  }

  /** The width `text` will take, mm, without its per-letter jitter (for wrapping decisions). */
  measure(text: string): number {
    let w = 0
    for (const ch of text) w += (glyph(this.p.face, ch)?.advance ?? 14) * this.p.letterSpacing
    return w * this.unit
  }

  /** Advance past a word space. */
  space(scale = 1): void {
    const adv = glyph(this.p.face, ' ')?.advance ?? 16
    this.x += adv * this.unit * this.p.wordSpacing * scale
  }

  /** Start a new line. */
  newline(): void {
    this.x = 0
    this.line++
  }

  /** Lay out `text` at the cursor (wrapping first if it would pass the width) and advance. */
  word(text: string): LaidWord {
    if (this.x > 0 && this.x + this.measure(text) > this.width) this.newline()
    const p = this.p
    const u = this.unit
    const base = this.baseline
    const main: Pt[][] = []
    const extra: Pt[][] = []
    const joinable: boolean[] = []
    for (const ch of text) {
      const g = glyph(p.face, ch)
      if (!g) {
        this.x += 14 * u * p.letterSpacing
        continue
      }
      const s = 1 + this.rng.gauss(p.sizeJitter)
      const lean = p.slant + this.rng.gauss(p.slantJitter)
      const gx = this.x
      const place = ([x, y]: GPt): Pt => {
        const yy = y * s
        const xx = x * s - yy * lean
        return [gx + xx * u, base + yy * u + this.wander(gx + xx * u)]
      }
      g.strokes.forEach((st, i) => {
        if (st.length === 0) return
        const placed = st.map(place)
        if (isDot(st)) {
          // a tap: touch down and flick a fraction of a millimetre down-right
          const [x0, y0] = centroid(placed)
          const flick: Pt[] = [
            [x0, y0],
            [x0 + 0.25 * u * 2, y0 + 0.2 * u * 2],
          ]
          if (p.delayDots) extra.push(flick)
          else {
            main.push(flick)
            joinable.push(false)
          }
          return
        }
        const delay = p.delayDots && i > 0 && isLowerJoinable(ch)
        if (delay) extra.push(placed)
        else {
          main.push(placed)
          joinable.push(p.join && isLetter(ch) && i === 0)
        }
      })
      this.x += g.advance * s * u * p.letterSpacing
    }
    const strokes: LaidStroke[] = []
    let run: Pt[] | null = null
    let runJoinable = false
    const joinGap = 0.35 * p.capHeight
    main.forEach((st, i) => {
      const ok = joinable[i]
      if (run && runJoinable && ok && dist(run[run.length - 1], st[0]) < joinGap) {
        run.push(...(samePt(run[run.length - 1], st[0]) ? st.slice(1) : st))
      } else {
        if (run) strokes.push({ pts: run, delayed: false })
        run = st.slice()
        runJoinable = ok
      }
    })
    if (run) strokes.push({ pts: run, delayed: false })
    for (const st of extra) strokes.push({ pts: st, delayed: true })
    return { text, strokes, box: bbox(strokes), baseline: base, line: this.line }
  }
}

/** Hershey's dots are tiny closed polygons, at most ~2.5 units across. */
function isDot(st: GPt[]): boolean {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const [x, y] of st) {
    x0 = Math.min(x0, x); x1 = Math.max(x1, x)
    y0 = Math.min(y0, y); y1 = Math.max(y1, y)
  }
  return x1 - x0 <= 2.5 && y1 - y0 <= 2.5
}

function centroid(pts: Pt[]): Pt {
  let x = 0, y = 0
  for (const p of pts) { x += p[0]; y += p[1] }
  return [x / pts.length, y / pts.length]
}

export function dist(a: Pt, b: Pt): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1])
}

function samePt(a: Pt, b: Pt): boolean {
  return Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9
}

/** Bounding box of strokes, mm; a zero box at the origin when empty. */
export function bbox(strokes: { pts: Pt[] }[]): [number, number, number, number] {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const s of strokes)
    for (const [x, y] of s.pts) {
      x0 = Math.min(x0, x); x1 = Math.max(x1, x)
      y0 = Math.min(y0, y); y1 = Math.max(y1, y)
    }
  return x0 === Infinity ? [0, 0, 0, 0] : [x0, y0, x1, y1]
}
