/**
 * The personal mark recogniser: few-shot, open-set, shape and context.
 *
 * Input: a gesture the built-in grammar did not claim (grammar.ts), as strokes in page mm, with
 * its context (context.ts). Output: one of the user's marks with a confidence, `ambiguous` between
 * two of them, or `none`. `none` is the common answer and the important one: most ink on a page is
 * writing and drawing, and a recogniser that maps every gesture to its nearest mark would fire on
 * every letter. So recognition is **open-set**: a gesture must pass every gate and come within
 * its mark's own thresholds, in two representations, or it is not a mark.
 *
 * The steps, cheapest first:
 *
 * 1. **Gates** per mark, from its examples. A gesture is compared only with marks whose
 *    - stroke count it matches, allowing one stroke more than the examples' most (a pen lifted
 *      mid-glyph) and none fewer than their least;
 *    - size is within ×{@link SIZE_RATIO} of the examples' median (marks are drawn at a steady
 *      size; letters are smaller and words wider);
 *    - aspect ratio is within ×{@link ASPECT_RATIO} of theirs (skipped for orientation-free marks);
 *    - relation to the page is not `inline` (between words of a line of writing), unless the mark
 *      was taught inline. This gate removes almost every letter and word (context.ts).
 * 2. **Shape**: the $P distance (cloud.ts), with rotation search, to each example; a mark's
 *    distance is its nearest example's.
 * 3. **Open-set threshold** per mark, τ. With one example, τ is {@link TAU_ONE}. With more, it is
 *    {@link TAU_K} times the largest leave-one-out distance among the examples (how far apart the
 *    user's own drawings of it are), clamped to [{@link TAU_MIN}, {@link TAU_MAX}]: a mark the user
 *    draws consistently gets a tight threshold, a loose one a looser threshold, never unbounded.
 * 4. **Ambiguity**: when the runner-up mark is also within its threshold and within
 *    {@link AMBIGUITY} of the winner's distance, the answer is `ambiguous`, never a guess (the same
 *    rule as packages/delegate's marks: an unsure reading is asked about, not acted on).
 * 5. **Second opinion, on the path**: dynamic time warping (packages/delegate's `dtw`) between the
 *    gesture's path and the winner's examples, at the rotation $P found, over every order and
 *    direction of its strokes. A point cloud forgets how the ink was laid down; the path keeps it.
 *    A word can scatter its points like a star while its path wanders quite differently, so the
 *    winner must also come within its path threshold, set like τ (from {@link DTW_ONE}, or
 *    {@link DTW_K} × the examples' leave-one-out path distances, clamped). Trying every
 *    articulation keeps the freedom $P exists for: redrawing a glyph's strokes in another order.
 * 6. **Negatives**: occurrences the user rejected or undid are kept with the mark (registry.ts).
 *    A gesture nearer to one of them than to every example is not the mark: "closer to something
 *    you said was not this". Rejection is how a mark learns its boundary with the user's own
 *    handwriting (a lemniscate mark and a cursive "on" are close in both representations).
 * 7. **Context prior**: each mark keeps counts of the relations it was taught and accepted in; a
 *    relation it has never been seen in costs up to {@link CONTEXT_WEIGHT} of the confidence.
 *
 * The confidence of a match is the mean of how far inside its two thresholds it fell (each 0.5 at
 * the threshold, 1 on an example), times the context factor.
 *
 * The constants were set on synthetic marks from packages/hand's personas (test/evaluate.ts;
 * `pnpm --filter marks eval` prints precision and recall). They are a starting point: real-ink
 * tuning on the Paper Pro is pending, as it is for packages/delegate's grammar.
 */

import { type Pt, dtw, pathLength, resample } from 'delegate'
import { type Cloud, ROTATION_DEG, rotationMatch, toCloud } from './cloud'
import { type Context, type Relation, RELATIONS } from './context'

/** τ for a mark taught from one example: mean matched-point distance, in glyph sizes. */
export const TAU_ONE = 0.085
/** τ bounds for marks with several examples. */
export const TAU_MIN = 0.06
export const TAU_MAX = 0.1
/** τ = TAU_K × the largest leave-one-out example distance. */
export const TAU_K = 1.5
/** The path threshold for one example, DTW mean point distance in glyph sizes, and its bounds. */
export const DTW_ONE = 0.09
export const DTW_MIN = 0.06
export const DTW_MAX = 0.11
export const DTW_K = 1.5
/** A gesture is compared only with marks drawn within this size factor. */
export const SIZE_RATIO = 1.6
/** … and this aspect-ratio factor. */
export const ASPECT_RATIO = 1.9
/** The runner-up within this fraction of the winner's distance makes the reading ambiguous. */
export const AMBIGUITY = 0.85
/** The most a never-seen context costs, as a fraction of the confidence. */
export const CONTEXT_WEIGHT = 0.3

/** One example of a mark, as the recogniser needs it. */
export interface Example {
  /** strokes in page mm, drawing order */
  strokes: Pt[][]
  /** the relation it was drawn in, when known */
  relation?: Relation
}

/** A mark as the recogniser sees it: its id, examples and tolerances. */
export interface MarkShape {
  id: string
  examples: Example[]
  /** rotation tolerance, degrees either way (180 = any orientation) */
  rotation?: number
  /** extra relation counts from accepted invocations (registry.ts) */
  relations?: Partial<Record<Relation, number>>
  /** occurrences the user said were not this mark */
  negatives?: Example[]
}

interface Template {
  cloud: Cloud
  /** the example's strokes (mm) and its path in drawing order, normalised like its cloud */
  strokes: Pt[][]
  seq: Pt[]
}

/** A mark compiled for matching. */
export interface Model {
  id: string
  templates: Template[]
  rotation: number
  /** shape threshold ($P mean point distance) and path threshold (DTW), glyph sizes */
  tau: number
  pathTau: number
  /** median size (mm) and aspect of the examples, and their stroke-count range */
  size: number
  aspect: number
  strokes: [number, number]
  relations: Record<Relation, number>
  negatives: Cloud[]
}

export type Recognition =
  | { kind: 'match'; mark: string; distance: number; tau: number; path: number; pathTau: number; confidence: number; second?: { mark: string; distance: number }; why: string }
  | { kind: 'ambiguous'; marks: [string, string]; distances: [number, number]; why: string }
  | { kind: 'none'; nearest?: { mark: string; distance: number; tau: number }; why: string }

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2
}

// --- the path, for the second opinion ------------------------------------------------------------

/** Points in a path sequence. */
const SEQ_N = 40

/**
 * Strokes as one sequence of about {@link SEQ_N} points along the inked path (pen-ups jump),
 * centred on the centroid, scaled so the larger side is 1, and rotated by `theta`: the cloud's frame.
 */
function sequence(strokes: Pt[][], theta = 0): Pt[] {
  const all = strokes.flat()
  const xs = all.map((p) => p[0]), ys = all.map((p) => p[1])
  const size = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), 0.5)
  const total = strokes.reduce((a, s) => a + Math.max(pathLength(s), 0.05), 0)
  const seq: Pt[] = []
  for (const s of strokes) {
    const L = Math.max(pathLength(s), 0.05)
    const k = Math.max(2, Math.round((SEQ_N * L) / total))
    seq.push(...(s.length > 1 ? resample(s, Math.max(L / (k - 1), 0.02)) : [s[0], s[0]]))
  }
  const cx = seq.reduce((a, p) => a + p[0], 0) / seq.length, cy = seq.reduce((a, p) => a + p[1], 0) / seq.length
  const c = Math.cos(theta), sn = Math.sin(theta)
  return seq.map(([x, y]) => { const u = (x - cx) / size, v = (y - cy) / size; return [u * c - v * sn, u * sn + v * c] as Pt })
}

/**
 * The gesture's possible articulations: every order and direction of its strokes (up to three
 * strokes; beyond that, as drawn and reversed).
 */
function articulations(strokes: Pt[][]): Pt[][][] {
  if (strokes.length > 3) return [strokes, [...strokes].reverse().map((s) => [...s].reverse())]
  const perms = (xs: number[]): number[][] => (xs.length <= 1 ? [xs] : xs.flatMap((x, i) => perms([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p])))
  const out: Pt[][][] = []
  for (const order of perms(strokes.map((_, i) => i)))
    for (let mask = 0; mask < 1 << strokes.length; mask++)
      out.push(order.map((i, j) => ((mask >> j) & 1 ? [...strokes[i]].reverse() : strokes[i])))
  return out
}

/**
 * The least DTW distance (delegate's `dtw`: mean point distance, glyph sizes) from any
 * articulation of `strokes`, turned by `theta` radians, to the path `seq`.
 */
export function pathDistance(strokes: Pt[][], seq: Pt[], theta = 0): number {
  let best = Infinity
  for (const a of articulations(strokes)) best = Math.min(best, dtw(sequence(a, theta), seq))
  return best
}

// --- compiling a mark ----------------------------------------------------------------------------

/** k × the largest leave-one-out distance, clamped; `one` with a single example. */
function threshold(loo: number[], one: number, k: number, lo: number, hi: number): number {
  return loo.length < 2 ? one : Math.min(hi, Math.max(lo, k * Math.max(...loo)))
}

/** Compile a mark: normalise its examples and derive its gates and thresholds. */
export function compile(m: MarkShape): Model {
  const templates: Template[] = m.examples.map((e) => ({ cloud: toCloud(e.strokes), strokes: e.strokes, seq: sequence(e.strokes) }))
  const rotation = m.rotation ?? ROTATION_DEG
  const others = (i: number) => templates.filter((_, j) => j !== i)
  const shapeLoo = templates.length < 2 ? [] : templates.map((t, i) => Math.min(...others(i).map((u) => rotationMatch(t.cloud.pts, u.cloud.pts, rotation).d)))
  const pathLoo = templates.length < 2 ? [] : templates.map((t, i) => Math.min(...others(i).map((u) => pathDistance(t.strokes, u.seq, rotationMatch(t.cloud.pts, u.cloud.pts, rotation).theta))))
  const relations = Object.fromEntries(RELATIONS.map((r) => [r, 0])) as Record<Relation, number>
  for (const e of m.examples) if (e.relation) relations[e.relation]++
  for (const [r, n] of Object.entries(m.relations ?? {})) relations[r as Relation] += n ?? 0
  const counts = templates.map((t) => t.cloud.strokes)
  return {
    id: m.id,
    templates,
    rotation,
    tau: threshold(shapeLoo, TAU_ONE, TAU_K, TAU_MIN, TAU_MAX),
    pathTau: threshold(pathLoo, DTW_ONE, DTW_K, DTW_MIN, DTW_MAX),
    size: median(templates.map((t) => t.cloud.size)),
    aspect: median(templates.map((t) => t.cloud.aspect)),
    strokes: [Math.min(...counts), Math.max(...counts)],
    relations,
    negatives: (m.negatives ?? []).map((e) => toCloud(e.strokes)),
  }
}

/** Why a gesture cannot be mark `m`, or null if it passes every gate. */
export function gate(m: Model, c: Cloud, ctx?: Context): string | null {
  if (c.strokes < m.strokes[0] || c.strokes > m.strokes[1] + 1) return `${c.strokes} strokes, the mark has ${m.strokes[0] === m.strokes[1] ? m.strokes[0] : m.strokes.join('–')}`
  if (c.size > m.size * SIZE_RATIO || c.size < m.size / SIZE_RATIO) return `${c.size.toFixed(1)} mm, the mark is drawn at ${m.size.toFixed(1)} mm`
  if (m.rotation < 90 && Math.abs(Math.log(c.aspect / m.aspect)) > Math.log(ASPECT_RATIO)) return `aspect ${c.aspect.toFixed(2)}, the mark's is ${m.aspect.toFixed(2)}`
  if (ctx?.relation === 'inline' && m.relations.inline === 0) return 'inside a line of writing'
  return null
}

/** The context factor (0..1] of relation `r` for mark `m`: Laplace-smoothed, relative to its most common relation. */
export function contextFactor(m: Model, r: Relation | undefined): number {
  if (!r) return 1
  const p = (x: number) => x + 0.5
  const best = Math.max(...RELATIONS.map((k) => p(m.relations[k])))
  return 1 - CONTEXT_WEIGHT * (1 - p(m.relations[r]) / best)
}

/** A mark's shape distance to a cloud: its nearest example, with the angle found. */
function distanceTo(m: Model, c: Cloud): { d: number; theta: number; t: Template } {
  let best = { d: Infinity, theta: 0, t: m.templates[0] }
  for (const t of m.templates) {
    const r = rotationMatch(c.pts, t.cloud.pts, m.rotation, Math.min(best.d, m.tau * 2.5))
    if (r.d < best.d) best = { ...r, t }
  }
  return best
}

// --- recognising -----------------------------------------------------------------------------------

/**
 * Recognise `strokes` (page mm, drawing order) among `models`, in context `ctx`. The recogniser
 * is pure and stateless: models come from the registry (registry.ts `models`) via {@link compile}.
 */
export function recognize(strokes: Pt[][], models: Model[], ctx?: Context): Recognition {
  if (!models.length) return { kind: 'none', why: 'no marks taught yet' }
  const c = toCloud(strokes)
  const gated: { m: Model; d: number; theta: number; t: Template }[] = []
  const reasons: string[] = []
  for (const m of models) {
    const why = gate(m, c, ctx)
    if (why) { reasons.push(`${m.id}: ${why}`); continue }
    gated.push({ m, ...distanceTo(m, c) })
  }
  if (!gated.length) return { kind: 'none', why: `no mark's gates pass (${reasons.slice(0, 3).join('; ')})` }
  gated.sort((a, b) => a.d / a.m.tau - b.d / b.m.tau)
  const [top, next] = gated
  if (top.d > top.m.tau)
    return { kind: 'none', nearest: { mark: top.m.id, distance: top.d, tau: top.m.tau }, why: `nearest mark ${top.m.id} at ${top.d.toFixed(3)}, beyond its threshold ${top.m.tau.toFixed(3)}` }
  if (next && next.d <= next.m.tau && top.d / next.d > AMBIGUITY)
    return { kind: 'ambiguous', marks: [top.m.id, next.m.id], distances: [top.d, next.d], why: `${top.m.id} (${top.d.toFixed(3)}) and ${next.m.id} (${next.d.toFixed(3)}) both fit` }

  // a rejected occurrence nearer than every example: not this mark
  for (const n of top.m.negatives) {
    const d = rotationMatch(c.pts, n.pts, top.m.rotation, top.d).d
    if (d < top.d) return { kind: 'none', nearest: { mark: top.m.id, distance: top.d, tau: top.m.tau }, why: `nearer an occurrence you said was not ${top.m.id} (${d.toFixed(3)} < ${top.d.toFixed(3)})` }
  }

  // the second opinion: could the hand have drawn the example's path?
  const path = Math.min(...top.m.templates.map((t) => pathDistance(strokes, t.seq, rotationMatch(c.pts, t.cloud.pts, top.m.rotation).theta)))
  if (path > top.m.pathTau)
    return { kind: 'none', nearest: { mark: top.m.id, distance: top.d, tau: top.m.tau }, why: `the shape fits ${top.m.id} (${top.d.toFixed(3)}) but the path does not (DTW ${path.toFixed(3)} > ${top.m.pathTau.toFixed(3)})` }

  const inside = (d: number, t: number) => 0.5 + 0.5 * Math.max(0, 1 - d / t)
  const ctxF = contextFactor(top.m, ctx?.relation)
  const confidence = ((inside(top.d, top.m.tau) + inside(path, top.m.pathTau)) / 2) * ctxF
  return {
    kind: 'match', mark: top.m.id, distance: top.d, tau: top.m.tau, path, pathTau: top.m.pathTau, confidence,
    second: next ? { mark: next.m.id, distance: next.d } : undefined,
    why: `$P ${top.d.toFixed(3)} ≤ τ ${top.m.tau.toFixed(3)}, path ${path.toFixed(3)} ≤ ${top.m.pathTau.toFixed(3)}${ctx ? `, ${ctx.relation} (×${ctxF.toFixed(2)})` : ''}`,
  }
}

/**
 * Whether two glyphs are the same shape, loosely: the gates (stroke count, size, aspect) of a mark
 * taught from `a`, a $P distance within `shape`, and a path distance within {@link DTW_MAX}. The
 * teach flow uses it to remember shapes it has asked about (teach.ts `SAME_SHAPE`).
 */
export function alike(a: Pt[][], b: Pt[][], shape: number): boolean {
  const m = compile({ id: 'a', examples: [{ strokes: a }] })
  const c = toCloud(b)
  if (gate(m, c)) return false
  const r = rotationMatch(c.pts, m.templates[0].cloud.pts, m.rotation, shape)
  return r.d <= shape && pathDistance(b, m.templates[0].seq, r.theta) <= DTW_MAX
}

/** The least shape distance between two sets of examples (conflict and novelty checks). */
export function crossDistance(a: Pt[][][], b: Pt[][][], rotation = ROTATION_DEG): number {
  let best = Infinity
  for (const x of a) for (const y of b) best = Math.min(best, rotationMatch(toCloud(x).pts, toCloud(y).pts, rotation, best).d)
  return best
}
