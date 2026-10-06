/**
 * The semantic marks that answer a card: circle = choose, tick = choose, strike = cancel,
 * an arrow between cards = chain, writing in the card's box or margin = correction, initials in
 * the consent box = consent (ADR 012 §3).
 *
 * Recognition is **in context**, not free-form vision. The card's layout (card.ts) says where
 * each answerable region is, so the question is never "what is this drawing?" but "does this
 * stroke enclose option B's label, tick its box, cross it out, or join two cards?". That makes
 * the classifier small, explainable and testable on synthetic strokes (test/marks.test.ts writes
 * them with packages/hand's biomechanical hand), and it means a mark that is not on a card's
 * region is not an answer at all: it is the user's page, and never an instruction.
 *
 * Two stages:
 *
 * 1. **Shape**, from geometry alone, per gesture (strokes close in time and space):
 *    `loop`, `tick`, `line`, `x`, `scribble`, `arrow`, or `writing`. The measures are the
 *    resampled path's length, chord, closure, total turning and sharp corners (geometry.ts).
 * 2. **Meaning**, from the shape against the cards' regions: which option a loop encloses
 *    (the fraction of the label's area inside the loop), which box a tick lands in, which label a
 *    line crosses (the length of the line inside it), which cards an arrow's ends touch.
 *
 * Every interpretation carries a confidence and the reason, and an ambiguous mark (two options
 * circled, a tick between boxes) is reported as such so the card can ask again in ink instead of
 * guessing. Only strokes on the user's own layer from the user's own pen reach this module; the
 * broker filters by layer and device before calling it (consent.ts).
 *
 * Thresholds are in mm and were set against the hand's personas (`sketcher`, `elder`,
 * `archivist`) at their natural size; they are a starting point to tune on real ink.
 */

import {
  type Pt, type Rect, bounds, contains, corners, dist, enclosed, height, inflate, lengthInside, overlap, pathLength,
  resample, turning, width, area, center, distToRect, hull, inPolygon,
} from './geometry'
import type { CardLayout } from './card'

/** A user stroke as the broker hands it over: mm points and its time span (Unix ms). */
export interface InkStroke {
  id: string
  pts: Pt[]
  t0: number
  t1: number
}

/** A gesture: strokes the user made as one mark. */
export interface Gesture {
  strokes: InkStroke[]
  bbox: Rect
}

/**
 * Group strokes into gestures: a stroke joins the previous gesture when it starts within `gapMs`
 * of the last one's lift and within `nearMm` of its box. Initials, an ✗ and a two-stroke arrow
 * are each one gesture; a tick and a circle are one stroke.
 */
export function gestures(strokes: InkStroke[], gapMs = 900, nearMm = 8): Gesture[] {
  const out: Gesture[] = []
  for (const s of [...strokes].sort((a, b) => a.t0 - b.t0)) {
    const b = bounds(s.pts)
    const g = out[out.length - 1]
    const last = g?.strokes[g.strokes.length - 1]
    if (g && last && s.t0 - last.t1 <= gapMs && overlap(inflate(g.bbox, nearMm), b) > 0) {
      g.strokes.push(s)
      g.bbox = bounds([...g.strokes.flatMap((x) => x.pts)])
    } else out.push({ strokes: [s], bbox: b })
  }
  return out
}

// --- stage 1: shape ----------------------------------------------------------------------------

export type ShapeKind = 'loop' | 'tick' | 'line' | 'x' | 'scribble' | 'arrow' | 'writing'

export interface Shape {
  kind: ShapeKind
  /** for `arrow` and `line`: tail and head (the drawn direction when there is no head) */
  from?: Pt
  to?: Pt
  /** whether an arrow has a drawn head (direction confirmed, not inferred from drawing order) */
  head?: boolean
  /** for `tick`: the vertex; for `loop`: the region it encloses (its convex hull) */
  vertex?: Pt
  polygon?: Pt[]
  why: string
}

/** Measures of one stroke used by the shape rules. */
interface Measures {
  rs: Pt[]
  L: number
  D: number
  chord: number
  straight: number
  turn: number
  corners: number[]
}

function measure(pts: Pt[]): Measures {
  const rs = resample(pts, 0.5)
  const L = pathLength(rs)
  const b = bounds(rs)
  const D = Math.max(width(b), height(b), 1e-6)
  const chord = dist(rs[0], rs[rs.length - 1])
  return { rs, L, D, chord, straight: L > 0 ? chord / L : 0, turn: turning(resample(pts, 1)), corners: corners(resample(pts, 1)) }
}

const isLine = (m: Measures) => m.straight > 0.9 && m.L > 4

function segmentsCross(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  const o = (p: Pt, q: Pt, r: Pt) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]))
  return o(a, b, c) !== o(a, b, d) && o(c, d, a) !== o(c, d, b)
}

/** A tick: one sharp vertex, a short leg down then a longer leg up and to the right. */
function asTick(m: Measures): Pt | undefined {
  if (m.D > 16 || m.corners.length < 1 || m.corners.length > 2) return
  const r1 = resample(m.rs, 1)
  // the vertex is the lowest corner (largest y on a y-down page)
  const c = m.corners.reduce((a, b) => (r1[b][1] > r1[a][1] ? b : a))
  const v = r1[c], s = r1[0], e = r1[r1.length - 1]
  const leg1 = dist(s, v), leg2 = dist(v, e)
  if (v[1] - s[1] <= 0.5 || v[1] - e[1] <= 1) return // must go down, then up
  if (e[0] <= v[0] || leg2 < 0.8 * leg1 || leg1 < 1) return // up and to the right, the long leg second
  return v
}

/** A single-stroke arrow: a shaft, then a sharp turn back near the end (the head drawn in one go). */
function asHookedArrow(m: Measures): { from: Pt; to: Pt } | undefined {
  const r1 = resample(m.rs, 1)
  if (m.L < 15) return
  const last = m.corners.filter((i) => i > r1.length * 0.7)
  if (!last.length) return
  const tip = r1[last[0]]
  const shaft = r1.slice(0, last[0] + 1)
  if (dist(shaft[0], tip) / pathLength(shaft) < 0.75) return
  return { from: shaft[0], to: tip }
}

/** Classify a gesture's shape from geometry alone. */
export function shapeOf(g: Gesture): Shape {
  const ms = g.strokes.map((s) => measure(s.pts))
  if (ms.length === 1) {
    const m = ms[0]
    const first = m.rs[0], last = m.rs[m.rs.length - 1]
    if (Math.abs(m.turn) > 1.5 * Math.PI && m.L > 1.9 * m.D && m.chord < 0.45 * m.D)
      return { kind: 'loop', polygon: hull(m.rs), why: `turning ${(m.turn / Math.PI).toFixed(2)}π, gap ${m.chord.toFixed(1)} mm of ${m.D.toFixed(1)}` }
    if (isLine(m)) return { kind: 'line', from: first, to: last, why: `straightness ${m.straight.toFixed(2)}` }
    const v = asTick(m)
    if (v) return { kind: 'tick', vertex: v, why: 'one vertex, short leg down, long leg up' }
    const hook = asHookedArrow(m)
    if (hook) return { kind: 'arrow', ...hook, head: true, why: 'shaft with a hooked head' }
    if (m.corners.length >= 4 && m.L > 3 * m.D && m.D > 6) return { kind: 'scribble', why: `${m.corners.length} reversals` }
    if (m.L > 15 && m.straight > 0.7) return { kind: 'arrow', from: first, to: last, head: false, why: 'long open stroke, direction as drawn' }
    return { kind: 'writing', why: 'no answer shape' }
  }
  if (ms.length === 2 && ms.every(isLine)) {
    const [a, b] = ms
    if (segmentsCross(a.rs[0], a.rs[a.rs.length - 1], b.rs[0], b.rs[b.rs.length - 1]) && Math.min(a.L, b.L) > 0.5 * Math.max(a.L, b.L))
      return { kind: 'x', why: 'two crossing lines of similar length' }
  }
  // an arrow drawn as a shaft plus a head of one or two short strokes at one end
  const order = ms.map((m, i) => i).sort((i, j) => ms[j].L - ms[i].L)
  const shaft = ms[order[0]]
  const rest = order.slice(1).map((i) => ms[i])
  if (shaft.L > 15 && shaft.straight > 0.75 && rest.length <= 2 && rest.every((m) => m.D < Math.min(12, 0.4 * shaft.chord))) {
    const a = shaft.rs[0], b = shaft.rs[shaft.rs.length - 1]
    // the head sits on the shaft's last (or first) fifth: shafts overshoot the head, heads fall short
    const k = Math.max(2, Math.floor(shaft.rs.length / 5))
    const near = (end: Pt[]) => rest.every((m) => Math.min(...m.rs.flatMap((q) => end.map((p) => dist(p, q)))) < 3)
    if (near(shaft.rs.slice(-k))) return { kind: 'arrow', from: a, to: b, head: true, why: 'shaft and head strokes' }
    if (near(shaft.rs.slice(0, k))) return { kind: 'arrow', from: b, to: a, head: true, why: 'shaft and head strokes (drawn tip first)' }
  }
  return { kind: 'writing', why: `${ms.length} strokes, no answer shape` }
}

// --- stage 2: meaning --------------------------------------------------------------------------

/** A card on the page, as the classifier sees it. */
export interface CardOnPage {
  task: string
  layout: CardLayout
}

export type Meaning =
  | { kind: 'choose'; task: string; option: string; via: 'circle' | 'tick'; confidence: number; why: string }
  | { kind: 'reject_option'; task: string; option: string; confidence: number; why: string }
  | { kind: 'cancel'; task: string; confidence: number; why: string }
  | { kind: 'chain'; from: string; to: string; confidence: number; why: string }
  | { kind: 'point'; task: string; at: Pt; confidence: number; why: string }
  | { kind: 'initials'; task: string; strokes: string[]; confidence: number; why: string }
  | { kind: 'write'; task: string; region: 'box' | 'margin'; strokes: string[]; confidence: number; why: string }
  | { kind: 'ambiguous'; task: string; candidates: string[]; why: string }
  | { kind: 'none'; why: string }

/** How far beside a card margin writing may sit and still be addressed to it, mm. */
export const MARGIN_MM = 10

/** Interpret one gesture against the cards on the page. */
export function interpret(g: Gesture, cards: CardOnPage[]): Meaning {
  const shape = shapeOf(g)
  const ids = g.strokes.map((s) => s.id)
  const pts = g.strokes.flatMap((s) => s.pts)
  const cardAt = (p: Pt, slack: number) => cards.find((c) => distToRect(p, c.layout.rect) <= slack)
  const over = cards.filter((c) => overlap(c.layout.rect, g.bbox) > 0.3 * Math.max(area(g.bbox), 1))

  switch (shape.kind) {
    case 'loop': {
      // Which option row holds the loop's area? Hand-drawn circles drift, undershoot and stop
      // short, so the label is often only partly inside; the row holding most of the enclosed
      // area is the steadier signal, provided the loop still covers a real part of the label.
      const poly = shape.polygon!
      const shares: { task: string; option: string; share: number; label: number }[] = []
      const total = areaIn(poly, g.bbox)
      if (total > 0) for (const c of cards) for (const ch of c.layout.choices)
        shares.push({ task: c.task, option: ch.id, share: areaIn(poly, ch.row) / total, label: enclosed(ch.label, poly) })
      shares.sort((a, b) => b.share - a.share)
      const [top, second] = shares
      const real = (x?: { share: number; label: number }) => !!x && x.share >= 0.3 && x.label >= 0.25
      if (real(top) && real(second))
        return { kind: 'ambiguous', task: top.task, candidates: [top.option, second.option], why: `the loop spans two options (${pct(top.share)} / ${pct(second.share)} of its area)` }
      if (top && top.share >= 0.45 && top.label >= 0.25)
        return { kind: 'choose', task: top.task, option: top.option, via: 'circle', confidence: top.share, why: `${shape.why}; ${pct(top.share)} of the loop on the option's row, ${pct(top.label)} of the label inside` }
      break
    }
    case 'tick': {
      const v = shape.vertex!
      const hits: { task: string; option: string; d: number }[] = []
      for (const c of cards) for (const ch of c.layout.choices) {
        const d = Math.min(distToRect(v, ch.box), distToRect(v, ch.label) + 1)
        if (d <= 2.5) hits.push({ task: c.task, option: ch.id, d })
      }
      hits.sort((a, b) => a.d - b.d)
      if (hits.length === 1 || (hits.length > 1 && hits[1].d - hits[0].d > 1.5))
        return { kind: 'choose', task: hits[0].task, option: hits[0].option, via: 'tick', confidence: hits[0].d === 0 ? 0.95 : 0.75, why: `${shape.why}; vertex ${hits[0].d.toFixed(1)} mm from the box` }
      if (hits.length > 1) return { kind: 'ambiguous', task: hits[0].task, candidates: hits.map((h) => h.option), why: 'the tick sits between options' }
      break
    }
    case 'line':
    case 'x':
    case 'scribble': {
      const horizontal = shape.kind !== 'line' || Math.abs(shape.to![1] - shape.from![1]) < 0.47 * Math.abs(shape.to![0] - shape.from![0])
      // a strike through an option's label rejects that option
      if (horizontal) for (const c of cards) for (const ch of c.layout.choices) {
        const inside = g.strokes.reduce((L, s) => L + lengthInside(s.pts, inflate(ch.label, 1)), 0)
        if (inside >= 0.6 * width(ch.label)) return { kind: 'reject_option', task: c.task, option: ch.id, confidence: 0.85, why: `${shape.why}; crosses ${(inside / width(ch.label) * 100).toFixed(0)}% of the label` }
      }
      // a strike through the title or header, an ✗ or a scribble over the card cancels the task
      for (const c of cards) {
        const top = { x0: c.layout.header.x0, y0: c.layout.header.y0, x1: c.layout.title.x1, y1: c.layout.title.y1 }
        // strikes drift: measure inside a band 3 mm taller than the title on each side
        const inside = g.strokes.reduce((L, s) => L + lengthInside(s.pts, inflate(top, 3)), 0)
        if (horizontal && inside >= 0.4 * width(top)) return { kind: 'cancel', task: c.task, confidence: 0.85, why: `${shape.why}; struck through the title` }
        if (shape.kind !== 'line' && contains(c.layout.rect, center(g.bbox))) return { kind: 'cancel', task: c.task, confidence: 0.8, why: `${shape.kind} over the card` }
      }
      if (shape.kind === 'line') return chainOrPoint(shape.from!, shape.to!, false, cards, cardAt, shape.why)
      break
    }
    case 'arrow':
      return chainOrPoint(shape.from!, shape.to!, !!shape.head, cards, cardAt, shape.why)
    case 'writing':
      break
  }

  // writing (or an unmatched shape) inside a card's answer boxes, or in its margin
  for (const c of cards) {
    const inkLen = g.strokes.reduce((L, s) => L + pathLength(s.pts), 0)
    if (c.layout.consent) {
      const inside = g.strokes.reduce((L, s) => L + lengthInside(s.pts, inflate(c.layout.consent!.box, 1.5)), 0)
      if (inside >= 0.7 * inkLen) return { kind: 'initials', task: c.task, strokes: ids, confidence: inside / inkLen, why: 'ink inside the consent box' }
    }
    if (c.layout.write) {
      const inside = g.strokes.reduce((L, s) => L + lengthInside(s.pts, inflate(c.layout.write!, 1.5)), 0)
      if (inside >= 0.7 * inkLen) return { kind: 'write', task: c.task, region: 'box', strokes: ids, confidence: inside / inkLen, why: 'writing in the card\'s box' }
    }
  }
  const beside = cards.filter((c) => !over.includes(c) && pts.every((p) => distToRect(p, c.layout.rect) <= MARGIN_MM))
  if (shape.kind === 'writing' && beside.length === 1)
    return { kind: 'write', task: beside[0].task, region: 'margin', strokes: ids, confidence: 0.6, why: `writing within ${MARGIN_MM} mm of the card` }
  return { kind: 'none', why: `${shape.kind} (${shape.why}) is not on a card's answer region: page content` }
}

function chainOrPoint(from: Pt, to: Pt, head: boolean, cards: CardOnPage[], cardAt: (p: Pt, s: number) => CardOnPage | undefined, why: string): Meaning {
  const a = cardAt(from, 4), b = cardAt(to, 4)
  if (a && b && a !== b) return { kind: 'chain', from: a.task, to: b.task, confidence: head ? 0.9 : 0.6, why: `${why}; from one card to another` }
  if (a && !b && head) return { kind: 'point', task: a.task, at: to, confidence: 0.7, why: `${why}; from the card to ink on the page` }
  return { kind: 'none', why: `${why}; does not join cards` }
}

const pct = (f: number) => `${Math.round(f * 100)}%`

/** Area (mm²) of polygon `poly` inside rectangle `r`, sampled on a 0.5 mm grid. */
function areaIn(poly: Pt[], r: Rect): number {
  const step = 0.5
  let k = 0
  for (let x = r.x0 + step / 2; x < r.x1; x += step) for (let y = r.y0 + step / 2; y < r.y1; y += step) if (inPolygon([x, y], poly)) k++
  return k * step * step
}

/** Whether a choice region exists on a layout (helper for tests and the broker). */
export const hasOption = (l: CardLayout, id: string) => l.choices.some((c) => c.id === id)
