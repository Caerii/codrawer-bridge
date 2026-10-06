/**
 * The task card: where it goes on the page, what is on it, and which parts of it are answerable.
 *
 * A card is agent ink on the pod's own layer (`codrawer: <pod>`, ADR 009 §1), written in the
 * pod's handwriting persona (packages/hand). It must never cross the user's ink, so placement
 * works from the page snapshot's per-stroke bounding boxes (protocol.md, `page`) and from the
 * cards already on the page. It must be readable at a glance on e-ink, so status is a discrete
 * mark in a box, never motion: the vocabulary extends smart_remarkable's additive status box
 * (☐ pending, ✓ done, ✗ failed; docs/investigations/smart-remarkable-integration.md §3.6).
 *
 * And it must be answerable by pen. Every place the user may mark (a choice row, its checkbox,
 * the consent box, the "write here" box) is a named region in the layout; the classifier
 * (marks.ts) reads the user's strokes against these regions rather than guessing from pixels.
 * The regions are the card's contract: a mark outside them is page content, not an answer.
 *
 * Layout, top to bottom (mm; the card is {@link CARD.width} wide):
 *
 *     ┃ research · K. Hale                 [☐]   header: pod and requester; status box
 *     ┃ Compare e-ink controllers for G3          title (the ask)
 *     ┃ scope: notebook G3 (this task only)       the one-time grant, if any (ADR 011)
 *     ┃ summary lines …                           body
 *     ┃ [1] source, [2] source                    evidence
 *     ┃ ☐ option A    ☐ option B   …             choices: circle the label or tick the box
 *     ┃ Send?  initial here [        ] K7Q-3XM    consent, bound to the action code
 *     ┃ ┌ write a correction here ┐               free answer
 *     ┃ 14:02 queued · 14:03 working · …          status trail (additive history)
 *
 * The left rule marks the block as agent ink (smart_remarkable's convention, which we also know
 * exactly from the layer). A card that needs the user gets a second rule beside the first:
 * visible across the page without reading anything.
 *
 * Reading order: constants; content; the layout of one card; placement among ink; status marks.
 */

import { type Pt, type Rect, rect, inflate, overlap, width, height, distToRect, center } from './geometry'
import type { Status } from './task'

/** Card metrics, mm. Text is written by `packages/hand` at {@link CARD.textScale}. */
export const CARD = {
  width: 84,
  pad: 3,
  /** left rule inset from the card's left edge */
  rule: 1,
  header: 9,
  line: 6,
  choice: 8,
  box: 5,
  consent: 13,
  write: 16,
  trail: 5,
  status: 6,
  /** hand writes about 4.3 mm per character at scale 1; 0.6 gives ≈ 2.6 mm */
  textScale: 0.6,
  charsPerLine: 30,
  /** clearance kept around the user's ink and other cards */
  clearance: 3,
  /** the page margin cards stay inside */
  margin: 4,
} as const

/** What a card says. Text is data for the hand; regions come from the layout. */
export interface CardContent {
  pod: string
  requester: string
  title: string
  status: Status
  /** the one-time scope, shown so the user sees exactly what the pod may read (ADR 011) */
  grant?: string
  body?: string[]
  evidence?: string[]
  choices?: { id: string; label: string }[]
  /** a consequential action awaiting a pen consent: its verb and its code (task.ts) */
  consent?: { verb: string; code: string; hash: string }
  /** whether to offer a free-answer box */
  write?: boolean
  /** status history, oldest first: `14:03 working` */
  trail?: string[]
}

/** A line of text to hand to the persona: its first baseline point (mm) and scale. */
export interface TextItem {
  text: string
  at: Pt
  scale: number
  role: 'header' | 'title' | 'grant' | 'body' | 'evidence' | 'choice' | 'consent' | 'code' | 'write' | 'trail'
}

/** A choice's answerable regions: the whole row (circle or strike the label) and its box (tick). */
export interface ChoiceRegion {
  id: string
  row: Rect
  label: Rect
  box: Rect
}

/** A laid-out card: everything drawn, and every region the user may answer in. */
export interface CardLayout {
  rect: Rect
  header: Rect
  status: Rect
  title: Rect
  choices: ChoiceRegion[]
  consent?: { box: Rect; code: string; hash: string }
  write?: Rect
  /** lines and boxes the card draws (mm polylines), status mark excluded */
  paths: Pt[][]
  text: TextItem[]
}

/** Greedy word wrap to `n` characters (the persona's advance is near-constant per character). */
export function wrap(text: string, n: number = CARD.charsPerLine): string[] {
  const out: string[] = []
  let line = ''
  for (const w of text.split(/\s+/).filter(Boolean)) {
    if (line && line.length + 1 + w.length > n) { out.push(line); line = w } else line = line ? `${line} ${w}` : w
  }
  if (line) out.push(line)
  return out
}

const box = (r: Rect): Pt[] => [[r.x0, r.y0], [r.x1, r.y0], [r.x1, r.y1], [r.x0, r.y1], [r.x0, r.y0]]

/** A dashed rectangle as separate dashes (each its own stroke), `dash` mm on, `dash` mm off. */
function dashed(r: Rect, dash = 2.5): Pt[][] {
  const out: Pt[][] = []
  const edge = (a: Pt, b: Pt) => {
    const L = Math.hypot(b[0] - a[0], b[1] - a[1])
    for (let s = 0; s < L; s += 2 * dash) {
      const e = Math.min(L, s + dash)
      out.push([[a[0] + ((b[0] - a[0]) * s) / L, a[1] + ((b[1] - a[1]) * s) / L], [a[0] + ((b[0] - a[0]) * e) / L, a[1] + ((b[1] - a[1]) * e) / L]])
    }
  }
  edge([r.x0, r.y0], [r.x1, r.y0]); edge([r.x1, r.y0], [r.x1, r.y1]); edge([r.x1, r.y1], [r.x0, r.y1]); edge([r.x0, r.y1], [r.x0, r.y0])
  return out
}

/** The card's height for `c`, mm, without placing it. */
export function cardHeight(c: CardContent): number {
  return layoutCard(c, [0, 0]).rect.y1
}

/** Lay out card `c` with its top-left corner at `at` (mm). */
export function layoutCard(c: CardContent, at: Pt): CardLayout {
  const { pad, line, textScale: s } = CARD
  const x0 = at[0], x1 = at[0] + CARD.width
  const tx = x0 + pad + 2 // text starts right of the rule
  const text: TextItem[] = []
  const paths: Pt[][] = []
  let y = at[1]

  const header = rect(x0, y, x1, y + CARD.header)
  const status = rect(x1 - pad - CARD.status, y + 1.5, x1 - pad, y + 1.5 + CARD.status)
  text.push({ text: `${c.pod} · ${c.requester}`, at: [tx, y + CARD.header - 2.5], scale: s * 0.85, role: 'header' })
  y += CARD.header

  const titleTop = y
  for (const l of wrap(c.title)) { text.push({ text: l, at: [tx, y + line - 1.5], scale: s, role: 'title' }); y += line }
  const title = rect(x0, titleTop, x1, y)
  if (c.grant) { text.push({ text: `scope: ${c.grant}`, at: [tx, y + line - 1.8], scale: s * 0.8, role: 'grant' }); y += line }
  for (const b of c.body ?? []) for (const l of wrap(b)) { text.push({ text: l, at: [tx, y + line - 1.5], scale: s, role: 'body' }); y += line }
  for (const e of c.evidence ?? []) for (const l of wrap(e, CARD.charsPerLine + 4)) { text.push({ text: l, at: [tx, y + line - 1.8], scale: s * 0.8, role: 'evidence' }); y += line }

  const choices: ChoiceRegion[] = []
  for (const ch of c.choices ?? []) {
    const row = rect(x0 + pad, y, x1 - pad, y + CARD.choice)
    const b = rect(tx, y + (CARD.choice - CARD.box) / 2, tx + CARD.box, y + (CARD.choice + CARD.box) / 2)
    const labelX = b.x1 + 3
    const labelW = Math.min(x1 - pad - labelX, ch.label.length * 4.3 * s + 2)
    const label = rect(labelX - 1, y + 0.8, labelX + labelW, y + CARD.choice - 0.8)
    paths.push(box(b))
    text.push({ text: ch.label, at: [labelX, y + CARD.choice - 2], scale: s, role: 'choice' })
    choices.push({ id: ch.id, row, label, box: b })
    y += CARD.choice
  }

  let consent: CardLayout['consent']
  if (c.consent) {
    const cb = rect(tx + 34, y + 2, tx + 62, y + CARD.consent - 1)
    paths.push(box(cb))
    text.push({ text: `${c.consent.verb}? initial`, at: [tx, y + CARD.consent - 4], scale: s, role: 'consent' })
    text.push({ text: c.consent.code, at: [cb.x1 + 1.5, y + CARD.consent - 4], scale: s * 0.75, role: 'code' })
    consent = { box: cb, code: c.consent.code, hash: c.consent.hash }
    y += CARD.consent
  }

  let write: Rect | undefined
  if (c.write) {
    write = rect(tx, y + 1, x1 - pad, y + CARD.write - 1)
    paths.push(...dashed(write))
    text.push({ text: 'write here', at: [tx + 2, y + 5], scale: s * 0.7, role: 'write' })
    y += CARD.write
  }

  if (c.trail?.length) { text.push({ text: c.trail.join(' · '), at: [tx, y + CARD.trail - 1.2], scale: s * 0.7, role: 'trail' }); y += CARD.trail }
  y += pad / 2

  // the rule: one for an ordinary card, two when the card needs the user
  paths.push([[x0 + CARD.rule, at[1] + 1], [x0 + CARD.rule, y - 1]])
  if (c.status === 'needs_you') paths.push([[x0 + CARD.rule + 1.6, at[1] + 1], [x0 + CARD.rule + 1.6, y - 1]])

  return { rect: rect(x0, at[1], x1, y), header, status, title, choices, consent, write, paths, text }
}

// --- placement ---------------------------------------------------------------------------------

/** Where a card goes, or a stub when the page has no room for it. */
export interface Placement {
  at: Pt
  rect: Rect
  /** no clear area fits the full card: draw a small tag that points to the task page instead */
  stub: boolean
  /** the score of the chosen spot (lower is better), for tests and tuning */
  score: number
}

/** A stub's size, mm: pod, status box and "→ p. 14" on one line. */
export const STUB: Pt = [36, 10]

/**
 * Find the best clear spot for a `size` (mm) card near `anchor` (the delegated ink's bounding
 * box), avoiding `ink` and `cards` (bounding boxes, mm) by {@link CARD.clearance}, inside the
 * page margin. Candidates are a 2 mm grid; the score is the gap to the anchor, plus a small
 * preference for the anchor's right (the margin where people annotate) and for aligning with
 * its top. When nothing fits, the same search runs for a {@link STUB}.
 */
export function place(size: Pt, anchor: Rect, ink: Rect[], cards: Rect[], page: Pt): Placement {
  const blocked = [...ink, ...cards].map((r) => inflate(r, CARD.clearance))
  const search = (w: number, h: number) => {
    let best: Placement | undefined
    for (let x = CARD.margin; x + w <= page[0] - CARD.margin; x += 2)
      for (let y = CARD.margin; y + h <= page[1] - CARD.margin; y += 2) {
        const r = rect(x, y, x + w, y + h)
        if (blocked.some((b) => overlap(b, r) > 0)) continue
        const gap = rectGap(r, anchor)
        const side = r.x0 >= anchor.x1 ? 0 : r.y0 >= anchor.y1 ? 6 : 14
        const score = gap + side + 0.15 * Math.abs(r.y0 - anchor.y0)
        if (!best || score < best.score) best = { at: [x, y], rect: r, stub: false, score }
      }
    return best
  }
  const full = search(size[0], size[1])
  if (full) return full
  const stub = search(STUB[0], STUB[1])
  if (stub) return { ...stub, stub: true }
  // a full page: the stub sits in the bottom margin, over nothing but the margin
  const r = rect(page[0] - CARD.margin - STUB[0], page[1] - CARD.margin - STUB[1], page[0] - CARD.margin, page[1] - CARD.margin)
  return { at: [r.x0, r.y0], rect: r, stub: true, score: Infinity }
}

/** The shortest distance between two rectangles, mm (0 when they touch or overlap). */
export function rectGap(a: Rect, b: Rect): number {
  const dx = Math.max(0, b.x0 - a.x1, a.x0 - b.x1)
  const dy = Math.max(0, b.y0 - a.y1, a.y0 - b.y1)
  return Math.hypot(dx, dy)
}

// --- status marks ------------------------------------------------------------------------------

/**
 * The status mark inside the card's status box, as mm polylines (the box itself included).
 *
 * | status    | mark            | why it reads at a glance                          |
 * | queued    | ☐ empty         | smart_remarkable's pending box                   |
 * | working   | ☐ with one "/"  | started; the half of an ✗ nobody mistakes for one |
 * | needs_you | ☐ with "!"      | and the card's doubled rule                      |
 * | done      | ☐ with ✓        |                                                   |
 * | failed    | ☐ with ✗        |                                                   |
 * | paused    | ☐ with "‖"      | the universal pause                              |
 * | cancelled | ☐ struck across | the same strike the user uses to cancel          |
 *
 * On the page model a status change tombstones the previous mark and draws the new one (ADR 008
 * §1). Where deleting agent ink is not yet possible on the tablet, the status trail line is the
 * additive record and the box gains marks without losing any (ADR 012 §2).
 */
export function statusMark(status: Status, r: Rect): Pt[][] {
  const [cx, cy] = center(r)
  const w = width(r), h = height(r)
  const m = 1.1 // inset
  const out: Pt[][] = [box(r)]
  switch (status) {
    case 'queued': break
    case 'working': out.push([[r.x0 + m, r.y1 - m], [r.x1 - m, r.y0 + m]]); break
    case 'needs_you': out.push([[cx, r.y0 + m], [cx, cy + h * 0.12]], [[cx, r.y1 - m - 0.5], [cx + 0.2, r.y1 - m - 0.3]]); break
    case 'done': out.push([[r.x0 + m, cy], [cx - w * 0.08, r.y1 - m], [r.x1 - m + 0.6, r.y0 - 0.8]]); break
    case 'failed': out.push([[r.x0 + m, r.y0 + m], [r.x1 - m, r.y1 - m]], [[r.x1 - m, r.y0 + m], [r.x0 + m, r.y1 - m]]); break
    case 'paused': out.push([[cx - 0.9, r.y0 + m], [cx - 0.9, r.y1 - m]], [[cx + 0.9, r.y0 + m], [cx + 0.9, r.y1 - m]]); break
    case 'cancelled': out.push([[r.x0 - 1.5, cy], [r.x1 + 1.5, cy]]); break
  }
  return out
}

/** Distance from a point to a card, mm (0 inside): how close a mark is to being "on" the card. */
export const distToCard = (p: Pt, l: CardLayout) => distToRect(p, l.rect)
