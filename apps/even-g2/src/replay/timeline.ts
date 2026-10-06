/**
 * The replay timeline: every stroke of a page placed on one clock, so the page can be scrubbed
 * like a video ("show me how I got here").
 *
 * ## The problem
 *
 * Thinking replay (docs/roadmap.md, item 2) shows the page as it was at any moment t. The strokes
 * that make it come from two places and carry time in several ways:
 *
 * - **The live store** (strokes.ts): each live stroke knows when it began here (`startedAt`, this
 *   device's Unix ms) and when each point was drawn (`times`, the sender's own `t` where it
 *   stamped one, else the arrival time here). Strokes from the tablet's saved page (`fromPage`)
 *   carry no times at all: the `.rm` file keeps none.
 * - **A session recording** (recording.ts, the "Export recording" JSONL): every message with the
 *   time it crossed the link (`ts`, Unix ms here), points with their sender's `t`.
 *
 * Two clocks meet: the sender's (a tablet, a browser, an agent's hand) and ours. Offsets inside
 * one stroke always come from one clock, so a stroke's duration and the pen's speed along it are
 * real (the fact timelapse.ts rests on too). Between strokes, the sender's clock is the better
 * ruler (it says when the pen moved, not when the network delivered it, and a router replaying a
 * page after `hello` delivers minutes of strokes in one burst), but each sender's clock is skewed
 * from ours by its own amount. So each *source* (a layer and author: the tablet, a peer, an agent)
 * gets one offset, the smallest lag seen between its stamps and their arrival
 * ({@link sourceLag}): for live ink that is the skew plus one network hop; for a replayed burst
 * every stroke of the source moves by the same amount, so their spacing is kept.
 *
 * ## The clock
 *
 * Timeline ms run from 0, the page as it stood before this session: saved-page strokes are all
 * there at t = 0 ("before this session"). The first live stroke starts at {@link LEAD_MS}; the
 * timeline ends {@link TAIL_MS} after the last point. Strokes are kept in drawing order (the
 * store's order, which is the order erasers cut by: an eraser cuts only ink begun before it), and
 * no stroke starts before the one drawn before it.
 *
 * {@link TimeMap} maps timeline ms to the scrubber's axis: identity, or with long idle stretches
 * (no pen down anywhere) compressed by {@link compressIdle}, so a ten-minute think does not take
 * most of the scrubber. Markers and playback both live on the axis.
 *
 * Pure: no DOM, no configuration (tested under tsx, test/replay.test.ts). replay/cursor.ts turns a
 * timeline into a stroke store at any t; replay/moments.ts finds the moments of thought on it.
 */
import type { Layer, PageMessage, Stroke } from '../strokes'
import { strokeTiming } from '../timelapse'

// ── The timeline's strokes ────────────────────────────────────────────────────────────────────

/** One stroke placed on the timeline. */
export interface ReplayStroke {
  id: string
  layer: Layer
  brush: string
  /** the saved page's tool, colour ("#rrggbbaa") and size; a peer's or agent's colour and author */
  tool?: string
  color?: string
  size?: number
  author?: string
  /** points [x, y, p] (normalized page coords, pressure 0..1); saved-page points [x, y, p, w] */
  pts: number[][]
  /** timeline ms at which each point is drawn, parallel to `pts`, non-decreasing */
  at: number[]
  /** from the saved page, before this session: every point at t = 0, no timing evidence */
  base: boolean
  /** the stroke was finished (stroke_end); an unfinished one stays "being drawn" at its end */
  ended: boolean
  /** timeline ms when it was taken back (stroke_delete) or cleared away; absent: never */
  removedAt?: number
}

/** A page's strokes on one clock. */
export interface Timeline {
  /** in drawing order: the saved page's strokes first, then live strokes by start */
  strokes: ReplayStroke[]
  /** timeline ms at which everything has been drawn (the last point, plus {@link TAIL_MS}) */
  durationMs: number
  /** Unix ms (this device's clock) of timeline 0; 0 when there are no live strokes */
  originMs: number
  /** how many strokes are from before this session (the saved page) */
  baseCount: number
  /** where it came from, for the replay bar */
  source: 'live' | 'recording'
}

/** The first live stroke starts this long after t = 0 (the saved page alone), ms. */
export const LEAD_MS = 400
/** The timeline runs this long past its last point, so the end shows the finished page, ms. */
export const TAIL_MS = 600

/** Tools that leave no ink of their own (strokes.ts ERASER_TOOLS; repeated so this stays DOM-free to import). */
const ERASERS = new Set(['eraser', 'erase_area'])

/** Whether a stroke is an eraser path (the tablet's eraser end, or a saved eraser tool). */
export function isEraser(s: { brush: string; tool?: string }): boolean {
  return s.brush === 'eraser' || (s.tool !== undefined && ERASERS.has(s.tool))
}

/** Who drew a stroke, as one key: `user` (the tablet), `peer:<author>`, `ai:<author>`. */
export function writerOf(s: { layer: Layer; author?: string; color?: string }): string {
  if (s.layer === 'user') return 'user'
  return `${s.layer}:${s.author ?? s.color ?? s.layer}`
}

/** A stroke before placement: when it reached us, and what its own stamps say. */
interface Raw {
  s: Omit<ReplayStroke, 'at' | 'base'>
  /** Unix ms here when it began (arrival) */
  arrived: number
  /** per-point stamps, Unix ms (sender's where stamped, else arrival); may be empty */
  times: number[]
  removedAtUnix?: number
}

/**
 * Each source's lag, ms: the smallest `arrived − times[0]` over its strokes. Our clock minus the
 * sender's, plus one network hop; adding it puts a stamp on our clock (see the module comment).
 */
export function sourceLag(raws: { writer: string; arrived: number; t0?: number }[]): Map<string, number> {
  const lag = new Map<string, number>()
  for (const r of raws) {
    if (r.t0 === undefined || !isFinite(r.t0)) continue
    const d = r.arrived - r.t0
    const was = lag.get(r.writer)
    if (was === undefined || d < was) lag.set(r.writer, d)
  }
  return lag
}

/** Place raw strokes (in drawing order) and saved-page strokes on one timeline. */
function place(base: Omit<ReplayStroke, 'at' | 'base'>[], raws: Raw[], source: Timeline['source']): Timeline {
  const lag = sourceLag(raws.map((r) => ({ writer: writerOf(r.s), arrived: r.arrived, t0: r.times.length ? r.times[0] : undefined })))
  const placed = raws.map((r) => {
    const n = r.s.pts.length
    const timing = strokeTiming({ n, times: r.times.length >= n ? r.times : undefined })
    const l = lag.get(writerOf(r.s))
    const start = r.times.length && l !== undefined ? r.times[0] + l : r.arrived
    return { r, start, offsets: timing.offsets }
  })
  // never before the stroke drawn before it (drawing order is the order erasers cut by)
  let prev = -Infinity
  for (const p of placed) {
    p.start = Math.max(p.start, prev)
    prev = p.start
  }
  const origin = placed.length ? placed[0].start - LEAD_MS : 0
  let end = 0
  const strokes: ReplayStroke[] = base.map((b) => ({ ...b, at: b.pts.map(() => 0), base: true }))
  for (const { r, start, offsets } of placed) {
    const at = offsets.map((o) => start - origin + o)
    if (at.length) end = Math.max(end, at[at.length - 1])
    const s: ReplayStroke = { ...r.s, at, base: false }
    if (r.removedAtUnix !== undefined) s.removedAt = Math.max(at[0] ?? 0, r.removedAtUnix - origin)
    strokes.push(s)
  }
  return { strokes, durationMs: (placed.length ? end : 0) + TAIL_MS, originMs: placed.length ? origin : 0, baseCount: base.length, source }
}

// ── From the live store ───────────────────────────────────────────────────────────────────────

/**
 * The timeline of the strokes in a live store (strokes.ts `all()`, in drawing order): saved-page
 * strokes at t = 0, live strokes at their own times. Strokes with no points are left out.
 */
export function fromStore(strokes: readonly Stroke[]): Timeline {
  const base: Omit<ReplayStroke, 'at' | 'base'>[] = []
  const raws: Raw[] = []
  for (const s of strokes) {
    if (s.pts.length === 0) continue
    const r = { id: s.id, layer: s.layer, brush: s.brush, tool: s.tool, color: s.color, size: s.size, author: s.author, pts: s.pts.map((p) => p.slice()), ended: s.done }
    if (s.fromPage || s.startedAt === undefined) base.push({ ...r, ended: true })
    else raws.push({ s: r, arrived: s.startedAt, times: (s.times ?? []).slice(0, s.pts.length) })
  }
  return place(base, raws, 'live')
}

// ── From a session recording ──────────────────────────────────────────────────────────────────

/**
 * The timeline of a session recording (recording.ts JSONL: `{"ts", "dir", "msg"}` per line).
 *
 * Read in order: `stroke_begin` / `stroke_pts` / `stroke_end` on any layer and `ai_stroke_*`
 * build strokes (arrival at the line's `ts`, point times from their own `t` when stamped);
 * `stroke_delete` takes strokes back at its `ts`; `clear` takes everything back. The first `page`
 * (the tablet's saved page) is the base at t = 0 when it comes before any live ink; a later
 * `page` for the same page is the tablet catching up with ink already here and is skipped, and
 * one for a different page or document clears what was there (its strokes are not replayed: they
 * carry no times). A router replaying the page after a reconnect sends strokes again with the
 * same ids: a finished stroke seen again is skipped. Lines that are not JSON are skipped.
 */
export function fromRecording(text: string): Timeline {
  const base: Omit<ReplayStroke, 'at' | 'base'>[] = []
  const raws: Raw[] = []
  const live = new Map<string, Raw>()
  const baseIds = new Map<string, Omit<ReplayStroke, 'at' | 'base'>>()
  const replayed = new Set<string>() // ids of finished strokes being sent again: ignore their points
  let page: { doc: string; page: string } | null = null
  const baseRemoved = new Map<string, number>()
  const takeBack = (ids: Iterable<string>, ts: number) => {
    for (const id of ids) {
      const r = live.get(id)
      if (r && r.removedAtUnix === undefined) r.removedAtUnix = ts
      if (baseIds.has(id) && !baseRemoved.has(id)) baseRemoved.set(id, ts)
    }
  }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let row: { ts?: unknown; msg?: Record<string, unknown> }
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    const m = row?.msg
    const ts = typeof row?.ts === 'number' ? row.ts : NaN
    if (!m || typeof m !== 'object' || !isFinite(ts)) continue
    const t = m.t
    const id = typeof m.id === 'string' ? m.id : ''
    if (t === 'stroke_begin' || t === 'ai_stroke_begin') {
      if (!id) continue
      const old = live.get(id)
      if (old && old.s.ended && old.removedAtUnix === undefined) {
        replayed.add(id)
        continue
      }
      replayed.delete(id)
      const layer: Layer = t === 'ai_stroke_begin' || m.layer === 'ai' ? 'ai' : m.layer === 'peer' ? 'peer' : 'user'
      const r: Raw = {
        s: {
          id,
          layer,
          brush: typeof m.brush === 'string' && m.brush ? m.brush : t === 'ai_stroke_begin' ? 'ghost' : 'pen',
          color: typeof m.color === 'string' ? m.color : undefined,
          author: typeof m.author === 'string' ? m.author : undefined,
          pts: [],
          ended: false,
        },
        arrived: ts,
        times: [],
      }
      if (old) raws.splice(raws.indexOf(old), 1) // begun again after being taken back: a new stroke
      live.set(id, r)
      raws.push(r)
    } else if (t === 'stroke_pts' || t === 'ai_stroke_pts') {
      if (replayed.has(id)) continue
      let r = live.get(id)
      if (!r) {
        // points with no begin (the recording started mid-stroke): an implicit begin, as strokes.ts
        r = { s: { id, layer: t === 'ai_stroke_pts' ? 'ai' : 'user', brush: 'pen', pts: [], ended: false }, arrived: ts, times: [] }
        live.set(id, r)
        raws.push(r)
      }
      for (const p of Array.isArray(m.pts) ? (m.pts as unknown[]) : []) {
        if (!Array.isArray(p) || p.length < 2 || typeof p[0] !== 'number' || typeof p[1] !== 'number') continue
        r.s.pts.push([p[0], p[1], typeof p[2] === 'number' ? p[2] : 0.6])
        r.times.push(typeof p[3] === 'number' && p[3] > 1e12 ? p[3] : ts)
      }
    } else if (t === 'stroke_end' || t === 'ai_stroke_end') {
      if (replayed.has(id)) continue
      const r = live.get(id)
      if (r) r.s.ended = true
    } else if (t === 'stroke_delete') {
      takeBack(Array.isArray(m.ids) ? (m.ids as unknown[]).filter((x): x is string => typeof x === 'string') : [], ts)
    } else if (t === 'clear') {
      takeBack([...live.keys(), ...baseIds.keys()], ts)
    } else if (t === 'page') {
      const pm = m as unknown as PageMessage
      const here = { doc: String(pm.doc), page: String(pm.page) }
      const same = page && page.doc === here.doc && page.page === here.page
      if (!page && raws.length === 0) {
        for (const row of Array.isArray(pm.strokes) ? pm.strokes : []) {
          if (!row || typeof row.id !== 'string' || !Array.isArray(row.pts)) continue
          const pts = row.pts.filter((p) => Array.isArray(p) && p.length >= 2).map((p) => (p.length >= 4 ? [p[0], p[1], p[2], p[3]] : [p[0], p[1], p.length >= 3 ? p[2] : 0.6]))
          if (!pts.length) continue
          const b = { id: 'rm:' + row.id, layer: (row.layer === 'ai' ? 'ai' : 'user') as Layer, brush: ERASERS.has(row.tool ?? '') ? 'eraser' : 'pen', tool: row.tool, color: typeof row.rgba === 'string' ? row.rgba : undefined, size: typeof row.size === 'number' ? row.size : undefined, pts, ended: true }
          baseIds.delete(b.id)
          baseIds.set(b.id, b)
        }
      } else if (page && !same) takeBack([...live.keys(), ...baseIds.keys()], ts)
      page = here
    }
  }
  base.push(...baseIds.values())
  const tl = place(base, raws, 'recording')
  // saved-page strokes cleared away later: on the timeline's clock
  for (const s of tl.strokes) {
    const at = s.base ? baseRemoved.get(s.id) : undefined
    if (at !== undefined) s.removedAt = Math.max(0, at - tl.originMs)
  }
  return tl
}

// ── Questions about the timeline ──────────────────────────────────────────────────────────────

/** How many of a stroke's points are drawn at timeline ms `t` (binary search over `at`). */
export function revealed(s: ReplayStroke, t: number): number {
  const at = s.at
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

/** A stroke's first and last timeline ms. */
export function span(s: ReplayStroke): [number, number] {
  return s.at.length ? [s.at[0], s.at[s.at.length - 1]] : [0, 0]
}

/**
 * Where "next stroke" goes from `t`: the end of the first stroke that ends after `t` (so each
 * step shows one more stroke whole). Null at the end. Saved-page strokes are all there at 0.
 */
export function nextStrokeEnd(tl: Timeline, t: number): number | null {
  let best = Infinity
  for (const s of tl.strokes) {
    if (s.base || !s.at.length) continue
    const e = s.at[s.at.length - 1]
    if (e > t + 0.5 && e < best) best = e
  }
  return isFinite(best) ? best : null
}

/** Where "previous stroke" goes from `t`: the end of the last stroke that ended before `t`, else 0. */
export function prevStrokeEnd(tl: Timeline, t: number): number {
  let best = 0
  for (const s of tl.strokes) {
    if (s.base || !s.at.length) continue
    const e = s.at[s.at.length - 1]
    if (e < t - 0.5 && e > best) best = e
  }
  return best
}

/**
 * The bounding box of all ink ever on the timeline (erased or taken back included), normalized
 * [x0, y0, x1, y1], or null when there is none: the replay frames this, so the camera holds still
 * while the page fills.
 */
export function inkBox(tl: Timeline): [number, number, number, number] | null {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const s of tl.strokes) {
    if (isEraser(s)) continue
    for (const p of s.pts) {
      if (p[0] < x0) x0 = p[0]
      if (p[1] < y0) y0 = p[1]
      if (p[0] > x1) x1 = p[0]
      if (p[1] > y1) y1 = p[1]
    }
  }
  return isFinite(x0) ? [x0, y0, x1, y1] : null
}

// ── The scrubber's axis ───────────────────────────────────────────────────────────────────────

/** Idle stretches up to this long keep their length on the compressed axis, ms. */
export const KEEP_IDLE_MS = 1000
/** No idle stretch, however long, takes more than this on the compressed axis, ms. */
export const MAX_IDLE_MS = 2500

/**
 * An idle stretch of `ms` (no pen down anywhere) as it lasts on the compressed axis: short ones
 * unchanged, longer ones growing a tenth as fast past {@link KEEP_IDLE_MS}, capped at
 * {@link MAX_IDLE_MS}. Monotonic, like timelapse.ts compressGap, with a longer keep and cap: a
 * replay is watched, not exported, and a pause should still read as a pause.
 */
export function compressIdle(ms: number): number {
  if (!(ms > 0)) return 0
  if (ms <= KEEP_IDLE_MS) return ms
  return Math.min(MAX_IDLE_MS, KEEP_IDLE_MS + (ms - KEEP_IDLE_MS) * 0.1)
}

/**
 * Timeline ms ↔ axis ms, piecewise linear and monotonic: identity, or with each idle stretch
 * compressed ({@link compressIdle}). The axis runs from 0 to {@link end}.
 */
export class TimeMap {
  /** knots [timeline ms, axis ms], increasing in both */
  private knots: Array<[number, number]>

  constructor(tl: Timeline, compress: boolean) {
    const D = tl.durationMs
    if (!compress) {
      this.knots = [[0, 0], [D, D]]
      return
    }
    // busy intervals (pen down somewhere), merged
    const busy = tl.strokes
      .filter((s) => !s.base && s.at.length)
      .map(span)
      .sort((a, b) => a[0] - b[0])
    const merged: Array<[number, number]> = []
    for (const b of busy) {
      const last = merged[merged.length - 1]
      if (last && b[0] <= last[1]) last[1] = Math.max(last[1], b[1])
      else merged.push([b[0], b[1]])
    }
    const knots: Array<[number, number]> = [[0, 0]]
    let real = 0
    let axis = 0
    for (const [a, b] of merged) {
      if (a > real) {
        axis += compressIdle(a - real)
        real = a
        knots.push([real, axis])
      }
      if (b > real) {
        axis += b - real
        real = b
        knots.push([real, axis])
      }
    }
    if (D > real) knots.push([D, axis + compressIdle(D - real)])
    this.knots = knots
  }

  /** The axis's length, ms. */
  get end(): number {
    return this.knots[this.knots.length - 1][1]
  }

  /** Timeline ms → axis ms (clamped to the axis). */
  toAxis(t: number): number {
    return this.interp(t, 0, 1)
  }

  /** Axis ms → timeline ms (clamped to the timeline). */
  toTime(a: number): number {
    return this.interp(a, 1, 0)
  }

  private interp(v: number, from: 0 | 1, to: 0 | 1): number {
    const k = this.knots
    if (v <= k[0][from]) return k[0][to]
    for (let i = 1; i < k.length; i++) {
      const p = k[i - 1]
      const q = k[i]
      if (v <= q[from]) {
        const w = q[from] - p[from]
        return w > 0 ? p[to] + ((v - p[from]) / w) * (q[to] - p[to]) : q[to]
      }
    }
    return k[k.length - 1][to]
  }
}
