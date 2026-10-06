/**
 * Consent by pen: deciding whether initials in a card's consent box authorise one action.
 *
 * What this can and cannot prove, honestly. Handwritten initials are a weak biometric: a person
 * who has seen them can imitate their shape, and two people's "AJ" can look alike. Online
 * signature verification (shape plus timing and pressure, compared by dynamic time warping) does
 * better than shape alone, but published equal-error rates against skilled forgeries are still
 * several percent, too weak to be the only lock on sending money. So the initials are **not** the
 * security boundary here. The boundary is everything around them, all of which the broker can
 * check exactly:
 *
 * 1. **Binding.** The consent is for one action hash (task.ts). The card shows the hash's code
 *    beside the box; the broker re-hashes the pending action and refuses if anything changed.
 *    A consent cannot be moved to another action, and a nonce makes each proposal single-use.
 * 2. **Provenance.** The strokes come from the user's layer, read by the tablet bridge from the
 *    physical pen device (`/dev/input/event2`) on the device paired to the requester, over the
 *    bridge's authenticated connection. A WebSocket client sending `stroke_*` with
 *    `layer:"user"` is not a pen: the router tags origin by connection, never by the message's
 *    own claim, and agents can write only their own `ai` layers (ADR 003, ADR 009 §2).
 * 3. **Order and freshness.** Every stroke starts after the card finished drawing this code and
 *    before the consent window closes, so ink written before the question existed cannot answer it.
 * 4. **Place.** The ink lies inside the consent box (marks.ts), not near it.
 *
 * The learned initials then add a *soft* signal: a shape-and-rhythm similarity to the user's
 * enrolled samples. Below the threshold, or for actions marked high-stakes, the broker asks for a
 * second factor on another surface that shows the same code (a ring tap on the glasses, a tap on
 * the phone). It never silently accepts a low score, and it never rejects silently either: the
 * card says why it is waiting.
 */

import { type Pt, bounds, dist, height, pathLength, resample, width } from './geometry'
import { type Action, actionHash, consentCode } from './task'
import type { InkStroke } from './marks'

/** A stroke as the broker knows it: where it came from, not only what it looks like. */
export interface ProvenancedStroke extends InkStroke {
  layer: string
  /** set by the router from the connection: `pen` only for the tablet bridge's evdev reader */
  origin: 'pen' | 'client' | 'agent'
  device: string
  author: string
  /** per-point pressure, 0..1 */
  pressure: number[]
}

/** An action waiting for consent, as the card showed it. */
export interface PendingConsent {
  action: Action
  /** the hash the card was drawn with */
  hash: string
  /** the code printed on the card */
  code: string
  /** when the card finished drawing the consent box and code, Unix ms */
  shownAt: number
  /** when the consent window closes, Unix ms */
  expires: number
  requester: { participant: string; device: string }
  /** require a second factor whatever the initials score */
  highStakes: boolean
  /** nonces already consumed */
  used: Set<string>
}

export interface ConsentResult {
  ok: boolean
  /** the hard checks that failed (empty when ok or only a second factor is needed) */
  failed: string[]
  /** 0..1 similarity to the enrolled initials, or undefined with none enrolled */
  similarity?: number
  needsSecondFactor: boolean
}

/** Minimum ink in a consent, mm: a dot or a stray touch is not initials. */
export const MIN_INK_MM = 8
/** Similarity at or above which enrolled initials count as a match (tune on real samples). */
export const MATCH = 0.55

/**
 * Check a consent. `strokes` are the gesture the classifier read as `initials` on this card;
 * `enrolled` are the user's enrolled initials (each a list of strokes), possibly empty.
 */
export function verifyConsent(p: PendingConsent, strokes: ProvenancedStroke[], enrolled: InkStroke[][], now: number): ConsentResult {
  const failed: string[] = []
  const hash = actionHash(p.action)
  if (hash !== p.hash) failed.push('the action changed after the card was drawn')
  if (consentCode(hash) !== p.code) failed.push('the code on the card is not this action\'s code')
  if (p.used.has(p.action.nonce)) failed.push('this proposal was already consented to')
  if (now > p.expires) failed.push('the consent window closed')
  for (const s of strokes) {
    if (s.layer !== 'user' || s.origin !== 'pen') { failed.push(`stroke ${s.id} is not from the pen`); break }
    if (s.device !== p.requester.device || s.author !== p.requester.participant) { failed.push(`stroke ${s.id} is not the requester's`); break }
    if (s.t0 <= p.shownAt) { failed.push(`stroke ${s.id} was written before the question`); break }
    if (s.t1 > p.expires) { failed.push(`stroke ${s.id} was written after the window`); break }
  }
  const ink = strokes.reduce((L, s) => L + pathLength(s.pts), 0)
  if (ink < MIN_INK_MM) failed.push(`only ${ink.toFixed(1)} mm of ink`)
  const pr = strokes.flatMap((s) => s.pressure)
  if (pr.length && Math.max(...pr) - Math.min(...pr) < 0.02) failed.push('pressure never varies: not a hand')

  const similarity = enrolled.length ? Math.max(...enrolled.map((e) => initialsSimilarity(strokes, e))) : undefined
  const ok = failed.length === 0
  return { ok, failed, similarity, needsSecondFactor: ok && (p.highStakes || similarity === undefined || similarity < MATCH) }
}

// --- initials similarity -----------------------------------------------------------------------

/**
 * A gesture as one sequence for comparison: strokes in drawing order, each resampled by arc
 * length, the pen-ups kept as a jump, translated to the centroid and scaled to unit size.
 */
export function signatureSequence(strokes: InkStroke[], n = 64): Pt[] {
  const all = strokes.flatMap((s) => s.pts)
  const L = strokes.reduce((a, s) => a + Math.max(pathLength(s.pts), 0.1), 0)
  const seq: Pt[] = []
  for (const s of strokes) {
    const k = Math.max(2, Math.round((n * Math.max(pathLength(s.pts), 0.1)) / L))
    const step = Math.max(pathLength(s.pts) / (k - 1), 0.05)
    seq.push(...resample(s.pts, step))
  }
  const b = bounds(all)
  const sc = Math.max(width(b), height(b), 1e-6)
  const cx = seq.reduce((a, p) => a + p[0], 0) / seq.length, cy = seq.reduce((a, p) => a + p[1], 0) / seq.length
  return seq.map(([x, y]) => [(x - cx) / sc, (y - cy) / sc])
}

/** Dynamic time warping distance between two sequences, normalised by path length. */
export function dtw(a: Pt[], b: Pt[]): number {
  const n = a.length, m = b.length
  let prev = new Float64Array(m + 1).fill(Infinity)
  prev[0] = 0
  for (let i = 1; i <= n; i++) {
    const cur = new Float64Array(m + 1).fill(Infinity)
    for (let j = 1; j <= m; j++) cur[j] = dist(a[i - 1], b[j - 1]) + Math.min(prev[j], cur[j - 1], prev[j - 1])
    prev = cur
  }
  return prev[m] / (n + m)
}

/** Similarity 0..1 of two sets of initials (1 = same path). */
export function initialsSimilarity(a: InkStroke[], b: InkStroke[]): number {
  if (a.length === 0 || b.length === 0) return 0
  const stroke = Math.abs(a.length - b.length) // a different stroke count is evidence too
  return Math.exp(-dtw(signatureSequence(a), signatureSequence(b)) / 0.08) * Math.pow(0.8, stroke)
}
