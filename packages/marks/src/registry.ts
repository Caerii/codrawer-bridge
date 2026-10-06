/**
 * The registry: every mark, its examples, its meaning, and the history that earned it.
 *
 * "A mark does not arrive with a meaning. It earns one." The registry is where that earning is
 * kept, so it can be inspected: for each mark, the examples it was taught from, its meaning
 * (an action and parameters, actions.ts), when it was created and changed, every time it fired,
 * what the user said each time (accept, reject, undo), and a confidence computed from that record.
 *
 * **Lineage** is the edit history of a mark: an append-only list of entries (create, refine the
 * meaning, add or remove an example, rename, retract, restore, share, unshare, adopt), each with
 * who and when and, for a meaning change, the meaning before and after. Nothing is overwritten,
 * so two things become visible:
 *
 * - **drift**: a mark whose recent occurrences sit farther from its examples than its early ones
 *   did (the hand changed how it draws it), which {@link drift} reports with the suggestion to
 *   add a recent occurrence as an example;
 * - **conflict**: two marks that look alike but mean different things, between collaborators or
 *   within one person's set, which {@link conflicts} reports pairwise with both lineages.
 *
 * **Ownership.** Every mark has an owner (a participant id). A mark recognises only its owner's
 * ink. Sharing makes a mark *visible* to the session, not active for anyone else: a collaborator
 * who likes it adopts it, which makes their own copy (lineage `adopt`, pointing at the original),
 * and from then on the two evolve separately. So a collaborator's meanings stay theirs unless
 * shared, and a shared meaning never changes under anyone who adopted it.
 *
 * **Confidence** is the posterior mean of a Beta(1, 1) prior updated by the accepts and rejects
 * (an undo counts as a reject): (accepts + 1) / (accepts + rejects + 2). It starts at 0.5 and has
 * to be earned. How the confidence and the history decide whether a mark asks, notifies or acts
 * silently is the teach flow's policy (teach.ts).
 *
 * **Storage.** The registry is plain data with a version (`toJSON` / {@link Registry.fromJSON}):
 * one JSON document, kept in the phone's localStorage by the app and in a file by the CLI and
 * tests. JSON rather than SQLite because the registry must run on the phone and in the router's
 * TypeScript tooling alike; a router-side SQLite mirror (with ADR 012's `tasks.sqlite`) can be
 * written from the same data when the broker lands. Examples keep their strokes resampled (at
 * most {@link KEEP_POINTS} points per stroke), which is what the recogniser uses anyway.
 *
 * Times are Unix ms; stroke points are page mm.
 */

import { type Pt, resample, pathLength } from 'delegate'
import { type Meaning, describe } from './actions'
import type { Relation, Zone } from './context'
import { type MarkShape, type Model, compile, crossDistance } from './recognizer'

/** Points kept per stored stroke. */
export const KEEP_POINTS = 48
/** Negatives kept per mark. */
export const MAX_NEGATIVES = 20

export interface StoredExample {
  id: string
  /** strokes, page mm, translated so the example's bounding box starts at 0, 0 */
  strokes: Pt[][]
  relation?: Relation
  zone?: Zone
  at: number
  by: string
  /** how it was given: taught on the phone, an occurrence on the page, a lasso selection */
  source: 'phone' | 'page' | 'lasso' | 'occurrence'
}

export type LineageOp = 'create' | 'refine' | 'add_example' | 'remove_example' | 'add_negative' | 'rename' | 'retract' | 'restore' | 'share' | 'unshare' | 'adopt'

export interface LineageEntry {
  at: number
  by: string
  op: LineageOp
  from?: Meaning
  to?: Meaning
  example?: string
  note?: string
}

export type Verdict = 'accept' | 'reject' | 'undo' | 'expired'

export interface Invocation {
  id: string
  at: number
  /** the meaning as it was when it fired (meanings change; history should not) */
  meaning: Meaning
  mode: 'confirm' | 'notify' | 'silent'
  confidence: number
  /** the recogniser's shape distance (drift is measured on it) */
  distance: number
  relation?: Relation
  page?: string
  strokes: string[]
  /** the occurrence's ink, kept small, so it can become an example */
  ink?: Pt[][]
  verdict?: Verdict
  verdictAt?: number
  via?: string
}

export interface Mark {
  id: string
  owner: string
  name: string
  meaning: Meaning
  examples: StoredExample[]
  /** occurrences the user rejected or undid: what this mark is not (recognizer.ts, step 6) */
  negatives?: StoredExample[]
  /** rotation tolerance, degrees either way (180: any orientation) */
  rotation: number
  createdAt: number
  changedAt: number
  retracted: boolean
  shared: boolean
  adoptedFrom?: { owner: string; mark: string }
  /** set when the built-in grammar wins on cards for this shape (grammar.ts) */
  shadowed?: string
  lineage: LineageEntry[]
  invocations: Invocation[]
}

export interface RegistryData {
  v: 1
  marks: Mark[]
}

/** Small strokes for storage: resampled, translated to the box's corner, rounded to 0.01 mm. */
export function compact(strokes: Pt[][]): Pt[][] {
  const all = strokes.flat()
  const x0 = Math.min(...all.map((p) => p[0])), y0 = Math.min(...all.map((p) => p[1]))
  return strokes.map((s) => {
    const L = pathLength(s)
    const r = L > 0 ? resample(s, Math.max(L / (KEEP_POINTS - 1), 0.05)).slice(0, KEEP_POINTS) : s.slice(0, 1)
    return r.map(([x, y]): Pt => [Math.round((x - x0) * 100) / 100, Math.round((y - y0) * 100) / 100])
  })
}

let seq = 0
const newId = (prefix: string, now: number) => `${prefix}_${now.toString(36)}${(seq++).toString(36)}`

export class Registry {
  marks: Mark[] = []
  private compiled = new Map<string, { key: string; model: Model }>()

  static fromJSON(data: unknown): Registry {
    const r = new Registry()
    const d = data as Partial<RegistryData> | null
    if (d && d.v === 1 && Array.isArray(d.marks)) r.marks = d.marks
    return r
  }

  toJSON(): RegistryData {
    return { v: 1, marks: this.marks }
  }

  get(id: string): Mark | undefined {
    return this.marks.find((m) => m.id === id)
  }

  /** Marks that recognise `owner`'s ink: theirs, not retracted, with examples. */
  active(owner: string): Mark[] {
    return this.marks.filter((m) => m.owner === owner && !m.retracted && m.examples.length > 0)
  }

  /** What `viewer` can see: their own marks, and others' shared ones. */
  visibleTo(viewer: string): Mark[] {
    return this.marks.filter((m) => m.owner === viewer || m.shared)
  }

  /** The compiled models of `owner`'s active marks (cached until a mark changes). */
  models(owner: string): Model[] {
    return this.active(owner).map((m) => {
      // accepted invocations feed the context prior, so they are part of the key
      const key = `${m.changedAt}:${m.invocations.filter((i) => i.verdict === 'accept').length}`
      const c = this.compiled.get(m.id)
      if (c && c.key === key) return c.model
      const model = compile(shapeOf(m))
      this.compiled.set(m.id, { key, model })
      return model
    })
  }

  // --- changes, each appended to the mark's lineage ----------------------------------------------

  create(o: { owner: string; name?: string; meaning: Meaning; examples: Omit<StoredExample, 'id' | 'at' | 'by'>[]; rotation?: number; shadowed?: string; now: number; note?: string }): Mark {
    const m: Mark = {
      id: newId('mk', o.now),
      owner: o.owner,
      name: o.name || describe(o.meaning),
      meaning: o.meaning,
      examples: o.examples.map((e) => ({ ...e, strokes: compact(e.strokes), id: newId('ex', o.now), at: o.now, by: o.owner })),
      rotation: o.rotation ?? 25,
      createdAt: o.now,
      changedAt: o.now,
      retracted: false,
      shared: false,
      shadowed: o.shadowed,
      lineage: [{ at: o.now, by: o.owner, op: 'create', to: o.meaning, note: o.note }],
      invocations: [],
    }
    this.marks.push(m)
    return m
  }

  private touch(m: Mark, e: LineageEntry) {
    m.lineage.push(e)
    m.changedAt = Math.max(e.at, m.changedAt + 1)
  }

  /** Change what a mark means. Only its owner may. */
  refine(id: string, meaning: Meaning, by: string, now: number, note?: string): Mark {
    const m = this.owned(id, by)
    this.touch(m, { at: now, by, op: 'refine', from: m.meaning, to: meaning, note })
    m.meaning = meaning
    return m
  }

  rename(id: string, name: string, by: string, now: number): Mark {
    const m = this.owned(id, by)
    this.touch(m, { at: now, by, op: 'rename', note: `${m.name} → ${name}` })
    m.name = name
    return m
  }

  addExample(id: string, ex: Omit<StoredExample, 'id' | 'at' | 'by'>, by: string, now: number): StoredExample {
    const m = this.owned(id, by)
    const e: StoredExample = { ...ex, strokes: compact(ex.strokes), id: newId('ex', now), at: now, by }
    m.examples.push(e)
    this.touch(m, { at: now, by, op: 'add_example', example: e.id })
    return e
  }

  removeExample(id: string, example: string, by: string, now: number): Mark {
    const m = this.owned(id, by)
    m.examples = m.examples.filter((e) => e.id !== example)
    this.touch(m, { at: now, by, op: 'remove_example', example })
    return m
  }

  /** Retract: the mark stops recognising; its history stays and it can be restored. */
  retract(id: string, by: string, now: number, note?: string): Mark {
    const m = this.owned(id, by)
    m.retracted = true
    this.touch(m, { at: now, by, op: 'retract', note })
    return m
  }

  restore(id: string, by: string, now: number): Mark {
    const m = this.owned(id, by)
    m.retracted = false
    this.touch(m, { at: now, by, op: 'restore' })
    return m
  }

  share(id: string, by: string, now: number, on = true): Mark {
    const m = this.owned(id, by)
    m.shared = on
    this.touch(m, { at: now, by, op: on ? 'share' : 'unshare' })
    return m
  }

  /** Adopt another participant's shared mark: a copy of your own, with lineage pointing at it. */
  adopt(id: string, by: string, now: number): Mark {
    const src = this.get(id)
    if (!src || !src.shared || src.owner === by) throw new Error(`mark ${id} is not shared with ${by}`)
    const m: Mark = {
      ...structuredClone(src),
      id: newId('mk', now),
      owner: by,
      shared: false,
      adoptedFrom: { owner: src.owner, mark: src.id },
      createdAt: now,
      changedAt: now,
      lineage: [{ at: now, by, op: 'adopt', to: src.meaning, note: `from ${src.owner}'s ${src.name}` }],
      invocations: [],
    }
    this.marks.push(m)
    return m
  }

  private owned(id: string, by: string): Mark {
    const m = this.get(id)
    if (!m) throw new Error(`no mark ${id}`)
    if (m.owner !== by) throw new Error(`mark ${id} is ${m.owner}'s; ${by} may adopt it, not change it`)
    return m
  }

  // --- invocations and feedback --------------------------------------------------------------------

  invoke(id: string, inv: Omit<Invocation, 'id'>): Invocation {
    const m = this.get(id)
    if (!m) throw new Error(`no mark ${id}`)
    const out: Invocation = { ...inv, id: newId('iv', inv.at), ink: inv.ink ? compact(inv.ink) : undefined }
    m.invocations.push(out)
    return out
  }

  /**
   * Record the user's verdict on an invocation. A reject or an undo also keeps the occurrence's ink
   * as a negative of the mark (at most {@link MAX_NEGATIVES}, newest kept), so the same misreading
   * does not happen twice. Returns the mark, or undefined for an unknown id.
   */
  feedback(invocation: string, verdict: Verdict, now: number, via?: string): { mark: Mark; inv: Invocation } | undefined {
    for (const m of this.marks) {
      const inv = m.invocations.find((i) => i.id === invocation)
      if (inv) {
        inv.verdict = verdict
        inv.verdictAt = now
        inv.via = via
        if ((verdict === 'reject' || verdict === 'undo') && inv.ink) {
          const e: StoredExample = { id: newId('ng', now), strokes: inv.ink, relation: inv.relation, at: now, by: m.owner, source: 'occurrence' }
          m.negatives = [...(m.negatives ?? []), e].slice(-MAX_NEGATIVES)
          this.touch(m, { at: now, by: m.owner, op: 'add_negative', example: e.id, note: `${verdict} of ${inv.id}` })
        }
        return { mark: m, inv }
      }
    }
    return undefined
  }
}

/** A stored mark as the recogniser's input. */
export function shapeOf(m: Mark): MarkShape {
  const relations: Partial<Record<Relation, number>> = {}
  for (const i of m.invocations) if (i.verdict === 'accept' && i.relation) relations[i.relation] = (relations[i.relation] ?? 0) + 1
  return {
    id: m.id, rotation: m.rotation, relations,
    examples: m.examples.map((e) => ({ strokes: e.strokes, relation: e.relation })),
    negatives: (m.negatives ?? []).map((e) => ({ strokes: e.strokes })),
  }
}

// --- reading the record ------------------------------------------------------------------------------

export interface Stats {
  fired: number
  accepts: number
  rejects: number
  /** Beta(1,1) posterior mean of acceptance */
  confidence: number
  /** accepts and rejects among the last ten verdicts */
  recent: { accepts: number; rejects: number }
  /** invocations since the meaning last changed, and how many of them were accepted */
  sinceChange: number
  acceptsSinceChange: number
  lastAt?: number
}

export function stats(m: Mark): Stats {
  const judged = m.invocations.filter((i) => i.verdict && i.verdict !== 'expired')
  const accepts = judged.filter((i) => i.verdict === 'accept').length
  const rejects = judged.length - accepts
  const last = judged.slice(-10)
  const changed = Math.max(0, ...m.lineage.filter((e) => e.op === 'refine' || e.op === 'create' || e.op === 'adopt' || e.op === 'restore').map((e) => e.at))
  return {
    fired: m.invocations.length,
    accepts,
    rejects,
    confidence: (accepts + 1) / (accepts + rejects + 2),
    recent: { accepts: last.filter((i) => i.verdict === 'accept').length, rejects: last.filter((i) => i.verdict !== 'accept').length },
    sinceChange: m.invocations.filter((i) => i.at >= changed).length,
    acceptsSinceChange: m.invocations.filter((i) => i.at >= changed && i.verdict === 'accept').length,
    lastAt: m.invocations[m.invocations.length - 1]?.at,
  }
}

/**
 * Drift: whether the mark's recent accepted occurrences sit farther from its examples than its
 * early ones did (ratio of mean distances, last five against first five), with the occurrence to
 * add as an example if so. Needs ten accepted occurrences.
 */
export function drift(m: Mark, threshold = 1.4): { drifting: boolean; ratio: number; suggest?: string } | null {
  const ok = m.invocations.filter((i) => i.verdict === 'accept')
  if (ok.length < 10) return null
  const mean = (xs: Invocation[]) => xs.reduce((a, i) => a + i.distance, 0) / xs.length
  const ratio = mean(ok.slice(-5)) / Math.max(mean(ok.slice(0, 5)), 1e-6)
  const far = ok.slice(-5).filter((i) => i.ink).sort((a, b) => b.distance - a.distance)[0]
  return { drifting: ratio > threshold, ratio, suggest: ratio > threshold ? far?.id : undefined }
}

export interface Conflict {
  a: string
  b: string
  owners: [string, string]
  distance: number
  meanings: [string, string]
  /** the same person, two marks that look alike: they will be read as ambiguous */
  within: boolean
}

/**
 * Pairs of visible marks that look alike (shape distance within the looser of their thresholds)
 * but mean different things. Between collaborators this is the "same glyph, different meaning"
 * a shared session must show; within one person it is a pair the recogniser will call ambiguous.
 */
export function conflicts(marks: Mark[]): Conflict[] {
  const live = marks.filter((m) => !m.retracted && m.examples.length)
  const out: Conflict[] = []
  for (let i = 0; i < live.length; i++) for (let j = i + 1; j < live.length; j++) {
    const a = live[i], b = live[j]
    if (describe(a.meaning) === describe(b.meaning)) continue // alike and meaning the same: agreement
    const ta = compile(shapeOf(a)).tau, tb = compile(shapeOf(b)).tau
    const d = crossDistance(a.examples.map((e) => e.strokes), b.examples.map((e) => e.strokes))
    if (d <= Math.max(ta, tb)) out.push({ a: a.id, b: b.id, owners: [a.owner, b.owner], distance: d, meanings: [describe(a.meaning), describe(b.meaning)], within: a.owner === b.owner })
  }
  return out
}
