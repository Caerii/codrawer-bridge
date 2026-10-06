/**
 * The session's page, kept in step with the router: ink, the tablet's saved page, the agent.
 *
 * Every client renders the page itself from strokes (docs/protocol.md): the tablet's bridge sends
 * the user's ink as `stroke_begin` / `stroke_pts` / `stroke_end`, the agent's as `ai_stroke_*`
 * (or stroke_* on the `ai` layer), other participants' on the `peer` layer; `stroke_delete` takes
 * strokes back. The handlers here apply each message to the shared
 * store (state.ts), poke the phone stage, and raise the dirty flags that make the render loop
 * send the glasses what changed:
 *
 * - live points mark the loupe and the canvas surface dirty; the glasses copy of the canvas
 *   waits for a stroke to end and the writing to pause (dirty.flushCanvas);
 * - AI ink only counts while the AI layer is shown;
 * - a `page` (the tablet's saved page, with exact tools and colours) or a `clear` redraws all.
 *
 * Ink activity ({@link ink}) is tracked for pacing: status text is held while the pen moves.
 */
import type { Inbound } from './protocol'
import { stage } from './phone/screen'
import { dirty, hud, ink, store, view } from './state'

/** Everything shown depends on the page: redraw the canvas, loupe and status line. */
function pageChanged() {
  dirty.loupe = true
  dirty.canvas = true
  dirty.flushCanvas = true
  dirty.text = true
}

/**
 * `hello`. A router that replays the page (the tablet's) is the source of truth: start from its
 * replay instead of merging it into whatever we had before the disconnect.
 */
export function onHello(m: Inbound['hello']) {
  if (m.replay) {
    store.clear()
    stage.invalidate()
    dirty.canvas = true
    dirty.flushCanvas = true
  }
}

/** The link dropped: a stroke cut off by the disconnect never gets its stroke_end. */
export function onDisconnect() {
  ink.active = false // a stroke cut off by the disconnect must not hold text updates
  store.endOpen() // and never gets its stroke_end
  stage.touch()
  dirty.text = true
}

/** `cursor`: the pen hovering over the tablet (bridge hover), as a pointer on the phone screen. */
export function onCursor(m: Inbound['cursor']) {
  if (m.gone) stage.setPointer(null)
  else if (typeof m.x === 'number' && typeof m.y === 'number') stage.setPointer(m.x, m.y, m.tool === 'eraser' ? 'eraser' : 'pen')
}

/**
 * `stroke_begin`: no frame yet; the first stroke_pts carries the first ink. Agents on routers
 * that carry no `ai_stroke_*` (the tablet's) draw with stroke_* on the `ai` layer; their ink, like
 * a peer's, may name its colour and author.
 */
export function onStrokeBegin(m: Inbound['stroke_begin']) {
  const layer = m.layer === 'peer' || m.layer === 'ai' ? m.layer : 'user'
  store.begin(
    m.id,
    layer,
    m.brush || 'pen',
    typeof m.ts === 'number' ? m.ts : undefined,
    layer !== 'user' ? { color: typeof m.color === 'string' ? m.color : undefined, author: m.author } : undefined,
  )
  ink.active = true
  ink.lastAt = performance.now()
  stage.setPointer(null) // the ink itself shows the pen now
}

/** `stroke_pts`: live ink for the loupe now; the canvas surface follows. */
export function onStrokePoints(m: Inbound['stroke_pts']) {
  store.points(m.id, m.pts || [], 'user')
  stage.touch()
  ink.lastAt = performance.now()
  dirty.loupe = true
  dirty.canvas = true
}

/** `stroke_end`: the glasses canvas may be resent once the writing pauses. */
export function onStrokeEnd(m: Inbound['stroke_end']) {
  store.end(m.id)
  stage.touch()
  ink.active = false
  ink.lastAt = performance.now()
  dirty.canvas = true // the loupe already shows the last points
  dirty.flushCanvas = true
  dirty.text = true
}

/**
 * `stroke_delete`: strokes taken back (an undo, "clear my strokes", an agent's animation frame).
 * The router has already checked who may delete what; anything that went is redrawn everywhere.
 */
export function onStrokeDelete(m: Inbound['stroke_delete']) {
  const ids = Array.isArray(m.ids) ? m.ids.filter((id): id is string => typeof id === 'string') : []
  if (store.remove(ids).length === 0) return
  stage.invalidate()
  dirty.loupe = true
  dirty.canvas = true
  dirty.flushCanvas = true
}

/** `ai_stroke_begin`. */
export function onAiStrokeBegin(m: Inbound['ai_stroke_begin']) {
  store.begin(m.id, 'ai', m.brush || 'ghost')
}

/** `ai_stroke_pts`: redraws the glasses only while the AI layer is shown. */
export function onAiStrokePoints(m: Inbound['ai_stroke_pts']) {
  store.points(m.id, m.pts || [], 'ai')
  stage.touch()
  if (view.showAi !== false) {
    dirty.loupe = true
    dirty.canvas = true
  }
}

/** `ai_stroke_end`. */
export function onAiStrokeEnd(m: Inbound['ai_stroke_end']) {
  store.end(m.id)
  if (view.showAi !== false) dirty.flushCanvas = true
}

/** `ai_intent`: the agent's plan for the HUD (≤ 120 chars). */
export function onAiIntent(m: Inbound['ai_intent']) {
  hud.intent = String(m.plan || '').slice(0, 120)
  dirty.text = true
}

/**
 * `page`: the tablet's saved page (the bridge's page watcher): exact tools, colours and widths,
 * erases and undos applied. It replaces our copy of the page; ink drawn since the save stays. A
 * different page or document clears the view and shows that page.
 */
export function onPage(m: Inbound['page']) {
  if (store.applyPage(m)) {
    hud.intent = ''
    stage.setPointer(null)
  }
  stage.invalidate()
  pageChanged()
}

/** `clear`: another client started a new drawing. */
export function onClear() {
  store.clear()
  stage.invalidate()
  hud.intent = ''
  pageChanged()
}
