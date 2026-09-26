/**
 * codrawer on the Even Realities G2.
 *
 * Even Hub web app: connects to a codrawer-bridge session over WebSocket,
 * rasterizes the live ink into a 288x144 image container on the glasses, and
 * shows the agent's stated intent (`ai_intent.plan`) in a text container.
 *
 * Input (glasses touchpad / R1 ring):
 *   click        toggle follow / full page
 *   double click cycle highlight: all → user → ai
 *   up / down    zoom the follow window in / out
 *
 * Outside the Even app (plain browser) the page still renders a preview canvas
 * so the same build is testable without the simulator.
 */
import {
  CreateStartUpPageContainer,
  ImageContainerProperty,
  ImageRawDataUpdate,
  ImageRawDataUpdateResult,
  OsEventTypeList,
  RebuildPageContainer,
  StartUpPageCreateResult,
  TextContainerProperty,
  TextContainerUpgrade,
  waitForEvenAppBridge,
  type EvenAppBridge,
} from '@evenrealities/even_hub_sdk'
import { packGray4, rasterize, StrokeStore, toGray8, type Highlight, type RasterOptions, type ViewMode } from './strokes'

// ── config ──────────────────────────────────────────────────────────────────
const params = new URLSearchParams(location.search)
function cfg(key: string, fallback: string): string {
  const fromQuery = params.get(key)
  if (fromQuery) {
    try {
      localStorage.setItem(`codrawer:${key}`, fromQuery)
    } catch {
      /* storage may be unavailable in the webview */
    }
    return fromQuery
  }
  try {
    return localStorage.getItem(`codrawer:${key}`) || fallback
  } catch {
    return fallback
  }
}
const defaultWs = `ws://${location.hostname || 'localhost'}:8577/ws/session1`
const WS_URL = cfg('ws', defaultWs)

// ── display geometry (G2: 576x288; image container max 288x144) ─────────────
// Tunables for the BLE budget: `?img=192x96` shrinks the frame 2.25x,
// `?fmt=gray4` halves the bytes again, `?frame_ms=400` caps the push rate.
const [IMG_W, IMG_H] = (() => {
  const m = /^(\d+)x(\d+)$/.exec(cfg('img', '288x144'))
  const w = m ? Math.min(288, Math.max(20, Number(m[1]))) : 288
  const h = m ? Math.min(144, Math.max(20, Number(m[2]))) : 144
  return [w, h]
})()
const IMG_ID = 1
const TEXT_ID = 2
const RENDER_INTERVAL_MS = 100
const MIN_FRAME_MS = Number(cfg('frame_ms', '250')) || 250
const FMT: 'gray8' | 'gray4' = cfg('fmt', 'gray8') === 'gray4' ? 'gray4' : 'gray8'
const BINARIZE = cfg('binarize', '1') !== '0'

const opts: RasterOptions = {
  width: IMG_W,
  height: IMG_H,
  mode: (cfg('mode', 'follow') as ViewMode) === 'full' ? 'full' : 'follow',
  highlight: (cfg('highlight', 'all') as Highlight) || 'all',
  window: Number(cfg('window', '0.22')) || 0.22,
  pageAspect: 1620 / 2160,
}

// ── state ───────────────────────────────────────────────────────────────────
const store = new StrokeStore()
const preview = document.getElementById('preview') as HTMLCanvasElement
const statusEl = document.getElementById('status') as HTMLDivElement
preview.width = IMG_W
preview.height = IMG_H
preview.style.width = `${IMG_W * 2}px`
preview.style.height = `${IMG_H * 2}px`
const ctx = preview.getContext('2d', { willReadFrequently: true })!
let intent = ''
let connected = false
let frames = 0
let lastImageResult = ''
let lastRoundTripMs = 0
let bridge: EvenAppBridge | null = null
let textDirty = true

function statusLine(): string {
  const conn = connected ? 'live' : 'reconnecting'
  const c = store.counts()
  const head = intent ? `AI: ${intent}` : `${c.user} user · ${c.ai} ai · ${opts.mode} · ${opts.highlight}`
  const rt = lastRoundTripMs ? ` · ${Math.round(lastRoundTripMs)}ms` : ''
  const bad = lastImageResult && lastImageResult !== 'success' ? ' · img:' + lastImageResult : ''
  return `${head}\n${conn} · f${frames}${rt}${bad}`
}

// ── websocket (codrawer protocol) ───────────────────────────────────────────
function connect() {
  const ws = new WebSocket(WS_URL)
  ws.onopen = () => {
    connected = true
    textDirty = true
    console.log('[codrawer] connected', WS_URL)
  }
  ws.onclose = () => {
    connected = false
    textDirty = true
    setTimeout(connect, 800)
  }
  ws.onmessage = (ev) => {
    let m: any
    try {
      m = JSON.parse(String(ev.data))
    } catch {
      return
    }
    switch (m.t) {
      case 'stroke_begin':
        store.begin(m.id, 'user', m.brush || 'pen')
        break
      case 'stroke_pts':
        store.points(m.id, m.pts || [], 'user')
        break
      case 'stroke_end':
        store.end(m.id)
        break
      case 'ai_stroke_begin':
        store.begin(m.id, 'ai', m.brush || 'ghost')
        break
      case 'ai_stroke_pts':
        store.points(m.id, m.pts || [], 'ai')
        break
      case 'ai_stroke_end':
        store.end(m.id)
        break
      case 'ai_intent':
        intent = String(m.plan || '').slice(0, 120)
        textDirty = true
        break
      default:
        break
    }
  }
}

// ── glasses page ────────────────────────────────────────────────────────────
async function initGlasses(b: EvenAppBridge): Promise<boolean> {
  const imageObject = [
    new ImageContainerProperty({
      xPosition: (576 - IMG_W) / 2,
      yPosition: 4,
      width: IMG_W,
      height: IMG_H,
      containerID: IMG_ID,
      containerName: 'canvas',
      zOrderIndex: 1,
    }),
  ]
  const textObject = [
    new TextContainerProperty({
      xPosition: 8,
      yPosition: IMG_H + 12,
      width: 560,
      height: 288 - IMG_H - 16,
      containerID: TEXT_ID,
      containerName: 'status',
      content: 'codrawer: connecting…',
      textColor: 3,
      isEventCapture: 1,
      zOrderIndex: 2,
    }),
  ]
  const result = await b.createStartUpPageContainer(new CreateStartUpPageContainer({ containerTotalNum: 2, imageObject, textObject }))
  if (result !== StartUpPageCreateResult.success) {
    // A page may already exist (e.g. the webview reloaded under HMR); rebuild it in place.
    const rebuilt = await b.rebuildPageContainer(new RebuildPageContainer({ containerTotalNum: 2, imageObject, textObject }))
    console.warn('[codrawer] startup page create returned', result, '→ rebuild', rebuilt)
    if (!rebuilt) return false
  }
  window.addEventListener('beforeunload', () => {
    void b.shutDownPageContainer(0)
  })
  let rawLogged = 0
  b.onEvenHubEvent((event) => {
    if (rawLogged < 6) {
      rawLogged++
      console.log('[codrawer] raw event', JSON.stringify(event).slice(0, 300))
    }
    // Touchpad/ring input arrives two ways: click / double-click / long-press as
    // sysEvent (eventType is omitted when it is 0 = CLICK, protobuf default), and
    // scroll up / down as a textEvent on the event-capture container (1 = up, 2 = down).
    const sys = event.sysEvent
    const text = event.textEvent
    let action = ''
    if (sys && sys.eventSource !== undefined) {
      const type = sys.eventType ?? OsEventTypeList.CLICK_EVENT
      if (type === OsEventTypeList.CLICK_EVENT) action = 'toggle-mode'
      else if (type === OsEventTypeList.DOUBLE_CLICK_EVENT) action = 'cycle-highlight'
      else if (type === OsEventTypeList.SCROLL_TOP_EVENT) action = 'zoom-in'
      else if (type === OsEventTypeList.SCROLL_BOTTOM_EVENT) action = 'zoom-out'
    } else if (text && text.containerID === TEXT_ID) {
      if (text.eventType === 1) action = 'zoom-in'
      else if (text.eventType === 2) action = 'zoom-out'
    }
    if (!action) return
    if (action === 'toggle-mode') opts.mode = opts.mode === 'follow' ? 'full' : 'follow'
    else if (action === 'cycle-highlight') opts.highlight = opts.highlight === 'all' ? 'user' : opts.highlight === 'user' ? 'ai' : 'all'
    else if (action === 'zoom-in') opts.window = Math.max(0.06, opts.window * 0.8)
    else if (action === 'zoom-out') opts.window = Math.min(1, opts.window * 1.25)
    store.dirty = true
    textDirty = true
    console.log('[codrawer] input', action, '→', opts.mode, opts.highlight, opts.window.toFixed(2))
  })
  return true
}

// Image updates must never overlap, and on real glasses each one rides BLE for
// tens to hundreds of ms. Queueing every frame lets lag compound, so this is
// latest-wins: while an update is in flight the newest frame waits, and any
// frame produced in between is dropped. The measured round trip throttles the
// next push (never faster than MIN_FRAME_MS).
let draining = false
let pendingFrame: Uint8Array | null = null
let lastPushAt = 0

function encodeFrame(): Uint8Array {
  const g8 = toGray8(ctx, IMG_W, IMG_H, BINARIZE ? 96 : 0)
  return FMT === 'gray4' ? packGray4(g8) : g8
}

async function drain(b: EvenAppBridge) {
  if (draining) return // one drain loop at a time, including its throttle waits
  draining = true
  try {
    while (pendingFrame) {
      const wait = Math.max(MIN_FRAME_MS, lastRoundTripMs) - (performance.now() - lastPushAt)
      if (wait > 0) await new Promise((r) => setTimeout(r, wait))
      const frame = pendingFrame
      pendingFrame = null
      if (!frame) break
      await sendFrame(b, frame)
    }
  } finally {
    draining = false
  }
}

async function sendFrame(b: EvenAppBridge, frame: Uint8Array) {
  {
    const t0 = performance.now()
    try {
      const r = await b.updateImageRawData(new ImageRawDataUpdate({ containerID: IMG_ID, containerName: 'canvas', imageData: frame }))
      lastImageResult = String(r)
      if (r !== ImageRawDataUpdateResult.success) console.warn('[codrawer] image update', r)
    } catch (e) {
      lastImageResult = 'error'
      console.error('[codrawer] image update threw', e)
    } finally {
      lastRoundTripMs = performance.now() - t0
      lastPushAt = performance.now()
      frames++
      textDirty = true
    }
  }
}

function pushFrame(b: EvenAppBridge, frame: Uint8Array) {
  pendingFrame = frame
  void drain(b)
}

// Text rides the same link; only send it when the content actually changed,
// and never more than a few times a second.
let textChain: Promise<void> = Promise.resolve()
let lastTextSent = ''
let lastTextAt = 0
function pushText(b: EvenAppBridge, content: string) {
  if (content === lastTextSent) return
  if (performance.now() - lastTextAt < 400) return
  lastTextSent = content
  lastTextAt = performance.now()
  textChain = textChain.then(async () => {
    try {
      await b.textContainerUpgrade(new TextContainerUpgrade({ containerID: TEXT_ID, containerName: 'status', content }))
    } catch (e) {
      console.error('[codrawer] text update threw', e)
    }
  })
}

// ── render loop ─────────────────────────────────────────────────────────────
function tick() {
  store.prune()
  if (store.dirty) {
    store.dirty = false
    rasterize(ctx, store, opts)
    if (bridge) pushFrame(bridge, encodeFrame())
    else frames++
    textDirty = true
  }
  if (textDirty) {
    textDirty = false
    const line = statusLine()
    statusEl.textContent = line
    if (bridge) pushText(bridge, line)
  }
}

async function main() {
  connect()
  rasterize(ctx, store, opts)
  statusEl.textContent = `waiting for Even bridge… (${WS_URL})`
  const b = await Promise.race<EvenAppBridge | null>([
    waitForEvenAppBridge(),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 3000)),
  ])
  let ready = false
  if (b) {
    try {
      ready = await initGlasses(b)
    } catch (e) {
      // e.g. a host callback lost across a hot reload; keep the preview alive
      console.warn('[codrawer] glasses init threw', e)
    }
  }
  if (b && ready) {
    bridge = b
    console.log('[codrawer] glasses page ready')
  } else {
    console.log('[codrawer] no Even bridge; browser preview only')
  }
  textDirty = true
  setInterval(tick, RENDER_INTERVAL_MS)
}

main().catch((e) => {
  console.error('[codrawer] fatal', e)
  statusEl.textContent = `fatal: ${String(e)}`
})
