/**
 * Timelapse pacing: when each stroke, and each point of it, appears in a timelapse video.
 *
 * The phone menu's "Export timelapse" replays the page into a video of a chosen length (10, 20 or
 * 40 s) that ends on a {@link HOLD_MS} hold of the finished page. A drawing session does not fit
 * that length as it happened: it has minutes of thinking between bursts of ink, strokes drawn
 * concurrently by several participants, and a saved page whose strokes carry no times at all. This
 * module turns the strokes' own times into a schedule on the video's clock; phone/timelapse.ts draws
 * the frames from it with the stage's renderer. It is pure (no DOM, no config), so it is tested
 * under tsx (test/timelapse.test.ts).
 *
 * The facts it rests on:
 *
 * - Live strokes know when they were drawn (strokes.ts): `start` is the sender's `stroke_begin.ts`
 *   or, without one, when the stroke began on this device; `times` holds each point's own `t`
 *   (Unix ms on the sender's clock, docs/protocol.md) or its arrival time here. Offsets inside one
 *   stroke always come from one clock, so a stroke's duration and the pen's relative speed along it
 *   are real even when the sender's clock and ours disagree.
 * - Points that arrive in a burst (a router replaying the page after `hello`, AI ink without
 *   times) have no usable spread: such a stroke is drawn evenly at a nominal pen rate
 *   ({@link PEN_RATE_MS} per point).
 * - Strokes from the tablet's saved page (`fromPage`) have no times: the .rm file keeps none. They
 *   are drawn first, in file order, each in a slot proportional to its point count: the whole
 *   length when nothing else is on the page, else the first {@link BASE_SHARE} of it as a quick base.
 *
 * How the live strokes are paced, in the order they were drawn (the store's order):
 *
 * 1. Each stroke starts at its own start time, never before the one drawn before it.
 * 2. Idle time (no stroke being drawn) is compressed by {@link compressGap}: short pauses keep their
 *    rhythm, long ones shrink to at most {@link MAX_GAP_MS}. Strokes that overlap in time (two
 *    participants at once) keep their overlap.
 * 3. The result is scaled uniformly to fill the drawing part of the video (its length minus the
 *    hold): a long session speeds up, a quick doodle slows down. Within a stroke the points keep
 *    their relative timing, so the pen speeds up and slows down as it did.
 *
 * All times here are milliseconds; video times run from 0 at the first frame.
 */

/** A stroke as the planner sees it: how many points, and what is known of when they were drawn. */
export interface TimelapseStroke {
  /** number of points */
  n: number
  /** from the tablet's saved page: no times, drawn in file order as the base */
  fromPage?: boolean
  /** when the stroke began, Unix ms (sender's `ts`, else arrival here); absent: no times */
  start?: number
  /** when each point was drawn, Unix ms, parallel to the points (may be absent or partial) */
  times?: number[]
}

/** A stroke on the video's clock: drawn from `start` to `end`, point j appearing at `at[j]` (ms). */
export interface PlannedStroke {
  start: number
  end: number
  /** video ms at which each point appears; non-decreasing, `at[0] === start` */
  at: number[]
}

export interface TimelapsePlan {
  /** one entry per input stroke, in the same order */
  strokes: PlannedStroke[]
  /** video ms by which every stroke is complete */
  drawMs: number
  /** the hold on the finished page after drawMs */
  holdMs: number
  /** the video's whole length: drawMs + holdMs */
  totalMs: number
}

/** The lengths offered in the menu, seconds. */
export const LENGTHS_S = [10, 20, 40] as const
/** The hold on the finished page at the end of every timelapse, ms. */
export const HOLD_MS = 1500
/** The share of the drawing time given to saved-page strokes when live strokes follow them. */
export const BASE_SHARE = 0.2
/** Nominal ms per point for a stroke whose own times are unusable (a 125 Hz pen). */
export const PEN_RATE_MS = 8
/** No stroke (a dot, a tick) takes less than this on the real clock, ms. */
export const MIN_STROKE_MS = 60
/** Pauses up to this long keep their length, ms. */
export const KEEP_GAP_MS = 300
/** No pause, however long, lasts more than this on the real clock after compression, ms. */
export const MAX_GAP_MS = 1200
/** A stroke whose points span longer than this has times we do not trust (a stuck pen, a clock jump), ms. */
const MAX_STROKE_MS = 120_000

/**
 * A pause of `ms` between strokes, compressed: short ones unchanged, longer ones grow a tenth as
 * fast past {@link KEEP_GAP_MS}, capped at {@link MAX_GAP_MS}. Monotonic, so a longer pause never
 * becomes shorter than a shorter one.
 */
export function compressGap(ms: number): number {
  if (!(ms > 0)) return 0
  if (ms <= KEEP_GAP_MS) return ms
  return Math.min(MAX_GAP_MS, KEEP_GAP_MS + (ms - KEEP_GAP_MS) * 0.1)
}

/**
 * A stroke's duration on the real clock and each point's offset from its first point (ms). The
 * stroke's own times when they are complete and plausible (non-decreasing after clamping, at least
 * a millisecond per point on average, under two minutes); else even spacing at {@link PEN_RATE_MS}.
 * Never shorter than {@link MIN_STROKE_MS}.
 */
export function strokeTiming(s: TimelapseStroke): { duration: number; offsets: number[] } {
  const n = Math.max(0, s.n)
  const t = s.times
  if (n >= 2 && t && t.length >= n) {
    const offsets: number[] = new Array(n)
    let prev = 0
    for (let j = 0; j < n; j++) {
      prev = Math.max(prev, t[j] - t[0]) // clamp: a point never appears before the one before it
      offsets[j] = prev
    }
    const span = offsets[n - 1]
    if (span >= n - 1 && span <= MAX_STROKE_MS) return { duration: Math.max(MIN_STROKE_MS, span), offsets }
  }
  const duration = Math.max(MIN_STROKE_MS, (n - 1) * PEN_RATE_MS)
  const offsets = Array.from({ length: n }, (_, j) => (n <= 1 ? 0 : (j / (n - 1)) * duration))
  return { duration, offsets }
}

/**
 * Plan a timelapse of `strokes` (in drawing order) lasting `totalMs`, the last `holdMs` of it on
 * the finished page. Strokes with no points get an empty slot at 0. `baseShare` is the share of
 * the drawing time the saved-page strokes take when live strokes follow ({@link BASE_SHARE}); 0
 * puts them all on the first frame (a replay clip, phone/replay.ts, starts on the page as it was).
 */
export function planTimelapse(strokes: TimelapseStroke[], totalMs: number, holdMs = HOLD_MS, baseShare = BASE_SHARE): TimelapsePlan {
  const hold = Math.max(0, Math.min(holdMs, totalMs))
  const drawMs = Math.max(0, totalMs - hold)
  const out: PlannedStroke[] = strokes.map(() => ({ start: 0, end: 0, at: [] }))

  const base: number[] = [] // saved-page strokes (and any without a start), in file order
  const live: number[] = []
  strokes.forEach((s, i) => {
    if (s.n <= 0) return
    if (s.fromPage || typeof s.start !== 'number' || !isFinite(s.start)) base.push(i)
    else live.push(i)
  })
  const baseMs = base.length === 0 ? 0 : live.length === 0 ? drawMs : drawMs * baseShare

  // The base: one slot per stroke, proportional to its points, drawn evenly.
  const basePoints = base.reduce((sum, i) => sum + strokes[i].n, 0)
  let cursor = 0
  for (const i of base) {
    const n = strokes[i].n
    const slot = basePoints > 0 ? (baseMs * n) / basePoints : 0
    const at = Array.from({ length: n }, (_, j) => cursor + (n <= 1 ? 0 : (j / (n - 1)) * slot))
    out[i] = { start: cursor, end: cursor + slot, at }
    cursor += slot
  }

  // Live strokes: real start times with idle time compressed, then scaled to fill what is left.
  const real: { start: number; offsets: number[]; duration: number }[] = []
  let prevStart = -Infinity
  let busyUntil = -Infinity
  let shift = 0 // idle time removed so far
  for (const i of live) {
    const s = strokes[i]
    const timing = strokeTiming(s)
    const begin = Math.max(s.start as number, prevStart)
    if (isFinite(busyUntil) && begin > busyUntil) {
      const idle = begin - busyUntil
      shift += idle - compressGap(idle)
    }
    real.push({ start: begin - shift, offsets: timing.offsets, duration: timing.duration })
    prevStart = begin
    busyUntil = Math.max(busyUntil, begin + timing.duration)
  }
  if (real.length) {
    const t0 = real[0].start
    const span = Math.max(...real.map((r) => r.start + r.duration)) - t0
    const k = span > 0 ? (drawMs - baseMs) / span : 0
    live.forEach((i, j) => {
      const r = real[j]
      const start = baseMs + (r.start - t0) * k
      out[i] = { start, end: start + r.duration * k, at: r.offsets.map((o) => start + o * k) }
    })
  }

  return { strokes: out, drawMs, holdMs: hold, totalMs: drawMs + hold }
}

/** How many of a planned stroke's points are showing at video time `t` (ms). */
export function revealedPoints(p: PlannedStroke, t: number): number {
  const at = p.at
  if (at.length === 0 || t < at[0]) return 0
  if (t >= at[at.length - 1]) return at.length
  let lo = 0 // at[lo] <= t
  let hi = at.length - 1 // at[hi] > t
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (at[mid] <= t) lo = mid
    else hi = mid
  }
  return lo + 1
}

/**
 * The recording formats to try, best first: H.264 in MP4 plays and shares everywhere (and is what
 * Safari and the iOS WebView of the Even app record), then WebM (Chrome before 126, Firefox).
 */
export const VIDEO_TYPES = ['video/mp4;codecs=avc1', 'video/mp4;codecs=avc1.42E01E', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']

/** The first of {@link VIDEO_TYPES} the recorder supports (MediaRecorder.isTypeSupported), or null. */
export function pickVideoType(isSupported: (type: string) => boolean): string | null {
  for (const t of VIDEO_TYPES) {
    try {
      if (isSupported(t)) return t
    } catch {
      // an engine that throws on a type it does not know: try the next
    }
  }
  return null
}

/** The file extension for a recorder MIME type ("video/mp4;codecs=…" → "mp4"). */
export function videoExtension(type: string): 'mp4' | 'webm' {
  return /^video\/mp4/i.test(type) ? 'mp4' : 'webm'
}
