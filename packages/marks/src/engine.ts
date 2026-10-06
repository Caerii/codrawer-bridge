/**
 * The marks engine: ink in, messages out. It joins the pieces in the order a gesture meets them:
 *
 *     owner's strokes ──gestures (delegate)──▶ settle at a pen-up gap
 *        ──route (grammar.ts)──▶ built-in answer → an ask card answered? → define / decline
 *                              → ordinary drawing → nothing
 *                              → personal ──recognize (recognizer.ts, with context.ts)──▶
 *                                   match     → invoke (registry.ts) in the mode teach.ts allows
 *                                               → mark_invoke (+ its effect, actions.ts)
 *                                   ambiguous → mark_seen ambiguous (nothing runs)
 *                                   none      → TeachFlow.seen → candidate → (lull) mark_ask
 *     mark_define / mark_feedback / mark_query / dock_action "mark_teach" ──handle()──▶ the same
 *
 * **Trailing marks.** People write a line and then, without pausing, add a mark at its end. The
 * gesture grouper (strokes within 900 ms and 8 mm) then folds the mark into the line's gesture. So
 * when a gesture of several strokes is not itself a mark, its last one to three strokes are tried
 * alone, provided they stand apart from the rest (no overlap with the rest's box grown by
 * {@link APART_MM}).
 *
 * **Whose ink.** The engine runs for one owner. It reads every stroke on the page for context and
 * targets, but recognises only the owner's: on the phone host, the tablet's `user` layer and the
 * phone's own pen (apps/even-g2 src/marks/host.ts decides).
 *
 * **Learning from use.** An invocation the user explicitly accepts adds its ink as an example,
 * up to {@link MAX_EXAMPLES}, so a mark taught once grows into its user's range of drawings; one
 * the user rejects or undoes becomes a negative (registry.ts). A new mark that looks like one of
 * the owner's existing marks is refused at teach time with the way out (add it as an example, or
 * retract the other), so a person's own marks are never confusable.
 *
 * **Asks answered by pen.** When an ask is drawn on the page as a card (teach.ts `askCard`, laid
 * out by the client that draws it), the client passes its layout to {@link MarkEngine.showAsk};
 * a circle or tick on an option is then routed as a built-in answer to that card, and becomes a
 * `mark_define` like a tap on the phone would.
 *
 * Pure apart from the `send` callback: no timers, no I/O. The host calls {@link MarkEngine.tick}.
 */

import { type CardLayout, type CardOnPage, type Gesture, type InkStroke, type Pt, type Rect, bounds, gestures, inflate, overlap, toNormalized } from 'delegate'
import { ACTIONS, ASK_OPTIONS, describe, effectOf, withDefaults, type Meaning, type Target } from './actions'
import { contextOf, type InkBox } from './context'
import { route, shadowedOnCards, unteachable } from './grammar'
import type { Box, MarkDefine, MarkFeedback, MarkMessage, AskItem } from './protocol'
import { crossDistance, recognize, TAU_ONE, type Recognition } from './recognizer'
import { type Invocation, Registry, stats } from './registry'
import { CONFIRM_TTL_MS, modeFor, NOT_A_MARK, NOTIFY_TTL_MS, type Occurrence, TeachFlow } from './teach'

/** A mark grows from its accepted uses up to this many examples (and is taught with at most this many). */
export const MAX_EXAMPLES = 5
/** Trailing strokes must stand this far apart from the rest of their gesture, mm. */
export const APART_MM = 1.5
/** The gesture grouper's gap (delegate's default): a gesture settles this long after its last pen-up, ms. */
export const SETTLE_MS = 900

/** A stroke on the page, as the engine needs it. */
export interface PageStroke extends InkStroke {
  author: string
  page?: string
}

export interface EngineOptions {
  owner: string
  send: (m: MarkMessage | Record<string, unknown>) => void
  /** the page size, mm (default: the Paper Pro's) */
  page?: Pt
  registry?: Registry
}

/** What happened to one gesture (returned by {@link MarkEngine.tick} for logs and tests). */
export type Outcome =
  | { gesture: string[]; kind: 'builtin' | 'drawing' | 'invoked' | 'ambiguous' | 'candidate' | 'unknown' | 'answered'; detail: string }

interface Pending {
  inv: Invocation
  mark: string
  mode: 'confirm' | 'notify' | 'silent'
  effect: Record<string, unknown> | null
  at: number
}

let occSeq = 0

export class MarkEngine {
  readonly owner: string
  readonly registry: Registry
  readonly flow = new TeachFlow()
  private send: EngineOptions['send']
  private page?: Pt
  /** every stroke on the page (context and targets) */
  private ink = new Map<string, PageStroke>()
  /** the owner's strokes not yet settled into gestures */
  private buffer: PageStroke[] = []
  private lastInkAt = -Infinity
  private cards: CardOnPage[] = []
  /** ask cards drawn on the page: card task id → ask id and occurrences */
  private askCards = new Map<string, { ask: string; occurrences: string[] }>()
  private pending = new Map<string, Pending>()

  constructor(o: EngineOptions) {
    this.owner = o.owner
    this.send = o.send
    this.page = o.page
    this.registry = o.registry ?? new Registry()
  }

  // --- ink ---------------------------------------------------------------------------------------

  /** A finished stroke on the page, anyone's. The owner's are queued for recognition. */
  stroke(s: PageStroke) {
    this.ink.set(s.id, s)
    if (s.author === this.owner) {
      this.buffer.push(s)
      this.lastInkAt = Math.max(this.lastInkAt, s.t1)
    }
  }

  /** Ink that is context only, never recognised: the saved page, ink from before watching began. */
  see(s: PageStroke) {
    this.ink.set(s.id, s)
  }

  /** Strokes taken back or erased: they are no longer context, targets or pending marks. */
  remove(ids: string[]) {
    for (const id of ids) this.ink.delete(id)
    this.buffer = this.buffer.filter((s) => !ids.includes(s.id))
  }

  /** A new page or a cleared one. */
  clear() {
    this.ink.clear()
    this.buffer = []
    this.askCards.clear()
  }

  /** The task cards on the page (packages/delegate layouts), for built-ins-first routing. */
  setCards(cards: CardOnPage[]) {
    this.cards = cards
  }

  /** An ask drawn on the page as a card: answers to it by pen become definitions. */
  showAsk(ask: string, layout: CardLayout) {
    const a = this.flow.asks.find((x) => x.id === ask)
    if (!a) return
    this.askCards.set(`ask:${ask}`, { ask, occurrences: a.items.map((c) => c.occ.id) })
    this.cards = [...this.cards.filter((c) => c.task !== `ask:${ask}`), { task: `ask:${ask}`, layout }]
  }

  /**
   * Advance to `now` (Unix ms): settle gestures whose last stroke lifted at least SETTLE_MS ago,
   * read them, send what is due (an ask at a lull), and lapse or auto-accept old invocations.
   */
  tick(now: number): Outcome[] {
    const out: Outcome[] = []
    const ready = this.buffer.length && now - Math.max(...this.buffer.map((s) => s.t1)) >= SETTLE_MS
    if (ready) {
      const strokes = this.buffer
      this.buffer = []
      for (const g of gestures(strokes)) out.push(...this.read(g, now))
    }
    const ask = this.flow.due(now, this.lastInkAt)
    if (ask) {
      const items: AskItem[] = ask.items.map((c) => ({
        occurrence: c.occ.id, strokes: c.occ.strokes, page: c.occ.page, bbox: this.norm(c.occ.bbox), ink_mm: relative(c.occ.ink), reason: c.reason, seen: c.seen,
      }))
      this.send({ t: 'mark_ask', ask: ask.id, owner: this.owner, items, options: ASK_OPTIONS, ts: now })
    }
    for (const [id, p] of this.pending) {
      if (p.mode === 'confirm' && now - p.at > CONFIRM_TTL_MS) { this.registry.feedback(id, 'expired', now, 'timeout'); this.pending.delete(id) }
      else if (p.mode === 'notify' && now - p.at > NOTIFY_TTL_MS) { this.registry.feedback(id, 'accept', now, 'timeout'); this.pending.delete(id) }
    }
    return out
  }

  // --- reading one gesture ---------------------------------------------------------------------------

  private read(g: Gesture, now: number): Outcome[] {
    const ids = g.strokes.map((s) => s.id)
    const r = route(g, this.cards)
    if (r.to === 'builtin') {
      const m = r.meaning
      if ('task' in m && this.askCards.has(m.task)) return [this.answerByPen(m, now, ids)]
      return [{ gesture: ids, kind: 'builtin', detail: `${m.kind}${'task' in m ? ` on ${m.task}` : ''}` }]
    }
    if (r.to === 'drawing') return [{ gesture: ids, kind: 'drawing', detail: r.why }]

    const whole = this.recognizeGesture(g.strokes)
    if (whole.rec.kind !== 'none' || g.strokes.length < 2) return [this.act(g.strokes, whole, now)]
    // a mark added at the end of a line without a pause: try the last strokes alone
    for (let k = 1; k <= Math.min(3, g.strokes.length - 1); k++) {
      const tail = g.strokes.slice(-k), rest = g.strokes.slice(0, -k)
      const tb = bounds(tail.flatMap((s) => s.pts)), rb = bounds(rest.flatMap((s) => s.pts))
      if (overlap(inflate(rb, APART_MM), tb) > 0) continue
      const part = this.recognizeGesture(tail)
      if (part.rec.kind === 'match') return [this.act(tail, part, now)]
    }
    return [this.act(g.strokes, whole, now)]
  }

  private recognizeGesture(strokes: InkStroke[]): { rec: Recognition; occ: Occurrence } {
    const own = new Set(strokes.map((s) => s.id))
    const boxes: InkBox[] = [...this.ink.values()].filter((s) => !own.has(s.id)).map((s) => ({ id: s.id, box: bounds(s.pts) }))
    const bbox = bounds(strokes.flatMap((s) => s.pts))
    const ctx = contextOf(bbox, boxes, this.page)
    const ink = strokes.map((s) => s.pts)
    const occ: Occurrence = { id: `oc_${strokes[0].t0.toString(36)}${(occSeq++).toString(36)}`, strokes: [...own], ink, bbox, ctx, page: (strokes[0] as PageStroke).page, at: strokes[0].t0 }
    return { rec: recognize(ink, this.registry.models(this.owner), ctx), occ }
  }

  private act(strokes: InkStroke[], { rec, occ }: { rec: Recognition; occ: Occurrence }, now: number): Outcome {
    const ids = occ.strokes
    if (rec.kind === 'match') return this.invoke(rec, occ, now)
    if (rec.kind === 'ambiguous') {
      this.send({ t: 'mark_seen', occurrence: occ.id, owner: this.owner, strokes: ids, page: occ.page, bbox: this.norm(occ.bbox), result: 'ambiguous', marks: rec.marks, why: rec.why, relation: occ.ctx.relation, ts: now })
      return { gesture: ids, kind: 'ambiguous', detail: rec.why }
    }
    const c = this.flow.seen(occ, now)
    if (c && c.occ === occ) {
      this.send({ t: 'mark_seen', occurrence: occ.id, owner: this.owner, strokes: ids, page: occ.page, bbox: this.norm(occ.bbox), result: 'candidate', reason: c.reason, why: `${c.reason}: ${occ.ctx.relation}, ${occ.ctx.zone}`, relation: occ.ctx.relation, ts: now })
      return { gesture: ids, kind: 'candidate', detail: c.reason }
    }
    if (c) return { gesture: ids, kind: 'candidate', detail: `repeat ${c.seen} of ${c.occ.id}` }
    return { gesture: ids, kind: 'unknown', detail: rec.why }
  }

  private invoke(rec: Extract<Recognition, { kind: 'match' }>, occ: Occurrence, now: number): Outcome {
    const mark = this.registry.get(rec.mark)!
    const { mode, why } = modeFor(stats(mark), rec.confidence, ACTIONS[mark.meaning.action].consequential)
    const target = this.target(occ)
    const inv = this.registry.invoke(mark.id, {
      at: now, meaning: mark.meaning, mode, confidence: rec.confidence, distance: rec.distance, relation: occ.ctx.relation, page: occ.page, strokes: occ.strokes, ink: occ.ink,
    })
    const effect = effectOf(mark.meaning, target, { owner: this.owner, mark: mark.id, invocation: inv.id }, now)
    this.send({
      t: 'mark_invoke', invocation: inv.id, mark: mark.id, owner: this.owner, name: mark.name, meaning: mark.meaning, mode, confidence: rec.confidence,
      why: `${rec.why}; ${why}`, occurrence: { strokes: occ.strokes, bbox: this.norm(occ.bbox), page: occ.page }, target, effect, ts: now,
    })
    if (mode !== 'confirm' && effect) this.send(effect)
    if (mode === 'silent') this.registry.feedback(inv.id, 'accept', now, 'silent')
    else this.pending.set(inv.id, { inv, mark: mark.id, mode, effect, at: now })
    return { gesture: occ.strokes, kind: 'invoked', detail: `${mark.name} (${mode}, ${rec.confidence.toFixed(2)})` }
  }

  /** The ink a mark acts on (context.ts), with its region and first stroke time. */
  private target(occ: Occurrence): Target {
    const ss = occ.ctx.target.map((id) => this.ink.get(id)).filter((s): s is PageStroke => !!s)
    const box = occ.ctx.targetBox
    return {
      page: occ.page,
      strokes: occ.ctx.target,
      region: box ? this.norm(box) : undefined,
      since: ss.length ? Math.min(...ss.map((s) => s.t0)) : undefined,
    }
  }

  private norm(r: Rect): Box {
    const a = toNormalized([r.x0, r.y0], this.page), b = toNormalized([r.x1, r.y1], this.page)
    const q = (v: number) => Math.round(v * 1e4) / 1e4
    return [q(a[0]), q(a[1]), q(b[0]), q(b[1])]
  }

  // --- answers and edits ---------------------------------------------------------------------------------

  /** A circle or tick on an ask card: the option is the meaning, or "not a mark". */
  private answerByPen(m: { kind: string; task?: string; option?: string }, now: number, ids: string[]): Outcome {
    const card = this.askCards.get(m.task!)!
    if (m.kind !== 'choose' || !m.option) return { gesture: ids, kind: 'answered', detail: `${m.kind} on the ask card: no answer` }
    for (const occurrence of card.occurrences) {
      const msg: MarkDefine = m.option === NOT_A_MARK
        ? { t: 'mark_define', op: 'decline', by: this.owner, ask: card.ask, occurrence, ts: now }
        : { t: 'mark_define', op: 'create', by: this.owner, ask: card.ask, occurrence, meaning: withDefaults(m.option as Meaning['action']), note: 'answered by pen on the ask card', ts: now }
      this.handle(msg, now)
      this.send(msg)
    }
    this.askCards.delete(m.task!)
    this.cards = this.cards.filter((c) => c.task !== m.task)
    return { gesture: ids, kind: 'answered', detail: `${m.option} for ${card.occurrences.length} mark(s)` }
  }

  /**
   * A message from any surface: definitions and edits, feedback, queries, and the dock's "Teach a
   * mark" on a lasso selection (strokes resolved by the caller). Returns an error string when the
   * request was refused (unteachable shape, not the owner), else null.
   */
  handle(m: MarkMessage | { t: 'dock_action'; id: string; strokes?: string[] }, now: number): string | null {
    try {
      switch (m.t) {
        case 'mark_define': return this.define(m, now)
        case 'mark_feedback': return this.feedback(m, now)
        case 'mark_query':
          this.send({ t: 'marks', owner: this.owner, marks: this.registry.visibleTo(m.by), ts: now })
          return null
        case 'dock_action': {
          if (m.id !== 'mark_teach' || !m.strokes?.length) return null
          const ss = m.strokes.map((id) => this.ink.get(id)).filter((s): s is PageStroke => !!s)
          if (!ss.length) return 'the selected strokes are not on this page'
          const why = unteachable([ss])
          if (why) return why
          const { occ } = this.recognizeGesture(ss)
          this.flow.lasso(occ, now)
          this.send({ t: 'mark_seen', occurrence: occ.id, owner: this.owner, strokes: occ.strokes, page: occ.page, bbox: this.norm(occ.bbox), result: 'candidate', reason: 'lasso', why: 'selected to teach', ts: now })
          return null
        }
        default: return null
      }
    } catch (e) {
      return e instanceof Error ? e.message : String(e)
    }
  }

  private define(m: MarkDefine, now: number): string | null {
    const by = m.by
    switch (m.op) {
      case 'decline':
        if (m.occurrence) this.flow.settle(m.occurrence, 'declined')
        return null
      case 'create': {
        if (!m.meaning) return 'a definition needs a meaning'
        const c = m.occurrence ? this.flow.find(m.occurrence) : undefined
        const examples = c
          ? [c.occ, ...c.repeats].map((o) => ({ strokes: o.ink, relation: o.ctx.relation, zone: o.ctx.zone, source: (c.reason === 'lasso' ? 'lasso' : 'page') as 'lasso' | 'page' }))
          : (m.examples ?? []).map((s) => ({ strokes: s, source: 'phone' as const }))
        if (!examples.length) return 'a definition needs at least one example'
        const asInk = (s: Pt[][]) => s.map((pts, i) => ({ id: String(i), pts, t0: i, t1: i }))
        const why = unteachable(examples.map((e) => asInk(e.strokes)))
        if (why) return why
        // a mark that would be confused with one of the owner's own is refused, with the way out
        for (const other of this.registry.active(by)) {
          const model = this.registry.models(by).find((x) => x.id === other.id)!
          const d = crossDistance(examples.map((e) => e.strokes), other.examples.map((e) => e.strokes))
          if (d <= Math.max(model.tau, TAU_ONE))
            return `this looks like your mark "${other.name}" (${describe(other.meaning)}); add it as an example of that mark, or retract that one first`
        }
        this.registry.create({ owner: by, name: m.name, meaning: m.meaning, examples: examples.slice(0, MAX_EXAMPLES), rotation: m.rotation, shadowed: shadowedOnCards(asInk(examples[0].strokes)) ?? undefined, now, note: m.note })
        if (m.occurrence) this.flow.settle(m.occurrence, 'defined')
        return null
      }
      case 'refine':
        if (!m.mark || !m.meaning) return 'refine needs a mark and a meaning'
        this.registry.refine(m.mark, m.meaning, by, now, m.note)
        return null
      case 'rename':
        this.registry.rename(m.mark!, m.name ?? '', by, now)
        return null
      case 'add_example': {
        const inv = m.occurrence ? this.registry.get(m.mark!)?.invocations.find((i) => i.id === m.occurrence) : undefined
        const strokes = inv?.ink ?? m.examples?.[0]
        if (!strokes) return 'add_example needs an occurrence or an example'
        this.registry.addExample(m.mark!, { strokes, relation: inv?.relation, source: inv ? 'occurrence' : 'phone' }, by, now)
        return null
      }
      case 'remove_example':
        this.registry.removeExample(m.mark!, m.example!, by, now)
        return null
      case 'retract':
        this.registry.retract(m.mark!, by, now, m.note)
        return null
      case 'restore':
        this.registry.restore(m.mark!, by, now)
        return null
      case 'share':
      case 'unshare':
        this.registry.share(m.mark!, by, now, m.op === 'share')
        return null
      case 'adopt':
        this.registry.adopt(m.mark!, by, now)
        return null
      default:
        return `${m.op} is not a definition a surface sends` // add_negative comes from feedback
    }
  }

  private feedback(m: MarkFeedback, now: number): string | null {
    const p = this.pending.get(m.invocation)
    const r = this.registry.feedback(m.invocation, m.verdict, now, m.via)
    if (!r) return `no invocation ${m.invocation}`
    this.pending.delete(m.invocation)
    // a confirmed action runs now; a rejected or undone one is relayed for its consumer to undo
    if (p?.mode === 'confirm' && m.verdict === 'accept' && p.effect) this.send(p.effect)
    // an explicitly accepted use is a good example: the mark grows to MAX_EXAMPLES from its own use
    if (m.verdict === 'accept' && r.inv.ink && r.mark.examples.length < MAX_EXAMPLES && r.mark.owner === m.by)
      this.registry.addExample(r.mark.id, { strokes: r.inv.ink, relation: r.inv.relation, source: 'occurrence' }, m.by, now)
    return null
  }

  /** Invocations waiting for a verdict (confirm) or still undoable (notify). */
  open(): { invocation: string; mark: string; mode: string; at: number }[] {
    return [...this.pending.entries()].map(([id, p]) => ({ invocation: id, mark: p.mark, mode: p.mode, at: p.at }))
  }
}

/** Strokes relative to their bounding box's corner (glyph ink on the wire, protocol.ts). */
export function relative(strokes: Pt[][]): Pt[][] {
  const b = bounds(strokes.flat())
  return strokes.map((s) => s.map(([x, y]): Pt => [Math.round((x - b.x0) * 100) / 100, Math.round((y - b.y0) * 100) / 100]))
}
