/**
 * The app's verbs: what the ring, the glasses menu and the slash commands can ask for.
 *
 * Input arrives in several shapes (a ring click, a menu item id, `/new` typed on the tablet), and
 * each source maps to an {@link Action}; this module carries the actions out on the shared state.
 * Most change how the glasses frame the page (follow ↔ fit, emphasis, zoom); the phone's Follow
 * view mirrors the framing and zoom changes. Layout switches (text view, editor) go through
 * setPageMode, which redraws what the new layout shows; every other action then asks for a fresh
 * canvas and status line.
 *
 * Two actions are routed before they get here, because they are not about the view: in the
 * editor the ring has its own meanings, and "send drawing" is the `/snap` command
 * (glasses/input.ts handles both).
 */
import { remember } from './config'
import { setPageMode, syncWideLayout } from './glasses/page'
import { link } from './link'
import { followGlasses } from './phone/views'
import { stage } from './phone/screen'
import { dirty, glasses, hud, store, view } from './state'

export type Action =
  | 'new-drawing'
  | 'send-drawing'
  | 'edit-doc'
  | 'text-view'
  | 'clear-ai'
  | 'toggle-ai'
  | 'toggle-mode'
  | 'toggle-wide'
  | 'cycle-view'
  | 'cycle-highlight'
  | 'zoom-in'
  | 'zoom-out'

/** Zoom steps for the follow window (fraction of the page width), and its limits. */
const ZOOM_IN = 0.8
const ZOOM_OUT = 1.25
const MIN_WINDOW = 0.06
const MAX_WINDOW = 1

/** Carry out an action. ('send-drawing' is the /snap command; see glasses/input.ts.) */
export function applyAction(action: Action) {
  if (action === 'send-drawing') return
  if (action === 'edit-doc') {
    if (glasses.bridge) void setPageMode(glasses.pageMode === 'edit' ? 'text' : 'edit')
    return
  }
  if (action === 'new-drawing') {
    // wipe locally and tell the session so every client starts fresh
    store.clear()
    stage.invalidate()
    hud.intent = ''
    link.send({ t: 'clear', ts: Date.now() })
  } else if (action === 'clear-ai') {
    store.clear('ai')
    stage.invalidate()
    hud.intent = ''
  } else if (action === 'toggle-ai') {
    view.showAi = !view.showAi
    stage.showAi = view.showAi
    stage.invalidate()
    remember('ai', view.showAi ? '1' : '0')
  } else if (action === 'text-view') {
    if (glasses.bridge) void setPageMode(glasses.pageMode === 'text' ? 'canvas' : 'text')
    return
  } else if (action === 'toggle-mode') view.mode = view.mode === 'follow' ? 'full' : 'follow'
  else if (action === 'cycle-view') {
    // the glasses menu's one view entry: follow → fit → wide fit → follow
    if (view.mode === 'follow') {
      view.mode = 'full'
      glasses.wideFit = false
    } else if (!glasses.wideFit) glasses.wideFit = true
    else {
      glasses.wideFit = false
      view.mode = 'follow'
    }
    remember('wide', glasses.wideFit ? '1' : '0')
  } else if (action === 'toggle-wide') {
    // turning wide fit on shows it: it is a way of fitting the page
    glasses.wideFit = !glasses.wideFit
    remember('wide', glasses.wideFit ? '1' : '0')
    if (glasses.wideFit) view.mode = 'full'
  }
  else if (action === 'cycle-highlight') view.highlight = view.highlight === 'all' ? 'user' : view.highlight === 'user' ? 'ai' : 'all'
  else if (action === 'zoom-in') view.window = Math.max(MIN_WINDOW, view.window * ZOOM_IN)
  else if (action === 'zoom-out') view.window = Math.min(MAX_WINDOW, view.window * ZOOM_OUT)
  if (action === 'toggle-mode' || action === 'toggle-wide' || action === 'cycle-view' || action === 'zoom-in' || action === 'zoom-out') {
    followGlasses() // the phone follows the ring too
  }
  if (action === 'toggle-mode' || action === 'toggle-wide' || action === 'cycle-view') syncWideLayout()
  dirty.canvas = true
  dirty.loupe = true
  dirty.flushCanvas = true // force a canvas refresh for the new view
  dirty.text = true
}
