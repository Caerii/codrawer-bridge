/**
 * codrawer on the Even Realities G2.
 *
 * Even Hub web app: connects to a codrawer-bridge session over WebSocket and
 * mirrors the ink on the glasses with two image containers:
 *
 *   canvas  the page (follow-crop or fit-to-ink), refreshed once per stroke
 *   loupe   a small window around the pen, refreshed as fast as BLE allows
 *
 * Bytes per update are the whole latency budget on real glasses (a 288x144
 * Gray8 frame is 41 KB and rode BLE in 200-400 ms), so live ink goes through
 * the loupe (a few KB) and the big canvas only moves at stroke_end.
 *
 * Input (glasses touchpad / R1 ring):
 *   click        toggle canvas follow / fit-to-ink
 *   double click cycle emphasis: all → user → ai
 *   up / down    zoom the follow windows in / out
 *
 * Outside the Even app (plain browser) the page still renders both previews.
 */
import {
  CreateStartUpPageContainer,
  ImageContainerProperty,
  ImageRawDataUpdate,
  ImageRawDataUpdateResult,
  MenuContainerProperty,
  MenuItemProperty,
  OsEventTypeList,
  RebuildPageContainer,
  StartUpPageCreateResult,
  TextContainerProperty,
  TextContainerUpgrade,
  waitForEvenAppBridge,
  type EvenAppBridge,
} from '@evenrealities/even_hub_sdk'
import { packGray4, rasterize, StrokeStore, toBase64, toGray8, type Highlight, type RasterOptions, type ViewMode } from './strokes'
import { runBench } from './bench'

// ── config ──────────────────────────────────────────────────────────────────
const params = new URLSearchParams(location.search)
function cfg(key: string, fallback: string): string {
  const fromQuery = params.get(key)
  if (fromQuery !== null) {
    try {
      localStorage.setItem(`codrawer:${key}`, fromQuery)
    } catch {
      /* storage may be unavailable in the webview */
    }
    return fromQuery
  }
  try {
    return localStorage.getItem(`codrawer:${key}`) ?? fallback
  } catch {
    return fallback
  }
}
function size(key: string, fallback: string, maxW: number, maxH: number): [number, number] {
  const v = cfg(key, fallback)
  if (v === '0') return [0, 0]
  const m = /^(\d+)x(\d+)$/.exec(v)
  const w = m ? Math.min(maxW, Math.max(20, Number(m[1]))) : Math.min(maxW, Number(fallback.split('x')[0]))
  const h = m ? Math.min(maxH, Math.max(20, Number(m[2]))) : Math.min(maxH, Number(fallback.split('x')[1]))
  return [w, h]
}
const defaultWs = `ws://${location.hostname || 'localhost'}:8577/ws/session1`
const WS_URL = cfg('ws', defaultWs)

// ── display geometry (G2: 576x288; image containers max 288x144) ────────────
// Tunables: ?img=240x120 (canvas) ?loupe=128x64 (or 0 to disable) ?fmt=gray4
// ?frame_ms=60 (loupe floor) ?canvas_ms=1200 (canvas floor) ?ai=0 (hide AI ink)
const [IMG_W, IMG_H] = size('img', '288x144', 288, 144)
const [LOUPE_W, LOUPE_H] = size('loupe', '128x64', 288, 144)
const HAS_LOUPE = LOUPE_W > 0
const SCREEN_W = 576
const SCREEN_H = 288
const IMG_ID = 1
const TEXT_ID = 2
const LOUPE_ID = 3
const RENDER_INTERVAL_MS = 50
const LOUPE_MIN_MS = Number(cfg('frame_ms', '60')) || 60
const CANVAS_MIN_MS = Number(cfg('canvas_ms', '1200')) || 1200
const FMT: 'gray8' | 'gray4' = cfg('fmt', 'gray8') === 'gray4' ? 'gray4' : 'gray8'
const BINARIZE = cfg('binarize', '1') !== '0'
const SHOW_AI = cfg('ai', '1') !== '0'
// b64 sends imageData as a base64 string instead of a JSON number[] across the
// WebView bridge; `?enc=array` restores the SDK's default marshaling.
const ENC: 'b64' | 'array' = cfg('enc', 'b64') === 'array' ? 'array' : 'b64'
const BENCH = cfg('bench', '0') === '1'

// glasses contextual-menu item ids (non-zero, unique) → actions
const MENU = { toggleAi: 1, toggleMode: 2, cycleHighlight: 3, zoomIn: 4, zoomOut: 5 } as const
const MENU_ACTION: Record<number, string> = {
  [MENU.toggleAi]: 'toggle-ai',
  [MENU.toggleMode]: 'toggle-mode',
  [MENU.cycleHighlight]: 'cycle-highlight',
  [MENU.zoomIn]: 'zoom-in',
  [MENU.zoomOut]: 'zoom-out',
}

const opts: RasterOptions = {
  width: IMG_W,
  height: IMG_H,
  mode: (cfg('mode', 'follow') as ViewMode) === 'full' ? 'full' : 'follow',
  highlight: (cfg('highlight', 'all') as Highlight) || 'all',
  window: Number(cfg('window', '0.22')) || 0.22,
  pageAspect: 1620 / 2160,
  showAi: SHOW_AI,
}
function loupeOpts(): RasterOptions {
  return { ...opts, width: LOUPE_W, height: LOUPE_H, mode: 'follow', window: opts.window * 0.45 }
}

// ── state ───────────────────────────────────────────────────────────────────
const store = new StrokeStore()
const preview = document.getElementById('preview') as HTMLCanvasElement
const loupePreview = document.getElementById('loupe') as HTMLCanvasElement
const statusEl = document.getElementById('status') as HTMLDivElement
function fit(c: HTMLCanvasElement, w: number, h: number) {
  c.width = Math.max(1, w)
  c.height = Math.max(1, h)
  c.style.width = `${w * 2}px`
  c.style.height = `${h * 2}px`
  c.style.display = w > 0 ? 'block' : 'none'
}
fit(preview, IMG_W, IMG_H)
fit(loupePreview, LOUPE_W, LOUPE_H)
const ctx = preview.getContext('2d', { willReadFrequently: true })!
const lctx = loupePreview.getContext('2d', { willReadFrequently: true })!

let intent = ''
let connected = false
let bridge: EvenAppBridge | null = null
let textDirty = true
let canvasDirty = true
let loupeDirty = true
let strokeEnded = false
let lastImageResult = ''
const rt = { loupe: 0, canvas: 0 }
const sent = { loupe: 0, canvas: 0 }

function statusLine(): string {
  const conn = connected ? 'live' : 'reconnecting'
  const c = store.counts()
  const ai = opts.showAi === false ? 'ai off' : `${c.ai} ai`
  const head = intent && opts.showAi !== false ? `AI: ${intent}` : `${c.user} user · ${ai} · ${opts.mode} · ${opts.highlight}`
  const l = HAS_LOUPE ? ` · L${Math.round(rt.loupe)}ms/${sent.loupe}` : ''
  const k = ` · C${Math.round(rt.canvas)}ms/${sent.canvas}`
  const bad = lastImageResult && lastImageResult !== 'success' ? ' · img:' + lastImageResult : ''
  return `${head}\n${conn}${l}${k}${bad}`
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
        loupeDirty = true
        break
      case 'stroke_pts':
        store.points(m.id, m.pts || [], 'user')
        loupeDirty = true
        canvasDirty = true
        break
      case 'stroke_end':
        store.end(m.id)
        loupeDirty = true
        canvasDirty = true
        strokeEnded = true
        break
      case 'ai_stroke_begin':
        store.begin(m.id, 'ai', m.brush || 'ghost')
        break
      case 'ai_stroke_pts':
        store.points(m.id, m.pts || [], 'ai')
        if (opts.showAi !== false) {
          loupeDirty = true
          canvasDirty = true
        }
        break
      case 'ai_stroke_end':
        store.end(m.id)
        if (opts.showAi !== false) strokeEnded = true
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
  const top = 4
  const imageObject = [
    new ImageContainerProperty({
      xPosition: 8,
      yPosition: top,
      width: IMG_W,
      height: IMG_H,
      containerID: IMG_ID,
      containerName: 'canvas',
      zOrderIndex: 1,
    }),
  ]
  if (HAS_LOUPE) {
    imageObject.push(
      new ImageContainerProperty({
        xPosition: SCREEN_W - 8 - LOUPE_W,
        yPosition: top,
        width: LOUPE_W,
        height: LOUPE_H,
        containerID: LOUPE_ID,
        containerName: 'loupe',
        zOrderIndex: 3,
      }),
    )
  }
  const textTop = top + Math.max(IMG_H, HAS_LOUPE ? LOUPE_H : 0) + 8
  const textObject = [
    new TextContainerProperty({
      xPosition: 8,
      yPosition: textTop,
      width: SCREEN_W - 16,
      height: Math.max(24, SCREEN_H - textTop - 4),
      containerID: TEXT_ID,
      containerName: 'status',
      content: 'codrawer: connecting…',
      textColor: 3,
      isEventCapture: 1,
      zOrderIndex: 2,
    }),
  ]
  // Contextual menu (long-press / context gesture on the glasses). Labels are
  // static until a rebuild, so they are verbs; current state shows in the status line.
  const menuObject = new MenuContainerProperty({
    menuItems: [
      new MenuItemProperty({ itemName: 'Toggle AI ghost', itemID: MENU.toggleAi }),
      new MenuItemProperty({ itemName: 'Follow / fit page', itemID: MENU.toggleMode }),
      new MenuItemProperty({ itemName: 'Cycle emphasis', itemID: MENU.cycleHighlight }),
      new MenuItemProperty({ itemName: 'Zoom in', itemID: MENU.zoomIn }),
      new MenuItemProperty({ itemName: 'Zoom out', itemID: MENU.zoomOut }),
    ],
  })
  const page = { containerTotalNum: imageObject.length + textObject.length, imageObject, textObject, menuObject }
  let result = await b.createStartUpPageContainer(new CreateStartUpPageContainer(page))
  if (result !== StartUpPageCreateResult.success) {
    // A page may already exist (the WebView reloaded and its unload shutdown never
    // reached the host). Tear it down and create again; rebuild is the last resort.
    try {
      await b.shutDownPageContainer(0)
    } catch {
      /* ignore */
    }
    await new Promise((r) => setTimeout(r, 350))
    result = await b.createStartUpPageContainer(new CreateStartUpPageContainer(page))
    if (result !== StartUpPageCreateResult.success) {
      const rebuilt = await b.rebuildPageContainer(new RebuildPageContainer(page))
      console.warn('[codrawer] startup page create returned', result, '→ rebuild', rebuilt)
      if (!rebuilt) {
        statusEl.textContent = `glasses page failed: create=${String(result)} rebuild=${String(rebuilt)}`
        return false
      }
    }
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
    const menu = event.menuItemClickEvent
    let action = ''
    if (menu && menu.itemID !== undefined) {
      action = MENU_ACTION[menu.itemID] ?? ''
    } else if (sys && sys.eventSource !== undefined) {
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
    if (action === 'toggle-ai') {
      opts.showAi = !opts.showAi
      try {
        localStorage.setItem('codrawer:ai', opts.showAi ? '1' : '0')
      } catch {
        /* ignore */
      }
    } else if (action === 'toggle-mode') opts.mode = opts.mode === 'follow' ? 'full' : 'follow'
    else if (action === 'cycle-highlight') opts.highlight = opts.highlight === 'all' ? 'user' : opts.highlight === 'user' ? 'ai' : 'all'
    else if (action === 'zoom-in') opts.window = Math.max(0.06, opts.window * 0.8)
    else if (action === 'zoom-out') opts.window = Math.min(1, opts.window * 1.25)
    canvasDirty = true
    loupeDirty = true
    strokeEnded = true // force a canvas refresh for the new view
    textDirty = true
    console.log('[codrawer] input', action, '→', opts.mode, opts.highlight, opts.window.toFixed(2))
  })
  return true
}

// ── frame scheduling ────────────────────────────────────────────────────────
// The SDK forbids overlapping image updates and every one rides BLE, so a
// single drain loop serves two latest-wins slots: the loupe first (small,
// frequent), then the canvas (big, rare). Each slot is throttled by its own
// measured round trip so a slow link degrades to a lower rate, never to lag.
type Slot = 'loupe' | 'canvas'
const pending: Record<Slot, Frame | null> = { loupe: null, canvas: null }
const lastPushAt: Record<Slot, number> = { loupe: 0, canvas: 0 }
const minMs: Record<Slot, number> = { loupe: LOUPE_MIN_MS, canvas: CANVAS_MIN_MS }
const containerOf: Record<Slot, { id: number; name: string }> = {
  loupe: { id: LOUPE_ID, name: 'loupe' },
  canvas: { id: IMG_ID, name: 'canvas' },
}
let draining = false

type Frame = Uint8Array | string
function encode(c: CanvasRenderingContext2D, w: number, h: number): Frame {
  const g8 = toGray8(c, w, h, BINARIZE ? 96 : 0)
  const bytes = FMT === 'gray4' ? packGray4(g8) : g8
  return ENC === 'b64' ? toBase64(bytes) : bytes
}

function readySlot(): Slot | null {
  const now = performance.now()
  for (const s of ['loupe', 'canvas'] as Slot[]) {
    if (pending[s] && now - lastPushAt[s] >= Math.max(minMs[s], rt[s])) return s
  }
  return null
}

async function drain(b: EvenAppBridge) {
  if (draining) return
  draining = true
  try {
    while (pending.loupe || pending.canvas) {
      let slot = readySlot()
      if (!slot) {
        await new Promise((r) => setTimeout(r, 15))
        continue
      }
      const frame = pending[slot]!
      pending[slot] = null
      const t0 = performance.now()
      try {
        const r = await b.updateImageRawData(
          new ImageRawDataUpdate({ containerID: containerOf[slot].id, containerName: containerOf[slot].name, imageData: frame }),
        )
        lastImageResult = String(r)
        if (r !== ImageRawDataUpdateResult.success) console.warn('[codrawer] image update', slot, r)
      } catch (e) {
        lastImageResult = 'error'
        console.error('[codrawer] image update threw', slot, e)
      } finally {
        rt[slot] = performance.now() - t0
        lastPushAt[slot] = performance.now()
        sent[slot]++
        textDirty = true
      }
      slot = null
    }
  } finally {
    draining = false
  }
}

// Text rides the same link; only send it when the content actually changed,
// and never more than a couple of times a second.
let textChain: Promise<void> = Promise.resolve()
let lastTextSent = ''
let lastTextAt = 0
function pushText(b: EvenAppBridge, content: string) {
  if (content === lastTextSent) return
  if (performance.now() - lastTextAt < 500) return
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
  const now = performance.now()
  if (HAS_LOUPE && loupeDirty) {
    loupeDirty = false
    rasterize(lctx, store, loupeOpts())
    if (bridge) {
      pending.loupe = encode(lctx, LOUPE_W, LOUPE_H)
      void drain(bridge)
    }
  }
  // The canvas is expensive: refresh at stroke_end, or at most every CANVAS_MIN_MS
  // during a long stroke. With no loupe it is the only view, so refresh eagerly.
  const canvasDue = strokeEnded || !HAS_LOUPE || now - lastPushAt.canvas >= CANVAS_MIN_MS
  if (canvasDirty && canvasDue) {
    canvasDirty = false
    strokeEnded = false
    rasterize(ctx, store, opts)
    if (bridge) {
      pending.canvas = encode(ctx, IMG_W, IMG_H)
      void drain(bridge)
    }
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
  if (HAS_LOUPE) rasterize(lctx, store, loupeOpts())
  statusEl.textContent = `waiting for Even bridge… (${WS_URL})`
  const b = await Promise.race<EvenAppBridge | null>([
    waitForEvenAppBridge(),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 3000)),
  ])
  if (b && BENCH) {
    await runBench(b, (lines) => {
      statusEl.textContent = lines.join('\n')
      void b.textContainerUpgrade(new TextContainerUpgrade({ containerID: TEXT_ID, containerName: 'status', content: lines.slice(0, 9).join('\n') })).catch(() => {})
    })
    return
  }
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
    canvasDirty = true
    loupeDirty = true
    strokeEnded = true
    console.log('[codrawer] glasses page ready', { canvas: `${IMG_W}x${IMG_H}`, loupe: HAS_LOUPE ? `${LOUPE_W}x${LOUPE_H}` : 'off', fmt: FMT })
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
