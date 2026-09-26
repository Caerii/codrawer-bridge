/**
 * Stroke store + rasterizer for the G2 image container.
 *
 * Mirrors the codrawer-bridge protocol (docs/protocol.md): points are normalized
 * [x, y, p, t?] in [0,1]; user ink and AI ink live on separate layers and the AI
 * never overwrites user ink. Rendering is client-side, as the protocol requires.
 */

export type Layer = 'user' | 'ai'

export interface Stroke {
  id: string
  layer: Layer
  brush: string
  pts: number[][] // [x, y, p] (t dropped)
  done: boolean
  endedAt: number
}

export type ViewMode = 'follow' | 'full'
export type Highlight = 'all' | 'user' | 'ai'

export interface RasterOptions {
  width: number
  height: number
  mode: ViewMode
  highlight: Highlight
  /** normalized width of the follow window (fraction of the page) */
  window: number
  /** page aspect (w/h) used in full mode; Paper Pro is 1620x2160 */
  pageAspect: number
}

const RETENTION_MS = 5 * 60 * 1000
const MAX_STROKES = 400

export class StrokeStore {
  private strokes = new Map<string, Stroke>()
  private order: string[] = []
  lastPoint: [number, number] | null = null
  dirty = true

  begin(id: string, layer: Layer, brush = 'pen') {
    const s: Stroke = { id, layer, brush, pts: [], done: false, endedAt: 0 }
    this.strokes.set(id, s)
    this.order.push(id)
    if (this.order.length > MAX_STROKES) {
      const drop = this.order.shift()
      if (drop) this.strokes.delete(drop)
    }
    this.dirty = true
  }

  points(id: string, pts: number[][], layerHint: Layer) {
    let s = this.strokes.get(id)
    if (!s) {
      this.begin(id, layerHint)
      s = this.strokes.get(id)!
    }
    for (const p of pts) {
      if (!Array.isArray(p) || p.length < 2) continue
      s.pts.push([p[0], p[1], p.length >= 3 ? p[2] : 0.6])
      this.lastPoint = [p[0], p[1]]
    }
    this.dirty = true
  }

  end(id: string) {
    const s = this.strokes.get(id)
    if (s) {
      s.done = true
      s.endedAt = Date.now()
    }
    this.dirty = true
  }

  prune(now = Date.now()) {
    for (const id of [...this.order]) {
      const s = this.strokes.get(id)
      if (s && s.done && now - s.endedAt > RETENTION_MS) {
        this.strokes.delete(id)
        this.order = this.order.filter((x) => x !== id)
        this.dirty = true
      }
    }
  }

  all(): Stroke[] {
    return this.order.map((id) => this.strokes.get(id)!).filter(Boolean)
  }

  get size() {
    return this.order.length
  }
}

/** Map normalized page coords into pixel coords for the chosen view. */
function makeMapper(o: RasterOptions, last: [number, number] | null) {
  if (o.mode === 'follow' && last) {
    const winW = o.window
    const winH = (o.window * o.height) / o.width / o.pageAspect
    const x0 = last[0] - winW / 2
    const y0 = last[1] - winH / 2
    return (x: number, y: number): [number, number] => [((x - x0) / winW) * o.width, ((y - y0) / winH) * o.height]
  }
  // full page, letterboxed inside the container, preserving the page aspect
  const contAspect = o.width / o.height
  let dw: number
  let dh: number
  if (contAspect > o.pageAspect) {
    dh = o.height
    dw = dh * o.pageAspect
  } else {
    dw = o.width
    dh = dw / o.pageAspect
  }
  const ox = (o.width - dw) / 2
  const oy = (o.height - dh) / 2
  return (x: number, y: number): [number, number] => [ox + x * dw, oy + y * dh]
}

/**
 * Draw the store into a 2D context. Brightness encodes layer: on the monochrome
 * HUD there is no color, so the emphasised layer is drawn brighter.
 */
export function rasterize(ctx: CanvasRenderingContext2D, store: StrokeStore, o: RasterOptions) {
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, o.width, o.height)
  const map = makeMapper(o, store.lastPoint)
  const follow = o.mode === 'follow'
  for (const s of store.all()) {
    if (s.pts.length < 2) continue
    const emphasised = o.highlight === 'all' || o.highlight === s.layer
    const lum = emphasised ? 255 : 110
    ctx.strokeStyle = `rgb(${lum},${lum},${lum})`
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    if (s.brush === 'eraser' && s.layer === 'user') {
      ctx.strokeStyle = '#000'
    }
    ctx.beginPath()
    let started = false
    for (const p of s.pts) {
      const [px, py] = map(p[0], p[1])
      const w = follow ? 1 + 2.5 * p[2] : 0.5 + 1.2 * p[2]
      ctx.lineWidth = s.brush === 'eraser' ? w * 6 : w
      if (!started) {
        ctx.moveTo(px, py)
        started = true
      } else {
        ctx.lineTo(px, py)
      }
    }
    ctx.stroke()
  }
  if (follow && store.lastPoint) {
    // pen cursor
    const [cx, cy] = map(store.lastPoint[0], store.lastPoint[1])
    ctx.strokeStyle = 'rgb(180,180,180)'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.arc(cx, cy, 3, 0, Math.PI * 2)
    ctx.stroke()
  }
}

/** RGBA canvas pixels → one byte per pixel (Gray8, 0..255). */
export function toGray8(ctx: CanvasRenderingContext2D, width: number, height: number): Uint8Array {
  const img = ctx.getImageData(0, 0, width, height).data
  const out = new Uint8Array(width * height)
  for (let i = 0, j = 0; i < img.length; i += 4, j++) {
    // luminance; the source is already grey so any channel works, average anyway
    out[j] = (img[i] + img[i + 1] + img[i + 2]) / 3
  }
  return out
}
