/**
 * The app's shared mutable state, named and in one place.
 *
 * The app is event-driven from three directions at once: router messages (ink, keys, the
 * document), glasses input (ring, touchpad, menu) and the phone page (buttons, drawing). None of
 * those handlers draws or sends anything itself. They change the state below and raise a
 * {@link dirty} flag; the render loop (loop.ts) runs every 50 ms, turns flags into frames and
 * text, and hands them to the glasses scheduler at the pace the link allows. That split is what
 * keeps a burst of ink from turning into a burst of ~200 ms image sends (ADR 006).
 *
 * State that one module owns outright lives in that module (the router socket in link.ts, the
 * transcript in hud/transcript.ts, the frame queues in glasses/scheduler.ts). What is here is read
 * and written across modules, so it is spelled out: each object documents who writes it and who
 * reads it.
 */
import type { EvenAppBridge } from '@evenrealities/even_hub_sdk'
import { StrokeStore, type RasterOptions } from './strokes'
import type { PageMode } from './glasses/layout'
import { ERASE_RADIUS, IMG_H, IMG_W, INITIAL_HIGHLIGHT, INITIAL_MODE, INITIAL_PAGE_MODE, INITIAL_WIDE_FIT, INITIAL_DIAGNOSTICS, INITIAL_WINDOW, PAGE_ASPECT, PREDICT_ERASE, SHOW_AI } from './config'

/**
 * The session's page: every stroke we know of, on its layer (user, peer, ai). Written by the
 * router messages (session.ts) and by drawing on the phone (phone/draw.ts); read by every
 * renderer (the glasses frames, the phone stage).
 */
export const store = new StrokeStore()
store.eraseRadius = ERASE_RADIUS
store.predictErase = PREDICT_ERASE

/**
 * How the glasses canvas frames the page (the canvas container's raster options). The ring and
 * the menu change `mode`, `highlight`, `window` and `showAi` (actions.ts); the phone's Follow
 * view mirrors `mode` and `window`; the loupe derives its own options from these.
 */
export const view: RasterOptions = {
  width: IMG_W,
  height: IMG_H,
  mode: INITIAL_MODE,
  highlight: INITIAL_HIGHLIGHT,
  window: INITIAL_WINDOW,
  pageAspect: PAGE_ASPECT,
  showAi: SHOW_AI,
}

/**
 * Work the render loop owes the glasses. Raised by anything that changes what they should show;
 * cleared by loop.ts once the work is done (or queued).
 */
export const dirty = {
  /** The status/transcript text should be re-rendered and, if it changed, sent. */
  text: true,
  /** The canvas surface should be re-rasterized (the phone's preview of it updates at once). */
  canvas: true,
  /** The loupe should get a fresh frame (drawn just in time, when the link is free). */
  loupe: true,
  /**
   * The glasses' copy of the canvas should be resent at the next lull: a stroke ended, or the
   * view changed. The canvas is a big send, so it waits for the writing to pause.
   */
  flushCanvas: false,
}

/**
 * Ink activity, for pacing: text updates and canvas sends hold back while ink is flowing.
 * Written by the stroke messages (session.ts), reset when the router connection drops.
 */
export const ink = {
  /** Between a stroke_begin and its stroke_end. */
  active: false,
  /** performance.now() of the last stroke message, ms. */
  lastAt: 0,
}

/**
 * The HUD: what the text container says besides the transcript, and the line being typed.
 * Written by keys, commands and terminal events (hud/); read by hud/render.ts.
 */
export const hud = {
  /** The agent's stated plan (`ai_intent.plan`, ≤ 120 chars), shown while the AI layer is on. */
  intent: '',
  /** One line of feedback for the last command or event ('saved', 'not connected', …). */
  notice: '',
  /** performance.now() of the last keystroke (or terminal output), ms: the typing view's clock. */
  typingAt: 0,
  /** The line being typed. */
  input: '',
  /** Highlighted entry of the `/` completion popup. */
  suggestIndex: 0,
  /** In the editor: the command line is open over the document (Ctrl+K), for one command. */
  commandOverlay: false,
}

/**
 * The glasses as a device. `sdk` is the Even bridge as soon as the host provides it (the camera
 * fallback uses it); `bridge` is the same object once our page is up on the glasses, and null
 * until then (and forever in a plain browser): everything that sends to the glasses checks it.
 */
export const glasses = {
  sdk: null as EvenAppBridge | null,
  bridge: null as EvenAppBridge | null,
  /** The page layout: canvas + loupe + status strip, full-screen text, or the editor. */
  pageMode: INITIAL_PAGE_MODE as PageMode,
  /** Wide fit is on (config.ts INITIAL_WIDE_FIT); it shows only in the fit view, see {@link isWide}. */
  wideFit: INITIAL_WIDE_FIT,
  /** Diagnostics are showing (config.ts INITIAL_DIAGNOSTICS): metrics on the lens, the phone's panel. */
  diagnostics: INITIAL_DIAGNOSTICS,
  /** One line about the glasses for the phone's Glasses panel. */
  status: 'waiting for the Even bridge…',
}

/**
 * Whether the glasses show the wide fit view now: wide fit is on, the canvas frames the whole page
 * (fit), and the page is in the canvas layout. The layout, the render loop and the surfaces all
 * follow this one predicate.
 */
export function isWide(): boolean {
  return glasses.wideFit && view.mode === 'full' && glasses.pageMode === 'canvas'
}
