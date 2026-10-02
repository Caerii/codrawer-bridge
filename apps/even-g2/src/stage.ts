/**
 * Stage: the phone screen's view of the page, made to be looked at (and projected).
 *
 * Separate from the glasses pipeline (strokes.ts rasterize → tiny binarized frames): this draws
 * the whole page at the phone's full resolution, anti-aliased, with pressure-weighted ink, on a
 * paper or dark theme, and redraws on every animation frame while ink arrives. Finished strokes
 * live in an offscreen cache, so a frame costs one blit plus the strokes still being drawn.
 */
import type { Stroke, StrokeStore } from './strokes'

export type Theme = 'paper' | 'dark'

const THEMES: Record<Theme, { page: string; surround: string; ink: string; ai: string; edge: string }> = {
  // the reMarkable's warm off-white page and near-black ink
  paper: { page: '#f6f4ee', surround: '#e4e1d8', ink: '#1d1d1b', ai: '#3a6ea5', edge: 'rgba(0,0,0,0.10)' },
  dark: { page: '#101410', surround: '#060806', ink: '#7ee787', ai: '#6aa9ff', edge: 'rgba(126,231,135,0.18)' },
}

export class Stage {
  private cache = document.createElement('canvas')
  private cacheValid = false
  private cachedDone = 0
  private cachedLastId = ''
  private dirty = true
  private page = { x: 0, y: 0, w: 1, h: 1 } // page rectangle in device pixels
  theme: Theme = 'paper'
  showAi = false

  constructor(
    private canvas: HTMLCanvasElement,
    private store: StrokeStore,
    private pageAspect: number, // width / height (Paper Pro 1620/2160)
  ) {
    new ResizeObserver(() => this.resize()).observe(canvas)
    this.resize()
    const frame = () => {
      if (this.dirty) this.draw()
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

  private resize() {
    const dpr = Math.min(3, window.devicePixelRatio || 1)
    const r = this.canvas.getBoundingClientRect()
    const w = Math.max(1, Math.round(r.width * dpr))
    const h = Math.max(1, Math.round(r.height * dpr))
    if (this.canvas.width === w && this.canvas.height === h) return
    this.canvas.width = this.cache.width = w
    this.canvas.height = this.cache.height = h
    // fit the page, keeping its aspect, with a margin that scales with the screen
    const m = Math.round(Math.min(w, h) * 0.03)
    const scale = Math.min((w - 2 * m) / this.pageAspect, h - 2 * m)
    const pw = scale * this.pageAspect
    const ph = scale
    this.page = { x: (w - pw) / 2, y: (h - ph) / 2, w: pw, h: ph }
    this.invalidate()
  }

  private paintStroke(ctx: CanvasRenderingContext2D, s: Stroke) {
    if (s.pts.length === 0) return
    if (s.layer === 'ai' && !this.showAi) return
    const t = THEMES[this.theme]
    const { x, y, w, h } = this.page
    // ~0.5 mm fineliner at full pressure on the 1620-px-wide page, scaled to this screen
    const base = w / 1620
    const eraser = s.brush === 'eraser'
    ctx.strokeStyle = eraser ? t.page : s.layer === 'ai' ? t.ai : t.ink
    ctx.fillStyle = ctx.strokeStyle
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    const pts = s.pts
    if (pts.length === 1) {
      const r = base * (eraser ? 12 : 1.2 + 2.4 * pts[0][2])
      ctx.beginPath()
      ctx.arc(x + pts[0][0] * w, y + pts[0][1] * h, r, 0, Math.PI * 2)
      ctx.fill()
      return
    }
    // one segment per pair: per-point pressure, smoothed through midpoints (quadratic curves)
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1]
      const b = pts[i]
      const p = (a[2] + b[2]) / 2
      ctx.lineWidth = eraser ? base * 24 : base * (1.4 + 4.2 * p)
      ctx.beginPath()
      const ax = x + a[0] * w
      const ay = y + a[1] * h
      const bx = x + b[0] * w
      const by = y + b[1] * h
      if (i >= 2) {
        const z = pts[i - 2]
        ctx.moveTo((x + z[0] * w + ax) / 2, (y + z[1] * h + ay) / 2)
        ctx.quadraticCurveTo(ax, ay, (ax + bx) / 2, (ay + by) / 2)
      } else {
        ctx.moveTo(ax, ay)
        ctx.lineTo((ax + bx) / 2, (ay + by) / 2)
      }
      ctx.stroke()
    }
    // close the last half-segment
    const z = pts[pts.length - 2]
    const b = pts[pts.length - 1]
    ctx.lineWidth = eraser ? base * 24 : base * (1.4 + 4.2 * b[2])
    ctx.beginPath()
    ctx.moveTo(x + ((z[0] + b[0]) / 2) * w, y + ((z[1] + b[1]) / 2) * h)
    ctx.lineTo(x + b[0] * w, y + b[1] * h)
    ctx.stroke()
  }

  private paintPage(ctx: CanvasRenderingContext2D) {
    const t = THEMES[this.theme]
    const { x, y, w, h } = this.page
    ctx.fillStyle = t.surround
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height)
    ctx.save()
    ctx.shadowColor = t.edge
    ctx.shadowBlur = Math.max(4, w * 0.02)
    ctx.fillStyle = t.page
    ctx.fillRect(x, y, w, h)
    ctx.restore()
  }

  private draw() {
    this.dirty = false
    const strokes = this.store.all()
    const done = strokes.filter((s) => s.done)
    // finished strokes accumulate in the cache; rebuild it when the finished list is no longer
    // an extension of what was cached (removed, replayed or finished out of order)
    const extends_ = done.length >= this.cachedDone && (this.cachedDone === 0 || done[this.cachedDone - 1]?.id === this.cachedLastId)
    if (!this.cacheValid || !extends_) {
      const c = this.cache.getContext('2d')!
      this.paintPage(c)
      for (const s of done) this.paintStroke(c, s)
      this.cacheValid = true
    } else if (done.length > this.cachedDone) {
      const c = this.cache.getContext('2d')!
      for (const s of done.slice(this.cachedDone)) this.paintStroke(c, s)
    }
    this.cachedDone = done.length
    this.cachedLastId = done.length ? done[done.length - 1].id : ''
    const ctx = this.canvas.getContext('2d')!
    ctx.drawImage(this.cache, 0, 0)
    for (const s of strokes) if (!s.done) this.paintStroke(ctx, s)
  }
}
