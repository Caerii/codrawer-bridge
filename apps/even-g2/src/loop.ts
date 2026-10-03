/**
 * The render loop: every 50 ms, turn what changed into what the glasses should show.
 *
 * Handlers elsewhere only raise dirty flags (state.ts); this is the one place that draws and
 * queues. Per tick, in order:
 *
 * 1. Housekeeping: drop strokes past the store's limits, and check the router is still alive.
 * 2. Loupe: when dirty, queue a just-in-time recipe, so the frame is drawn the moment the link is
 *    free, with the pen where it is then. (Without glasses, just redraw the phone's preview.)
 * 3. Canvas: when dirty, re-rasterize the surface (the phone preview updates at once). The glasses
 *    copy is a big send: with a loupe showing live ink it waits for a lull in the writing, not
 *    every stroke_end (in handwriting every letter ends a stroke, and each ~200–400 ms canvas send
 *    would hold the loupe off the link); with no loupe it is the only view, so it goes at every
 *    stroke end or at most every CANVAS_MIN_MS.
 * 4. Text: when dirty (or when the typing view just expired), render it, show it in the phone's
 *    Glasses panel and offer it to the glasses; a deferred offer stays dirty for the next tick.
 * 5. The document autosaves 2 s after its last edit.
 */
import { CANVAS_LULL_MS, CANVAS_MIN_MS, HAS_LOUPE } from './config'
import { autosaveIfDue } from './doc/document'
import { canvasFrame, drawCanvas, drawLoupe, loupeFrame, scheduler, textPusher } from './glasses/display'
import { isTyping, renderText } from './hud/render'
import { link } from './link'
import { showStatus } from './phone/panel'
import { stage } from './phone/screen'
import { dirty, glasses, hud, ink, store } from './state'

let wasTyping = false
let canvasUnsent = false // the canvas surface changed since the glasses last got it

/** One tick of the render loop (see the module comment). */
export function tick() {
  if (store.prune()) {
    stage.invalidate()
    dirty.canvas = true
    dirty.flushCanvas = true
  }
  const now = performance.now()
  link.checkLiveness(now)

  if (HAS_LOUPE && dirty.loupe) {
    dirty.loupe = false
    if (glasses.bridge) scheduler.want('loupe', loupeFrame) // drawn and encoded when the link is free
    else drawLoupe() // the phone's preview only
  }

  if (dirty.canvas) {
    dirty.canvas = false
    drawCanvas()
    canvasUnsent = true
  }
  const canvasDue = HAS_LOUPE
    ? dirty.flushCanvas && !ink.active && now - ink.lastAt >= CANVAS_LULL_MS
    : dirty.flushCanvas || now - scheduler.startedAt('canvas') >= CANVAS_MIN_MS
  if (canvasUnsent && canvasDue) {
    canvasUnsent = false
    dirty.flushCanvas = false
    if (glasses.bridge) scheduler.offer('canvas', canvasFrame())
  }

  const typingNow = isTyping()
  if (wasTyping && !typingNow) dirty.text = true // the typing view expired: back to status
  wasTyping = typingNow
  if (dirty.text) {
    dirty.text = false
    const line = renderText()
    showStatus(`${glasses.status}\n${line}`)
    if (glasses.bridge && !textPusher.push(line, { typingAt: hud.typingAt, inkActive: ink.active, lastInkAt: ink.lastAt })) dirty.text = true // deferred: retry next tick
  }

  autosaveIfDue()
}
