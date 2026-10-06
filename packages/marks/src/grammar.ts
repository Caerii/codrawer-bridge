/**
 * Built-in marks first, personal marks second: how the two vocabularies share one page.
 *
 * codrawer has one recognition system with two vocabularies. packages/delegate's grammar is the
 * built-in one: circle, tick, strike, ✗, arrow and initials, read *against the regions of a card*
 * (ADR 012 §2). Personal marks are the user's own glyphs, read anywhere else on the page. They
 * must never be confused, and three rules guarantee it:
 *
 * 1. **Built-ins first, and cards are theirs.** Every gesture goes to delegate's `interpret`
 *    against the cards on the page. If it answers a card (choose, reject, cancel, chain, point,
 *    initials, write), that is what it is. A gesture *on* a card that answers nothing is still the
 *    card's: it is never read as a personal mark (cards are the broker's contract, and a personal
 *    mark firing on one would be a second, unreviewed way to act on a task).
 * 2. **Reserved shapes.** Off the cards, a round loop, a straight line and a cross are ordinary
 *    drawing (a circled word, an underline, a crossing-out): they go nowhere. They, and the tick,
 *    can never be *taught* as personal marks: teaching one is refused with the reason. So a
 *    circle always means what it meant yesterday.
 *
 *    "Round" matters. delegate's shape rules were written to read marks *on card regions*, where
 *    a closed path is a circle whatever its corners; a five-pointed star also closes and turns
 *    through 4π, so delegate calls it a loop. Off the cards a star is a classic personal mark, so
 *    only loops with at most {@link ROUND_CORNERS} sharp corners are reserved. Likewise delegate's
 *    tick rule is loose off a box (a lemniscate or a spiral is sometimes "one vertex, down then
 *    up"), so ticks are refused when taught but not used to veto recognition.
 * 3. **Personal marks second**: everything else goes to the personal recogniser
 *    (recognizer.ts), which rejects what it was not taught. A personal mark whose shape the
 *    built-in grammar knows (a star is a loop to it; an arrow; a scribble) is *shadowed* on cards:
 *    there the built-in reading wins. The gallery says so.
 *
 * Gestures (strokes grouped in time and space) also come from delegate (`gestures`), so the two
 * vocabularies see the same units.
 */

import {
  type CardOnPage, type Gesture, type InkStroke, type Meaning as CardMeaning, type ShapeKind,
  center, corners, distToRect, interpret, resample, shapeOf,
} from 'delegate'

/** A loop with at most this many sharp corners is a circle (reserved); more, a glyph (a star). */
export const ROUND_CORNERS = 2

/** Shapes that are ordinary drawing off the cards (with `loop` only when round). */
export const RESERVED: ReadonlySet<ShapeKind> = new Set<ShapeKind>(['loop', 'line', 'x'])
/** Shapes that cannot be taught (the reserved ones and the tick). */
export const UNTEACHABLE: ReadonlySet<ShapeKind> = new Set<ShapeKind>(['loop', 'line', 'x', 'tick'])
/** Shapes the built-in grammar reads on a card: a personal mark of one of these is shadowed there. */
export const SHADOWED: ReadonlySet<ShapeKind> = new Set<ShapeKind>(['loop', 'arrow', 'scribble', 'tick'])

export type Routing =
  /** a built-in answer to a card: the broker's, not ours */
  | { to: 'builtin'; meaning: CardMeaning }
  /** a reserved shape off the cards, or ink on a card that answers nothing: not a mark */
  | { to: 'drawing'; shape: ShapeKind; why: string }
  /** for the personal recogniser */
  | { to: 'personal'; shape: ShapeKind }

/** delegate's shape, with `loop` split into round (a circle) and cornered (a star, a triangle). */
export function builtinShape(strokes: InkStroke[]): { kind: ShapeKind; round: boolean } {
  const kind = shapeOf({ strokes, bbox: { x0: 0, y0: 0, x1: 0, y1: 0 } }).kind
  const round = kind === 'loop' && strokes.length === 1 && corners(resample(strokes[0].pts, 1)).length <= ROUND_CORNERS
  return { kind, round }
}

/** Route one gesture: built-in answer, ordinary drawing, or a personal-mark candidate. */
export function route(g: Gesture, cards: CardOnPage[] = []): Routing {
  const { kind, round } = builtinShape(g.strokes)
  if (cards.length) {
    const meaning = interpret(g, cards)
    if (meaning.kind !== 'none') return { to: 'builtin', meaning }
    const c = center(g.bbox)
    if (cards.some((k) => distToRect(c, k.layout.rect) <= 2)) return { to: 'drawing', shape: kind, why: 'on a card, and not an answer: only built-in marks count on cards' }
  }
  if (RESERVED.has(kind) && (kind !== 'loop' || round))
    return { to: 'drawing', shape: kind, why: `${round ? 'a round loop' : kind}: a built-in shape, ordinary drawing off the cards` }
  return { to: 'personal', shape: kind }
}

const NAMES: Partial<Record<ShapeKind, string>> = { loop: 'circle', x: 'cross', line: 'line', tick: 'tick' }

/**
 * Why examples cannot be taught as a personal mark, or null when they can: refused when most of
 * them read as a circle, a tick, a line or a cross.
 */
export function unteachable(examples: InkStroke[][]): string | null {
  if (!examples.length || examples.every((e) => !e.length)) return 'no ink'
  const reserved = examples.map((e) => builtinShape(e)).filter((s) => UNTEACHABLE.has(s.kind) && (s.kind !== 'loop' || s.round))
  if (reserved.length * 2 > examples.length) {
    const name = NAMES[reserved[0].kind] ?? reserved[0].kind
    return `this reads as a ${name}, a built-in mark (it answers task cards) and ordinary drawing elsewhere; draw something more your own`
  }
  return null
}

/** Whether a mark of this shape is read as a built-in on cards (the gallery's "shadowed" note). */
export function shadowedOnCards(strokes: InkStroke[]): ShapeKind | null {
  const { kind } = builtinShape(strokes)
  return SHADOWED.has(kind) ? kind : null
}
