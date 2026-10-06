/**
 * Drawing on the phone: this device as a participant in the session (ADR 008, first slice).
 *
 * With the draw button on, a finger, mouse or Apple Pencil on the stage draws. The strokes go to
 * the session on the `peer` layer with this participant's id and colour; everyone sees them live
 * (in colour on phones and the web, dashed on the glasses), and they survive the tablet's page
 * snapshots. They are not written into the reMarkable notebook yet.
 *
 * Local ink never waits for the network: each point goes into the shared store at once, and the
 * points are batched to the router at pen rate (~16 ms, like the tablet's 60 Hz). Ids are
 * `p_<participant>_<base36 ms>`; points are [x, y, pressure, t] with x, y normalized page
 * coordinates rounded to 1e-4, pressure 0..1 rounded to 1e-3, and t Unix ms.
 */
import { cfg, remember } from '../config'
import { link } from '../link'
import { dirty, store } from '../state'
import { defaultColorFor } from './palette'
import { stage } from './screen'

/**
 * This participant: a random id made once and remembered, and a colour (`?color=`, or the one
 * picked in the menu, else one derived from the id).
 */
function participant(): { id: string; color: string } {
  let id = ''
  try {
    id = localStorage.getItem('codrawer:participant') ?? ''
    if (!id) {
      id = Math.random().toString(36).slice(2, 10)
      localStorage.setItem('codrawer:participant', id)
    }
  } catch {
    id = Math.random().toString(36).slice(2, 10)
  }
  return { id, color: cfg('color', defaultColorFor(id)) }
}

/** Who draws here; set up by {@link setupDrawing}. */
let me = { id: '', color: '' }
const drawBtn = () => document.getElementById('drawBtn') as HTMLButtonElement

/** This participant's colour (CSS hex). */
export function myColor(): string {
  return me.color
}

/** Change this participant's colour for new strokes (strokes already drawn keep theirs); remembered. */
export function setMyColor(color: string) {
  me = { ...me, color }
  remember('color', color)
  drawBtn().style.color = color
}

// ── Taking strokes back ───────────────────────────────────────────────────────────────────────
//
// The routers let a connection delete only the strokes it began (docs/protocol.md,
// `stroke_delete`), so "my strokes" are the ones drawn here since this connection's `hello`: after
// a reconnect the router would refuse the older ones, and deleting them here alone would be a lie
// undone by the next replay. The list is forgotten on every hello.

/** Ids of the strokes drawn here on this connection, oldest first. */
let mine: string[] = []

/** A new connection: the router no longer counts earlier strokes as ours. */
export function forgetMyStrokes() {
  mine = []
}

/** The strokes drawn here on this connection that are still on the page, oldest first. */
export function myStrokes(): string[] {
  mine = mine.filter((id) => store.has(id) && id !== current)
  return mine
}

/** Delete strokes for everyone: here at once, then `stroke_delete` to the session. */
function deleteForEveryone(ids: string[]) {
  if (ids.length === 0) return
  store.remove(ids)
  mine = mine.filter((id) => !ids.includes(id))
  link.send({ t: 'stroke_delete', ids, ts: Date.now() })
  stage.invalidate()
  dirty.loupe = true
  dirty.canvas = true
  dirty.flushCanvas = true
}

/** "Undo my last stroke": the newest stroke drawn here, if any. Returns whether one went. */
export function undoMyLastStroke(): boolean {
  const ids = myStrokes()
  const last = ids.length ? ids[ids.length - 1] : undefined
  if (last !== undefined) deleteForEveryone([last])
  return last !== undefined
}

/** "Clear my strokes": every stroke drawn here on this connection. Returns how many went. */
export function clearMyStrokes(): number {
  const ids = [...myStrokes()]
  deleteForEveryone(ids)
  return ids.length
}

/** The stroke being drawn here, and its points not yet sent. */
let current: string | null = null
let batch: number[][] = []
let flushedAt = 0 // performance.now() of the last batch sent, ms

function flush() {
  if (!current || batch.length === 0) return
  link.send({ t: 'stroke_pts', id: current, pts: batch })
  batch = []
  flushedAt = performance.now()
}

/** Identify this participant, colour the draw button, and turn stage pointer input into strokes. */
export function setupDrawing() {
  me = participant()
  const btn = drawBtn()
  btn.style.color = me.color
  btn.onclick = () => {
    stage.drawMode = !stage.drawMode
    btn.setAttribute('aria-pressed', String(stage.drawMode))
  }

  stage.onDraw = (phase, x, y, pressure) => {
    const pt = [Math.round(x * 1e4) / 1e4, Math.round(y * 1e4) / 1e4, Math.round(pressure * 1e3) / 1e3, Date.now()]
    if (phase === 'down') {
      current = `p_${me.id}_${Date.now().toString(36)}`
      store.begin(current, 'peer', 'pen', Date.now(), { color: me.color, author: me.id })
      mine.push(current)
      link.send({ t: 'stroke_begin', id: current, layer: 'peer', brush: 'pen', color: me.color, author: me.id, ts: Date.now() })
      batch = []
    }
    if (!current) return
    store.points(current, [pt], 'peer') // local ink never waits for the network
    batch.push(pt)
    if (phase === 'up') {
      flush()
      store.end(current)
      link.send({ t: 'stroke_end', id: current, ts: Date.now() })
      current = null
    } else if (performance.now() - flushedAt >= 16) {
      flush() // pen-rate batches, like the tablet's 60 Hz
    }
    stage.touch()
    dirty.loupe = true
    dirty.canvas = true
    if (phase === 'up') dirty.flushCanvas = true
  }
}
