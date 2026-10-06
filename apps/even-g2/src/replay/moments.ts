/**
 * Moments of thought: where, on a page's timeline, the pen says something beyond the ink.
 *
 * ## The problem
 *
 * A replay scrubber over a whole session is a long, featureless bar. What a writer (or a coach
 * looking over a learner's attempt) wants to find on it are the moments where thinking showed:
 * the long pause before a step, the line erased and written again, the stroke drawn at half the
 * usual speed, the passage that flowed, and where someone else (a peer, the agent) came in. The
 * roadmap (docs/roadmap.md, item 2) asks for these as markers; the Primer (ADR 010) reads the same
 * evidence for its learner model (src/codrawer_bridge/primer/ink_signals.py, `LineSignals`), and
 * {@link MomentsSummary} is shaped so it can consume this module's output later.
 *
 * ## Facts it rests on
 *
 * - Strokes come from replay/timeline.ts on one clock (timeline ms), in drawing order; offsets
 *   inside one stroke are real (one clock), so a stroke's speed is real. Saved-page strokes have
 *   no times: they are ink an eraser can cut, but no evidence of timing.
 * - Speeds are in page widths per second, with y scaled by the page's 4:3 aspect so both axes use
 *   the same unit (ink_signals.py `InkStroke.length`, Paper Pro 1620 × 2160 page px).
 * - The eraser removes the tablet's own earlier ink within `5 × thickness` page px of its path
 *   plus the ink's half width (erase.ts; {@link DEFAULT_ERASE_RADIUS}). Only `user` ink is cut.
 * - Writing research reads pauses as planning and difficulty, relative to the writer's own rhythm
 *   (Wengelin 2006; Alamargot et al. 2006; cited in ink_signals.py). The thresholds here are
 *   starting values in the Primer's spirit (its 4 s absolute pause, its "under 70 % of the median
 *   speed"), to be calibrated per writer, not results from that literature.
 *
 * ## The heuristics (all thresholds exported, all times ms)
 *
 * - **pause**: pen up between two of one writer's pen-downs for at least the writer's threshold,
 *   {@link PAUSE_FACTOR} × their median gap, kept within [{@link PAUSE_FLOOR_MS},
 *   {@link PAUSE_ALWAYS_MS}] (a pause of 4 s or more always counts, as in the Primer). A writer
 *   with fewer than {@link MIN_BASELINE} gaps gets {@link PAUSE_ALWAYS_MS}.
 * - **erase**: an eraser stroke that cut ink (which strokes, how many points), or strokes taken
 *   back (`stroke_delete`, a clear) at one moment. Erasures of one writer less than
 *   {@link MERGE_MS} apart are one moment.
 * - **rewrite**: ink drawn over or near (within {@link REWRITE_PAD} of) the region just erased,
 *   starting within {@link REWRITE_WINDOW_MS} after the erasure.
 * - **hesitation**: a stroke drawn at under {@link HESITATION_RATIO} of the writer's median stroke
 *   speed (strokes long and slow enough to measure, a baseline of at least {@link MIN_BASELINE});
 *   consecutive slow strokes are one moment.
 * - **burst**: a run of at least {@link BURST_MIN_STROKES} strokes without a break (gaps under
 *   {@link RUN_GAP_FACTOR} × the median gap, and under the pause threshold) whose ink rate is at
 *   least {@link BURST_RATIO} × the writer's median run rate.
 * - **contribution**: ink by anyone other than the page's primary writer (the tablet's user when
 *   there is one): a peer or the agent, one moment per run (split at {@link CONTRIB_GAP_MS}).
 *
 * Pauses, hesitations, bursts and rewrites are read for human writers (the tablet, peers), not
 * the agent, whose timing is a simulated hand's (packages/hand).
 *
 * Pure: no DOM, no configuration (test/moments.test.ts).
 */
import { DEFAULT_ERASE_RADIUS, halfWidth, PAGE_H, PAGE_W, type Box } from '../erase'
import { isEraser, span, writerOf, type ReplayStroke, type Timeline } from './timeline'

// ── Thresholds ────────────────────────────────────────────────────────────────────────────────

/** A pause counts at this many times the writer's median gap between pen-downs… */
export const PAUSE_FACTOR = 4
/** …but never under this, ms… */
export const PAUSE_FLOOR_MS = 2000
/** …and always from this, ms (the Primer's absolute pause term, ink_signals.py). */
export const PAUSE_ALWAYS_MS = 4000
/** Gaps or measurable strokes needed before a writer's own rhythm is trusted. */
export const MIN_BASELINE = 5
/** A stroke slower than this fraction of the writer's median speed is a hesitation. */
export const HESITATION_RATIO = 0.5
/** Strokes shorter than this (page widths, ~1.8 mm) or quicker than {@link MIN_MEASURE_MS} are not measured for speed. */
export const MIN_LENGTH = 0.01
export const MIN_MEASURE_MS = 80
/** A run of writing breaks at a gap of this many times the median gap (and at a pause). */
export const RUN_GAP_FACTOR = 2.5
/** Runs shorter than this many strokes are never bursts. */
export const BURST_MIN_STROKES = 4
/** A run whose ink rate is at least this many times the writer's median run rate is a burst. */
export const BURST_RATIO = 1.5
/** Ink drawn this close to an erased region (page widths/heights) rewrites it. */
export const REWRITE_PAD = 0.03
/** …if it starts within this long after the erasure, ms. */
export const REWRITE_WINDOW_MS = 60_000
/** Erasures of one writer closer than this are one moment, ms. */
export const MERGE_MS = 2000
/** Another writer's run of strokes breaks at a gap this long, ms. */
export const CONTRIB_GAP_MS = 3000

// ── What it returns ───────────────────────────────────────────────────────────────────────────

export type MomentKind = 'pause' | 'erase' | 'rewrite' | 'hesitation' | 'burst' | 'contribution'

/** One marker on the timeline. */
export interface Moment {
  kind: MomentKind
  /** timeline ms where it begins (a pause: the pen lifting; the others: their first stroke) */
  t: number
  /** timeline ms where it ends (≥ t) */
  end: number
  /** who: timeline.ts {@link writerOf} (`user`, `peer:<author>`, `ai:<author>`) */
  writer: string
  /** the strokes it concerns (an erasure: the eraser strokes and what they cut or took back) */
  strokeIds: string[]
  /** a short caption, e.g. "Pause · 6.2 s" */
  label: string
  /** 0..1, how marked it is (for drawing; 1 = as strong as it gets) */
  strength: number
  /** where on the page (normalized [x0, y0, x1, y1]) */
  box?: Box
}

/** A writer's own rhythm: the baselines the moments are relative to. */
export interface WriterRhythm {
  writer: string
  /** strokes with times (erasers included) */
  strokes: number
  /** median pen-up gap between pen-downs, ms (null: fewer than two strokes) */
  medianGapMs: number | null
  /** the pause threshold this writer got, ms */
  pauseThresholdMs: number
  /** median stroke speed, page widths per second (null: too few measurable strokes) */
  medianSpeed: number | null
  /** time with the pen down, ms */
  penDownMs: number
}

/**
 * The page's moments in numbers, for whatever reads ink as evidence (the Primer's learner model
 * and policy, a coach's report). Times in ms on the timeline's clock.
 */
export interface MomentsSummary {
  /** the timeline's length, ms */
  durationMs: number
  /** the primary writer (null: no timed ink) */
  primary: string | null
  writers: WriterRhythm[]
  counts: Record<MomentKind, number>
  /** the longest pause by a human writer, ms (0: none) */
  longestPauseMs: number
  /** the marked pauses added up, ms */
  pausedMs: number
  /** strokes the eraser cut into (wholly or in part), and points it removed */
  strokesErased: number
  pointsErased: number
  /** strokes taken back (stroke_delete, clear) */
  strokesTakenBack: number
  /** strokes written over erased ink */
  rewriteStrokes: number
  /** strokes drawn hesitantly */
  hesitantStrokes: number
  /** strokes inside bursts */
  burstStrokes: number
  /** strokes by writers other than the primary */
  contributedStrokes: number
}

export interface MomentsResult {
  /** sorted by t */
  moments: Moment[]
  summary: MomentsSummary
}

// ── Geometry and statistics ───────────────────────────────────────────────────────────────────

/** Page height over width: one unit of normalized y is 4/3 of one of x (ink_signals.py). */
const H_OVER_W = PAGE_H / PAGE_W

/** A stroke's path length in page widths (y scaled by the page aspect). */
export function strokeLength(pts: number[][]): number {
  let total = 0
  for (let i = 1; i < pts.length; i++) total += Math.hypot(pts[i][0] - pts[i - 1][0], (pts[i][1] - pts[i - 1][1]) * H_OVER_W)
  return total
}

/** The median of `xs` (null when empty). */
export function median(xs: readonly number[]): number | null {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

function boxOf(pts: number[][], keep?: (i: number) => boolean): Box | null {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  pts.forEach((p, i) => {
    if (keep && !keep(i)) return
    x0 = Math.min(x0, p[0])
    y0 = Math.min(y0, p[1])
    x1 = Math.max(x1, p[0])
    y1 = Math.max(y1, p[1])
  })
  return isFinite(x0) ? [x0, y0, x1, y1] : null
}

function union(a: Box | null | undefined, b: Box | null | undefined): Box | undefined {
  if (!a) return b ?? undefined
  if (!b) return a
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])]
}

function overlaps(a: Box, b: Box, pad = 0): boolean {
  return !(a[2] + pad < b[0] || b[2] + pad < a[0] || a[3] + pad < b[1] || b[3] + pad < a[1])
}

/** Squared distance, page px, from (px, py) to segment a–b (all page px). */
function segDist2(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax
  const dy = by - ay
  const L = dx * dx + dy * dy
  const k = L > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L)) : 0
  const x = ax + k * dx - px
  const y = ay + k * dy - py
  return x * x + y * y
}

const secs = (ms: number) => (ms >= 10_000 ? `${Math.round(ms / 1000)} s` : `${(ms / 1000).toFixed(1)} s`)
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`

/** A writer's name for captions: "you" is not known here, so the tablet is "Tablet". */
export function writerName(writer: string): string {
  if (writer === 'user') return 'Tablet'
  const [layer, ...rest] = writer.split(':')
  const who = rest.join(':')
  if (layer === 'ai') return who && who !== 'ai' ? `Agent (${who})` : 'Agent'
  return who && who !== 'peer' ? who : 'A peer'
}

// ── The moments ───────────────────────────────────────────────────────────────────────────────

interface Timed {
  s: ReplayStroke
  i: number // index in the timeline
  t0: number
  t1: number
}

/**
 * Which ink each eraser stroke cut, as the tablet cuts it (erase.ts): points of earlier `user`
 * ink within the eraser's radius plus the ink's half width of its path, taken in drawing order,
 * each point at most once. Returns per eraser index: the strokes cut and the points removed.
 */
export function eraserCuts(tl: Timeline, radius = DEFAULT_ERASE_RADIUS): Map<number, { ids: string[]; points: number; box: Box | null }> {
  const out = new Map<number, { ids: string[]; points: number; box: Box | null }>()
  const gone = tl.strokes.map((s) => new Uint8Array(s.pts.length))
  const boxes = tl.strokes.map((s) => boxOf(s.pts))
  tl.strokes.forEach((e, ei) => {
    if (e.base || e.layer !== 'user' || !isEraser(e) || e.pts.length === 0) return
    const eStart = e.at[0]
    const reach = (radius + 8) / PAGE_W // the widest ink's half width beyond the radius
    const eb = boxes[ei]!
    const ids: string[] = []
    let points = 0
    let box: Box | null = null
    for (let si = 0; si < ei; si++) {
      const s = tl.strokes[si]
      if (s.layer !== 'user' || isEraser(s) || !boxes[si]) continue
      if (s.removedAt !== undefined && s.removedAt <= eStart) continue
      if (!overlaps(boxes[si]!, eb, reach * H_OVER_W)) continue
      const g = gone[si]
      let cut = 0
      for (let j = 0; j < s.pts.length; j++) {
        if (g[j]) continue
        const p = s.pts[j]
        const px = p[0] * PAGE_W
        const py = p[1] * PAGE_H
        const r = radius + halfWidth(p)
        const r2 = r * r
        for (let k = 0; k < e.pts.length; k++) {
          const a = e.pts[k > 0 ? k - 1 : 0]
          const b = e.pts[k]
          if (segDist2(px, py, a[0] * PAGE_W, a[1] * PAGE_H, b[0] * PAGE_W, b[1] * PAGE_H) <= r2) {
            g[j] = 1
            cut++
            box = union(box, [p[0], p[1], p[0], p[1]]) ?? null
            break
          }
        }
      }
      if (cut) {
        ids.push(s.id)
        points += cut
      }
    }
    out.set(ei, { ids, points, box })
  })
  return out
}

/** Options: the eraser's radius (page px), when the live store's differs from the default. */
export interface MomentOptions {
  eraseRadius: number
}

/** Find the moments of thought on a timeline (see the module comment for the heuristics). */
export function findMoments(tl: Timeline, opts: Partial<MomentOptions> = {}): MomentsResult {
  const moments: Moment[] = []
  const timed: Timed[] = []
  tl.strokes.forEach((s, i) => {
    if (s.base || s.at.length === 0) return
    const [t0, t1] = span(s)
    timed.push({ s, i, t0, t1 })
  })

  // writers, in order of first appearance
  const byWriter = new Map<string, Timed[]>()
  for (const x of timed) {
    const w = writerOf(x.s)
    if (!byWriter.has(w)) byWriter.set(w, [])
    byWriter.get(w)!.push(x)
  }
  const hasUser = byWriter.has('user') || tl.strokes.some((s) => s.base && s.layer === 'user')
  let primary: string | null = hasUser ? 'user' : null
  if (!primary) {
    let most = -1
    for (const [w, xs] of byWriter) {
      const n = xs.reduce((a, x) => a + x.s.pts.length, 0)
      if (!w.startsWith('ai:') && n > most) {
        most = n
        primary = w
      }
    }
    if (!primary && byWriter.size) primary = [...byWriter.keys()][0]
  }

  const rhythms: WriterRhythm[] = []
  let longestPauseMs = 0
  let pausedMs = 0
  let hesitantStrokes = 0
  let burstStrokes = 0
  const thresholds = new Map<string, number>()

  for (const [writer, xs] of byWriter) {
    const human = !writer.startsWith('ai:')
    // gaps: pen up between one pen-down's end and the next's start (overlaps are no gap)
    const gaps: { a: number; b: number; next: number }[] = []
    let busy = -Infinity
    xs.forEach((x, k) => {
      if (k > 0 && x.t0 > busy) gaps.push({ a: busy, b: x.t0, next: k })
      busy = Math.max(busy, x.t1)
    })
    const medGap = median(gaps.map((g) => g.b - g.a))
    const threshold = medGap !== null && gaps.length >= MIN_BASELINE ? Math.min(PAUSE_ALWAYS_MS, Math.max(PAUSE_FLOOR_MS, PAUSE_FACTOR * medGap)) : PAUSE_ALWAYS_MS
    thresholds.set(writer, threshold)

    // speeds of the strokes long and slow enough to measure
    const speeds = new Map<number, number>()
    for (const x of xs) {
      if (isEraser(x.s) || x.s.pts.length < 3) continue
      const dur = x.t1 - x.t0
      const len = strokeLength(x.s.pts)
      if (dur >= MIN_MEASURE_MS && len >= MIN_LENGTH) speeds.set(x.i, len / (dur / 1000))
    }
    const medSpeed = speeds.size >= MIN_BASELINE ? median([...speeds.values()]) : null
    rhythms.push({ writer, strokes: xs.length, medianGapMs: medGap, pauseThresholdMs: threshold, medianSpeed: medSpeed, penDownMs: xs.reduce((a, x) => a + (x.t1 - x.t0), 0) })
    if (!human) continue

    // pauses
    for (const g of gaps) {
      const d = g.b - g.a
      if (d < threshold) continue
      longestPauseMs = Math.max(longestPauseMs, d)
      pausedMs += d
      moments.push({ kind: 'pause', t: g.a, end: g.b, writer, strokeIds: [xs[g.next].s.id], label: `Pause · ${secs(d)}`, strength: Math.min(1, 0.35 + 0.65 * Math.log2(d / threshold) / 3), box: boxOf(xs[g.next].s.pts) ?? undefined })
    }

    // hesitations: consecutive slow strokes, one moment
    if (medSpeed) {
      let run: Timed[] = []
      const flush = () => {
        if (!run.length) return
        const ratio = median(run.map((x) => speeds.get(x.i)! / medSpeed))!
        hesitantStrokes += run.length
        moments.push({
          kind: 'hesitation',
          t: run[0].t0,
          end: run[run.length - 1].t1,
          writer,
          strokeIds: run.map((x) => x.s.id),
          label: run.length === 1 ? `Slow stroke · ${ratio.toFixed(2)}× usual speed` : `Slow writing · ${run.length} strokes at ${ratio.toFixed(2)}×`,
          strength: Math.min(1, 0.4 + (HESITATION_RATIO - ratio) * 1.5),
          box: run.reduce<Box | undefined>((b, x) => union(b, boxOf(x.s.pts)), undefined),
        })
        run = []
      }
      let prevEnd = -Infinity
      for (const x of xs) {
        const v = speeds.get(x.i)
        if (v === undefined) continue // unmeasured strokes neither start nor break a run
        const slow = v < HESITATION_RATIO * medSpeed
        if (slow && run.length && x.t0 - prevEnd >= threshold) flush()
        if (slow) run.push(x)
        else flush()
        prevEnd = x.t1
      }
      flush()
    }

    // bursts: runs of writing without a break, at a high ink rate
    if (medGap !== null) {
      const breakAt = Math.min(threshold, Math.max(400, RUN_GAP_FACTOR * medGap))
      const runs: Timed[][] = []
      let cur: Timed[] = []
      let end = -Infinity
      for (const x of xs) {
        if (isEraser(x.s)) {
          if (cur.length) runs.push(cur)
          cur = []
          end = x.t1
          continue
        }
        if (cur.length && x.t0 - end >= breakAt) {
          runs.push(cur)
          cur = []
        }
        cur.push(x)
        end = Math.max(end, x.t1)
      }
      if (cur.length) runs.push(cur)
      const rate = (r: Timed[]) => {
        const dur = Math.max(1, r[r.length - 1].t1 - r[0].t0)
        return r.reduce((a, x) => a + strokeLength(x.s.pts), 0) / (dur / 1000)
      }
      const multi = runs.filter((r) => r.length >= 2)
      const medRate = multi.length >= 3 ? median(multi.map(rate)) : null
      if (medRate) {
        for (const r of runs) {
          if (r.length < BURST_MIN_STROKES) continue
          const k = rate(r) / medRate
          if (k < BURST_RATIO) continue
          burstStrokes += r.length
          moments.push({
            kind: 'burst',
            t: r[0].t0,
            end: r[r.length - 1].t1,
            writer,
            strokeIds: r.map((x) => x.s.id),
            label: `Fluent burst · ${plural(r.length, 'stroke')} at ${k.toFixed(1)}×`,
            strength: Math.min(1, 0.4 + (k - BURST_RATIO) * 0.4),
            box: r.reduce<Box | undefined>((b, x) => union(b, boxOf(x.s.pts)), undefined),
          })
        }
      }
    }
  }

  // erasures: eraser strokes that cut, and strokes taken back
  const cuts = eraserCuts(tl, opts.eraseRadius)
  const erases: Moment[] = []
  let strokesErased = 0
  let pointsErased = 0
  const erasedIds = new Set<string>()
  for (const [ei, c] of cuts) {
    if (!c.ids.length) continue
    const e = tl.strokes[ei]
    const [t0, t1] = span(e)
    pointsErased += c.points
    for (const id of c.ids) erasedIds.add(id)
    erases.push({ kind: 'erase', t: t0, end: t1, writer: writerOf(e), strokeIds: [e.id, ...c.ids], label: '', strength: 0, box: c.box ?? undefined })
  }
  strokesErased = erasedIds.size
  const takenBack = tl.strokes.filter((s) => s.removedAt !== undefined)
  takenBack.sort((a, b) => a.removedAt! - b.removedAt!)
  for (const s of takenBack) {
    const last = erases[erases.length - 1]
    const box = boxOf(s.pts) ?? undefined
    if (last && last.label === 'taken back' && s.removedAt! - last.end < 500) {
      last.strokeIds.push(s.id)
      last.box = union(last.box, box)
    } else erases.push({ kind: 'erase', t: s.removedAt!, end: s.removedAt!, writer: writerOf(s), strokeIds: [s.id], label: 'taken back', strength: 0, box })
  }
  erases.sort((a, b) => a.t - b.t)
  // one writer's erasures close together are one moment
  const merged: Moment[] = []
  for (const m of erases) {
    const last = merged[merged.length - 1]
    if (last && last.writer === m.writer && m.t - last.end < MERGE_MS && (last.label === 'taken back') === (m.label === 'taken back')) {
      last.end = Math.max(last.end, m.end)
      last.strokeIds.push(...m.strokeIds.filter((id) => !last.strokeIds.includes(id)))
      last.box = union(last.box, m.box)
    } else merged.push({ ...m, strokeIds: [...m.strokeIds] })
  }
  const eraserIds = new Set(tl.strokes.filter((s) => isEraser(s)).map((s) => s.id))
  for (const m of merged) {
    if (m.label === 'taken back') {
      const n = m.strokeIds.length
      m.label = `Took back ${plural(n, 'stroke')}`
      m.strength = Math.min(1, 0.4 + n * 0.1)
    } else {
      const n = m.strokeIds.filter((id) => !eraserIds.has(id)).length
      m.label = `Erased · ${plural(n, 'stroke')} cut`
      m.strength = Math.min(1, 0.45 + n * 0.1)
    }
    moments.push(m)
  }

  // rewrites: new ink over or near what was just erased
  let rewriteStrokes = 0
  for (const m of merged) {
    if (!m.box) continue
    const near = timed.filter(
      (x) => !isEraser(x.s) && x.t0 >= m.end && x.t0 <= m.end + REWRITE_WINDOW_MS && (m.label.startsWith('Took') || writerOf(x.s) === m.writer) && !m.strokeIds.includes(x.s.id) && overlaps(boxOf(x.s.pts)!, m.box!, REWRITE_PAD),
    )
    if (!near.length) continue
    // the rewrite is the first stretch of such ink, until a pause by its writer
    const writer = writerOf(near[0].s)
    const limit = thresholds.get(writer) ?? PAUSE_ALWAYS_MS
    const run = [near[0]]
    for (const x of near.slice(1)) {
      if (x.t0 - run[run.length - 1].t1 >= limit) break
      run.push(x)
    }
    rewriteStrokes += run.length
    moments.push({
      kind: 'rewrite',
      t: run[0].t0,
      end: run[run.length - 1].t1,
      writer,
      strokeIds: run.map((x) => x.s.id),
      label: `Rewrote after erasing · ${plural(run.length, 'stroke')}`,
      strength: Math.min(1, 0.45 + run.length * 0.05),
      box: run.reduce<Box | undefined>((b, x) => union(b, boxOf(x.s.pts)), undefined),
    })
  }

  // contributions: anyone else's ink, one moment per run
  let contributedStrokes = 0
  for (const [writer, xs] of byWriter) {
    if (writer === primary) continue
    let run: Timed[] = []
    const flush = () => {
      if (!run.length) return
      contributedStrokes += run.length
      moments.push({
        kind: 'contribution',
        t: run[0].t0,
        end: run[run.length - 1].t1,
        writer,
        strokeIds: run.map((x) => x.s.id),
        label: `${writerName(writer)} ${writer.startsWith('ai:') ? 'wrote' : 'drew'} · ${plural(run.length, 'stroke')}`,
        strength: Math.min(1, 0.5 + run.length * 0.02),
        box: run.reduce<Box | undefined>((b, x) => union(b, boxOf(x.s.pts)), undefined),
      })
      run = []
    }
    for (const x of xs) {
      if (run.length && x.t0 - run[run.length - 1].t1 >= CONTRIB_GAP_MS) flush()
      run.push(x)
    }
    flush()
  }

  moments.sort((a, b) => a.t - b.t || a.end - b.end)
  const counts: Record<MomentKind, number> = { pause: 0, erase: 0, rewrite: 0, hesitation: 0, burst: 0, contribution: 0 }
  for (const m of moments) counts[m.kind]++
  return {
    moments,
    summary: {
      durationMs: tl.durationMs,
      primary,
      writers: rhythms,
      counts,
      longestPauseMs,
      pausedMs,
      strokesErased,
      pointsErased,
      strokesTakenBack: takenBack.length,
      rewriteStrokes,
      hesitantStrokes,
      burstStrokes,
      contributedStrokes,
    },
  }
}
