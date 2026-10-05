/**
 * The glasses page's lifecycle: bring it up, keep trying until we get the display, switch layouts.
 *
 * Bringing it up is less simple than one call, for reasons each learned on a device:
 *
 * - `createStartUpPageContainer` answers `invalid` when a page already exists: the app was
 *   reopened from the Even Hub tab while its previous page was still registered, or the WebView
 *   hot-reloaded. We then rebuild in place with the same containers.
 * - Never call `shutDownPageContainer` to start clean: on the device that exits the whole app
 *   (seen 2026-09-27 as "tapping the app closes it"). The one deliberate use is
 *   {@link releaseIfStale}, which is meant to close this copy.
 * - If neither works, another app (or an earlier copy of this one) usually still holds the glasses
 *   display. We retry with a growing delay (2 s + 1 s per attempt, at most 10 s) and take over the
 *   moment it lets go.
 *
 * Layout switches ({@link setPageMode}) are one rebuild (~165 ms, ADR 006) that blanks every
 * container, so they wait for any image send still on the wire, and everything shown afterwards
 * is sent fresh. Image frames pause in the text and editor layouts (they have no image
 * containers).
 */
import { CreateStartUpPageContainer, RebuildPageContainer, StartUpPageCreateResult, type EvenAppBridge, type EvenHubEvent } from '@evenrealities/even_hub_sdk'
import { FMT, HAS_LOUPE, IMG_H, IMG_W, LOUPE_H, LOUPE_W, PROBE, remember } from '../config'
import { editor, saveDoc } from '../doc/document'
import { renderText } from '../hud/render'
import { link } from '../link'
import { showStatus } from '../phone/panel'
import { dirty, glasses, hud, isWide } from '../state'
import { scheduler, textPusher } from './display'
import { buildPage, IMG_ID, LOUPE_ID, TEXT_ID, type PageMode } from './layout'
import { runProbe } from './probe'

/** Whether the page on the glasses was built as the wide fit layout. */
let builtWide = false

/** Ask for a fresh canvas, loupe and status line (after the page was (re)built). */
function redrawAll() {
  dirty.canvas = true
  dirty.loupe = true
  dirty.flushCanvas = true
  dirty.text = true
}

/**
 * Switch the glasses page to `mode` (remembered for the next load). Entering the editor saves the
 * document first; leaving it saves unsaved edits and closes its command line. Without glasses the
 * mode still changes (the phone's Glasses panel shows its text).
 */
export async function setPageMode(mode: PageMode, rebuild = false) {
  if (mode === glasses.pageMode && !rebuild) return
  if (mode === 'edit' && glasses.pageMode !== 'edit') saveDoc('enter')
  if (glasses.pageMode === 'edit' && mode !== 'edit') {
    if (editor.dirty) saveDoc('leave')
    hud.commandOverlay = false
  }
  glasses.pageMode = mode
  remember('view', mode)
  scheduler.clear()
  const b = glasses.bridge
  if (!b) {
    dirty.text = true
    return
  }
  // never rebuild the page under an image update that is still on the wire
  while (scheduler.busy) await new Promise((r) => setTimeout(r, 10))
  scheduler.forgetShown() // the rebuild blanks the containers
  builtWide = isWide()
  const ok = await b.rebuildPageContainer(new RebuildPageContainer(buildPage(mode, renderText, builtWide)))
  console.log('[codrawer] page mode', mode, ok ? 'ok' : 'rebuild failed')
  textPusher.forget() // the rebuild carried fresh content; resend on next change
  if (mode === 'canvas') {
    dirty.canvas = true
    dirty.loupe = true
    dirty.flushCanvas = true
  }
  dirty.text = true
}

/**
 * Rebuild the canvas page if the wide fit view should now show and the page was built without it,
 * or the other way round (wide fit toggled, or the ring switched follow ↔ fit while it is on).
 */
export function syncWideLayout() {
  if (glasses.bridge && glasses.pageMode === 'canvas' && isWide() !== builtWide) void setPageMode('canvas', true)
}

/**
 * Create our page (or rebuild the one left behind) and subscribe to glasses input. Resolves false
 * if the glasses would not take it. The first few raw events are logged: their shape is the SDK
 * fact most often needed when input misbehaves.
 */
async function initGlasses(b: EvenAppBridge, onEvent: (event: EvenHubEvent) => void): Promise<boolean> {
  builtWide = isWide()
  const page = buildPage(glasses.pageMode, renderText, builtWide)
  const result = await b.createStartUpPageContainer(new CreateStartUpPageContainer(page))
  if (result !== StartUpPageCreateResult.success) {
    // A page already exists (reopened from the Even Hub tab, or a hot reload): rebuild it in
    // place with the same container set. Never shutDownPageContainer here (see above).
    const rebuilt = await b.rebuildPageContainer(new RebuildPageContainer(page))
    console.warn('[codrawer] startup page create returned', result, '→ rebuild', rebuilt)
    if (!rebuilt) {
      glasses.status = `glasses page failed: create=${String(result)} rebuild=${String(rebuilt)}`
      console.error('[codrawer]', glasses.status)
      return false
    }
  }
  let rawLogged = 0
  b.onEvenHubEvent((event) => {
    if (rawLogged < 6) {
      rawLogged++
      console.log('[codrawer] raw event', JSON.stringify(event).slice(0, 300))
    }
    onEvent(event)
  })
  return true
}

let retries = 0

/**
 * Put our page on the glasses, retrying until it sticks; then (with `?probe=1`) run the link
 * probe, and from then on the render loop sends to the glasses.
 */
export async function attachGlasses(b: EvenAppBridge, onEvent: (event: EvenHubEvent) => void) {
  let ready = false
  try {
    ready = await initGlasses(b, onEvent)
  } catch (e) {
    // e.g. a host callback lost across a hot reload; keep the preview alive
    glasses.status = `glasses init threw: ${String(e)}`
    console.error('[codrawer] glasses init threw', String(e))
  }
  if (!ready) {
    // Usually another app (or an earlier copy of this one) still holds the glasses display.
    // Keep trying; the moment it lets go, this app takes over.
    retries++
    glasses.status += ` · close other glasses apps; retrying (${retries})`
    dirty.text = true
    setTimeout(() => void attachGlasses(b, onEvent), Math.min(10_000, 2000 + retries * 1000))
    return
  }
  if (PROBE && HAS_LOUPE) {
    // one-shot link probe (probe.ts); read from the URL directly so it never sticks in storage
    glasses.status = 'glasses: probing link…'
    await runProbe(b, { id: LOUPE_ID, name: 'loupe', w: LOUPE_W, h: LOUPE_H }, { id: IMG_ID, name: 'canvas', w: IMG_W, h: IMG_H }, TEXT_ID, (lines) => {
      showStatus(lines.join('\n'))
    })
    textPusher.forget() // the probe overwrote the status text
  }
  glasses.status = 'glasses: on'
  glasses.bridge = b
  redrawAll()
  console.log('[codrawer] glasses page ready', { canvas: `${IMG_W}x${IMG_H}`, loupe: HAS_LOUPE ? `${LOUPE_W}x${LOUPE_H}` : 'off', fmt: FMT })
}

/**
 * Called after each pairing refusal: if this copy is a stale one refused in the background (see
 * ReconnectPolicy.isStaleCopy), close it so the copy on screen can have the glasses display.
 */
export function releaseIfStale() {
  if (!glasses.bridge || !link.policy.isStaleCopy(performance.now(), document.visibilityState === 'hidden')) return
  console.warn('[codrawer] refused while in the background; releasing the glasses for the active copy')
  void glasses.bridge.shutDownPageContainer(0).catch(() => {})
}
