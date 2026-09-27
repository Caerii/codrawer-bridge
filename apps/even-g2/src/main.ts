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
import { packGray4, rasterize, StrokeStore, toBase64, toGray8, toPngBase64, toPngBytes, type Highlight, type RasterOptions, type ViewMode } from './strokes'
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
// png: base64 PNG string (the documented encoded-image path; tiny JSON, the host
// converts to Gray4). gray8 / gray4: raw pixel bytes as number[] (?enc=b64 as a
// base64 string of the raw bytes, which the phone host rejected on 2026-09-26).
const FMT: 'png' | 'gray8' | 'gray4' = ((v) => (v === 'gray8' || v === 'gray4' ? v : 'png'))(cfg('fmt', 'png'))
const BINARIZE = cfg('binarize', '1') !== '0'
const SHOW_AI = cfg('ai', '1') !== '0'
// `?enc=b64` sends imageData as a base64 string across the WebView bridge. The
// simulator accepts it but the phone host answered sendFailed (2026-09-26), so the
// SDK's number[] marshaling stays the default; the bench compares both.
const ENC: 'b64' | 'array' = cfg('enc', 'array') === 'b64' ? 'b64' : 'array'
const BENCH = cfg('bench', '0') === '1'

// glasses contextual-menu item ids (non-zero, unique) → actions
const MENU = { newDrawing: 1, toggleAi: 2, toggleMode: 3, cycleHighlight: 4, zoomIn: 5, zoomOut: 6, clearAi: 7, textView: 8 } as const
const MENU_ACTION: Record<number, string> = {
  [MENU.newDrawing]: 'new-drawing',
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
let strokeActive = false
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
type PageMode = 'canvas' | 'text'
let pageMode: PageMode = cfg('view', 'canvas') === 'text' ? 'text' : 'canvas'
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
  if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ t: kind, text, ts: Date.now() }))
  else notice = 'not connected'
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
    default:
      notice = ''
  }
}

function handleKey(m: { key?: string; char?: string; mods?: { ctrl?: boolean; alt?: boolean; meta?: boolean } }) {
  const key = String(m.key || '')
  const ch = typeof m.char === 'string' ? m.char : ''
  const mods = m.mods || {}
  typingAt = performance.now()
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
  { name: '/term', help: 'send an instruction to the terminal' },
  { name: '/mode', help: 'ink | term: where plain lines go' },
  { name: '/hw', help: 'AI handwrites text on the canvas' },
  { name: '/draw', help: 'AI draws text' },
  { name: '/new', help: 'new drawing for every client' },
  { name: '/ai', help: 'toggle the AI ghost layer' },
  { name: '/text', help: 'toggle full-screen text view' },
  { name: '/clear', help: 'clear the transcript' },
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
function connect() {
  const ws = new WebSocket(WS_URL)
  socket = ws
  ws.onopen = () => {
    connected = true
    textDirty = true
    console.log('[codrawer] connected', WS_URL)
  }
  ws.onclose = () => {
    connected = false
    strokeActive = false // a stroke cut off by the disconnect must not hold text updates
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
        strokeActive = true
        loupeDirty = true
        break
      case 'stroke_pts':
        store.points(m.id, m.pts || [], 'user')
        loupeDirty = true
        canvasDirty = true
        break
      case 'stroke_end':
        store.end(m.id)
        strokeActive = false
        loupeDirty = true
        canvasDirty = true
        strokeEnded = true
        textDirty = true
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
      case 'clear':
        // another client started a new drawing
        store.clear()
        intent = ''
        loupeDirty = true
        canvasDirty = true
        strokeEnded = true
        textDirty = true
        break
      case 'key':
        handleKey(m)
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
      new MenuItemProperty({ itemName: mode === 'text' ? 'Canvas view' : 'Text view', itemID: MENU.textView }),
      new MenuItemProperty({ itemName: 'Toggle AI ghost', itemID: MENU.toggleAi }),
      new MenuItemProperty({ itemName: 'Follow / fit page', itemID: MENU.toggleMode }),
      new MenuItemProperty({ itemName: 'Cycle emphasis', itemID: MENU.cycleHighlight }),
      new MenuItemProperty({ itemName: 'Zoom in', itemID: MENU.zoomIn }),
      new MenuItemProperty({ itemName: 'Zoom out', itemID: MENU.zoomOut }),
      new MenuItemProperty({ itemName: 'Clear AI ink', itemID: MENU.clearAi }),
    ],
  })
  if (mode === 'text') {
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
async function setPageMode(b: EvenAppBridge, mode: PageMode) {
  if (mode === pageMode) return
  pageMode = mode
  try {
    localStorage.setItem('codrawer:view', mode)
  } catch {
    /* ignore */
  }
  pending.loupe = null
  pending.canvas = null
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
  if (action === 'new-drawing') {
    // wipe locally and tell the session so every client starts fresh
    store.clear()
    intent = ''
    if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ t: 'clear', ts: Date.now() }))
  } else if (action === 'clear-ai') {
    store.clear('ai')
    intent = ''
  } else if (action === 'toggle-ai') {
    opts.showAi = !opts.showAi
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
      statusEl.textContent = `glasses page failed: create=${String(result)} rebuild=${String(rebuilt)}`
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
    // In text view the ring scrolls the transcript instead of zooming.
    if (pageMode === 'text' && (action === 'zoom-in' || action === 'zoom-out')) {
      handleKey({ key: action === 'zoom-in' ? 'ArrowUp' : 'ArrowDown' })
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
const lastPushAt: Record<Slot, number> = { loupe: 0, canvas: 0 }
const minMs: Record<Slot, number> = { loupe: LOUPE_MIN_MS, canvas: CANVAS_MIN_MS }
const containerOf: Record<Slot, { id: number; name: string }> = {
  loupe: { id: LOUPE_ID, name: 'loupe' },
  canvas: { id: IMG_ID, name: 'canvas' },
}
let draining = false

type Frame = Uint8Array | string
function encode(c: CanvasRenderingContext2D, w: number, h: number): Frame {
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

function readySlot(): Slot | null {
  const now = performance.now()
  for (const s of ['loupe', 'canvas'] as Slot[]) {
    if (pending[s] && now - lastPushAt[s] >= Math.max(minMs[s], rt[s])) return s
  }
  return null
}

async function drain(b: EvenAppBridge) {
  if (draining) return
  if (pageMode === 'text') {
    // no image containers on this page
    pending.loupe = null
    pending.canvas = null
    return
  }
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
  // A text update is a ~83 ms host call that competes with ink frames, so hold
  // it while a stroke is in progress and never send more than one every 2 s,
  // except while typing, where the line must follow the keys (~150 ms floor).
  // The very first line (replacing "connecting…") always goes out.
  if (lastTextSent !== '') {
    const typing = performance.now() - typingAt < 1500
    if (!typing && strokeActive) return
    if (performance.now() - lastTextAt < (typing ? 150 : 2000)) return
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
    const line = renderText()
    statusEl.textContent = line
    if (bridge) pushText(bridge, line)
  } else if (isTyping() && inputLine === '' && performance.now() - typingAt > 15000) {
    textDirty = true // typing view expires back to the status view
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
