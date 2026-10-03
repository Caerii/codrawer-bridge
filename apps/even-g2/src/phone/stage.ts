/**
 * Stage: the phone screen's view of the page, made to be looked at (and projected).
 *
 * Separate from the glasses pipeline (strokes.ts rasterize → tiny binarized frames): this draws
 * the page at the phone's full resolution, anti-aliased, with pressure-weighted ink, on a paper
 * or dark theme, and redraws on every animation frame while ink arrives.
 *
 * - View: "page" shows the whole page; "focus" frames the writing (ink bounds with margin, never
 *   tighter than a third of the page) so a projector is not mostly empty paper; "follow" tracks
 *   the pen at the glasses' follow scale (the same slice of page width), so a ring tap that
 *   switches the glasses between follow and full does the same here. The camera glides to its
 *   target instead of jumping.
 * - Pointer: where the pen hovers (cursor messages), so viewers can follow before ink appears.
 * - Loupe overlay (Fit and Page views): a dashed box for what the glasses loupe shows, with a
 *   corner handle: drag it to change the loupe's zoom.
 * - Backdrop: the phone camera (live video, or a still) instead of paper: ink is drawn white with
 *   a soft dark halo so it reads over any scene. Drawing over the world.
 * - Finished strokes live in an offscreen, transparent ink layer while the view is still; a frame
 *   is then the background (paper or video), one blit, and the strokes still being drawn.
 * - Export: pagePng() draws the whole page at its own resolution the same way, for the phone
 *   menu's "Download page as PNG".
 */
import type { Stroke, StrokeStore } from '../strokes'
import { ERASER_TOOLS, WASH_TOOLS } from '../strokes'

/** "#rrggbbaa" or "#rrggbb" → [r, g, b, a] (0..255); black when missing or malformed. */
export function parseRgba(c: string | undefined): [number, number, number, number] {
  const m = typeof c === 'string' ? /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(c) : null
  if (!m) return [0, 0, 0, 255]
  const v = parseInt(m[1], 16)
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255, m[2] ? parseInt(m[2], 16) : 255]
}

export type Theme = 'paper' | 'dark'
export type View = 'page' | 'focus' | 'follow'

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
  /** follow view: visible width as a fraction of the page width (the glasses' opts.window) */
  followWindow = 0.22
  showAi = false
  /** the glasses loupe's view in normalized page coords [x0, y0, x1, y1]; null hides it */
  loupeRect: () => number[] | null = () => null
  /** the loupe box was resized to this width (fraction of the page width) */
  onLoupeResize: (window: number) => void = () => {}
  private handle: { x: number; y: number; r: number } | null = null // device px, last drawn
  /** Draw mode: pointer input on the stage draws (a mouse, a finger, an Apple Pencil). */
  drawMode = false
  /** pen down / move / up in normalized page coords, pressure 0..1 (draw mode only) */
  onDraw: (phase: 'down' | 'move' | 'up', x: number, y: number, pressure: number) => void = () => {}
  private drawing = false
  private dragging: { cx: number } | null = null
  private exportSize: { w: number; h: number } | null = null // set while pagePng() paints
  private suppressClick = false

  constructor(
    private canvas: HTMLCanvasElement,
    private store: StrokeStore,
    private pageAspect: number, // width / height (Paper Pro 1620/2160)
  ) {
    this.cam.cx = this.camAt.cx = pageAspect / 2
    new ResizeObserver(() => this.resize()).observe(canvas)
    this.wireHandle()
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
    if (this.view === 'follow') {
      const pen = this.pointer ? [this.pointer.x, this.pointer.y] : this.store.lastPoint
      if (pen) {
        const h = (this.followWindow * A) / screenAspect // same page width as the glasses view
        return h >= whole.h ? whole : { cx: pen[0] * A, cy: pen[1], h }
      }
      // no pen yet: frame the writing until there is one
    }
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
    if (this.drawing) {
      // hold the camera still under a stroke being drawn here, or the line would bend
      if (this.dirty) this.draw()
      return
    }
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
    const W = this.exportSize?.w ?? this.canvas.width
    const H = this.exportSize?.h ?? this.canvas.height
    const s = H / cam.h
    const A = this.pageAspect
    return {
      s,
      X: (nx: number) => W / 2 + (nx * A - cam.cx) * s,
      Y: (ny: number) => H / 2 + (ny - cam.cy) * s,
    }
  }

  /**
   * A stroke from the tablet's saved page, drawn as the tablet draws it: its colour, its
   * per-point width from the file, translucency for highlighter and shader, a lighter pencil.
   * Eraser strokes paint nothing (their effect is already in the page).
   */
  private paintPageStroke(ctx: CanvasRenderingContext2D, s: Stroke, cam: Cam) {
    const tool = s.tool ?? 'pen'
    if (ERASER_TOOLS.has(tool)) return
    const t = THEMES[this.theme]
    const { s: scale, X, Y } = this.xf(cam)
    const pagePx = scale * this.pageAspect // device pixels per page width
    const rgba = parseRgba(s.color)
    const wash = WASH_TOOLS.has(tool)
    // black ink follows the theme (near-black on paper, the dark theme's ink); colours stay
    const isBlack = rgba[0] < 24 && rgba[1] < 24 && rgba[2] < 24
    let color = isBlack ? t.ink : `rgb(${rgba[0]},${rgba[1]},${rgba[2]})`
    if (this.backdrop && !wash) color = '#ffffff'
    let alpha = 1
    if (tool === 'highlighter') alpha = 0.35 // stored opaque, drawn translucent by xochitl
    else if (tool === 'shader') alpha = Math.max(0.08, rgba[3] / 255)
    else if (tool === 'pencil') alpha = 0.8
    else if (tool === 'mechanical_pencil') alpha = 0.7
    const fallback = (p: number) => pagePx * ((1.4 + 4.2 * p) / 1620)
    const width = (pt: number[]) => (pt.length >= 4 && pt[3] > 0 ? Math.max(0.6, pt[3] * pagePx) : fallback(pt[2]))
    ctx.save()
    try {
      ctx.strokeStyle = ctx.fillStyle = color
      ctx.lineJoin = 'round'
      ctx.lineCap = tool === 'highlighter' ? 'square' : 'round'
      if (this.backdrop && !wash) {
        ctx.shadowColor = 'rgba(0,0,0,0.75)'
        ctx.shadowBlur = Math.max(2, (pagePx / 1620) * 6)
      }
      if (wash || alpha < 1) {
        // one path at one width, so overlapping segments do not darken the wash
        ctx.globalAlpha = alpha
        if (tool === 'highlighter') ctx.globalCompositeOperation = 'multiply'
        const pts = s.pts
        let wsum = 0
        for (const p of pts) wsum += width(p)
        ctx.lineWidth = wsum / Math.max(1, pts.length)
        ctx.beginPath()
        ctx.moveTo(X(pts[0][0]), Y(pts[0][1]))
        for (let i = 1; i < pts.length; i++) ctx.lineTo(X(pts[i][0]), Y(pts[i][1]))
        if (pts.length === 1) ctx.lineTo(X(pts[0][0]) + 0.01, Y(pts[0][1]))
        ctx.stroke()
        return
      }
      this.paintPath(ctx, s.pts, width, X, Y)
    } finally {
      ctx.restore()
    }
  }

  private paintStroke(ctx: CanvasRenderingContext2D, s: Stroke, cam: Cam) {
    if (s.pts.length === 0) return
    if (s.layer === 'ai' && !this.showAi) return
    if (s.fromPage) return this.paintPageStroke(ctx, s, cam)
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
      ctx.strokeStyle = ctx.fillStyle = s.layer === 'peer' && s.color ? s.color : s.layer === 'ai' ? t.ai : t.ink
    }
    const pts = s.pts
    const width = (p: number) => (eraser ? base * 24 : base * (this.backdrop ? 2 : 1.4) + base * 4.2 * p)
    try {
      this.paintPath(ctx, pts, (pt) => width(pt[2]), X, Y)
    } finally {
      ctx.globalCompositeOperation = 'source-over'
      ctx.shadowBlur = 0
      ctx.shadowColor = 'transparent'
    }
  }

  private paintPath(ctx: CanvasRenderingContext2D, pts: number[][], width: (pt: number[]) => number, X: (n: number) => number, Y: (n: number) => number) {
    if (pts.length === 1) {
      ctx.beginPath()
      ctx.arc(X(pts[0][0]), Y(pts[0][1]), width(pts[0]) / 2, 0, Math.PI * 2)
      ctx.fill()
      return
    }
    // one segment per pair: per-point pressure, smoothed through midpoints (quadratic curves)
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1]
      const b = pts[i]
      ctx.lineWidth = (width(a) + width(b)) / 2
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
    ctx.lineWidth = width(b)
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

  /** Resize the glasses rectangle by dragging its corner handle (pointer events on the stage). */
  private wireHandle() {
    const toDevice = (e: PointerEvent) => {
      const r = this.canvas.getBoundingClientRect()
      const k = this.canvas.width / Math.max(1, r.width)
      return { x: (e.clientX - r.left) * k, y: (e.clientY - r.top) * k }
    }
    // Draw mode takes the pointer first: every down/move/up becomes a stroke in page coords.
    this.canvas.addEventListener('pointerdown', (e) => {
      if (!this.drawMode) return
      const [x, y] = this.toPage(e)
      this.drawing = true
      this.canvas.setPointerCapture(e.pointerId)
      this.onDraw('down', x, y, e.pressure || 0.5)
      e.preventDefault()
      e.stopImmediatePropagation()
    })
    this.canvas.addEventListener('pointermove', (e) => {
      if (!this.drawing) return
      // coalesced events: a pen reports far more often than animation frames
      for (const ev of e.getCoalescedEvents?.() ?? [e]) {
        const [x, y] = this.toPage(ev)
        this.onDraw('move', x, y, ev.pressure || 0.5)
      }
      e.stopImmediatePropagation()
    })
    const lift = (e: PointerEvent) => {
      if (!this.drawing) return
      this.drawing = false
      const [x, y] = this.toPage(e)
      this.onDraw('up', x, y, e.pressure || 0.5)
      this.suppressClick = true // not a tap on the page
      e.stopImmediatePropagation()
    }
    this.canvas.addEventListener('pointerup', lift)
    this.canvas.addEventListener('pointercancel', lift)

    this.canvas.addEventListener('pointerdown', (e) => {
      const h = this.handle
      if (!h) return
      const p = toDevice(e)
      if (Math.hypot(p.x - h.x, p.y - h.y) > h.r * 2.2) return // generous touch target
      const box = this.loupeRect()
      if (!box) return
      const { X } = this.xf(this.cam)
      this.dragging = { cx: X((box[0] + box[2]) / 2) }
      this.canvas.setPointerCapture(e.pointerId)
      e.preventDefault()
    })
    this.canvas.addEventListener('pointermove', (e) => {
      if (!this.dragging) return
      const p = toDevice(e)
      // the box stays centred where it is: its width is twice the handle's distance
      const { s } = this.xf(this.cam)
      const widthPageUnits = (2 * Math.abs(p.x - this.dragging.cx)) / s
      const w = Math.min(1, Math.max(0.06, widthPageUnits / this.pageAspect))
      this.onLoupeResize(w)
      this.dirty = true
    })
    const end = (e: PointerEvent) => {
      if (!this.dragging) return
      this.dragging = null
      this.suppressClick = true // the tap-to-hide-the-bar must not fire after a drag
      this.canvas.releasePointerCapture(e.pointerId)
    }
    this.canvas.addEventListener('pointerup', end)
    this.canvas.addEventListener('pointercancel', end)
  }

  /** A pointer position as normalized page coords [x, y] under the current camera. */
  toPage(e: { clientX: number; clientY: number }): [number, number] {
    const r = this.canvas.getBoundingClientRect()
    const k = this.canvas.width / Math.max(1, r.width)
    const X = (e.clientX - r.left) * k
    const Y = (e.clientY - r.top) * k
    const s = this.canvas.height / this.cam.h
    const nx = ((X - this.canvas.width / 2) / s + this.cam.cx) / this.pageAspect
    const ny = (Y - this.canvas.height / 2) / s + this.cam.cy
    return [nx, ny]
  }

  /**
   * The whole page as a PNG, `width` device px wide (default 1620, the Paper Pro page's own
   * width; the height follows the page aspect). Drawn as the stage draws it, on the current
   * theme's paper, but without the camera backdrop, the pointer or the loupe box. Resolves null
   * if the browser cannot encode it.
   */
  pagePng(width = 1620): Promise<Blob | null> {
    const w = Math.round(width)
    const h = Math.round(width / this.pageAspect)
    // ink on its own transparent layer first, as on screen, so eraser strokes cut ink, not paper
    const ink = document.createElement('canvas')
    ink.width = w
    ink.height = h
    const backdrop = this.backdrop
    this.backdrop = null
    this.exportSize = { w, h }
    try {
      const cam = { cx: this.pageAspect / 2, cy: 0.5, h: 1 } // exactly the page
      const ictx = ink.getContext('2d')!
      for (const s of this.store.all()) this.paintStroke(ictx, s, cam)
    } finally {
      this.backdrop = backdrop
      this.exportSize = null
    }
    const out = document.createElement('canvas')
    out.width = w
    out.height = h
    const ctx = out.getContext('2d')!
    ctx.fillStyle = THEMES[this.theme].page
    ctx.fillRect(0, 0, w, h)
    ctx.drawImage(ink, 0, 0)
    return new Promise((resolve) => out.toBlob(resolve, 'image/png'))
  }

  /** True once after a handle drag (lets the page's tap handler ignore the drag's click). */
  consumeDrag(): boolean {
    const was = this.suppressClick
    this.suppressClick = false
    return was
  }

  private paintGlasses(ctx: CanvasRenderingContext2D) {
    this.handle = null
    if (this.view === 'follow' || this.backdrop) return
    const box = this.loupeRect()
    if (!box) return
    const { X, Y } = this.xf(this.cam)
    const dpr = this.canvas.width / Math.max(1, this.canvas.getBoundingClientRect().width)
    const accent = this.theme === 'paper' ? 'rgba(47,128,95,' : 'rgba(126,231,135,'
    const x0 = X(box[0])
    const y0 = Y(box[1])
    const x1 = X(box[2])
    const y1 = Y(box[3])
    ctx.save()
    ctx.fillStyle = accent + '0.05)'
    ctx.fillRect(x0, y0, x1 - x0, y1 - y0)
    ctx.setLineDash([5 * dpr, 4 * dpr])
    ctx.lineWidth = 1.5 * dpr
    ctx.strokeStyle = accent + '0.9)'
    ctx.strokeRect(x0, y0, x1 - x0, y1 - y0)
    ctx.setLineDash([])
    const r = 7 * dpr
    ctx.fillStyle = accent + '1)'
    ctx.beginPath()
    ctx.roundRect(x1 - r, y1 - r, 2 * r, 2 * r, 3 * dpr)
    ctx.fill()
    ctx.restore()
    this.handle = { x: x1, y: y1, r }
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
    this.paintGlasses(ctx)
    this.paintPointer(ctx)
  }
}
