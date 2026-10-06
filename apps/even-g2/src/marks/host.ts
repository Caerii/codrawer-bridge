/**
 * Marks that earn their meaning, hosted on this phone (packages/marks; ADR 013).
 *
 * The phone is the first recogniser host: it already holds every stroke of the session in its
 * store, it is where the user looks to inspect and edit, and it is always on while the tablet
 * sleeps. This module owns the engine and its registry for one owner (this participant, the
 * phone's own id, phone/draw.ts) and wires it to the session:
 *
 *   tablet ink (layer user) and this phone's pen ──stroke_end──▶ engine.stroke   (recognised)
 *   everyone else's ink, the saved page ─────────────────────────▶ engine.see      (context only)
 *   stroke_delete / clear / a new page ───────────────────────────▶ engine.remove / clear
 *   every 500 ms while watching ────────────────────────────────▶ engine.tick ──▶ link.send + the UI
 *   mark_define / mark_feedback by this owner, mark_query, dock_action "mark_teach" ─▶ engine.handle
 *   marks (another participant's registry) ──▶ their shared marks, to view and adopt
 *
 * **Watching is opt-in** ("Watch my ink for marks" in My marks, remembered): recognition reads the
 * tablet's ink, and two phones watching the same tablet would both act on one mark. Teaching,
 * the gallery and edits work without it.
 *
 * **Local effects.** `replay_from` is acted on here (Thinking replay from the marked ink); every
 * other action's effect is a message the engine sends (task_create, primer_request, term_prompt,
 * latex_recognize), or the invocation itself is the record (tag).
 *
 * The registry is kept in localStorage (`codrawer:marks`), JSON, with lineage (registry.ts).
 * Points arrive normalized (protocol.md) and the engine works in page mm (delegate's geometry).
 */
import { fromNormalized, type Pt } from 'delegate'
import { MarkEngine, Registry, type MarkInvoke, type MarkMessage, type Mark, type MarkAsk, type MarkDefine } from 'marks'
import { link } from '../link'
import { myId } from '../phone/draw'
import { replayFrom } from '../phone/replay'
import { store } from '../state'
import type { Stroke } from '../strokes'

const KEY = 'codrawer:marks'
const WATCH_KEY = 'codrawer:marks-watch'
/** How often the engine settles gestures and checks for a lull, ms. */
const TICK_MS = 500

function load(): Registry {
  try {
    return Registry.fromJSON(JSON.parse(localStorage.getItem(KEY) ?? 'null'))
  } catch {
    return new Registry()
  }
}

let saveTimer = 0
function save() {
  if (saveTimer) return
  saveTimer = window.setTimeout(() => {
    saveTimer = 0
    try {
      localStorage.setItem(KEY, JSON.stringify(registry))
    } catch (e) {
      console.warn('[codrawer] marks: could not save the registry', e)
    }
  }, 300)
}

const registry = load()
let engine: MarkEngine | null = null
let watching = false
let timer = 0

type Listener = () => void
const changed: Listener[] = []
const asks: ((a: MarkAsk) => void)[] = []
const invokes: ((m: MarkInvoke) => void)[] = []
/** Invocations shown and not yet settled, for running replay_from on accept. */
const open = new Map<string, MarkInvoke>()

function notify() {
  save()
  for (const f of changed) f()
}

/** What the engine sends: to the session, and to this phone's own UI (the router does not echo). */
function emit(m: MarkMessage | Record<string, unknown>) {
  link.send(m)
  receive(m as MarkMessage, true)
}

function eng(): MarkEngine {
  if (!engine || engine.owner !== myId()) engine = new MarkEngine({ owner: myId(), send: emit, registry })
  return engine
}

/** A store stroke as the engine takes it: page mm, its times, and whose it is. */
function toPage(s: Stroke, owner: boolean): { id: string; pts: Pt[]; t0: number; t1: number; author: string } | null {
  const pts = s.pts.filter((_, i) => !s.gone?.[i]).map((p) => fromNormalized(p))
  if (pts.length < 1) return null
  const t0 = s.times?.[0] ?? s.startedAt ?? s.ts ?? Date.now()
  const t1 = s.times?.[s.times.length - 1] ?? t0
  return { id: s.id, pts, t0, t1, author: owner ? myId() : s.author ?? s.layer }
}

/** Whether a stroke is this owner's: the tablet's pen, or drawn on this phone. */
const isMine = (s: Stroke) => s.layer === 'user' || (s.layer === 'peer' && s.author === myId())

/** A stroke ended (tablet, peer or this phone's pen). */
export function marksStrokeEnded(id: string) {
  if (!watching) return
  const s = store.all().find((x) => x.id === id)
  if (!s || s.brush === 'eraser' || s.layer === 'ai') return
  const p = toPage(s, isMine(s))
  if (!p) return
  if (isMine(s)) eng().stroke({ ...p, t0: Date.now() - (p.t1 - p.t0), t1: Date.now() }) // the engine's clock is this device's
  else eng().see(p)
}

/** The whole page again (a saved page, a reconnect): context only. */
function reseePage() {
  if (!watching) return
  eng().clear()
  for (const s of store.all()) {
    if (s.brush === 'eraser' || s.layer === 'ai') continue
    const p = toPage(s, false)
    if (p) eng().see(p)
  }
}

// ── Messages from the session ────────────────────────────────────────────────────────────────

/** Another participant's marks (a `marks` snapshot): keep their shared ones, to view and adopt. */
function importShared(owner: string, marks: Mark[]) {
  if (owner === myId()) return
  registry.marks = registry.marks.filter((m) => m.owner !== owner).concat(marks.filter((m) => m.shared && m.owner === owner))
  notify()
}

/** A marks message, from the router (`local` false) or this phone's own engine. */
function receive(m: MarkMessage, local: boolean) {
  const me = myId()
  switch (m.t) {
    case 'mark_ask':
      if (m.owner === me) for (const f of asks) f(m)
      return
    case 'mark_invoke':
      if (m.owner !== me) return
      open.set(m.invocation, m)
      if (m.mode !== 'confirm') runLocal(m)
      for (const f of invokes) f(m)
      notify()
      return
    case 'mark_seen':
      if (m.owner === me) console.log('[codrawer] mark', m.result, m.mark ?? m.reason ?? '', m.why)
      return
    case 'mark_define':
    case 'mark_feedback':
      if (!local && m.by === me) { const err = eng().handle(m, Date.now()); if (err) console.warn('[codrawer] marks:', err); notify() }
      return
    case 'mark_query':
      if (!local && m.by !== me) link.send({ t: 'marks', owner: me, marks: registry.visibleTo(m.by).filter((x) => x.owner === me), ts: Date.now() })
      return
    case 'marks':
      if (!local) importShared(m.owner, m.marks)
      return
  }
}

/** Effects this phone acts on itself. */
function runLocal(m: MarkInvoke) {
  if (m.meaning.action === 'replay_from' && m.target.strokes.length) replayFrom(m.target.strokes)
}

// ── What the UI calls ────────────────────────────────────────────────────────────────────────

export const marks = {
  registry,
  owner: () => myId(),
  get watching() {
    return watching
  },
  /** Start or stop recognising this owner's ink (remembered). */
  setWatching(on: boolean) {
    watching = on
    try { localStorage.setItem(WATCH_KEY, on ? '1' : '0') } catch { /* private mode */ }
    window.clearInterval(timer)
    if (on) {
      reseePage()
      timer = window.setInterval(() => {
        const out = eng().tick(Date.now())
        if (out.length) notify()
      }, TICK_MS)
    }
    notify()
  },
  /**
   * A definition or an edit from this phone: applied here (this phone hosts this owner's marks) and
   * sent to the session so other surfaces see it. Returns the engine's refusal, or null.
   */
  define(m: Omit<MarkDefine, 't' | 'by' | 'ts'>): string | null {
    const msg: MarkDefine = { ...m, t: 'mark_define', by: myId(), ts: Date.now() }
    const err = eng().handle(msg, msg.ts)
    if (!err) link.send(msg)
    notify()
    return err
  },
  /** Accept, reject or undo an invocation. */
  feedback(invocation: string, verdict: 'accept' | 'reject' | 'undo') {
    const msg = { t: 'mark_feedback' as const, invocation, verdict, by: myId(), via: 'phone' as const, ts: Date.now() }
    eng().handle(msg, msg.ts)
    link.send(msg)
    const inv = open.get(invocation)
    if (inv && inv.mode === 'confirm' && verdict === 'accept') runLocal(inv)
    open.delete(invocation)
    notify()
  },
  /** Ask the session for everyone's shared marks. */
  query() {
    link.send({ t: 'mark_query', by: myId() })
  },
  onChange(f: Listener) { changed.push(f) },
  onAsk(f: (a: MarkAsk) => void) { asks.push(f) },
  onInvoke(f: (m: MarkInvoke) => void) { invokes.push(f) },
}

/**
 * The dock's "Teach a mark" on a lasso selection (`dock_action` id `mark_teach`, protocol.md): the
 * selected strokes are those with a point inside `bbox` (xochitl's scene units, x centred:
 * x = (x_rm + w/2) / w, y = y_rm / h, for the Paper Pro's 1620 × 2160).
 */
function onDock(m: { id?: string; bbox?: number[] }) {
  if (m.id !== 'mark_teach' || !Array.isArray(m.bbox) || m.bbox.length !== 4) return
  const [x0, y0, x1, y1] = [(m.bbox[0] + 810) / 1620, m.bbox[1] / 2160, (m.bbox[2] + 810) / 1620, m.bbox[3] / 2160]
  const ids = store.all().filter((s) => s.layer === 'user' && s.pts.some((p) => p[0] >= x0 && p[0] <= x1 && p[1] >= y0 && p[1] <= y1)).map((s) => s.id)
  if (!ids.length) return
  if (!watching) reseeOnce()
  const err = eng().handle({ t: 'dock_action', id: 'mark_teach', strokes: ids }, Date.now())
  if (err) console.warn('[codrawer] marks: teach from selection:', err)
  notify()
}

/** Load the page as context once, so a lasso works without watching. */
function reseeOnce() {
  eng().clear()
  for (const s of store.all()) {
    const p = toPage(s, false)
    if (p && s.brush !== 'eraser') eng().see(p)
  }
}

/** Wire the host to the session (main.ts). */
export function setupMarks() {
  for (const t of ['mark_ask', 'mark_invoke', 'mark_seen', 'mark_define', 'mark_feedback', 'mark_query', 'marks'] as const)
    link.on(t, (m) => receive(m as MarkMessage, false))
  link.on('dock_action', onDock)
  link.on('stroke_end', (m) => marksStrokeEnded(m.id))
  link.on('stroke_delete', (m) => { if (Array.isArray(m.ids)) eng().remove(m.ids.filter((x): x is string => typeof x === 'string')) })
  link.on('clear', () => eng().clear())
  link.on('page', () => reseePage())
  let on = false
  try { on = localStorage.getItem(WATCH_KEY) === '1' } catch { /* private mode */ }
  if (on) marks.setWatching(true)
}
