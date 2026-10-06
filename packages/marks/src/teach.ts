/**
 * The teach flow: when to ask what a mark means, and how a meaning earns the right to act alone.
 *
 * The agent is a co-thinker that "does not talk over you while you are mid-thought" (roadmap), so
 * asking is rationed:
 *
 * - **Only candidates are asked about.** An unknown gesture (one neither the built-in grammar nor
 *   any personal mark claimed, grammar.ts) becomes a candidate for one of three reasons:
 *   - `isolated`: a deliberate-looking glyph beside content: compact (aspect within
 *     {@link COMPACT}), mark-sized ({@link SIZE_MM}), few strokes, and placed beside a line or in a
 *     margin next to ink, never inside a line of writing;
 *   - `repeated`: a compact unknown glyph drawn a second time (the same shape, by the recogniser's
 *     single-example threshold), anywhere but inside a line;
 *   - `lasso`: the user selected it and asked ("Teach a mark" in the dock or on the phone).
 * - **At most once.** A shape that was asked about, declined ("not a mark") or left unanswered is
 *   remembered and never asked about again; only a lasso can bring it back.
 * - **Batched, at a lull.** Candidates wait until the pen has rested {@link LULL_MS}, then go out
 *   together as one `mark_ask` of at most {@link MAX_ITEMS}, and at most one ask every
 *   {@link ASK_GAP_MS} (a lasso candidate skips the gap: the user asked). An ask not answered in
 *   {@link ASK_TTL_MS} is dismissed.
 * - **In-medium.** The ask is a small card ("this mark → ?") whose options are the action
 *   vocabulary; on paper it is laid out by packages/delegate's card code ({@link askCard}) and
 *   answered like any card, by circling or ticking an option, so the answer to "what does this
 *   mark mean?" is itself read by the built-in grammar.
 *
 * Once defined, a mark **earns** silence ({@link modeFor}):
 *
 * - `confirm` (a quiet confirmation: the action waits for an accept, and lapses unanswered) for
 *   its first {@link CONFIRM_FIRST} accepted uses, again for the first uses after its meaning
 *   changes, whenever the reading is unsure (confidence < {@link SURE}), and always for a
 *   consequential action (actions.ts);
 * - `notify` (the action runs, with a quiet undo; no answer within {@link NOTIFY_TTL_MS} counts
 *   as an accept) once it has been confirmed enough;
 * - `silent` (the action runs, logged in the mark's history) once it has at least
 *   {@link SILENT_AFTER} accepts, a confidence of {@link SILENT_CONFIDENCE}, at most one rejection
 *   among the last ten, and this reading is sure ({@link SILENT_SURE}).
 *
 * Retracting a mark stops it at once; restoring it starts the confirmations over. Every step is in
 * the mark's lineage and invocations (registry.ts), so the user can always see why a mark acted.
 *
 * This module is the policy and the candidate state machine; engine.ts drives it with ink and
 * messages. Times are Unix ms passed in by the caller, so the flow is deterministic under test.
 */

import { type CardContent } from 'delegate'
import { ACTIONS, ASK_OPTIONS, type ActionKind } from './actions'
import type { Context } from './context'
import type { Stats } from './registry'
import { alike, TAU_ONE } from './recognizer'
import type { Pt } from 'delegate'

// --- the policy ----------------------------------------------------------------------------------

export const LULL_MS = 3_000
export const ASK_GAP_MS = 5 * 60_000
export const ASK_TTL_MS = 15 * 60_000
export const MAX_ITEMS = 3
export const CONFIRM_FIRST = 3
export const SURE = 0.55
export const SILENT_AFTER = 5
export const SILENT_CONFIDENCE = 0.85
export const SILENT_SURE = 0.65
/** A confirm not answered in this long lapses (the action never runs). */
export const CONFIRM_TTL_MS = 2 * 60_000
/** A notify not undone in this long counts as accepted. */
export const NOTIFY_TTL_MS = 60_000
/** Aspect (height / width) range of a deliberate glyph. */
export const COMPACT: [number, number] = [0.5, 2.2]
/** Size range (larger side) of a deliberate glyph, mm. */
export const SIZE_MM: [number, number] = [3, 20]
/** Most strokes in a deliberate glyph. */
export const MAX_STROKES = 4
/**
 * Two unknown glyphs are "the same shape" for remembering and repetition within this $P distance
 * (with the recogniser's gates and a path check, recognizer.ts `alike`): looser than a one-example
 * mark's threshold, because forgetting a "not a mark" costs the user an
 * extra question while a false "same shape" costs only a missed candidate.
 */
export const SAME_SHAPE = 1.4 * TAU_ONE

export type Mode = 'confirm' | 'notify' | 'silent'

/** How an invocation of a mark with history `s` runs, for a reading of `confidence`. */
export function modeFor(s: Stats, confidence: number, consequential: boolean): { mode: Mode; why: string } {
  if (consequential) return { mode: 'confirm', why: 'a consequential action always asks' }
  if (s.acceptsSinceChange < CONFIRM_FIRST) return { mode: 'confirm', why: `confirmed ${s.acceptsSinceChange} of the first ${CONFIRM_FIRST} times` }
  if (confidence < SURE) return { mode: 'confirm', why: `an unsure reading (${confidence.toFixed(2)})` }
  if (s.accepts >= SILENT_AFTER && s.confidence >= SILENT_CONFIDENCE && s.recent.rejects <= 1 && confidence >= SILENT_SURE)
    return { mode: 'silent', why: `earned: ${s.accepts} accepted, confidence ${s.confidence.toFixed(2)}` }
  return { mode: 'notify', why: `trusted enough to act, with an undo (confidence ${s.confidence.toFixed(2)})` }
}

// --- candidates ----------------------------------------------------------------------------------

export type CandidateReason = 'isolated' | 'repeated' | 'lasso'
export type CandidateStatus = 'pending' | 'asked' | 'defined' | 'declined' | 'dismissed'

/** A gesture as the teach flow sees it. */
export interface Occurrence {
  id: string
  /** stroke ids */
  strokes: string[]
  /** the ink, page mm */
  ink: Pt[][]
  bbox: { x0: number; y0: number; x1: number; y1: number }
  ctx: Context
  page?: string
  at: number
}

export interface Candidate {
  occ: Occurrence
  reason: CandidateReason
  status: CandidateStatus
  /** how many times the shape has been seen (repeats join the first occurrence) */
  seen: number
  /** the other occurrences of the same shape: more examples when it is defined */
  repeats: Occurrence[]
  ask?: string
  firstAt: number
  lastAt: number
}

export interface Ask {
  id: string
  items: Candidate[]
  at: number
}

/** Why `o` looks like a deliberate glyph, or null. */
export function deliberate(o: Occurrence): string | null {
  const w = o.bbox.x1 - o.bbox.x0, h = o.bbox.y1 - o.bbox.y0
  const size = Math.max(w, h), aspect = Math.max(h, 0.5) / Math.max(w, 0.5)
  if (o.ink.length > MAX_STROKES) return null
  if (size < SIZE_MM[0] || size > SIZE_MM[1]) return null
  if (aspect < COMPACT[0] || aspect > COMPACT[1]) return null
  if (o.ctx.relation === 'inline' || o.ctx.relation === 'adjoining' || o.ctx.relation === 'over') return null
  return `${o.ink.length} stroke${o.ink.length > 1 ? 's' : ''}, ${size.toFixed(0)} mm, ${o.ctx.relation}`
}

let askSeq = 0

/**
 * The candidate state machine:
 *
 *     (unknown gesture) ──seen──▶ pending ──due()──▶ asked ──answer──▶ defined | declined
 *                                    │                 └──ASK_TTL──▶ dismissed
 *                                    └──(same shape again)──▶ pending, seen + 1
 *
 * declined, dismissed, asked and defined shapes are remembered: they never become candidates
 * again, except by lasso.
 */
export class TeachFlow {
  candidates: Candidate[] = []
  asks: Ask[] = []
  lastAskAt = -Infinity
  /** recent unknown glyphs that were not candidates themselves (for `repeated`) */
  private unknown: Occurrence[] = []

  /** The candidate whose shape `o` repeats, if any. */
  private sameShape(o: Occurrence, among: Candidate[]): Candidate | undefined {
    return among.find((c) => [c.occ, ...c.repeats].some((x) => alike(x.ink, o.ink, SAME_SHAPE)))
  }

  /**
   * An unknown gesture. Returns the candidate it made or joined, or null (not deliberate, or a
   * shape already settled).
   */
  seen(o: Occurrence, now: number): Candidate | null {
    const known = this.sameShape(o, this.candidates)
    if (known) {
      known.seen++
      known.lastAt = now
      if (known.status === 'pending' || known.status === 'asked') known.repeats.push(o)
      return known.status === 'pending' ? known : null
    }
    if (!deliberate(o)) return null // not glyph-like: neither asked about nor remembered
    const beside = o.ctx.relation === 'beside' || ((o.ctx.zone === 'margin_left' || o.ctx.zone === 'margin_right') && o.ctx.relation === 'near')
    if (beside) return this.add(o, 'isolated', now)
    // a glyph on its own, not beside content: remember it, and make it a candidate if it comes back
    const earlier = this.unknown.find((x) => alike(x.ink, o.ink, SAME_SHAPE))
    if (earlier) {
      this.unknown = this.unknown.filter((x) => x !== earlier)
      const c = this.add(earlier, 'repeated', now)
      c.seen = 2
      c.repeats.push(o)
      return c
    }
    this.unknown.push(o)
    if (this.unknown.length > 50) this.unknown.shift()
    return null
  }

  /** The user lasso-selected ink and asked to teach it: a candidate whatever its history. */
  lasso(o: Occurrence, now: number): Candidate {
    return this.add(o, 'lasso', now)
  }

  private add(o: Occurrence, reason: CandidateReason, now: number): Candidate {
    const c: Candidate = { occ: o, reason, status: 'pending', seen: 1, repeats: [], firstAt: now, lastAt: now }
    this.candidates.push(c)
    return c
  }

  /**
   * The ask to send now, if any: pending candidates, at a lull (`lastInkAt` is when the pen last
   * lifted), no sooner than ASK_GAP_MS after the previous ask unless one was lassoed. Marks the
   * candidates asked.
   */
  due(now: number, lastInkAt: number): Ask | null {
    this.expire(now)
    const pending = this.candidates.filter((c) => c.status === 'pending')
    if (!pending.length || now - lastInkAt < LULL_MS) return null
    const urgent = pending.some((c) => c.reason === 'lasso')
    if (!urgent && now - this.lastAskAt < ASK_GAP_MS) return null
    // lassoed first, then the most repeated, then the oldest
    const rank = (c: Candidate) => (c.reason === 'lasso' ? 0 : 1)
    const items = pending.sort((a, b) => rank(a) - rank(b) || b.seen - a.seen || a.firstAt - b.firstAt).slice(0, MAX_ITEMS)
    const ask: Ask = { id: `ma_${now.toString(36)}${(askSeq++).toString(36)}`, items, at: now }
    for (const c of items) { c.status = 'asked'; c.ask = ask.id }
    this.asks.push(ask)
    this.lastAskAt = now
    return ask
  }

  /** Asks not answered in ASK_TTL_MS: their candidates are dismissed (asked once, never again). */
  expire(now: number): Candidate[] {
    const gone: Candidate[] = []
    for (const c of this.candidates) if (c.status === 'asked' && c.ask) {
      const a = this.asks.find((x) => x.id === c.ask)
      if (a && now - a.at > ASK_TTL_MS) { c.status = 'dismissed'; gone.push(c) }
    }
    return gone
  }

  /** The candidate for an occurrence id. */
  find(occurrence: string): Candidate | undefined {
    return this.candidates.find((c) => c.occ.id === occurrence)
  }

  /** The user answered: `defined` (a mark was made from it) or `declined` ("not a mark"). */
  settle(occurrence: string, status: 'defined' | 'declined'): Candidate | undefined {
    const c = this.find(occurrence)
    if (c) c.status = status
    return c
  }
}

// --- the ask card on paper -------------------------------------------------------------------------

/** The option id that means "not a mark". */
export const NOT_A_MARK = 'not_a_mark'

/**
 * The ask as a packages/delegate card, for drawing beside the mark in the agent's hand: the
 * title asks, the choices are the vocabulary plus "not a mark". Circling or ticking an option is
 * read by the built-in grammar (grammar.ts), which is how a pen answers.
 */
export function askCard(items: number, options: ActionKind[] = ASK_OPTIONS.slice(0, 4)): CardContent {
  return {
    pod: 'marks',
    requester: 'you',
    status: 'needs_you',
    title: items > 1 ? `these ${items} marks → ?` : 'this mark → ?',
    choices: [...options.map((k) => ({ id: k, label: ACTIONS[k].label })), { id: NOT_A_MARK, label: 'not a mark' }],
  }
}
