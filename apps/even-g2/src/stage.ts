/**
 * Stage: the phone screen's view of the page, made to be looked at (and projected).
 *
 * Separate from the glasses pipeline (strokes.ts rasterize → tiny binarized frames): this draws
 * the page at the phone's full resolution, anti-aliased, with pressure-weighted ink, on a paper
 * or dark theme, and redraws on every animation frame while ink arrives.
 *
 * - View: "page" shows the whole page; "focus" frames the writing (ink bounds with margin, never
 *   tighter than a third of the page) so a projector is not mostly empty paper. The camera glides
 *   to its target instead of jumping.
 * - Pointer: where the pen hovers (cursor messages), so viewers can follow before ink appears.
 * - Backdrop: the phone camera (live video, or a still) instead of paper: ink is drawn white with
 *   a soft dark halo so it reads over any scene. Drawing over the world.
 * - Finished strokes live in an offscreen, transparent ink layer while the view is still; a frame
 *   is then the background (paper or video), one blit, and the strokes still being drawn.
 */
import type { Stroke, StrokeStore } from './strokes'

export type Theme = 'paper' | 'dark'
export type View = 'page' | 'focus'

const THEMES: Record<Theme, { page: string; surround: string; ink: string; ai: string; edge: string; pointer: string }> = {
  // the reMarkable's warm off-white page and near-black ink
  paper: { page: '#f6f4ee', surround: '#e4e1d8', ink: '#1d1d1b', ai: '#3a6ea5', edge: 'rgba(0,0,0,0.10)', pointer: 'rgba(214,72,40,0.55)' },
  dark: { page: '#101410', surround: '#060806', ink: '#7ee787', ai: '#6aa9ff', edge: 'rgba(126,231,135,0.18)', pointer: 'rgba(255,190,90,0.6)' },
}

interface Cam {
  cx: number // centre in page units (x: 0..pageAspect, y: 0..1)
  cy: number
  h: number // visible height in page units
}

export class Stage {
  private cache = document.createElement('canvas') // finished ink, transparent
  private live = document.createElement('canvas') // strokes still being drawn
  private cacheValid = false
  private cachedDone = 0
  private cachedLastId = ''
  private dirty = true
  private cam: Cam = { cx: 0, cy: 0.5, h: 1.1 }
  private camAt: Cam = { cx: 0, cy: 0.5, h: 1.1 } // camera the cache was drawn with
  private pointer: { x: number; y: number; tool: string; at: number } | null = null
  private backdrop: HTMLVideoElement | HTMLImageElement | null = null
  theme: Theme = 'paper'
  view: View = 'focus'
  showAi = false

  constructor(
    private canvas: HTMLCanvasElement,
    private store: StrokeStore,
    private pageAspect: number, // width / height (Paper Pro 1620/2160)
  ) {
    this.cam.cx = this.camAt.cx = pageAspect / 2
    new ResizeObserver(() => this.resize()).observe(canvas)
    this.resize()
    const frame = () => {
      this.step()
      requestAnimationFrame(frame)
    }
    requestAnimationFrame(frame)
  }

  /** Something changed (points arrived): redraw on the next animation frame. */
  touch() {
    this.dirty = true
  }

  /** Strokes were removed or restyled (clear, prune, replay, theme): rebuild the cache. */
  invalidate() {
    this.cacheValid = false
    this.dirty = true
  }

  setTheme(t: Theme) {
    this.theme = t
    this.invalidate()
  }

  /** Draw over a camera feed or photo instead of paper (null: back to paper). */
  setBackdrop(b: HTMLVideoElement | HTMLImageElement | null) {
    this.backdrop = b
    this.invalidate() // ink style changes (halo) with the backdrop
  }

  get hasBackdrop() {
    return this.backdrop !== null
  }

  setView(v: View) {
    this.view = v
    this.dirty = true
  }

  /** The pen hovers at (x, y) in normalized page coords; null when it left range. */
  setPointer(x: number | null, y = 0, tool = 'pen') {
    this.pointer = x === null ? null : { x, y, tool, at: performance.now() }
    this.dirty = true
  }

  private resize() {
    const dpr = Math.min(3, window.devicePixelRatio || 1)
    const r = this.canvas.getBoundingClientRect()
    const w = Math.max(1, Math.round(r.width * dpr))
    const h = Math.max(1, Math.round(r.height * dpr))
    if (this.canvas.width === w && this.canvas.height === h) return
    this.canvas.width = this.cache.width = w
    this.canvas.height = this.cache.height = h
    this.invalidate()
  }

  /** Where the camera wants to be: the whole page, or the writing with room around it. */
  private target(): Cam {
    const W = this.canvas.width
    const H = this.canvas.height
    const screenAspect = W / H
    const A = this.pageAspect
    const whole = { cx: A / 2, cy: 0.5, h: Math.max(1, A / screenAspect) * 1.06 }
    if (this.view === 'page') return whole
    let x0 = Infinity
    let y0 = Infinity
    let x1 = -Infinity
    let y1 = -Infinity
    for (const s of this.store.all()) {
      if (s.layer === 'ai' && !this.showAi) continue
      if (s.pts.length === 0) continue
      x0 = Math.min(x0, s.box[0])
      y0 = Math.min(y0, s.box[1])
      x1 = Math.max(x1, s.box[2])
      y1 = Math.max(y1, s.box[3])
    }
    if (this.pointer) {
      x0 = Math.min(x0, this.pointer.x)
      y0 = Math.min(y0, this.pointer.y)
      x1 = Math.max(x1, this.pointer.x)
      y1 = Math.max(y1, this.pointer.y)
    }
    if (!isFinite(x0)) return whole
    // in page units, with a margin; never tighter than a third of the page width
    const minW = A / 3
    let w = Math.max(minW, (x1 - x0) * A * 1.25)
    let h = Math.max(minW / screenAspect, (y1 - y0) * 1.25)
    if (w / h > screenAspect) h = w / screenAspect
    else w = h * screenAspect
    if (h >= whole.h) return whole
    return { cx: ((x0 + x1) / 2) * A, cy: (y0 + y1) / 2, h }
  }

  private step() {
    const t = this.target()
    const c = this.cam
    const k = 0.14 // glide: ~0.3 s to settle at 60 fps
    const moving = Math.abs(t.cx - c.cx) > 1e-4 || Math.abs(t.cy - c.cy) > 1e-4 || Math.abs(t.h - c.h) / t.h > 1e-3
    if (moving) {
      c.cx += (t.cx - c.cx) * k
      c.cy += (t.cy - c.cy) * k
      c.h += (t.h - c.h) * k
      this.dirty = true
    }
    if (this.pointer && performance.now() - this.pointer.at > 2500) this.setPointer(null) // stale
    const live = this.backdrop instanceof HTMLVideoElement && !this.backdrop.paused
    if (this.dirty || live) this.draw()
  }

  /** page units → device pixels for the current camera */
  private xf(cam: Cam) {
    const W = this.canvas.width
    const H = this.canvas.height
    const s = H / cam.h
    const A = this.pageAspect
    return {
      s,
      X: (nx: number) => W / 2 + (nx * A - cam.cx) * s,
      Y: (ny: number) => H / 2 + (ny - cam.cy) * s,
    }
  }

  private paintStroke(ctx: CanvasRenderingContext2D, s: Stroke, cam: Cam) {
    if (s.pts.length === 0) return
    if (s.layer === 'ai' && !this.showAi) return
    const t = THEMES[this.theme]
    const { s: scale, X, Y } = this.xf(cam)
    // ~0.5 mm fineliner at full pressure on the 1620-px-wide page, scaled to the view
    const base = (scale * this.pageAspect) / 1620
    const eraser = s.brush === 'eraser'
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    if (eraser) {
      // the ink layer is transparent: erasing cuts it, whatever is behind (paper, video) shows
      ctx.globalCompositeOperation = 'destination-out'
      ctx.strokeStyle = ctx.fillStyle = '#000'
    } else if (this.backdrop) {
      ctx.strokeStyle = ctx.fillStyle = s.layer === 'ai' ? '#9cc7ff' : '#ffffff'
      ctx.shadowColor = 'rgba(0,0,0,0.75)'
      ctx.shadowBlur = Math.max(2, base * 6)
    } else {
      ctx.strokeStyle = ctx.fillStyle = s.layer === 'ai' ? t.ai : t.ink
    }
    const pts = s.pts
    const width = (p: number) => (eraser ? base * 24 : base * (this.backdrop ? 2 : 1.4) + base * 4.2 * p)
    try {
      this.paintPath(ctx, pts, width, X, Y)
    } finally {
      ctx.globalCompositeOperation = 'source-over'
      ctx.shadowBlur = 0
      ctx.shadowColor = 'transparent'
    }
  }

  private paintPath(ctx: CanvasRenderingContext2D, pts: number[][], width: (p: number) => number, X: (n: number) => number, Y: (n: number) => number) {
    if (pts.length === 1) {
      ctx.beginPath()
      ctx.arc(X(pts[0][0]), Y(pts[0][1]), width(pts[0][2]) / 2, 0, Math.PI * 2)
      ctx.fill()
      return
    }
    // one segment per pair: per-point pressure, smoothed through midpoints (quadratic curves)
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1]
      const b = pts[i]
      ctx.lineWidth = width((a[2] + b[2]) / 2)
      ctx.beginPath()
      const ax = X(a[0])
      const ay = Y(a[1])
      const bx = X(b[0])
      const by = Y(b[1])
      if (i >= 2) {
        const z = pts[i - 2]
        ctx.moveTo((X(z[0]) + ax) / 2, (Y(z[1]) + ay) / 2)
        ctx.quadraticCurveTo(ax, ay, (ax + bx) / 2, (ay + by) / 2)
      } else {
        ctx.moveTo(ax, ay)
        ctx.lineTo((ax + bx) / 2, (ay + by) / 2)
      }
      ctx.stroke()
    }
    const z = pts[pts.length - 2]
    const b = pts[pts.length - 1]
    ctx.lineWidth = width(b[2])
    ctx.beginPath()
    ctx.moveTo((X(z[0]) + X(b[0])) / 2, (Y(z[1]) + Y(b[1])) / 2)
    ctx.lineTo(X(b[0]), Y(b[1]))
    ctx.stroke()
  }

  private paintBackground(ctx: CanvasRenderingContext2D, cam: Cam) {
    const b = this.backdrop
    if (b) {
      // cover the screen with the camera image, cropping the excess (like a camera viewfinder)
      const bw = b instanceof HTMLVideoElement ? b.videoWidth : b.naturalWidth
      const bh = b instanceof HTMLVideoElement ? b.videoHeight : b.naturalHeight
      const W = this.canvas.width
      const H = this.canvas.height
      ctx.fillStyle = '#000'
      ctx.fillRect(0, 0, W, H)
      if (bw && bh) {
        const k = Math.max(W / bw, H / bh)
        ctx.drawImage(b, (W - bw * k) / 2, (H - bh * k) / 2, bw * k, bh * k)
      }
      return
    }
    const t = THEMES[this.theme]
    const { X, Y } = this.xf(cam)
    ctx.fillStyle = t.surround
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height)
    const x = X(0)
    const y = Y(0)
    const w = X(1) - x
    const h = Y(1) - y
    ctx.save()
    ctx.shadowColor = t.edge
    ctx.shadowBlur = Math.max(4, w * 0.02)
    ctx.fillStyle = t.page
    ctx.fillRect(x, y, w, h)
    ctx.restore()
  }

  private paintPointer(ctx: CanvasRenderingContext2D) {
    if (!this.pointer) return
    const t = THEMES[this.theme]
    const { X, Y } = this.xf(this.cam)
    const r = Math.max(6, Math.min(this.canvas.width, this.canvas.height) * 0.012)
    ctx.beginPath()
    ctx.arc(X(this.pointer.x), Y(this.pointer.y), this.pointer.tool === 'eraser' ? r * 1.8 : r, 0, Math.PI * 2)
    if (this.pointer.tool === 'eraser') {
      ctx.strokeStyle = t.pointer
      ctx.lineWidth = r * 0.35
      ctx.stroke()
    } else {
      ctx.fillStyle = t.pointer
      ctx.fill()
    }
  }

  private draw() {
    this.dirty = false
    const strokes = this.store.all()
    const done = strokes.filter((s) => s.done)
    const cam = this.cam
    const camMoved = cam.cx !== this.camAt.cx || cam.cy !== this.camAt.cy || cam.h !== this.camAt.h
    // Finished strokes accumulate in the cache; rebuild it when the camera moved or the finished
    // list is no longer an extension of what was cached (removed, replayed, out of order).
    const extendsCache = done.length >= this.cachedDone && (this.cachedDone === 0 || done[this.cachedDone - 1]?.id === this.cachedLastId)
    if (!this.cacheValid || camMoved || !extendsCache) {
      const c = this.cache.getContext('2d')!
      c.clearRect(0, 0, this.cache.width, this.cache.height) // ink only; the background is per frame
      for (const s of done) this.paintStroke(c, s, cam)
      this.camAt = { ...cam }
      this.cacheValid = true
    } else if (done.length > this.cachedDone) {
      const c = this.cache.getContext('2d')!
      for (const s of done.slice(this.cachedDone)) this.paintStroke(c, s, cam)
    }
    this.cachedDone = done.length
    this.cachedLastId = done.length ? done[done.length - 1].id : ''
    const ctx = this.canvas.getContext('2d')!
    this.paintBackground(ctx, cam)
    ctx.drawImage(this.cache, 0, 0)
    // live strokes go through a scratch layer too, so an eraser cuts ink and never the background
    if (strokes.some((s) => !s.done)) {
      const l = this.live.getContext('2d')!
      this.live.width = this.canvas.width
      this.live.height = this.canvas.height
      for (const s of strokes) if (!s.done) this.paintStroke(l, s, cam)
      ctx.drawImage(this.live, 0, 0)
    }
    this.paintPointer(ctx)
  }
}
