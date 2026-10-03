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
import { LoupeCamera, packGray4, rasterize, StrokeStore, toBase64, toGray8, toPng1Bytes, toPngBase64, toPngBytes, type Highlight, type RasterOptions, type ViewMode } from './strokes'
import { runBench } from './bench'
import { Editor } from './editor'
import { CollabDoc } from './collab'
import { runProbe } from './probe'
import { Stage, type Theme, type View } from './stage'

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
// Dev server (simulator, QR sideload): the router runs on the same host. Packaged .ehpk: the
// address baked in at build time (vite.config.ts), since the package has no meaningful host.
const defaultWs = import.meta.env.DEV
  ? `ws://${location.hostname || 'localhost'}:8577/ws/session1`
  : __CODRAWER_WS__
const WS_URL = cfg('ws', defaultWs)

// ── display geometry (G2: 576x288; image containers max 288x144) ────────────
// Tunables: ?img=240x120 (canvas) ?loupe=128x64 (or 0 to disable) ?fmt=gray4
// ?frame_ms=60 (loupe floor) ?canvas_ms=1200 (canvas floor) ?ai=0 (hide AI ink)
const [IMG_W, IMG_H] = size('img', '288x144', 288, 144)
// The phone converts every frame to an uncompressed 4-bpp bitmap for the glasses, so the cost
// per send grows with the loupe's pixel area (~12 ms per KB of bitmap measured: 128x64 ≈ 4 KB ≈
// 200 ms, 288x144 ≈ 20 KB ≈ 400 ms), not with our PNG size. Up to 272x144 fits beside the canvas.
const [LOUPE_W, LOUPE_H] = size('loupe', '128x64', 272, 144)
const HAS_LOUPE = LOUPE_W > 0
const SCREEN_W = 576
const SCREEN_H = 288
const IMG_ID = 1
const TEXT_ID = 2
const LOUPE_ID = 3
const RENDER_INTERVAL_MS = 50
const LOUPE_MIN_MS = Number(cfg('frame_ms', '60')) || 60
const CANVAS_MIN_MS = Number(cfg('canvas_ms', '1200')) || 1200
const CANVAS_LULL_MS = Number(cfg('lull_ms', '600')) || 600
// png: base64 PNG string (the documented encoded-image path; tiny JSON, the host
// converts to Gray4). gray8 / gray4: raw pixel bytes as number[] (?enc=b64 as a
// base64 string of the raw bytes, which the phone host rejected on 2026-09-26).
// png1 (1-bit PNG) is ~4x smaller than the browser's PNG; measured on the device it does not
// lower the ~190 ms per-call floor but keeps the canvas send short (2026-10-02).
const FMT: 'png' | 'png1' | 'gray8' | 'gray4' = ((v) => (v === 'gray8' || v === 'gray4' || v === 'png' ? v : 'png1'))(cfg('fmt', 'png1'))
// Image updates allowed on the wire at once. Keep 1: the phone host answers sendFailed to
// overlapping updates (measured with inflight=2, 2026-10-02).
const INFLIGHT = Math.max(1, Math.min(4, Number(cfg('inflight', '1')) || 1))
const BINARIZE = cfg('binarize', '1') !== '0'
const SHOW_AI = cfg('ai', '0') !== '0'
// `?enc=b64` sends imageData as a base64 string across the WebView bridge. The
// simulator accepts it but the phone host answered sendFailed (2026-09-26), so the
// SDK's number[] marshaling stays the default; the bench compares both.
const ENC: 'b64' | 'array' = cfg('enc', 'array') === 'b64' ? 'b64' : 'array'
const BENCH = cfg('bench', '0') === '1'

// glasses contextual-menu item ids (non-zero, unique) → actions
const MENU = { newDrawing: 1, toggleAi: 2, toggleMode: 3, cycleHighlight: 4, zoomIn: 5, zoomOut: 6, clearAi: 7, textView: 8, sendDrawing: 9, editDoc: 10 } as const
const MENU_ACTION: Record<number, string> = {
  [MENU.newDrawing]: 'new-drawing',
  [MENU.editDoc]: 'edit-doc',
  [MENU.sendDrawing]: 'send-drawing',
  [MENU.textView]: 'text-view',
  [MENU.clearAi]: 'clear-ai',
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
const loupeCam = new LoupeCamera(LOUPE_H / Math.max(1, LOUPE_W), opts.pageAspect)
const LOUPE_CAM = cfg('loupe_cam', '1') !== '0' // 0: plain re-centring on the pen every frame
// loupe zoom relative to the default (set by dragging the loupe box on the phone)
let loupeZoom = Number(cfg('loupe_zoom', '1')) || 1
function loupeBase(): number {
  return opts.window * 0.45 * (LOUPE_W / 128) * loupeZoom
}
// The writing the loupe should keep in view: recent user strokes (last dozen, within ~12 s or still
// being drawn) near the pen, as one bounding box. null when there is none.
function writingContext(base: number): [number, number, number, number] | null {
  const pen = store.lastPoint
  if (!pen) return null
  const strokes = store.all()
  const now = Date.now()
  const reach = base * 2.5 // anything farther is a different place on the page
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  let seen = 0
  for (let i = strokes.length - 1; i >= 0 && seen < 12; i--) {
    const s = strokes[i]
    if (s.layer !== 'user' || s.pts.length === 0 || s.brush === 'eraser') continue
    seen++
    if (s.done && now - s.endedAt > 12_000) break // older than the current burst of writing
    const cx = (s.box[0] + s.box[2]) / 2
    const cy = (s.box[1] + s.box[3]) / 2
    if (Math.abs(cx - pen[0]) > reach || Math.abs(cy - pen[1]) > reach * 1.5) continue
    x0 = Math.min(x0, s.box[0])
    y0 = Math.min(y0, s.box[1])
    x1 = Math.max(x1, s.box[2])
    y1 = Math.max(y1, s.box[3])
  }
  return isFinite(x0) ? [x0, y0, x1, y1] : null
}

function loupeOpts(): RasterOptions {
  const base = loupeBase()
  if (!LOUPE_CAM) return { ...opts, width: LOUPE_W, height: LOUPE_H, mode: 'follow', window: base }
  const cam = loupeCam.update(store.lastPoint, base, performance.now(), writingContext(base))
  return { ...opts, width: LOUPE_W, height: LOUPE_H, mode: 'follow', window: cam.window, center: cam.center }
}

// ── state ───────────────────────────────────────────────────────────────────
const store = new StrokeStore()
const preview = document.getElementById('preview') as HTMLCanvasElement
const loupePreview = document.getElementById('loupe') as HTMLCanvasElement
const statusEl = document.getElementById('status') as HTMLDivElement
// Glasses state shown on the phone page above the status line (it is otherwise overwritten).
let glassesState = 'waiting for the Even bridge…'

// Dev builds mirror console output to the dev server (vite.config.ts → .codrawer/logs/phone.log),
// so device problems can be read on the desktop without a phone debugger.
if (import.meta.env.DEV) {
  const post = (level: string, args: unknown[]) => {
    const text = args.map((a) => (typeof a === 'string' ? a : (() => { try { return JSON.stringify(a) } catch { return String(a) } })())).join(' ')
    void fetch('/__log', { method: 'POST', body: `${level} ${text}`.slice(0, 2000), keepalive: true }).catch(() => {})
  }
  for (const level of ['log', 'warn', 'error'] as const) {
    const orig = console[level].bind(console)
    console[level] = (...args: unknown[]) => {
      orig(...args)
      if (typeof args[0] === 'string' && args[0].startsWith('[EvenAppBridge]')) return // noisy
      post(level, args)
    }
  }
  window.addEventListener('error', (e) => post('error', ['window.onerror', e.message, `${e.filename}:${e.lineno}`]))
  window.addEventListener('unhandledrejection', (e) => post('error', ['unhandledrejection', String(e.reason)]))
  post('log', ['[codrawer] page loaded', navigator.userAgent, location.href])
}
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

// ── phone screen (stage.ts) ─────────────────────────────────────────────────
// The whole page at full resolution, live, on paper or dark: what you look at (or project).
// The glasses previews above stay in a "Glasses" panel for diagnostics.
const stage = new Stage(document.getElementById('stage') as HTMLCanvasElement, store, opts.pageAspect)
stage.showAi = opts.showAi !== false
const themeBtn = document.getElementById('themeBtn') as HTMLButtonElement
const connEl = document.getElementById('conn') as HTMLSpanElement
function applyTheme(t: Theme) {
  stage.setTheme(t)
  document.documentElement.dataset.theme = t
  // the icon shows where a tap goes: a moon on paper, a sun in the dark
  themeBtn.innerHTML = t === 'paper' ? '<svg viewBox="0 0 24 24"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/></svg>' : '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>'
  themeBtn.title = t === 'paper' ? 'Dark theme' : 'Paper theme'
  try {
    localStorage.setItem('codrawer:theme', t)
  } catch {
    /* ignore */
  }
}
applyTheme(cfg('theme', 'paper') === 'dark' ? 'dark' : 'paper')
themeBtn.onclick = () => applyTheme(stage.theme === 'paper' ? 'dark' : 'paper')
;(document.getElementById('debugBtn') as HTMLButtonElement).onclick = (e) => {
  const on = document.body.classList.toggle('debug')
  ;(e.currentTarget as HTMLButtonElement).setAttribute('aria-pressed', String(on))
}
// tap the page to hide the bar (clean projection); tap again to bring it back
;(document.getElementById('stage') as HTMLCanvasElement).onclick = () => {
  if (stage.consumeDrag()) return // that was a resize of the loupe box
  document.body.classList.toggle('chromeless')
}
// The loupe's view, drawn on the phone (Fit/Page views) as a dashed box; drag its corner to zoom
// the loupe (remembered).
stage.loupeRect = () => (HAS_LOUPE && LOUPE_CAM && store.lastPoint ? loupeCam.rect() : null)
stage.onLoupeResize = (w) => {
  // the box's width is the camera's window (base × speed zoom): set the base so it lands there
  loupeZoom = Math.min(6, Math.max(0.15, w / loupeBase()))
  try {
    localStorage.setItem('codrawer:loupe_zoom', loupeZoom.toFixed(3))
  } catch {
    /* ignore */
  }
  loupeDirty = true
}
const viewButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('.seg button[data-view]'))
// The phone view mirrors the glasses: a ring tap (follow ↔ full) and ring zoom change both. The
// Follow · Fit · Page control sets the phone alone (until the next ring action).
function applyView(v: View) {
  stage.followWindow = opts.window
  stage.setView(v)
  for (const b of viewButtons) b.setAttribute('aria-pressed', String(b.dataset.view === v))
}
function viewFromGlasses(): View {
  return opts.mode === 'follow' ? 'follow' : 'focus'
}
// start in step with the glasses; ?stage=page|focus|follow overrides for this load only
applyView(((v) => (v === 'page' || v === 'focus' || v === 'follow' ? v : viewFromGlasses()))(params.get('stage')))
for (const b of viewButtons) b.onclick = () => applyView(b.dataset.view as View)

// ── camera: draw over the world ─────────────────────────────────────────────
// Live video from the back camera behind the ink (getUserMedia). If the WebView will not grant
// live video, fall back to the Even app's own camera (a still photo via the SDK).
let evenSdk: EvenAppBridge | null = null // the SDK bridge, even when the glasses page is not up
const camBtn = document.getElementById('camBtn') as HTMLButtonElement
const freezeBtn = document.getElementById('freezeBtn') as HTMLButtonElement
const video = document.getElementById('camera') as HTMLVideoElement
let camStream: MediaStream | null = null

function stopCamera() {
  camStream?.getTracks().forEach((t) => t.stop())
  camStream = null
  video.srcObject = null
  stage.setBackdrop(null)
  camBtn.setAttribute('aria-pressed', 'false')
  camBtn.title = 'Draw over the camera'
  freezeBtn.hidden = true
}

async function startCamera() {
  camBtn.title = 'Starting the camera…'
  try {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('getUserMedia unavailable')
    camStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false,
    })
    video.srcObject = camStream
    await video.play()
    stage.setBackdrop(video)
    camBtn.setAttribute('aria-pressed', 'true')
    camBtn.title = 'Back to paper'
    freezeBtn.hidden = false
    freezeBtn.setAttribute('aria-pressed', 'false')
    console.log('[codrawer] camera live', video.videoWidth, 'x', video.videoHeight)
    return
  } catch (e) {
    console.warn('[codrawer] live camera unavailable; trying a photo', String(e))
  }
  try {
    const shot = evenSdk ? await evenSdk.captureImageFromCamera() : null
    if (!shot?.base64) throw new Error(evenSdk ? 'no photo taken' : 'no Even bridge')
    const img = new Image()
    img.src = shot.base64.startsWith('data:') ? shot.base64 : `data:${shot.mimeType || 'image/jpeg'};base64,${shot.base64}`
    await img.decode()
    stage.setBackdrop(img)
    camBtn.setAttribute('aria-pressed', 'true')
    camBtn.title = 'Back to paper'
    console.log('[codrawer] camera photo', img.naturalWidth, 'x', img.naturalHeight)
  } catch (e) {
    console.warn('[codrawer] camera unavailable', String(e))
    camBtn.title = 'Camera unavailable'
    notice = 'camera unavailable'
  }
}
camBtn.onclick = () => (stage.hasBackdrop ? stopCamera() : void startCamera())
// Freeze holds the current frame so you can draw over a moment; tap again to go live.
freezeBtn.onclick = () => {
  if (video.paused) {
    void video.play()
    freezeBtn.setAttribute('aria-pressed', 'false')
  } else {
    video.pause()
    freezeBtn.setAttribute('aria-pressed', 'true')
  }
  stage.touch()
}

// Keep the phone screen on while this page is visible (presenting). The lock is released by
// the browser whenever the page is hidden, so take it again on every return.
async function keepAwake() {
  try {
    const nav = navigator as Navigator & { wakeLock?: { request(type: 'screen'): Promise<unknown> } }
    if (!nav.wakeLock || document.visibilityState !== 'visible') return
    await nav.wakeLock.request('screen')
    console.log('[codrawer] screen wake lock held')
  } catch (e) {
    console.warn('[codrawer] screen wake lock unavailable', String(e))
  }
}
void keepAwake()
document.addEventListener('visibilitychange', () => void keepAwake())

// Tablet notices from the router's hello (boot.sh on the tablet: OS version, codrawer release,
// the previous OS after an update, whether this OS is one codrawer was tested on).
const banner = document.getElementById('banner') as HTMLDivElement
function tabletNotice(t: Record<string, string>) {
  let text = ''
  let key = ''
  if (t.osChangedFrom && t.os) {
    text = `Tablet updated ${t.osChangedFrom} → ${t.os} · codrawer restored`
    key = `os:${t.osChangedFrom}>${t.os}`
  }
  if (t.osTested === '0' && t.os) {
    text = `${text ? text + ' · ' : ''}codrawer is not yet tested on OS ${t.os}; experimental features stay off`
    key ||= `untested:${t.os}`
  }
  if (!text) return
  try {
    if (localStorage.getItem('codrawer:notice') === key) return // already acknowledged
  } catch {
    /* ignore */
  }
  ;(document.getElementById('bannerText') as HTMLSpanElement).textContent = text
  banner.hidden = false
  ;(document.getElementById('bannerOk') as HTMLButtonElement).onclick = () => {
    banner.hidden = true
    try {
      localStorage.setItem('codrawer:notice', key)
    } catch {
      /* ignore */
    }
  }
  console.log('[codrawer] tablet notice:', text, t)
}

function setConn(live: boolean) {
  connEl.classList.toggle('live', live)
  ;(connEl.querySelector('span') ?? connEl).textContent = live ? 'live' : 'reconnecting'
}

let intent = ''
let connected = false
let bridge: EvenAppBridge | null = null
let textDirty = true
let canvasDirty = true
let loupeDirty = true
let strokeEnded = false
let strokeActive = false
let lastInkAt = 0 // performance.now() of the last stroke message; text waits for a lull
let lastImageResult = ''
const rt = { loupe: 0, canvas: 0 }
const sent = { loupe: 0, canvas: 0 }

// ── typing: keyboard bridged from the tablet ────────────────────────────────
// `key` messages carry one key-down each; the app owns line editing. Enter
// commits the line to the transcript; a leading slash makes it a command:
//   /hw <text>     ask the AI to handwrite <text> on the canvas (prompt, mode handwriting)
//   /draw <text>   ask the AI to draw <text>                    (prompt, mode draw)
//   /new           new drawing (clears every client)
//   /ai            toggle the AI ghost layer
//   /text          toggle the full-screen text view
//   /clear         clear the transcript
type PageMode = 'canvas' | 'text' | 'edit'
let pageMode: PageMode = ((v) => (v === 'text' || v === 'edit' ? v : 'canvas'))(cfg('view', 'canvas'))

// ── document editor (edit view) ─────────────────────────────────────────────
// A real buffer with a cursor. In edit view plain keys edit the document;
// Ctrl+K opens the command line over it (same commands as everywhere),
// Ctrl+S saves and shares it with the session, Ctrl+E leaves edit view.
const editor = new Editor()
let cmdOverlay = false // command line shown over the editor
let docSavedText = ''
let docChangedAt = 0
let docSyncedAt = 0
// Shared live editing (collab.ts): the editor's text is a Yjs CRDT synced through the router.
const collab = new CollabDoc(editor, (msg) => {
  if (!socket || socket.readyState !== WebSocket.OPEN) return false
  socket.send(JSON.stringify(msg))
  return true
})
collab.onRemoteChange = () => {
  textDirty = true
  persistDoc()
}
try {
  const state = localStorage.getItem('codrawer:ydoc')
  const saved = localStorage.getItem('codrawer:doc')
  if (state) collab.load(state)
  else if (saved) {
    // first run after the switch to live editing: adopt the plain-text document
    editor.setText(saved)
    collab.commitLocal()
  }
  docSavedText = editor.text()
} catch {
  /* ignore */
}

/** Keep the CRDT state (and a plain-text copy) in local storage. */
function persistDoc() {
  const text = editor.text()
  const state = collab.state()
  try {
    localStorage.setItem('codrawer:doc', text)
    localStorage.setItem('codrawer:ydoc', state)
  } catch {
    /* ignore */
  }
  // the Even bridge's storage survives EHPK packaging where WebView localStorage may not
  if (bridge) {
    void bridge.setLocalStorage('doc', text).catch(() => {})
    void bridge.setLocalStorage('ydoc', state).catch(() => {})
  }
}

function saveDoc(reason: string) {
  collab.commitLocal()
  const text = editor.text()
  docSavedText = text
  editor.dirty = false
  persistDoc()
  // Edits already travel live as doc_update; this plain-text copy is for the desktop router,
  // which writes it to .codrawer/doc.md for the terminal agent. crdt:true tells live-editing
  // clients to ignore it (they have the same text already).
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ t: 'doc', text, crdt: true, cursor: { line: editor.row + 1, col: editor.col + 1 }, reason, ts: Date.now() }))
    docSyncedAt = performance.now()
  }
}

function editorKey(key: string, ch: string, mods: { ctrl?: boolean; alt?: boolean; meta?: boolean }): boolean {
  if (mods.ctrl) {
    switch (key.toLowerCase()) {
      case 'k':
        cmdOverlay = true
        inputLine = ''
        return true
      case 's':
        saveDoc('save')
        notice = 'saved'
        return true
      case 'e':
        void setPageMode(bridge, 'text')
        return true
      case 'arrowleft':
        editor.wordLeft()
        return true
      case 'arrowright':
        editor.wordRight()
        return true
      case 'home':
        editor.row = 0
        editor.col = 0
        return true
      case 'end':
        editor.row = editor.lines.length - 1
        editor.end()
        return true
      default:
        return false
    }
  }
  if (ch) editor.insert(ch)
  else if (key === 'Enter') editor.newline()
  else if (key === 'Backspace') editor.backspace()
  else if (key === 'Delete') editor.delete()
  else if (key === 'ArrowLeft') editor.left()
  else if (key === 'ArrowRight') editor.right()
  else if (key === 'ArrowUp') editor.up()
  else if (key === 'ArrowDown') editor.down()
  else if (key === 'Home') editor.home()
  else if (key === 'End') editor.end()
  else if (key === 'PageUp') editor.pageUp(6)
  else if (key === 'PageDown') editor.pageDown(6)
  else if (key === 'Tab') editor.insert('  ')
  else if (key === 'Escape') {
    notice = ''
  } else return false
  if (editor.dirty) {
    docChangedAt = performance.now()
    collab.commitLocal() // live: every keystroke reaches the other editors within ~40 ms
  }
  return true
}
let inputLine = ''
const transcript: string[] = []
const TRANSCRIPT_MAX = 80
let typingAt = 0 // performance.now() of the last keystroke
let scrollBack = 0 // lines of transcript hidden below the view (0 = newest)
let notice = '' // one-line feedback for commands

// ── terminal (even-terminal via the router's term bridge) ───────────────────
//   /term <text>   send one instruction to the terminal session
//   /mode term     plain lines go to the terminal until /mode ink
//   y | a | n      answer a pending permission; any line answers a pending question
type LineMode = 'ink' | 'term'
let lineMode: LineMode = 'ink'
let termPending: 'permission' | 'question' | null = null
let termStream = '' // assistant text still being streamed (not yet a transcript line)
let termAt = 0

function pushTranscript(line: string) {
  for (const l of line.split('\n')) {
    if (!l.trim()) continue
    transcript.push(l.slice(0, 200))
  }
  while (transcript.length > TRANSCRIPT_MAX) transcript.shift()
  scrollBack = 0
}

function handleTerm(m: { kind?: string; text?: string }) {
  const text = typeof m.text === 'string' ? m.text : ''
  termAt = performance.now()
  typingAt = termAt // keep the transcript view open while the terminal talks
  switch (m.kind) {
    case 'text': {
      termStream += text
      // break streamed text into transcript lines at newlines; keep the tail live
      const parts = termStream.split('\n')
      termStream = parts.pop() ?? ''
      for (const p of parts) pushTranscript(p)
      if (termStream.length > 90) {
        const cut = termStream.lastIndexOf(' ', 80)
        const head = cut > 30 ? termStream.slice(0, cut) : termStream.slice(0, 80)
        pushTranscript(head)
        termStream = termStream.slice(head.length).trimStart()
      }
      break
    }
    case 'permission':
      flushTermStream()
      termPending = 'permission'
      pushTranscript(text)
      break
    case 'question':
      flushTermStream()
      termPending = 'question'
      pushTranscript(text)
      break
    case 'note':
      flushTermStream()
      if (text.startsWith('→ ') || text.startsWith('— done')) termPending = null
      pushTranscript(text)
      break
    case 'status':
      flushTermStream()
      notice = text
      break
    default:
      return
  }
  textDirty = true
}

function flushTermStream() {
  if (termStream.trim()) pushTranscript(termStream)
  termStream = ''
}

function sendTerm(kind: 'term_prompt' | 'term_answer', text: string) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    // from the editor, the document rides along as context for the agent
    const context = pageMode === 'edit' ? 'doc' : undefined
    if (context && editor.dirty) saveDoc('prompt')
    socket.send(JSON.stringify({ t: kind, text, context, ts: Date.now() }))
  } else notice = 'not connected'
}

function isTyping(): boolean {
  return inputLine.length > 0 || performance.now() - typingAt < 15000 || termStream.length > 0
}

function commitLine(raw: string) {
  const line = raw.trim()
  if (!line) return
  transcript.push(line)
  while (transcript.length > TRANSCRIPT_MAX) transcript.shift()
  scrollBack = 0
  const [cmd, ...rest] = line.split(/\s+/)
  const arg = rest.join(' ')
  const send = (o: Record<string, unknown>) => {
    if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ ...o, ts: Date.now() }))
  }
  // A pending terminal permission/question takes the whole line, whatever the mode.
  if (termPending) {
    sendTerm('term_answer', line)
    termPending = null
    return
  }
  if (!line.startsWith('/') && lineMode === 'term') {
    sendTerm('term_prompt', line)
    return
  }
  switch (cmd.toLowerCase()) {
    case '/term':
    case '/t':
      if (arg) sendTerm('term_prompt', arg)
      notice = arg ? '' : 'usage: /term <instruction>'
      break
    case '/snap':
      // whole page attached, whatever was drawn this turn
      if (socket && socket.readyState === WebSocket.OPEN)
        socket.send(JSON.stringify({ t: 'term_prompt', text: arg || 'Look at the attached drawing and describe what you see.', attach: 'page', ts: Date.now() }))
      break
    case '/mode':
      lineMode = arg.toLowerCase() === 'term' ? 'term' : 'ink'
      notice = `mode: ${lineMode}`
      break
    case '/hw':
    case '/write':
      if (arg) send({ t: 'prompt', text: arg, mode: 'handwriting' })
      notice = arg ? `AI: writing "${arg.slice(0, 40)}"` : 'usage: /hw <text>'
      break
    case '/draw':
    case '/d':
      if (arg) send({ t: 'prompt', text: arg, mode: 'draw' })
      notice = arg ? `AI: drawing "${arg.slice(0, 40)}"` : 'usage: /draw <text>'
      break
    case '/new':
      applyAction('new-drawing')
      notice = 'new drawing'
      break
    case '/ai':
      applyAction('toggle-ai')
      notice = opts.showAi === false ? 'AI ghost off' : 'AI ghost on'
      break
    case '/text':
      applyAction('text-view')
      break
    case '/clear':
      transcript.length = 0
      notice = 'transcript cleared'
      break
    case '/edit':
      if (bridge) void setPageMode(bridge, pageMode === 'edit' ? 'text' : 'edit')
      else {
        pageMode = pageMode === 'edit' ? 'text' : 'edit'
        textDirty = true
      }
      break
    case '/doc':
      if (arg.toLowerCase() === 'new') {
        editor.setText('')
        editor.dirty = true
        collab.commitLocal() // clears it for everyone editing the session document
        docChangedAt = performance.now()
        notice = 'new document'
      } else {
        saveDoc('share')
        notice = `document shared (${editor.text().length} chars)`
      }
      break
    default:
      notice = ''
  }
}

function handleKey(m: { key?: string; char?: string; mods?: { ctrl?: boolean; alt?: boolean; meta?: boolean } }) {
  const key = String(m.key || '')
  const ch = typeof m.char === 'string' ? m.char : ''
  const mods = m.mods || {}
  typingAt = performance.now()
  if (pageMode === 'edit' && !cmdOverlay) {
    if (editorKey(key, ch, mods)) textDirty = true
    return
  }
  if (pageMode === 'edit' && cmdOverlay && key === 'Escape') {
    cmdOverlay = false
    inputLine = ''
    textDirty = true
    return
  }
  const sugg = suggestions()
  if (mods.ctrl && key.toLowerCase() === 'l') {
    transcript.length = 0
  } else if (sugg.length && (key === 'Tab' || key === 'ArrowRight')) {
    // complete the highlighted command; a trailing space invites the argument
    const pick = sugg[Math.min(suggestIndex, sugg.length - 1)]
    inputLine = pick.name + ' '
    suggestIndex = 0
  } else if (sugg.length && (key === 'ArrowUp' || key === 'ArrowDown')) {
    suggestIndex = (suggestIndex + (key === 'ArrowDown' ? 1 : sugg.length - 1)) % sugg.length
  } else if (sugg.length && key === 'Enter' && sugg.length === 1 && inputLine !== sugg[0].name) {
    inputLine = sugg[0].name + ' '
    suggestIndex = 0
  } else if (ch) {
    inputLine += ch
    suggestIndex = 0
  } else if (key === 'Backspace') {
    inputLine = inputLine.slice(0, -1)
    suggestIndex = 0
  } else if (key === 'Enter') {
    commitLine(inputLine)
    inputLine = ''
    suggestIndex = 0
    if (pageMode === 'edit') cmdOverlay = false // one command, then back to the document
  } else if (key === 'Escape') {
    inputLine = ''
    notice = ''
    suggestIndex = 0
  } else if (key === 'ArrowUp' || key === 'PageUp') {
    scrollBack = Math.min(Math.max(0, transcript.length - 1), scrollBack + (key === 'PageUp' ? 5 : 1))
  } else if (key === 'ArrowDown' || key === 'PageDown') {
    scrollBack = Math.max(0, scrollBack - (key === 'PageDown' ? 5 : 1))
  } else {
    return
  }
  textDirty = true
}

// ── slash-command completion ────────────────────────────────────────────────
const COMMANDS: { name: string; help: string }[] = [
  { name: '/term', help: 'send an instruction to the terminal (+ this turn\'s ink)' },
  { name: '/snap', help: 'send the whole page to the terminal' },
  { name: '/mode', help: 'ink | term: where plain lines go' },
  { name: '/hw', help: 'AI handwrites text on the canvas' },
  { name: '/draw', help: 'AI draws text' },
  { name: '/new', help: 'new drawing for every client' },
  { name: '/ai', help: 'toggle the AI ghost layer' },
  { name: '/text', help: 'toggle full-screen text view' },
  { name: '/clear', help: 'clear the transcript' },
  { name: '/edit', help: 'edit the document (Ctrl+K commands, Ctrl+S save, Ctrl+E leave)' },
  { name: '/doc', help: 'share the document with the session (/doc new clears it)' },
]
let suggestIndex = 0

/** Commands matching the input while it is still a bare `/word` (no space yet). */
function suggestions(): { name: string; help: string }[] {
  if (!inputLine.startsWith('/') || inputLine.includes(' ')) return []
  const prefix = inputLine.toLowerCase()
  return COMMANDS.filter((c) => c.name.startsWith(prefix))
}

// ── layout for a proportional font with no measurement API ─────────────────
// The glasses wrap at container width (~560 px usable). Wrapping happens on the
// device, so every wrapped row eats a row of the budget; we wrap conservatively
// ourselves and fill rows from the bottom so the input line is always visible.
const COLS = 44
function wrapLine(s: string, cols = COLS): string[] {
  const out: string[] = []
  let rest = s
  while (rest.length > cols) {
    let cut = rest.lastIndexOf(' ', cols)
    if (cut < cols * 0.5) cut = cols
    out.push(rest.slice(0, cut).trimEnd())
    rest = rest.slice(cut).trimStart()
  }
  out.push(rest)
  return out
}

function metricsLine(): string {
  const conn = connected ? 'live' : 'reconnecting'
  const c = store.counts()
  const ai = opts.showAi === false ? 'ai off' : `${c.ai} ai`
  const l = HAS_LOUPE ? ` · L${Math.round(rt.loupe)}ms/${sent.loupe}` : ''
  const k = ` · C${Math.round(rt.canvas)}ms/${sent.canvas}`
  const bad = lastImageResult && lastImageResult !== 'success' ? ' · img:' + lastImageResult : ''
  return `${c.user} user · ${ai} · ${opts.mode} · ${conn}${l}${k}${bad}`
}

/** The text container's content for the current layout and activity. */
function renderText(): string {
  // Row budget: 288 px tall page at ~27 px per row minus padding → 9 rows; the
  // canvas layout's strip below the images holds 4.
  if (pageMode === 'edit') {
    const total = 9
    const overlayRows = cmdOverlay ? 1 : 0
    const v = editor.view(total - 1 - overlayRows, COLS)
    const state = connected ? 'live' : 'offline'
    const head = notice || `doc · Ln ${v.line}, Col ${v.col} · ${v.totalLines} lines · ${state}`
    const out = [head.slice(0, COLS), ...v.rows]
    while (out.length < total - overlayRows) out.push('')
    if (cmdOverlay) {
      const prompt = termPending ? (termPending === 'permission' ? 'y/a/n' : '?') : lineMode === 'term' ? '$' : '>'
      out.push(wrapLine(`${prompt} ${inputLine}▌`).slice(-1)[0])
    }
    return out.join('\n').slice(0, 1900)
  }
  const rows = pageMode === 'text' ? 9 : 4
  if (pageMode === 'canvas' && !isTyping()) {
    const head = intent && opts.showAi !== false ? `AI: ${intent}` : metricsLine()
    const foot = intent && opts.showAi !== false ? metricsLine() : notice
    return foot ? `${head}\n${foot}` : head
  }

  // Bottom-up fill: input line (always), then completion popup, then the live
  // terminal tail, then transcript lines newest-first, until the budget is spent.
  const bottom: string[] = []
  const prompt = termPending === 'permission' ? 'y/a/n' : termPending === 'question' ? '?' : lineMode === 'term' ? '$' : '>'
  const inputRows = wrapLine(`${prompt} ${inputLine}▌${scrollBack ? `  ↑${scrollBack}` : ''}`)
  bottom.push(...inputRows.slice(-2)) // never more than two rows of input

  const sugg = suggestions()
  if (sugg.length) {
    const max = pageMode === 'text' ? 5 : 2
    const start = Math.max(0, Math.min(suggestIndex, sugg.length - max))
    const shown = sugg.slice(start, start + max)
    const popup = shown.map((c, i) => `${start + i === suggestIndex ? '▸' : ' '} ${c.name}  ${c.help}`.slice(0, COLS))
    bottom.unshift(...popup)
  }

  let budget = rows - bottom.length
  const above: string[] = []
  if (termStream && budget > 0) {
    const tail = wrapLine(termStream)
    const take = tail.slice(-Math.min(2, budget))
    above.unshift(...take)
    budget -= take.length
  }
  const end = Math.max(0, transcript.length - scrollBack)
  for (let i = end - 1; i >= 0 && budget > 0; i--) {
    const w = wrapLine(transcript[i])
    const take = w.slice(-budget)
    above.unshift(...take)
    budget -= take.length
  }
  if (pageMode === 'text' && budget > 0) {
    // spare rows: pin a header with the notice or the metrics
    above.unshift(notice || (intent && opts.showAi !== false ? `AI: ${intent}` : metricsLine()))
    budget--
  } else if (pageMode === 'canvas' && notice && budget > 0) {
    above.unshift(notice)
    budget--
  }
  return [...above, ...bottom].join('\n').slice(0, 1900)
}

// ── websocket (codrawer protocol) ───────────────────────────────────────────
let socket: WebSocket | null = null
// Reconnect with capped backoff. Liveness: a router that sends app-level pings (the tablet's Go
// router) must be heard from every PING_DEAD_MS, otherwise the socket is presumed dead (a phone
// that changed networks keeps a half-open socket and would show "live" forever). Routers that
// never ping (the desktop Python router) are not timed out.
const PING_DEAD_MS = 25_000
let retryMs = 800
let lastHeardAt = 0
let routerPings = false

function connect() {
  let ws: WebSocket
  try {
    ws = new WebSocket(WS_URL)
  } catch (e) {
    console.error('[codrawer] bad router URL', WS_URL, e)
    setTimeout(connect, (retryMs = Math.min(5000, retryMs * 1.6)))
    return
  }
  socket = ws
  ws.onopen = () => {
    connected = true
    retryMs = 800
    setConn(true)
    lastHeardAt = performance.now()
    routerPings = false
    textDirty = true
    collab.announce() // merge anything edited while offline; the router replays the rest
    console.log('[codrawer] connected', WS_URL)
  }
  ws.onclose = () => {
    if (socket !== ws) return
    connected = false
    setConn(false)
    strokeActive = false // a stroke cut off by the disconnect must not hold text updates
    store.endOpen() // and never gets its stroke_end
    stage.touch()
    textDirty = true
    setTimeout(connect, retryMs)
    retryMs = Math.min(5000, retryMs * 1.6)
  }
  ws.onmessage = (ev) => {
    lastHeardAt = performance.now()
    let m: any
    try {
      m = JSON.parse(String(ev.data))
    } catch {
      return
    }
    switch (m.t) {
      case 'hello':
        if (m.tablet && typeof m.tablet === 'object') tabletNotice(m.tablet)
        // A router that replays the page (the tablet's) is the source of truth: start from its
        // replay instead of merging it into whatever we had before the disconnect.
        if (m.replay) {
          store.clear()
          stage.invalidate()
          canvasDirty = true
          strokeEnded = true
        }
        break
      case 'ping':
        routerPings = true
        break
      case 'cursor':
        // the pen hovering over the tablet (bridge hover); a pointer on the phone screen
        if (m.gone) stage.setPointer(null)
        else if (typeof m.x === 'number' && typeof m.y === 'number') stage.setPointer(m.x, m.y, m.tool === 'eraser' ? 'eraser' : 'pen')
        break
      case 'stroke_begin':
        // no frame yet: the first stroke_pts carries the first ink
        store.begin(m.id, 'user', m.brush || 'pen')
        strokeActive = true
        lastInkAt = performance.now()
        stage.setPointer(null) // the ink itself shows the pen now
        break
      case 'stroke_pts':
        store.points(m.id, m.pts || [], 'user')
        stage.touch()
        lastInkAt = performance.now()
        loupeDirty = true
        canvasDirty = true
        break
      case 'stroke_end':
        store.end(m.id)
        stage.touch()
        strokeActive = false
        lastInkAt = performance.now()
        canvasDirty = true // the loupe already shows the last points
        strokeEnded = true
        textDirty = true
        break
      case 'ai_stroke_begin':
        store.begin(m.id, 'ai', m.brush || 'ghost')
        break
      case 'ai_stroke_pts':
        store.points(m.id, m.pts || [], 'ai')
        stage.touch()
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
      case 'clear':
        // another client started a new drawing
        store.clear()
        stage.invalidate()
        intent = ''
        loupeDirty = true
        canvasDirty = true
        strokeEnded = true
        textDirty = true
        break
      case 'key':
        handleKey(m)
        break
      case 'doc_update':
        collab.applyRemote(Array.isArray(m.us) ? m.us : typeof m.u === 'string' ? [m.u] : [])
        break
      case 'doc_compact':
        collab.answerCompact()
        break
      case 'doc':
        // A plain-text document from a participant without live editing (e.g. an agent):
        // fold it in as an ordinary edit. Live-editing clients mark their copies crdt:true.
        if (typeof m.text === 'string' && !m.crdt) {
          collab.replaceWith(m.text)
          editor.setText(m.text)
          docSavedText = m.text
          persistDoc()
          notice = 'document updated'
          textDirty = true
        }
        break
      case 'term':
        handleTerm(m)
        break
      default:
        break
    }
  }
}

// ── glasses page ────────────────────────────────────────────────────────────
/** Container set for a layout: canvas + loupe + status text, or one full-screen text. */
function buildPage(mode: PageMode) {
  const menuObject = new MenuContainerProperty({
    menuItems: [
      new MenuItemProperty({ itemName: 'New drawing', itemID: MENU.newDrawing }),
      new MenuItemProperty({ itemName: 'Send drawing to agent', itemID: MENU.sendDrawing }),
      new MenuItemProperty({ itemName: mode === 'text' ? 'Canvas view' : 'Text view', itemID: MENU.textView }),
      new MenuItemProperty({ itemName: mode === 'edit' ? 'Leave editor' : 'Edit document', itemID: MENU.editDoc }),
      new MenuItemProperty({ itemName: 'Toggle AI ghost', itemID: MENU.toggleAi }),
      new MenuItemProperty({ itemName: 'Follow / fit page', itemID: MENU.toggleMode }),
      new MenuItemProperty({ itemName: 'Cycle emphasis', itemID: MENU.cycleHighlight }),
      new MenuItemProperty({ itemName: 'Zoom in', itemID: MENU.zoomIn }),
      new MenuItemProperty({ itemName: 'Zoom out', itemID: MENU.zoomOut }),
      new MenuItemProperty({ itemName: 'Clear AI ink', itemID: MENU.clearAi }),
    ],
  })
  if (mode === 'text' || mode === 'edit') {
    const textObject = [
      new TextContainerProperty({
        xPosition: 8,
        yPosition: 4,
        width: SCREEN_W - 16,
        height: SCREEN_H - 8,
        containerID: TEXT_ID,
        containerName: 'status',
        content: renderText(),
        textColor: 4,
        isEventCapture: 1,
      }),
    ]
    return { containerTotalNum: 1, textObject, menuObject }
  }
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
  return { containerTotalNum: imageObject.length + textObject.length, imageObject, textObject, menuObject }
}

/** Switch layouts with one rebuild (~165 ms); image pushes pause while in text view. */
async function setPageMode(b: EvenAppBridge | null, mode: PageMode) {
  if (mode === pageMode) return
  if (mode === 'edit' && pageMode !== 'edit') saveDoc('enter')
  if (pageMode === 'edit' && mode !== 'edit') {
    if (editor.dirty) saveDoc('leave')
    cmdOverlay = false
  }
  pageMode = mode
  try {
    localStorage.setItem('codrawer:view', mode)
  } catch {
    /* ignore */
  }
  pending.loupe = null
  pending.canvas = null
  if (!b) {
    textDirty = true
    return
  }
  // never rebuild the page under an image update that is still on the wire
  while (draining || inFlight) await new Promise((r) => setTimeout(r, 10))
  lastFrame.loupe = lastFrame.canvas = null // the rebuild blanks the containers
  const ok = await b.rebuildPageContainer(new RebuildPageContainer(buildPage(mode)))
  console.log('[codrawer] page mode', mode, ok ? 'ok' : 'rebuild failed')
  lastTextSent = '' // the rebuild carried fresh content; resend on next change
  if (mode === 'canvas') {
    canvasDirty = true
    loupeDirty = true
    strokeEnded = true
  }
  textDirty = true
}

function applyAction(action: string) {
  if (action === 'send-drawing') {
    commitLine('/snap')
    typingAt = performance.now()
    textDirty = true
    return
  }
  if (action === 'edit-doc') {
    if (bridge) void setPageMode(bridge, pageMode === 'edit' ? 'text' : 'edit')
    return
  }
  if (action === 'new-drawing') {
    // wipe locally and tell the session so every client starts fresh
    store.clear()
    stage.invalidate()
    intent = ''
    if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ t: 'clear', ts: Date.now() }))
  } else if (action === 'clear-ai') {
    store.clear('ai')
    stage.invalidate()
    intent = ''
  } else if (action === 'toggle-ai') {
    opts.showAi = !opts.showAi
    stage.showAi = opts.showAi
    stage.invalidate()
    try {
      localStorage.setItem('codrawer:ai', opts.showAi ? '1' : '0')
    } catch {
      /* ignore */
    }
  } else if (action === 'text-view') {
    if (bridge) void setPageMode(bridge, pageMode === 'text' ? 'canvas' : 'text')
    return
  } else if (action === 'toggle-mode') opts.mode = opts.mode === 'follow' ? 'full' : 'follow'
  else if (action === 'cycle-highlight') opts.highlight = opts.highlight === 'all' ? 'user' : opts.highlight === 'user' ? 'ai' : 'all'
  else if (action === 'zoom-in') opts.window = Math.max(0.06, opts.window * 0.8)
  else if (action === 'zoom-out') opts.window = Math.min(1, opts.window * 1.25)
  if (action === 'toggle-mode' || action === 'zoom-in' || action === 'zoom-out') {
    applyView(viewFromGlasses()) // the phone follows the ring too
  }
  canvasDirty = true
  loupeDirty = true
  strokeEnded = true // force a canvas refresh for the new view
  textDirty = true
}

async function initGlasses(b: EvenAppBridge): Promise<boolean> {
  const page = buildPage(pageMode)
  const result = await b.createStartUpPageContainer(new CreateStartUpPageContainer(page))
  if (result !== StartUpPageCreateResult.success) {
    // A page already exists: the app was reopened from the Even Hub tab while its
    // previous page was still registered, or the WebView hot-reloaded. Rebuild it in
    // place with the same container set. Never call shutDownPageContainer here: on
    // the device that exits the whole app (seen 2026-09-27 as "tapping the app
    // closes it").
    const rebuilt = await b.rebuildPageContainer(new RebuildPageContainer(page))
    console.warn('[codrawer] startup page create returned', result, '→ rebuild', rebuilt)
    if (!rebuilt) {
      glassesState = `glasses page failed: create=${String(result)} rebuild=${String(rebuilt)}`
      console.error('[codrawer]', glassesState)
      return false
    }
  }
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
    // In text view the ring scrolls the transcript; in edit view it moves the cursor by line.
    if ((pageMode === 'text' || pageMode === 'edit') && (action === 'zoom-in' || action === 'zoom-out')) {
      handleKey({ key: action === 'zoom-in' ? 'ArrowUp' : 'ArrowDown' })
      return
    }
    if (pageMode === 'edit' && action === 'toggle-mode') {
      // click in edit view = save + share, the common action
      saveDoc('ring')
      notice = 'saved'
      textDirty = true
      return
    }
    applyAction(action)
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
const lastPushAt: Record<Slot, number> = { loupe: 0, canvas: 0 } // when the last send started
const lastFrame: Record<Slot, Frame | null> = { loupe: null, canvas: null } // last frame sent
const minMs: Record<Slot, number> = { loupe: LOUPE_MIN_MS, canvas: CANVAS_MIN_MS }
const containerOf: Record<Slot, { id: number; name: string }> = {
  loupe: { id: LOUPE_ID, name: 'loupe' },
  canvas: { id: IMG_ID, name: 'canvas' },
}
let draining = false

type Frame = Uint8Array | string
function encode(c: CanvasRenderingContext2D, w: number, h: number): Frame {
  if (FMT === 'png1') {
    const bytes = toPng1Bytes(c, w, h, 96)
    return ENC === 'b64' ? toBase64(bytes) : bytes
  }
  if (FMT === 'png') {
    if (BINARIZE) {
      // snap to black/white in place so the PNG is a 1-bit-like image with long runs
      const img = c.getImageData(0, 0, w, h)
      const d = img.data
      for (let i = 0; i < d.length; i += 4) {
        const v = (d[i] + d[i + 1] + d[i + 2]) / 3 >= 96 ? 255 : 0
        d[i] = d[i + 1] = d[i + 2] = v
        d[i + 3] = 255
      }
      c.putImageData(img, 0, 0)
    }
    // string imageData (base64) is rejected by the phone host; send PNG bytes as an array
    return ENC === 'b64' ? toPngBase64(c.canvas) : toPngBytes(c.canvas)
  }
  const g8 = toGray8(c, w, h, BINARIZE ? 96 : 0)
  const bytes = FMT === 'gray4' ? packGray4(g8) : g8
  return ENC === 'b64' ? toBase64(bytes) : bytes
}

function sameFrame(a: Frame | null, b: Frame): boolean {
  if (a === null || typeof a !== typeof b) return false
  if (typeof a === 'string') return a === b
  const x = a as Uint8Array
  const y = b as Uint8Array
  if (x.length !== y.length) return false
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false
  return true
}

/** Queue a frame unless it is identical to what the container already shows. */
function offer(slot: Slot, frame: Frame, b: EvenAppBridge) {
  if (sameFrame(lastFrame[slot], frame)) return
  pending[slot] = frame
  void drain(b)
}

// A slot may send again once its previous send has completed and minMs has passed since that
// send started: awaiting the call already serializes on the link, so waiting the measured round
// trip again after completion would halve the frame rate.
function readySlot(): Slot | null {
  const now = performance.now()
  for (const s of ['loupe', 'canvas'] as Slot[]) {
    if (pending[s] && now - lastPushAt[s] >= Math.max(minMs[s], rt[s])) return s // rt: the send has completed
  }
  return null
}

// Per-slot send stats for the phone log (every 5 s while sending): fps, ms per send, bytes.
const stats: Record<Slot, { n: number; ms: number; bytes: number }> = {
  loupe: { n: 0, ms: 0, bytes: 0 },
  canvas: { n: 0, ms: 0, bytes: 0 },
}
let statsAt = performance.now()
function logStats() {
  const now = performance.now()
  if (now - statsAt < 5000) return
  const secs = (now - statsAt) / 1000
  const parts = (['loupe', 'canvas'] as Slot[])
    .filter((k) => stats[k].n)
    .map((k) => `${k} ${(stats[k].n / secs).toFixed(1)} fps ${Math.round(stats[k].ms / stats[k].n)} ms ${Math.round(stats[k].bytes / stats[k].n)} B`)
  if (parts.length) console.log(`[codrawer] perf ${parts.join(' | ')} (fmt=${FMT} inflight=${INFLIGHT})`)
  for (const k of ['loupe', 'canvas'] as Slot[]) stats[k] = { n: 0, ms: 0, bytes: 0 }
  statsAt = now
}

let inFlight = 0
async function drain(b: EvenAppBridge) {
  if (draining) return
  if (pageMode !== 'canvas') {
    // no image containers on this page (text and edit views)
    pending.loupe = null
    pending.canvas = null
    return
  }
  draining = true
  try {
    while (pending.loupe || pending.canvas) {
      const slot = inFlight < INFLIGHT ? readySlot() : null
      if (!slot) {
        await new Promise((r) => setTimeout(r, inFlight ? 5 : 15))
        continue
      }
      const frame = pending[slot]!
      pending[slot] = null
      lastFrame[slot] = frame
      const sending = send(b, slot, frame)
      if (INFLIGHT === 1) await sending
    }
    while (inFlight) await new Promise((r) => setTimeout(r, 5))
  } finally {
    draining = false
  }
}

async function send(b: EvenAppBridge, slot: Slot, frame: Frame) {
  inFlight++
  const t0 = performance.now()
  lastPushAt[slot] = t0
  try {
    const r = await b.updateImageRawData(
      new ImageRawDataUpdate({ containerID: containerOf[slot].id, containerName: containerOf[slot].name, imageData: frame }),
    )
    lastImageResult = String(r)
    if (r !== ImageRawDataUpdateResult.success) console.warn('[codrawer] image update', slot, r)
  } catch (e) {
    lastImageResult = 'error'
    lastFrame[slot] = null // unknown what the glasses show; never skip the next frame
    console.error('[codrawer] image update threw', slot, e)
  } finally {
    const ms = performance.now() - t0
    // With several in flight the round trip no longer paces the slot; minMs still does.
    rt[slot] = INFLIGHT === 1 ? ms : 0
    sent[slot]++
    stats[slot].n++
    stats[slot].ms += ms
    stats[slot].bytes += typeof frame === 'string' ? frame.length : frame.length
    inFlight--
    logStats()
  }
}

// Text rides the same link; only send it when the content actually changed,
// and never more than a couple of times a second.
let textChain: Promise<void> = Promise.resolve()
let lastTextSent = ''
let lastTextAt = 0
const INK_LULL_MS = 700
/** Send the text container if due. False = deferred (call again later), true = sent or unchanged. */
function pushText(b: EvenAppBridge, content: string): boolean {
  if (content === lastTextSent) return true
  // A text update is a ~83 ms host call that competes with ink frames, so hold it while ink
  // is flowing (including the gaps between handwritten letters) and never send more than one
  // every 2 s, except while typing, where the line must follow the keys (~150 ms floor).
  // The very first line (replacing "connecting…") always goes out.
  if (lastTextSent !== '') {
    const now = performance.now()
    const typing = now - typingAt < 1500
    if (!typing && (strokeActive || now - lastInkAt < INK_LULL_MS)) return false
    if (now - lastTextAt < (typing ? 150 : 2000)) return false
  }
  lastTextSent = content
  lastTextAt = performance.now()
  textChain = textChain.then(async () => {
    try {
      await b.textContainerUpgrade(new TextContainerUpgrade({ containerID: TEXT_ID, containerName: 'status', content }))
    } catch (e) {
      console.error('[codrawer] text update threw', e)
    }
  })
  return true
}

// ── render loop ─────────────────────────────────────────────────────────────
let wasTyping = false
let sendCanvasPending = false // the preview changed since the glasses last got the canvas
function tick() {
  if (store.prune()) {
    stage.invalidate()
    canvasDirty = true
    strokeEnded = true
  }
  const now = performance.now()
  if (connected && routerPings && now - lastHeardAt > PING_DEAD_MS) {
    console.warn('[codrawer] router silent for', Math.round(now - lastHeardAt), 'ms; reconnecting')
    routerPings = false
    socket?.close() // onclose reconnects
  }
  if (HAS_LOUPE && loupeDirty) {
    loupeDirty = false
    rasterize(lctx, store, loupeOpts())
    if (bridge) offer('loupe', encode(lctx, LOUPE_W, LOUPE_H), bridge)
  }
  // The phone preview redraws live, every tick. The glasses copy of the canvas is a big send:
  // with a loupe showing live ink it waits for stroke_end, so it never holds the link during a
  // stroke; with no loupe it is the only view, so it refreshes at most every CANVAS_MIN_MS.
  if (canvasDirty) {
    canvasDirty = false
    // in the full-page view, outline the loupe's view so you can see where you are zoomed in
    // (in follow view the canvas is zoomed in too, and only a stray edge would show)
    const marked = HAS_LOUPE && LOUPE_CAM && opts.mode === 'full'
    rasterize(ctx, store, marked ? { ...opts, marker: loupeCam.rect() } : opts)
    sendCanvasPending = true
  }
  // With a loupe, wait for a lull in the writing, not every stroke_end: in handwriting every
  // letter ends a stroke, and each ~400 ms canvas send would hold the loupe off the link.
  const canvasDue = HAS_LOUPE
    ? strokeEnded && !strokeActive && now - lastInkAt >= CANVAS_LULL_MS
    : strokeEnded || now - lastPushAt.canvas >= CANVAS_MIN_MS
  if (sendCanvasPending && canvasDue) {
    sendCanvasPending = false
    strokeEnded = false
    if (bridge) offer('canvas', encode(ctx, IMG_W, IMG_H), bridge)
  }
  const typingNow = isTyping()
  if (wasTyping && !typingNow) textDirty = true // the typing view expired: back to status
  wasTyping = typingNow
  if (textDirty) {
    textDirty = false
    const line = renderText()
    statusEl.textContent = `${glassesState}\n${line}`
    if (bridge && !pushText(bridge, line)) textDirty = true // deferred: retry next tick
  }
  // autosave the document 2 s after the last edit
  if (editor.dirty && docChangedAt && performance.now() - docChangedAt > 2000) {
    docChangedAt = 0
    saveDoc('auto')
    textDirty = true
  }
}

async function main() {
  connect()
  rasterize(ctx, store, opts)
  if (HAS_LOUPE) rasterize(lctx, store, loupeOpts())
  statusEl.textContent = `waiting for Even bridge… (${WS_URL})`
  const bridgeP = waitForEvenAppBridge()
  void bridgeP.then((sdk) => {
    evenSdk = sdk
  })
  const b = await Promise.race<EvenAppBridge | null>([
    bridgeP,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 3000)),
  ])
  if (b && BENCH) {
    await runBench(b, (lines) => {
      statusEl.textContent = lines.join('\n')
      void b.textContainerUpgrade(new TextContainerUpgrade({ containerID: TEXT_ID, containerName: 'status', content: lines.slice(0, 9).join('\n') })).catch(() => {})
    })
    return
  }
  textDirty = true
  setInterval(tick, RENDER_INTERVAL_MS)
  if (b) {
    await attachGlasses(b)
  } else {
    // A packaged (.ehpk) app can take longer than 3 s to get its bridge on a cold start; keep
    // the browser preview running and attach whenever it arrives instead of giving up.
    glassesState = 'no Even bridge yet (still waiting)'
    console.log('[codrawer] no Even bridge yet; browser preview until it arrives')
    void bridgeP.then(attachGlasses)
  }
}

let glassesRetries = 0
async function attachGlasses(b: EvenAppBridge) {
  let ready = false
  try {
    ready = await initGlasses(b)
  } catch (e) {
    // e.g. a host callback lost across a hot reload; keep the preview alive
    glassesState = `glasses init threw: ${String(e)}`
    console.error('[codrawer] glasses init threw', String(e))
  }
  if (!ready) {
    // Usually another app (or an earlier copy of this one) still holds the glasses display.
    // Keep trying; the moment it lets go, this app takes over.
    glassesRetries++
    glassesState += ` · close other glasses apps; retrying (${glassesRetries})`
    textDirty = true
    setTimeout(() => void attachGlasses(b), Math.min(10_000, 2000 + glassesRetries * 1000))
    return
  }
  if (params.get('probe') === '1' && HAS_LOUPE) {
    // one-shot link probe (probe.ts); read from the URL directly so it never sticks in storage
    glassesState = 'glasses: probing link…'
    await runProbe(b, { id: LOUPE_ID, name: 'loupe', w: LOUPE_W, h: LOUPE_H }, { id: IMG_ID, name: 'canvas', w: IMG_W, h: IMG_H }, TEXT_ID, (lines) => {
      statusEl.textContent = lines.join('\n')
    })
    lastTextSent = '' // the probe overwrote the status text
  }
  glassesState = 'glasses: on'
  bridge = b
  canvasDirty = true
  loupeDirty = true
  strokeEnded = true
  textDirty = true
  console.log('[codrawer] glasses page ready', { canvas: `${IMG_W}x${IMG_H}`, loupe: HAS_LOUPE ? `${LOUPE_W}x${LOUPE_H}` : 'off', fmt: FMT })
}

main().catch((e) => {
  console.error('[codrawer] fatal', e)
  statusEl.textContent = `fatal: ${String(e)}`
})
