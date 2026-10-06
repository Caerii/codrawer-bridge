/**
 * "Export timelapse": the page redrawn stroke by stroke into a short video, from the phone menu.
 *
 * The menu item opens a row of options under it (like New drawing's confirm): the length (10, 20 or
 * 40 s, all ending on a 1.5 s hold of the finished page) and the theme (paper or dark, the stage's
 * own preselected). Record replays the page into an offscreen canvas while a MediaRecorder films it; the
 * item counts up ("Recording… 42%") with a Cancel beside it. Then the video is shared (touch
 * devices, after one more tap: the share sheet needs a fresh gesture) or downloaded.
 *
 * How a frame is made:
 *
 * - The schedule is timelapse.ts's: which points of which strokes show at each moment of the video,
 *   from the strokes' own times (pen speed kept, long pauses compressed, the saved page first).
 * - The pixels are the stage's: Stage.paintPage() paints every stroke exactly as the phone does
 *   (pressure widths, peers' colours, washes, erasers), so the video looks like the screen.
 * - As on the stage, finished strokes accumulate on a transparent ink layer (painted once each, in
 *   drawing order, so erasers cut what came before) and strokes still being drawn are repainted on
 *   a live layer every frame; a frame is the page colour, the ink, the live layer and a small
 *   "codrawer" wordmark in the corner. History is painted as it happened: strokes whole (the
 *   store's erase masks are the end state, erase.ts), and the tablet's eraser cutting the ink
 *   layer as it moves, not only once it lifts.
 * - The canvas is 1080 × 1440 (the page aspect at Paper Pro resolution ÷ 1.5), or 720 × 960 on a
 *   device that reports 2 GB of memory or less; even sizes, as H.264 needs.
 *
 * The recording runs in real time: `canvas.captureStream(30)` films the canvas and a frame is
 * painted on every animation frame, so the video is as long as the plan (a page sent to the
 * background paints on a throttled timer instead, so the video still ends on time, with fewer
 * frames; iOS suspends the page outright, so keep the app in front while it records). Every frame is repainted
 * even when nothing moved (the hold), because a canvas stream only emits frames when the canvas is
 * drawn to: an idle canvas would cut the hold short. The strokes are copied when recording starts;
 * ink that arrives meanwhile is not in the video.
 *
 * Formats: H.264 MP4 where the recorder can (Safari, iOS WebViews including the Even app's, Chrome
 * 126+), else WebM (VP9 / VP8). Without MediaRecorder or canvas.captureStream the item is disabled
 * and its tooltip says why.
 *
 * The replay bar's *Clip* (phone/replay.ts) records through the same path with its own strokes
 * ({@link ClipSource}): a range of a replay, the ink before it on the first frame.
 */
import { ERASER_TOOLS, type Stroke } from '../strokes'
import { LENGTHS_S, pickVideoType, planTimelapse, revealedPoints, videoExtension, type TimelapsePlan } from '../timelapse'
import { store } from '../state'
import { stage } from './screen'
import { canShareFile, formatBytes, shareOrDownload, stampedName } from './share'
import { THEMES, type Theme } from './stage'

/** Frames per second asked of the canvas stream. */
const FPS = 30

// ── What this browser can do ──────────────────────────────────────────────────────────────────

/** Why a timelapse cannot be recorded here, or null when it can. */
export function timelapseUnsupported(): string | null {
  if (typeof MediaRecorder === 'undefined') return 'This browser cannot record video (no MediaRecorder)'
  if (typeof HTMLCanvasElement.prototype.captureStream !== 'function') return 'This browser cannot film a canvas (no captureStream)'
  if (!pickVideoType((t) => MediaRecorder.isTypeSupported(t))) return 'This browser records no MP4 or WebM video'
  return null
}

/** The video's size: the page aspect, 1080 px wide, or 720 on a low-memory device; even numbers. */
function videoSize(): { w: number; h: number } {
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory
  const w = typeof memory === 'number' && memory <= 2 ? 720 : 1080
  return { w, h: Math.round(w / stage.aspect / 2) * 2 }
}

// ── Recording ─────────────────────────────────────────────────────────────────────────────────

/** A finished timelapse. */
export interface Timelapse {
  blob: Blob
  name: string
  /** the plan's length, ms (the video's duration) */
  ms: number
}

/** The strokes a timelapse shows, copied (points and times) so ink arriving meanwhile cannot move them. */
function snapshot(): Stroke[] {
  return store
    .all()
    .filter((s) => s.pts.length > 0 && (s.layer !== 'ai' || stage.showAi) && !(s.fromPage && ERASER_TOOLS.has(s.tool ?? '')))
    .map((s) => ({ ...s, pts: s.pts.slice(), times: s.times?.slice(), gone: undefined, goneCount: undefined }))
}

/**
 * Paints the frames of one plan. `frame(t)` brings the canvas to video time `t` (ms); times only
 * move forward.
 */
class FramePainter {
  readonly canvas = document.createElement('canvas')
  private ink = document.createElement('canvas') // finished strokes, transparent
  private live = document.createElement('canvas') // strokes being drawn at this moment
  private committed = 0 // strokes [0, committed) are on the ink layer

  constructor(
    private strokes: Stroke[],
    private plan: TimelapsePlan,
    private theme: Theme,
    size: { w: number; h: number },
  ) {
    for (const c of [this.canvas, this.ink, this.live]) {
      c.width = size.w
      c.height = size.h
    }
  }

  frame(t: number) {
    const { strokes, plan } = this
    const ink = this.ink.getContext('2d')!
    // finished strokes join the ink layer in drawing order, so an eraser cuts only what came before
    while (this.committed < strokes.length && plan.strokes[this.committed].end <= t) {
      stage.paintPage(ink, [strokes[this.committed]], this.theme, true)
      this.committed++
    }
    const live = this.live.getContext('2d')!
    live.clearRect(0, 0, this.live.width, this.live.height)
    const partial: Stroke[] = []
    for (let i = this.committed; i < strokes.length; i++) {
      const p = plan.strokes[i]
      if (p.start > t) break // starts are in drawing order
      const n = revealedPoints(p, t)
      if (n === 0) continue
      const s = n === strokes[i].pts.length ? strokes[i] : { ...strokes[i], pts: strokes[i].pts.slice(0, n), done: false }
      // an eraser cuts the ink as it moves (repainting its prefix cuts nothing new)
      if (s.brush === 'eraser') stage.paintPage(ink, [s], this.theme, true)
      else partial.push(s)
    }
    if (partial.length) stage.paintPage(live, partial, this.theme, true)

    const { width: w, height: h } = this.canvas
    const ctx = this.canvas.getContext('2d')!
    const colors = THEMES[this.theme]
    ctx.globalAlpha = 1
    ctx.fillStyle = colors.page
    ctx.fillRect(0, 0, w, h)
    ctx.drawImage(this.ink, 0, 0)
    ctx.drawImage(this.live, 0, 0)
    // the wordmark, small in the bottom-right corner
    const px = Math.round(h * 0.02)
    ctx.font = `600 ${px}px -apple-system, BlinkMacSystemFont, Inter, system-ui, sans-serif`
    ctx.textAlign = 'right'
    ctx.textBaseline = 'alphabetic'
    ctx.globalAlpha = 0.45
    ctx.fillStyle = colors.ink
    ctx.fillText('codrawer', w - px * 1.2, h - px * 1.1)
    ctx.globalAlpha = 1
  }
}

/**
 * Strokes of someone else's choosing to record instead of the page (a replay's range,
 * phone/replay.ts): `start` and `times` on any one clock, strokes without `start` drawn as the
 * base, which takes `baseShare` of the drawing time (0: all on the first frame).
 */
export interface ClipSource {
  strokes: Stroke[]
  baseShare: number
  /** file name prefix, e.g. "codrawer-replay" */
  prefix: string
}

/**
 * Record the page (or `clip`'s strokes) as a timelapse `lengthS` seconds long on `theme`.
 * `onProgress` hears the share done (0..1) on every frame. Resolves null if `signal` aborts it;
 * rejects if the page is empty or the browser cannot record.
 */
export async function recordTimelapse(lengthS: number, theme: Theme, onProgress: (f: number) => void, signal: AbortSignal, clip?: ClipSource): Promise<Timelapse | null> {
  const why = timelapseUnsupported()
  if (why) throw new Error(why)
  const strokes = clip ? clip.strokes : snapshot()
  if (strokes.length === 0) throw new Error('The page is empty')
  const plan = planTimelapse(
    strokes.map((s) => ({ n: s.pts.length, fromPage: s.fromPage, start: clip ? s.startedAt : (s.ts ?? s.startedAt), times: s.times })),
    lengthS * 1000,
    undefined,
    clip?.baseShare,
  )
  const painter = new FramePainter(strokes, plan, theme, videoSize())
  const type = pickVideoType((t) => MediaRecorder.isTypeSupported(t))!
  painter.frame(0)

  const stream = painter.canvas.captureStream(FPS)
  const recorder = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: painter.canvas.width >= 1080 ? 6_000_000 : 3_000_000 })
  const chunks: Blob[] = []
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data)
  }
  const stopped = new Promise<void>((resolve) => (recorder.onstop = () => resolve()))
  recorder.start(1000)
  const t0 = performance.now()
  console.log('[codrawer] timelapse', strokes.length, 'strokes,', lengthS, 's,', type, `${painter.canvas.width}x${painter.canvas.height}`)

  await new Promise<void>((resolve) => {
    // animation frames while the page shows; a hidden page gets none, so a timer keeps the clock
    // (and the end of the recording) on time, at whatever rate the browser allows it
    const next = () => (document.hidden ? setTimeout(tick, 1000 / FPS) : requestAnimationFrame(tick))
    const tick = () => {
      if (signal.aborted) return resolve()
      const t = performance.now() - t0
      painter.frame(Math.min(t, plan.totalMs))
      onProgress(Math.min(1, t / plan.totalMs))
      if (t >= plan.totalMs) return resolve()
      next()
    }
    next()
  })
  recorder.stop()
  await stopped
  for (const track of stream.getTracks()) track.stop()
  if (signal.aborted) return null
  const blob = new Blob(chunks, { type: type.split(';')[0] })
  return { blob, name: stampedName(clip?.prefix ?? 'codrawer-timelapse', videoExtension(type)), ms: plan.totalMs }
}

// ── The menu row ──────────────────────────────────────────────────────────────────────────────

/**
 * The menu item and its row: idle (row hidden), choosing (options), recording (progress, Cancel),
 * ready (a recorded video waiting for the tap that shares it).
 */
type Phase = 'idle' | 'choosing' | 'recording' | 'ready'

let phase: Phase = 'idle'
let lengthS: number = LENGTHS_S[1]
let theme: Theme | null = null // null: the stage's theme when the row opens
let abort: AbortController | null = null
let ready: Timelapse | null = null

const el = {
  item: () => document.querySelector('#menu [data-act="tl"]') as HTMLButtonElement,
  label: () => document.querySelector('#menu [data-act="tl"] span') as HTMLSpanElement,
  box: () => document.getElementById('tlBox') as HTMLDivElement,
  part: (name: 'opts' | 'run' | 'done') => document.querySelector(`#tlBox .tl-${name}`) as HTMLDivElement,
  progress: () => document.getElementById('tlProgress') as HTMLProgressElement,
}

const LABEL = 'Export timelapse…'

function show(p: Phase) {
  phase = p
  el.box().hidden = p === 'idle'
  el.part('opts').hidden = p !== 'choosing'
  el.part('run').hidden = p !== 'recording'
  el.part('done').hidden = p !== 'ready'
}

/** Sync the item with what the browser can do and the row with the chosen options. */
export function refreshTimelapse() {
  const item = el.item()
  const why = timelapseUnsupported()
  item.setAttribute('aria-disabled', String(why !== null))
  item.title = why ?? 'Replay this page, stroke by stroke, into a short video'
  const t = theme ?? stage.theme
  for (const b of Array.from(el.box().querySelectorAll<HTMLButtonElement>('[data-len]'))) b.setAttribute('aria-pressed', String(Number(b.dataset.len) === lengthS))
  for (const b of Array.from(el.box().querySelectorAll<HTMLButtonElement>('[data-tltheme]'))) b.setAttribute('aria-pressed', String(b.dataset.tltheme === t))
}

/** The menu is closing: an open options row folds away; a recording or a ready video stays. */
export function timelapseMenuClosed() {
  if (phase === 'choosing') show('idle')
}

/** Escape inside the menu: true when it folded the options row (and should go no further). */
export function timelapseEscape(): boolean {
  if (phase !== 'choosing') return false
  show('idle')
  el.item().focus()
  return true
}

async function start() {
  const t = theme ?? stage.theme
  abort = new AbortController()
  show('recording')
  const label = el.label()
  const progress = el.progress()
  label.textContent = 'Recording… 0%'
  ;(el.part('run').querySelector('button') as HTMLButtonElement).focus()
  try {
    const video = await recordTimelapse(
      lengthS,
      t,
      (f) => {
        const pct = Math.floor(f * 100)
        label.textContent = `Recording… ${pct}%`
        progress.value = f
      },
      abort.signal,
    )
    abort = null
    if (!video) {
      label.textContent = LABEL
      show('idle')
      return
    }
    console.log('[codrawer] timelapse', video.name, video.blob.size, 'bytes,', video.ms, 'ms')
    if (canShareFile(new File([video.blob], video.name, { type: video.blob.type }))) {
      // the share sheet needs a fresh tap: offer one
      ready = video
      label.textContent = `Timelapse ready · ${formatBytes(video.blob.size)}`
      show('ready')
      return
    }
    await shareOrDownload(video.blob, video.name, 'codrawer timelapse')
    label.textContent = `Timelapse saved · ${formatBytes(video.blob.size)}`
    show('idle')
    setTimeout(() => phase === 'idle' && (el.label().textContent = LABEL), 4000)
  } catch (e) {
    abort = null
    console.warn('[codrawer] timelapse failed', e)
    label.textContent = (e as Error).message || 'Timelapse failed'
    show('idle')
    setTimeout(() => phase === 'idle' && (el.label().textContent = LABEL), 4000)
  }
}

/**
 * The row's actions (the menu routes every `data-act` starting with "tl" here, and the option
 * buttons by their data attributes): `tl` opens or folds the options, `tl-go` records, `tl-cancel`
 * stops a recording, `tl-share` shares the ready video, `tl-discard` drops it.
 */
export function timelapseAction(act: string, target: HTMLElement) {
  const len = target.closest<HTMLElement>('[data-len]')?.dataset.len
  const th = target.closest<HTMLElement>('[data-tltheme]')?.dataset.tltheme
  if (len) lengthS = Number(len)
  else if (th === 'paper' || th === 'dark') theme = th
  else if (act === 'tl') {
    if (el.item().getAttribute('aria-disabled') === 'true') return
    if (phase === 'idle') {
      theme = null
      show('choosing')
      ;(el.part('opts').querySelector('[data-act="tl-go"]') as HTMLButtonElement).focus()
    } else if (phase === 'choosing') show('idle')
  } else if (act === 'tl-no') {
    show('idle')
    el.item().focus()
  } else if (act === 'tl-go') void start()
  else if (act === 'tl-cancel') abort?.abort()
  else if (act === 'tl-share' && ready) {
    const video = ready
    void shareOrDownload(video.blob, video.name, 'codrawer timelapse').then((how) => {
      if (how === 'cancelled') return // keep it for another try
      ready = null
      el.label().textContent = LABEL
      show('idle')
    })
  } else if (act === 'tl-discard') {
    ready = null
    el.label().textContent = LABEL
    show('idle')
    el.item().focus()
  }
  refreshTimelapse()
}
