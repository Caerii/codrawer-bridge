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
import { cfg } from '../config'
import { link } from '../link'
import { dirty, store } from '../state'
import { stage } from './screen'

/** The participant palette; a participant's default colour is picked from it by id. */
const PARTICIPANT_COLORS = ['#d6482a', '#2f80ed', '#9b51e0', '#219653', '#f2994a', '#eb5757']

/** This participant: a random id made once and remembered, and a colour (`?color=` overrides). */
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
  let h = 0
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return { id, color: cfg('color', PARTICIPANT_COLORS[h % PARTICIPANT_COLORS.length]) }
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
  const me = participant()
  const drawBtn = document.getElementById('drawBtn') as HTMLButtonElement
  drawBtn.style.color = me.color
  drawBtn.onclick = () => {
    stage.drawMode = !stage.drawMode
    drawBtn.setAttribute('aria-pressed', String(stage.drawMode))
  }

  stage.onDraw = (phase, x, y, pressure) => {
    const pt = [Math.round(x * 1e4) / 1e4, Math.round(y * 1e4) / 1e4, Math.round(pressure * 1e3) / 1e3, Date.now()]
    if (phase === 'down') {
      current = `p_${me.id}_${Date.now().toString(36)}`
      store.begin(current, 'peer', 'pen', Date.now(), { color: me.color, author: me.id })
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
