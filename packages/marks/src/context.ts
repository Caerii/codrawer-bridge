/**
 * Where a mark sits: the context half of personal mark recognition.
 *
 * Shape alone cannot tell a personal mark from handwriting. A user's bolt glyph and the letter
 * `N` in a word share a cloud closely enough; what separates them is that the letter sits *inside
 * a line of writing*, with ink close on both sides along the same baseline, and the mark sits
 * *beside* something, in a margin or at a line's end, apart from it. So every gesture is read
 * with a few context features, computed from the page's other ink (stroke boxes in page mm, the
 * same input card placement uses in packages/delegate):
 *
 * - **zone**: which part of the page (the four margins or the body). Personal marks live in the
 *   margins more often than not, and each mark keeps its own zone counts.
 * - **relation** to the nearest ink:
 *   - `inline`: ink on *both* sides along the same baseline, each within a word gap
 *     ({@link WORD_GAP_MM}): between the words of a line of writing, so almost certainly a letter
 *     or a word;
 *   - `adjoining`: within {@link INLINE_MM} on one side only: the end of a word, or a mark drawn
 *     tight against one;
 *   - `beside`: the nearest ink on the same baseline is {@link INLINE_MM}–{@link NEAR_MM} away:
 *     a mark annotating a line;
 *   - `over`: the gesture overlaps other ink (a mark drawn on top of a word);
 *   - `near`: ink within {@link NEAR_MM}, but not on the same baseline (above or below a block);
 *   - `alone`: nothing within {@link NEAR_MM}.
 * - **side**: on which side of its line the mark sits, read in the writing direction (left to
 *   right for the scripts codrawer serves today): `before` the line's start, `after` its end,
 *   or `above`/`below` a block. A mark at the end of a line and one at its start can mean
 *   different things to the same person (a ★ after a line is "important", before it "a heading").
 *
 * The **target** is the ink the mark refers to: the strokes on its baseline within reach, or the
 * nearest block. An action (make a flashcard of *this*, delegate *this*) acts on the target.
 *
 * Distances are mm; the page is the Paper Pro's (`PAPER_PRO_MM` from packages/hand).
 */

import { PAPER_PRO_MM } from 'hand'
import { type Pt, type Rect, bounds, inflate, overlap } from 'delegate'

const PAPER_PRO_MM_PT: Pt = PAPER_PRO_MM

/** Ink closer than this on a baseline is part of the same line of writing, mm. */
export const INLINE_MM = 3.2
/** Ink closer than this on both sides along a baseline puts a gesture inside a line, mm. */
export const WORD_GAP_MM = 10
/** Ink farther than this is not what a mark refers to, mm. */
export const NEAR_MM = 25
/** The page margin band, mm. */
export const MARGIN_MM = 18

export type Zone = 'margin_left' | 'margin_right' | 'top' | 'bottom' | 'body'
export type Relation = 'inline' | 'adjoining' | 'beside' | 'over' | 'near' | 'alone'
export type Side = 'before' | 'after' | 'above' | 'below' | 'none'

export const RELATIONS: Relation[] = ['inline', 'adjoining', 'beside', 'over', 'near', 'alone']

/** Other ink on the page, as the context reader needs it. */
export interface InkBox {
  id: string
  box: Rect
}

export interface Context {
  zone: Zone
  relation: Relation
  side: Side
  /** gap to the nearest other ink, mm (Infinity when the page is otherwise empty) */
  nearest: number
  /** ids of the ink the mark refers to (may be empty) */
  target: string[]
  /** their bounding box, mm */
  targetBox?: Rect
}

/** The gap between two rectangles along x (negative when they overlap in x), mm. */
const gapX = (a: Rect, b: Rect) => Math.max(b.x0 - a.x1, a.x0 - b.x1)
/** The gap between two rectangles, mm (0 when they touch or overlap). */
function gap(a: Rect, b: Rect): number {
  const dx = Math.max(b.x0 - a.x1, a.x0 - b.x1, 0)
  const dy = Math.max(b.y0 - a.y1, a.y0 - b.y1, 0)
  return Math.hypot(dx, dy)
}

/**
 * Whether `b` is on `a`'s baseline: their vertical extents overlap by at least half of the
 * shorter one. Marks and letters differ in height, so the shorter extent is the measure.
 */
function sameLine(a: Rect, b: Rect): boolean {
  const ov = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0)
  return ov >= 0.5 * Math.min(a.y1 - a.y0 + 0.5, b.y1 - b.y0 + 0.5)
}

/** The zone of a gesture's box on a page of `page` mm. */
export function zoneOf(box: Rect, page: Pt = PAPER_PRO_MM_PT): Zone {
  const cx = (box.x0 + box.x1) / 2, cy = (box.y0 + box.y1) / 2
  if (cx < MARGIN_MM) return 'margin_left'
  if (cx > page[0] - MARGIN_MM) return 'margin_right'
  if (cy < MARGIN_MM) return 'top'
  if (cy > page[1] - MARGIN_MM) return 'bottom'
  return 'body'
}

/**
 * Read the context of a gesture with bounding box `box` among the page's other ink `ink` (which
 * must not include the gesture's own strokes).
 */
export function contextOf(box: Rect, ink: InkBox[], page: Pt = PAPER_PRO_MM_PT): Context {
  const zone = zoneOf(box, page)
  const near = ink.filter((s) => gap(box, s.box) <= NEAR_MM)
  const nearest = ink.reduce((m, s) => Math.min(m, gap(box, s.box)), Infinity)
  const area = Math.max((box.x1 - box.x0) * (box.y1 - box.y0), 1)
  const covered = near.reduce((a, s) => a + overlap(box, s.box), 0)
  const line = near.filter((s) => sameLine(box, s.box))
  const left = line.filter((s) => s.box.x1 <= (box.x0 + box.x1) / 2)
  const right = line.filter((s) => s.box.x0 >= (box.x0 + box.x1) / 2)
  const within = (ss: InkBox[], mm: number) => ss.some((s) => gapX(box, s.box) <= mm)

  let relation: Relation
  if (covered > 0.35 * area && near.some((s) => overlap(inflate(s.box, -0.3), box) > 0)) relation = 'over'
  else if (within(left, WORD_GAP_MM) && within(right, WORD_GAP_MM)) relation = 'inline'
  else if (within(left, INLINE_MM) || within(right, INLINE_MM)) relation = 'adjoining'
  else if (line.length) relation = 'beside'
  else if (near.length) relation = 'near'
  else relation = 'alone'

  // The target: the line the mark sits on, or else the nearest block (chained within 6 mm).
  let target: InkBox[] = []
  let side: Side = 'none'
  if (line.length && relation !== 'inline') {
    target = growLine(line, ink, box)
    const tb = bounds(target.flatMap((s) => [[s.box.x0, s.box.y0], [s.box.x1, s.box.y1]] as Pt[]))
    side = (box.x0 + box.x1) / 2 < (tb.x0 + tb.x1) / 2 ? 'before' : 'after'
  } else if (near.length && relation !== 'inline') {
    const first = near.reduce((a, s) => (gap(box, s.box) < gap(box, a.box) ? s : a))
    target = chain(first, ink, 6)
    const tb = bounds(target.flatMap((s) => [[s.box.x0, s.box.y0], [s.box.x1, s.box.y1]] as Pt[]))
    side = (box.y0 + box.y1) / 2 < tb.y0 ? 'above' : (box.y0 + box.y1) / 2 > tb.y1 ? 'below' : (box.x1 <= tb.x0 ? 'before' : 'after')
  }
  const targetBox = target.length ? bounds(target.flatMap((s) => [[s.box.x0, s.box.y0], [s.box.x1, s.box.y1]] as Pt[])) : undefined
  return { zone, relation, side, nearest, target: target.map((s) => s.id), targetBox }
}

/** The whole line a mark sits beside: its baseline neighbours, extended along the line by word gaps (≤ 12 mm). */
function growLine(seed: InkBox[], ink: InkBox[], mark: Rect): InkBox[] {
  const band = { y0: Math.min(...seed.map((s) => s.box.y0)), y1: Math.max(...seed.map((s) => s.box.y1)) }
  const onBand = ink.filter((s) => sameLine({ x0: 0, x1: 1, ...band }, s.box) && !(s.box.x1 > mark.x0 && s.box.x0 < mark.x1))
  const out = new Set(seed)
  let grew = true
  while (grew) {
    grew = false
    for (const s of onBand) {
      if (out.has(s)) continue
      if ([...out].some((o) => Math.abs(gapX(o.box, s.box)) <= 12 && gapX(o.box, s.box) <= 12)) { out.add(s); grew = true }
    }
  }
  return [...out]
}

/** Strokes reachable from `first` in hops of at most `hop` mm. */
function chain(first: InkBox, ink: InkBox[], hop: number): InkBox[] {
  const out = new Set([first])
  let grew = true
  while (grew) {
    grew = false
    for (const s of ink) if (!out.has(s) && [...out].some((o) => gap(o.box, s.box) <= hop)) { out.add(s); grew = true }
  }
  return [...out]
}
