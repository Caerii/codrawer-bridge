/**
 * Thinking replay on the phone: scrub any page like a video, with the moments of thought marked.
 *
 * "Replay this page" (the ⋯ menu) replays the strokes in the live store since the page opened;
 * "Replay a recording…" replays a session recording (`.jsonl` from "Export recording", picked
 * with the file chooser). Either way the stage stops drawing the live page and draws the page as
 * it stood at the playhead; a bar under it holds the controls, and a "Replay · Live" chip in the
 * toolbar (or the bar's Live button, or Escape) returns to the live page.
 *
 * How it fits together:
 *
 *   strokes / recording ──replay/timeline.ts──▶ Timeline ──replay/moments.ts──▶ markers
 *                                                  │
 *   scrubber axis (TimeMap) ──▶ timeline ms ──replay/cursor.ts──▶ a StrokeStore at t
 *                                                  ├──▶ the stage (Stage.replay), every frame
 *                                                  └──▶ the glasses canvas (canvasSource), ≥ 200 ms apart
 *
 * - **The page at t** is drawn by the stage's own painter from the cursor's store: peers in their
 *   colours, agent ink in its style, the tablet's eraser cutting ink as it did (erasing is data in
 *   the store, erase.ts). The camera frames the replay's whole ink, so it holds still.
 * - **The axis** is the timeline's own time, or with long idle stretches compressed ("Compress
 *   pauses", on by default: timeline.ts compressIdle); the pen keeps its own speed either way.
 *   Playback runs the axis at 1, 2, 4 or 8 times real time. The time shown is the session's own.
 * - **Markers** are the moments (moments.ts), coloured by kind; a moment with length (a pause, a
 *   burst) also shades its span. Tapping one jumps to it (to its start, so the page shows the
 *   moment about to happen) and names it above the track. Saved-page strokes are on the page at
 *   0, "before this session".
 * - **Prev / next** step to the previous or next stroke's end, so each step shows one stroke whole.
 * - **The glasses** show the replay on their canvas while it is open: the canvas draws the
 *   cursor's store, at most every {@link GLASSES_MS} (an image update costs ~200 ms, ADR 006; the
 *   scheduler's latest-wins slot drops frames the link cannot take). The loupe stays live.
 * - **Clip** exports a range of the replay as a video through the timelapse recorder
 *   (phone/timelapse.ts): ink finished before the range is the first frame, the range is drawn at
 *   the chosen speed (3 to 60 s), then the usual hold.
 *
 * The replay is a snapshot: ink that arrives while it is open joins the live page, not the replay
 * (open it again to include it).
 */
import { canvasSource } from '../glasses/display'
import { dirty, store } from '../state'
import type { Stroke } from '../strokes'
import { HOLD_MS } from '../timelapse'
import { ReplayCursor } from '../replay/cursor'
import { findMoments, type Moment, type MomentsSummary } from '../replay/moments'
import { fromRecording, fromStore, inkBox, LEAD_MS, nextStrokeEnd, prevStrokeEnd, revealed, TimeMap, type Timeline } from '../replay/timeline'
import { stage } from './screen'
import { canShareFile, formatBytes, shareOrDownload } from './share'
import { recordTimelapse, timelapseUnsupported } from './timelapse'

/** The glasses canvas gets a replay frame at most this often, ms (one image update, ADR 006). */
export const GLASSES_MS = 200
/** Playback speeds offered. */
const SPEEDS = [1, 2, 4, 8] as const
/** A clip lasts at least this long and at most this long before its hold, s. */
const CLIP_MIN_S = 3
const CLIP_MAX_S = 60

// ── The open replay ───────────────────────────────────────────────────────────────────────────

interface Replay {
  tl: Timeline
  cursor: ReplayCursor
  map: TimeMap
  moments: Moment[]
  summary: MomentsSummary
  frame: [number, number, number, number] | null
  /** the playhead, axis ms */
  axis: number
  playing: boolean
  /** the marker last tapped (shown in the caption until the playhead leaves it) */
  picked: Moment | null
  /** the clip's range on the timeline, ms */
  clip: [number, number]
}

let rp: Replay | null = null
let speed: number = 1
let compress = true
let clipOpen = false
let clipAbort: AbortController | null = null
let ready: { blob: Blob; name: string } | null = null

/** The last replay's moments in numbers (for the console and, later, the Primer), or null. */
export function replaySummary(): MomentsSummary | null {
  return rp?.summary ?? null
}

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T
const el = {
  bar: () => $<HTMLDivElement>('#replay'),
  chip: () => $<HTMLButtonElement>('#replayChip'),
  track: () => $<HTMLDivElement>('#rpTrack'),
  caption: () => $<HTMLSpanElement>('#rpCaption'),
  time: () => $<HTMLSpanElement>('#rpTime'),
  btn: (name: string) => $<HTMLButtonElement>(`#replay [data-rp="${name}"]`),
  clip: () => $<HTMLDivElement>('#replay .rp-clip'),
  file: () => $<HTMLInputElement>('#replayFile'),
}

/** Colour variable per moment kind (index.html #replay). */
const KIND_VAR: Record<Moment['kind'], string> = {
  pause: '--pause',
  erase: '--erase',
  rewrite: '--rewrite',
  hesitation: '--hesitation',
  burst: '--burst',
  contribution: '--contribution',
}

/** m:ss (or h:mm:ss) of `ms`. */
export function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const mm = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(mm).padStart(2, '0')}:${ss}` : `${mm}:${ss}`
}

/** Open a replay of `tl` (replacing any open one), at its end: the page as it is now. */
function open(tl: Timeline) {
  stopPlaying()
  const cursor = new ReplayCursor(tl, store.eraseRadius)
  const { moments, summary } = findMoments(tl, { eraseRadius: store.eraseRadius })
  const map = new TimeMap(tl, compress)
  rp = { tl, cursor, map, moments, summary, frame: inkBox(tl), axis: map.end, playing: false, picked: null, clip: [0, tl.durationMs] }
  console.log('[codrawer] replay', tl.source, `${tl.strokes.length} strokes (${tl.baseCount} before this session), ${clock(tl.durationMs)};`, summary.counts, summary)
  el.bar().hidden = false
  el.chip().hidden = false
  buildMarkers()
  seekAxis(map.end)
  syncControls()
  el.track().focus({ preventScroll: true })
}

/** Leave the replay: the stage and the glasses go back to the live page. */
export function closeReplay() {
  if (!rp) return
  stopPlaying()
  clipAbort?.abort()
  rp = null
  stage.replay(null)
  canvasSource.store = null
  dirty.canvas = true
  dirty.flushCanvas = true
  el.bar().hidden = true
  el.chip().hidden = true
}

/** Whether a replay is showing. */
export function replaying(): boolean {
  return rp !== null
}

/** "Replay this page": the live store's strokes since the page opened. */
export function replayThisPage() {
  const tl = fromStore(store.all())
  if (!tl.strokes.length) {
    console.log('[codrawer] replay: the page is empty')
    return
  }
  open(tl)
}

/** "Replay a recording…": pick a `.jsonl` and replay it. */
export function pickRecording() {
  const input = el.file()
  input.value = ''
  input.click()
}

async function loadRecording(file: File) {
  const tl = fromRecording(await file.text())
  if (!tl.strokes.length) {
    alert(`${file.name}: no strokes in this recording`)
    return
  }
  open(tl)
  el.caption().textContent = `${file.name} · ${tl.strokes.length} strokes`
}

/** Sync the menu items with what can be replayed (the menu calls this when it opens). */
export function refreshReplay() {
  const item = document.querySelector('#menu [data-act="replay"]') as HTMLButtonElement | null
  if (!item) return
  const empty = store.all().every((s) => s.pts.length === 0)
  item.setAttribute('aria-disabled', String(empty))
  item.title = empty ? 'Nothing on the page yet' : 'Scrub this page like a video, with the moments of thought marked'
}

// ── Moving the playhead ───────────────────────────────────────────────────────────────────────

let glassesAt = 0
let glassesTimer = 0

/** Show the cursor's store on the glasses canvas, at most every GLASSES_MS (the last one always). */
function pokeGlasses() {
  if (glassesTimer) return
  const wait = glassesAt + GLASSES_MS - performance.now()
  const send = () => {
    glassesTimer = 0
    if (!rp) return
    glassesAt = performance.now()
    canvasSource.store = rp.cursor.store
    dirty.canvas = true
    dirty.flushCanvas = true
  }
  if (wait <= 0) send()
  else glassesTimer = window.setTimeout(send, wait)
}

/** Bring the page to axis ms `axis` (clamped): the stage, the glasses, the bar. */
function seekAxis(axis: number) {
  if (!rp) return
  rp.axis = Math.max(0, Math.min(rp.map.end, axis))
  const t = rp.map.toTime(rp.axis)
  const r = rp.cursor.seek(t)
  if (r.rebuilt) {
    stage.replay(rp.cursor.store, rp.frame)
    stage.invalidate()
  } else if (r.erased) stage.erased(r.erased)
  stage.touch()
  if (r.changed) pokeGlasses()
  if (rp.picked && (t < rp.picked.t - 1 || t > Math.max(rp.picked.end, rp.picked.t + 1500))) rp.picked = null
  renderBar()
}

/** Seek to timeline ms `t`. */
function seekTime(t: number) {
  if (rp) seekAxis(rp.map.toAxis(t))
}

let pendingAxis: number | null = null
/** Seek on the next animation frame (scrubbing: at most one seek per frame). */
function seekSoon(axis: number) {
  if (pendingAxis === null)
    requestAnimationFrame(() => {
      const a = pendingAxis
      pendingAxis = null
      if (a !== null) seekAxis(a)
    })
  pendingAxis = axis
}

let lastFrame = 0
function playFrame(now: number) {
  if (!rp || !rp.playing) return
  const dt = Math.min(100, now - lastFrame) // a background tab does not jump ahead
  lastFrame = now
  const next = rp.axis + dt * speed
  if (next >= rp.map.end) {
    seekAxis(rp.map.end)
    stopPlaying()
    return
  }
  seekAxis(next)
  requestAnimationFrame(playFrame)
}

function play() {
  if (!rp) return
  if (rp.axis >= rp.map.end - 1) seekAxis(0) // from the start again
  rp.playing = true
  lastFrame = performance.now()
  requestAnimationFrame(playFrame)
  syncControls()
}

function stopPlaying() {
  if (rp) rp.playing = false
  syncControls()
}

// ── The bar ───────────────────────────────────────────────────────────────────────────────────

/** The fraction of the track at timeline ms `t`. */
const frac = (t: number) => (rp && rp.map.end > 0 ? rp.map.toAxis(t) / rp.map.end : 0)
const pct = (f: number) => `${(Math.max(0, Math.min(1, f)) * 100).toFixed(3)}%`

/** One button per moment (and its span, when it has one); "before this session" at 0. */
function buildMarkers() {
  const box = el.track().querySelector('.rp-marks') as HTMLDivElement
  box.replaceChildren()
  if (!rp) return
  const add = (t: number, end: number, kind: string, color: string, label: string, onPick: () => void) => {
    if (end - t > 50) {
      const span = document.createElement('div')
      span.className = 'rp-span'
      span.style.setProperty('--k', color)
      span.style.left = pct(frac(t))
      span.style.width = pct(frac(end) - frac(t))
      box.append(span)
    }
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'rp-mark'
    b.dataset.kind = kind
    b.style.setProperty('--k', color)
    b.style.left = pct(frac(t))
    b.title = `${label} (${clock(t)})`
    b.setAttribute('aria-label', b.title)
    b.addEventListener('pointerdown', (e) => e.stopPropagation()) // a tap on a marker is not a scrub
    b.addEventListener('click', (e) => {
      e.stopPropagation()
      onPick()
    })
    box.append(b)
    return b
  }
  if (rp.tl.baseCount) add(0, 0, 'before', 'var(--before)', `Before this session · ${rp.tl.baseCount} strokes from the saved page`, () => {
    stopPlaying()
    seekTime(0)
  })
  for (const m of rp.moments) {
    const b = add(m.t, m.end, m.kind, `var(${KIND_VAR[m.kind]})`, m.label, () => {
      if (!rp) return
      stopPlaying()
      rp.picked = m
      seekTime(m.t)
    })
    b.dataset.t = String(m.t)
  }
}

/** The caption: the moment at the playhead, else how far the page has got. */
function caption(t: number): string {
  if (!rp) return ''
  const m = rp.picked ?? rp.moments.filter((x) => x.t <= t && t <= Math.max(x.end, x.t + 1200)).pop()
  if (m) return `<i style="background: var(${KIND_VAR[m.kind]})"></i>${escapeHtml(m.label)}`
  const live = rp.tl.strokes.filter((s) => !s.base)
  const drawn = live.filter((s) => revealed(s, t) > 0 && !(s.removedAt !== undefined && s.removedAt <= t)).length
  if (t < LEAD_MS && rp.tl.baseCount) return `Before this session · ${rp.tl.baseCount} saved strokes`
  return `${drawn} of ${live.length} strokes`
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
}

function renderBar() {
  if (!rp) return
  const t = rp.map.toTime(rp.axis)
  const f = rp.map.end > 0 ? rp.axis / rp.map.end : 0
  const track = el.track()
  ;(track.querySelector('.rp-fill') as HTMLElement).style.width = pct(f)
  ;(track.querySelector('.rp-head') as HTMLElement).style.left = pct(f)
  track.setAttribute('aria-valuenow', String(Math.round(f * 100)))
  track.setAttribute('aria-valuetext', clock(t))
  el.time().textContent = `${clock(t)} / ${clock(rp.tl.durationMs)}`
  el.caption().innerHTML = caption(t)
  for (const b of Array.from(track.querySelectorAll<HTMLButtonElement>('.rp-mark'))) b.setAttribute('aria-current', String(rp.picked !== null && b.dataset.t === String(rp.picked.t) && b.dataset.kind === rp.picked.kind))
  const range = track.querySelector('.rp-range') as HTMLElement
  range.hidden = !clipOpen
  if (clipOpen) {
    range.style.left = pct(frac(rp.clip[0]))
    range.style.width = pct(frac(rp.clip[1]) - frac(rp.clip[0]))
    const len = clipLengthS()
    ;(el.clip().querySelector('.rp-clip-len') as HTMLElement).textContent = `${clock(rp.clip[0])}–${clock(rp.clip[1])} → ${len.toFixed(len < 10 ? 1 : 0)} s video`
  }
}

function syncControls() {
  const play = el.btn('play')
  const on = !!rp?.playing
  play.setAttribute('aria-label', on ? 'Pause' : 'Play')
  play.title = on ? 'Pause (space)' : 'Play (space)'
  play.innerHTML = on ? '<svg viewBox="0 0 24 24"><path d="M8 5v14M16 5v14"/></svg>' : '<svg viewBox="0 0 24 24"><path d="M7 5l12 7-12 7z"/></svg>'
  for (const b of Array.from(document.querySelectorAll<HTMLButtonElement>('#replay [data-speed]'))) b.setAttribute('aria-pressed', String(Number(b.dataset.speed) === speed))
  el.btn('compress').setAttribute('aria-pressed', String(compress))
  el.btn('clip').setAttribute('aria-pressed', String(clipOpen))
  el.clip().hidden = !clipOpen
  const why = timelapseUnsupported()
  el.btn('clip-go').setAttribute('aria-disabled', String(why !== null || clipAbort !== null))
  el.btn('clip-go').title = why ?? 'Record the range as a video'
}

// ── Clips ─────────────────────────────────────────────────────────────────────────────────────

/** The clip's video length before its hold, s: the range on the axis at the chosen speed. */
function clipLengthS(): number {
  if (!rp) return CLIP_MIN_S
  const axisMs = rp.map.toAxis(rp.clip[1]) - rp.map.toAxis(rp.clip[0])
  return Math.max(CLIP_MIN_S, Math.min(CLIP_MAX_S, axisMs / speed / 1000))
}

/**
 * The strokes of timeline range [a, b] for the timelapse recorder: ink finished by `a` is the
 * base (on the first frame, in drawing order, erasers included so they cut as they did), ink
 * drawn in the range keeps its timeline times, cut at `b`. Ink taken back before `a` is left out.
 */
export function clipStrokes(tl: Timeline, a: number, b: number, showAi: boolean): Stroke[] {
  const out: Stroke[] = []
  for (const s of tl.strokes) {
    if (s.removedAt !== undefined && s.removedAt <= a) continue
    if (s.layer === 'ai' && !showAi) continue
    const n = s.base ? s.pts.length : revealed(s, b)
    if (n === 0) continue
    const pts = s.pts.slice(0, n)
    const before = s.base || s.at[n - 1] <= a
    let x0 = 1
    let y0 = 1
    let x1 = 0
    let y1 = 0
    for (const p of pts) {
      x0 = Math.min(x0, p[0])
      y0 = Math.min(y0, p[1])
      x1 = Math.max(x1, p[0])
      y1 = Math.max(y1, p[1])
    }
    out.push({
      id: s.id,
      layer: s.layer,
      brush: s.brush,
      pts,
      done: true,
      endedAt: 0,
      box: [x0, y0, x1, y1],
      fromPage: s.base || undefined,
      tool: s.tool,
      color: s.color,
      size: s.size,
      author: s.author,
      startedAt: before ? undefined : s.at[0],
      times: before ? undefined : s.at.slice(0, n),
    })
  }
  return out
}

async function exportClip() {
  if (!rp || clipAbort || timelapseUnsupported()) return
  if (ready) {
    // a recorded clip waiting for the tap that shares it (the share sheet needs a fresh gesture)
    const clip = ready
    const how = await shareOrDownload(clip.blob, clip.name, 'codrawer replay')
    if (how !== 'cancelled') {
      ready = null
      el.btn('clip-go').textContent = 'Export clip'
    }
    return
  }
  const [a, b] = rp.clip
  const strokes = clipStrokes(rp.tl, a, b, stage.showAi)
  const go = el.btn('clip-go')
  const bar = el.clip().querySelector('progress') as HTMLProgressElement
  clipAbort = new AbortController()
  stopPlaying()
  bar.hidden = false
  syncControls()
  try {
    const video = await recordTimelapse(clipLengthS() + HOLD_MS / 1000, stage.theme, (f) => (bar.value = f), clipAbort.signal, { strokes, baseShare: 0, prefix: 'codrawer-replay' })
    if (!video) return
    console.log('[codrawer] replay clip', video.name, video.blob.size, 'bytes,', video.ms, 'ms')
    if (canShareFile(new File([video.blob], video.name, { type: video.blob.type }))) {
      ready = video
      go.textContent = `Share clip · ${formatBytes(video.blob.size)}`
    } else await shareOrDownload(video.blob, video.name, 'codrawer replay')
  } catch (e) {
    console.warn('[codrawer] replay clip failed', e)
    go.title = (e as Error).message
  } finally {
    clipAbort = null
    bar.hidden = true
    bar.value = 0
    syncControls()
  }
}

// ── Wiring ────────────────────────────────────────────────────────────────────────────────────

/** Wire the bar, the toolbar chip, the file chooser and the keyboard. */
export function setupReplay() {
  el.chip().onclick = closeReplay
  el.file().addEventListener('change', () => {
    const f = el.file().files?.[0]
    if (f) void loadRecording(f).catch((e) => console.warn('[codrawer] replay: cannot read', f.name, e))
  })
  el.bar().addEventListener('click', (e) => {
    const target = e.target as HTMLElement
    const speedBtn = target.closest<HTMLElement>('[data-speed]')
    const act = target.closest<HTMLElement>('[data-rp]')?.dataset.rp
    if (speedBtn) speed = Number(speedBtn.dataset.speed) || 1
    else if (!rp) return
    else if (act === 'play') rp.playing ? stopPlaying() : play()
    else if (act === 'prev') {
      stopPlaying()
      seekTime(prevStrokeEnd(rp.tl, rp.map.toTime(rp.axis)))
    } else if (act === 'next') {
      stopPlaying()
      const t = nextStrokeEnd(rp.tl, rp.map.toTime(rp.axis))
      seekTime(t ?? rp.tl.durationMs)
    } else if (act === 'compress') {
      const t = rp.map.toTime(rp.axis)
      compress = !compress
      rp.map = new TimeMap(rp.tl, compress)
      buildMarkers()
      seekTime(t)
    } else if (act === 'clip') clipOpen = !clipOpen
    else if (act === 'in' || act === 'out') {
      const t = rp.map.toTime(rp.axis)
      rp.clip = act === 'in' ? [t, Math.max(t, rp.clip[1])] : [Math.min(t, rp.clip[0]), t]
      if (rp.clip[1] - rp.clip[0] < 1) rp.clip = act === 'in' ? [t, rp.tl.durationMs] : [0, t]
    } else if (act === 'clip-go') void exportClip()
    else if (act === 'live') closeReplay()
    syncControls()
    renderBar()
  })

  // the track: press and drag to scrub (playback pauses while the finger is down)
  const track = el.track()
  let scrubbing = false
  let wasPlaying = false
  const at = (e: PointerEvent) => {
    const r = track.getBoundingClientRect()
    return rp ? ((e.clientX - r.left) / Math.max(1, r.width)) * rp.map.end : 0
  }
  track.addEventListener('pointerdown', (e) => {
    if (!rp) return
    scrubbing = true
    wasPlaying = rp.playing
    rp.playing = false
    rp.picked = null
    track.setPointerCapture(e.pointerId)
    seekSoon(at(e))
    e.preventDefault()
  })
  track.addEventListener('pointermove', (e) => {
    if (scrubbing) seekSoon(at(e))
  })
  const lift = (e: PointerEvent) => {
    if (!scrubbing) return
    scrubbing = false
    seekSoon(at(e))
    if (wasPlaying) play()
    else syncControls()
  }
  track.addEventListener('pointerup', lift)
  track.addEventListener('pointercancel', lift)

  // keys while replaying (not while typing in a field, and not inside the menu)
  document.addEventListener('keydown', (e) => {
    if (!rp || e.defaultPrevented) return
    const target = e.target as HTMLElement
    if (target.closest('input, textarea, [contenteditable], #menu')) return
    if (e.key === ' ' || e.key === 'k') rp.playing ? stopPlaying() : play()
    else if (e.key === 'ArrowLeft') {
      stopPlaying()
      seekTime(prevStrokeEnd(rp.tl, rp.map.toTime(rp.axis)))
    } else if (e.key === 'ArrowRight') {
      stopPlaying()
      seekTime(nextStrokeEnd(rp.tl, rp.map.toTime(rp.axis)) ?? rp.tl.durationMs)
    } else if (e.key === 'Home') seekAxis(0)
    else if (e.key === 'End') seekAxis(rp.map.end)
    else if (e.key === 'Escape') closeReplay()
    else return
    e.preventDefault()
  })
}
