/**
 * Stroke store + rasterizer for the G2 image container.
 *
 * Mirrors the codrawer-bridge protocol (docs/protocol.md): points are normalized
 * [x, y, p, t?] in [0,1]; user ink and AI ink live on separate layers and the AI
 * never overwrites user ink. Rendering is client-side, as the protocol requires.
 */

import { zlibSync } from 'fflate'

/** user: the tablet's own ink · peer: another participant (phone, web, …) · ai: agent ink */
export type Layer = 'user' | 'ai' | 'peer'

export interface Stroke {
  id: string
  layer: Layer
  brush: string
  /** [x, y, p] (t kept apart, in `times`); strokes from the tablet's saved page carry [x, y, p, w] */
  pts: number[][]
  done: boolean
  endedAt: number
  /** bounding box in page coords [x0, y0, x1, y1], for culling in follow mode */
  box: [number, number, number, number]
  /** stroke_begin's ts (ms, the tablet's clock), for rebasing on a page snapshot */
  ts?: number
  /** Unix ms on this device's clock when the stroke began here (live strokes; for timelapses) */
  startedAt?: number
  /**
   * When each point was drawn, Unix ms, parallel to `pts` (live strokes; for timelapses): the
   * point's own `t` where the sender stamped one (the sender's clock), else when it arrived here.
   * Saved-page strokes have none: the .rm file keeps no times.
   */
  times?: number[]
  /** from the tablet's saved page (`page` message): exact tool, colour and size */
  fromPage?: boolean
  /** ADR 008 tool name (fineliner, ballpoint, …, highlighter, shader, eraser, erase_area) */
  tool?: string
  /** CSS colour "#rrggbbaa" */
  color?: string
  /** the tool's thickness setting */
  size?: number
  /** participant who drew it (peer layer) */
  author?: string
}

/** A `page` message (docs/protocol.md): the tablet's saved page, authoritative up to `rev`. */
export interface PageMessage {
  t: 'page'
  doc: string
  page: string
  title?: string
  rev: number
  strokes: { id: string; tool?: string; color?: number; rgba?: string; size?: number; pts: number[][] }[]
}

/** Tools that leave no ink of their own (their effect is already in the saved page). */
export const ERASER_TOOLS = new Set(['eraser', 'erase_area'])
/** Translucent tools. */
export const WASH_TOOLS = new Set(['highlighter', 'shader'])

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
  /** draw the AI layer at all (false = user ink only, saves bytes on the HUD) */
  showAi?: boolean
  /** follow mode: centre of the window in page coords (default: the pen) */
  center?: [number, number]
  /** a rectangle in page coords to outline (the loupe's view, shown on the big canvas) */
  marker?: [number, number, number, number]
  /**
   * full mode: magnification over the plain fit (1 = the whole inked area; 2 = twice as close),
   * centred on the pen (or `center`), kept inside the inked area. The ring's scroll sets it in the
   * wide fit view, which has no loupe to zoom instead (glasses/display.ts).
   */
  fitZoom?: number
}

// Memory and raster cost scale with points, so the page is bounded by points (oldest finished
// strokes go first), not by age: a long drawing keeps its beginning.
const MAX_STROKES = 3000
const MAX_POINTS = 120_000

export class StrokeStore {
  private strokes = new Map<string, Stroke>()
  private order: string[] = []
  private nPoints = 0
  /** last user pen position (follow mode tracks the user, never the AI) */
  lastPoint: [number, number] | null = null
  /** the tablet page the snapshot strokes belong to (null: no `page` message yet) */
  page: { doc: string; page: string; title?: string; rev: number } | null = null

  begin(id: string, layer: Layer, brush = 'pen', ts?: number, peer?: { color?: string; author?: string }) {
    const old = this.strokes.get(id)
    if (old) {
      // Seen before (a router replaying the page after a reconnect): restart it in place.
      this.nPoints -= old.pts.length
      old.layer = layer
      old.brush = brush
      old.pts = []
      old.done = false
      old.box = [1, 1, 0, 0]
      old.ts = ts
      old.startedAt = Date.now()
      old.times = []
      old.color = peer?.color ?? old.color
      old.author = peer?.author ?? old.author
      return
    }
    this.strokes.set(id, { id, layer, brush, pts: [], done: false, endedAt: 0, box: [1, 1, 0, 0], ts, startedAt: Date.now(), times: [], color: peer?.color, author: peer?.author })
    this.order.push(id)
  }

  /**
   * Make the tablet's saved page the base. The snapshot holds every stroke saved up to `rev`
   * (erased ones are absent), so earlier snapshot strokes go, live user strokes go unless they
   * began after `rev` (drawn since the save, in no file yet), and the snapshot's strokes come
   * first, then the kept live ones. On a different page (or document) the AI layer goes too:
   * it was drawn over the other page. Returns whether the page changed.
   */
  applyPage(m: PageMessage): boolean {
    const changed = !this.page || this.page.doc !== m.doc || this.page.page !== m.page
    const rev = Number(m.rev) || 0
    const keep: string[] = []
    for (const id of this.order) {
      const s = this.strokes.get(id)
      if (!s) continue
      // other participants' and the AI's ink is never in the tablet's file: it stays while the
      // page stays; the tablet's own live ink stays only if it began after the save
      const keepIt = s.layer !== 'user' ? !changed : !s.fromPage && s.ts !== undefined && s.ts > rev
      if (keepIt) keep.push(id)
      else {
        this.nPoints -= s.pts.length
        this.strokes.delete(id)
      }
    }
    const fresh: string[] = []
    for (const r of Array.isArray(m.strokes) ? m.strokes : []) {
      if (!r || typeof r.id !== 'string' || !Array.isArray(r.pts)) continue
      const id = 'rm:' + r.id // never collides with live ids
      const s: Stroke = {
        id,
        layer: 'user',
        brush: ERASER_TOOLS.has(r.tool ?? '') ? 'eraser' : 'pen',
        pts: [],
        done: true,
        endedAt: 0,
        box: [1, 1, 0, 0],
        fromPage: true,
        tool: r.tool,
        color: typeof r.rgba === 'string' ? r.rgba : undefined,
        size: typeof r.size === 'number' ? r.size : undefined,
      }
      const b = s.box
      for (const p of r.pts) {
        if (!Array.isArray(p) || p.length < 2) continue
        const [x, y] = p
        s.pts.push(p.length >= 4 ? [x, y, p[2], p[3]] : [x, y, p.length >= 3 ? p[2] : 0.6])
        if (x < b[0]) b[0] = x
        if (y < b[1]) b[1] = y
        if (x > b[2]) b[2] = x
        if (y > b[3]) b[3] = y
      }
      this.nPoints += s.pts.length
      this.strokes.delete(id) // a duplicate id inside one snapshot: the last wins
      this.strokes.set(id, s)
      fresh.push(id)
    }
    this.order = [...new Set(fresh), ...keep]
    this.page = { doc: m.doc, page: m.page, title: m.title, rev }
    if (changed) this.lastPoint = null
    return changed
  }

  points(id: string, pts: number[][], layerHint: Layer) {
    let s = this.strokes.get(id)
    if (!s) {
      this.begin(id, layerHint)
      s = this.strokes.get(id)!
    }
    const b = s.box
    const now = Date.now()
    const times = (s.times ??= [])
    for (const p of pts) {
      if (!Array.isArray(p) || p.length < 2) continue
      const x = p[0]
      const y = p[1]
      s.pts.push([x, y, p.length >= 3 ? p[2] : 0.6])
      // a sender's t is Unix ms (docs/protocol.md); anything else is not a time we can use
      times.push(p.length >= 4 && typeof p[3] === 'number' && p[3] > 1e12 ? p[3] : now)
      this.nPoints++
      if (x < b[0]) b[0] = x
      if (y < b[1]) b[1] = y
      if (x > b[2]) b[2] = x
      if (y > b[3]) b[3] = y
      if (s.layer === 'user') this.lastPoint = [x, y]
    }
  }

  end(id: string) {
    const s = this.strokes.get(id)
    if (s) {
      s.done = true
      s.endedAt = Date.now()
    }
  }

  /** Close every open stroke (the connection dropped mid-stroke; no stroke_end will come). */
  endOpen() {
    for (const s of this.strokes.values()) if (!s.done) this.end(s.id)
  }

  /** Drop every stroke, or only one layer's. */
  clear(layer?: Layer) {
    if (!layer) {
      this.strokes.clear()
      this.order = []
      this.nPoints = 0
      this.lastPoint = null
      this.page = null
    } else {
      for (const id of this.order) {
        const s = this.strokes.get(id)
        if (s?.layer === layer) {
          this.nPoints -= s.pts.length
          this.strokes.delete(id)
        }
      }
      this.order = this.order.filter((id) => this.strokes.has(id))
    }
  }

  /** Drop the oldest finished strokes while over budget. True when something was dropped. */
  prune(): boolean {
    let dropped = 0
    while ((this.order.length - dropped > MAX_STROKES || this.nPoints > MAX_POINTS) && dropped < this.order.length) {
      const s = this.strokes.get(this.order[dropped])
      if (!s || !s.done) break // never drop a stroke that is still being drawn
      this.nPoints -= s.pts.length
      this.strokes.delete(s.id)
      dropped++
    }
    if (dropped) this.order = this.order.slice(dropped)
    return dropped > 0
  }

  all(): Stroke[] {
    return this.order.map((id) => this.strokes.get(id)!).filter(Boolean)
  }

  get pointCount() {
    return this.nPoints
  }

  counts(): { user: number; ai: number } {
    let user = 0
    let ai = 0
    for (const s of this.all()) {
      if (s.layer === 'ai') ai++
      else user++
    }
    return { user, ai }
  }
}

/** Bounding box of all ink in normalized page coords, or null when empty. */
function inkBounds(strokes: Stroke[]): [number, number, number, number] | null {
  let x0 = 1
  let y0 = 1
  let x1 = 0
  let y1 = 0
  let any = false
  for (const s of strokes) {
    if (s.tool && ERASER_TOOLS.has(s.tool)) continue
    for (const p of s.pts) {
      any = true
      if (p[0] < x0) x0 = p[0]
      if (p[1] < y0) y0 = p[1]
      if (p[0] > x1) x1 = p[0]
      if (p[1] > y1) y1 = p[1]
    }
  }
  return any ? [x0, y0, x1, y1] : null
}

/** The follow window in page coords [x0, y0, x1, y1], or null when there is no pen yet. */
function followWindow(o: RasterOptions, store: StrokeStore): [number, number, number, number] | null {
  const last = o.center ?? store.lastPoint
  if (!last) return null
  const winW = o.window
  const winH = (o.window * o.height * o.pageAspect) / o.width // normalized page height; keeps shapes true
  const pad = 0.02 // wide lines reach slightly past their points
  return [last[0] - winW / 2 - pad, last[1] - winH / 2 - pad, last[0] + winW / 2 + pad, last[1] + winH / 2 + pad]
}

/** Map normalized page coords into pixel coords for the chosen view. */
function makeMapper(o: RasterOptions, store: StrokeStore) {
  const last = o.center ?? store.lastPoint
  if (o.mode === 'follow' && last) {
    const winW = o.window
    const winH = (o.window * o.height * o.pageAspect) / o.width // normalized page height; keeps shapes true
    const x0 = last[0] - winW / 2
    const y0 = last[1] - winH / 2
    return (x: number, y: number): [number, number] => [((x - x0) / winW) * o.width, ((y - y0) / winH) * o.height]
  }
  // full: fit the ink's bounding box (whole page when empty) into the container,
  // preserving the page's physical aspect so shapes are not stretched.
  const b = inkBounds(store.all()) ?? [0, 0, 1, 1]
  const margin = 0.03
  const bx0 = Math.max(0, b[0] - margin)
  const by0 = Math.max(0, b[1] - margin)
  const bw = Math.max(0.02, Math.min(1, b[2] + margin) - bx0)
  const bh = Math.max(0.02, Math.min(1, b[3] + margin) - by0)
  // physical size of the box: page width units are pageAspect × page height units
  const physW = bw * o.pageAspect
  const physH = bh
  const z = Math.max(1, o.fitZoom ?? 1)
  const scale = Math.min(o.width / physW, o.height / physH) * z
  const dw = physW * scale
  const dh = physH * scale
  let ox = (o.width - dw) / 2
  let oy = (o.height - dh) / 2
  if (z > 1) {
    // bring the pen (or `center`) to the middle, without showing past the inked area's edges
    const f = last ?? [bx0 + bw / 2, by0 + bh / 2]
    const fx = ((f[0] - bx0) / bw) * dw
    const fy = ((f[1] - by0) / bh) * dh
    ox = dw > o.width ? Math.min(0, Math.max(o.width - dw, o.width / 2 - fx)) : ox
    oy = dh > o.height ? Math.min(0, Math.max(o.height - dh, o.height / 2 - fy)) : oy
  }
  return (x: number, y: number): [number, number] => [ox + ((x - bx0) / bw) * dw, oy + ((y - by0) / bh) * dh]
}

/**
 * Draw the store into a 2D context. Brightness encodes layer: on the monochrome
 * HUD there is no color, so the emphasised layer is drawn brighter.
 */
export function rasterize(ctx: CanvasRenderingContext2D, store: StrokeStore, o: RasterOptions) {
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, o.width, o.height)
  const map = makeMapper(o, store)
  const follow = o.mode === 'follow'
  const win = follow ? followWindow(o, store) : null
  for (const s of store.all()) {
    if (s.pts.length < 2) continue
    if (s.layer === 'ai' && o.showAi === false) continue
    if (win && (s.box[2] < win[0] || s.box[0] > win[2] || s.box[3] < win[1] || s.box[1] > win[3])) continue
    // the saved page's eraser strokes leave no ink: their effect is already in the page
    if (s.fromPage && s.tool && ERASER_TOOLS.has(s.tool)) continue
    // Emphasis must survive a 1-bit render (the simulator thresholds grey to
    // full green), so the de-emphasised layer is dashed as well as dimmer.
    // Highlighter and shader washes are faint and dashed: the HUD has no translucency, and a
    // solid band would hide the writing under it.
    const wash = s.tool !== undefined && WASH_TOOLS.has(s.tool)
    const emphasised = (o.highlight === 'all' || o.highlight === s.layer) && !wash
    const lum = emphasised ? 255 : 110
    ctx.strokeStyle = `rgb(${lum},${lum},${lum})`
    // on the one-colour lens other participants' ink is dashed, so it reads as not yours
    ctx.setLineDash(wash ? [1, 4] : !emphasised ? [2, 3] : s.layer === 'peer' ? [4, 2] : [])
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    if (s.brush === 'eraser' && s.layer === 'user') {
      ctx.strokeStyle = '#000'
    }
    // Canvas applies one lineWidth per path, so pressure needs a path per run of points with
    // the same (quantized) width. The floor keeps thin lines solid after binarization.
    const widthOf = (p: number) => {
      const w = follow ? 1 + 2.5 * p : 1.3 + 1.2 * p
      return Math.round((s.brush === 'eraser' ? w * 6 : w) * 2) / 2
    }
    let [px, py] = map(s.pts[0][0], s.pts[0][1])
    let width = widthOf(s.pts[0][2])
    ctx.lineWidth = width
    ctx.beginPath()
    ctx.moveTo(px, py)
    for (let i = 1; i < s.pts.length; i++) {
      const p = s.pts[i]
      const [qx, qy] = map(p[0], p[1])
      const w = widthOf(p[2])
      if (w !== width) {
        ctx.stroke()
        width = w
        ctx.lineWidth = w
        ctx.beginPath()
        ctx.moveTo(px, py)
      }
      ctx.lineTo(qx, qy)
      px = qx
      py = qy
    }
    ctx.stroke()
  }
  ctx.setLineDash([])
  if (o.marker) {
    const [ax, ay] = map(o.marker[0], o.marker[1])
    const [bx, by] = map(o.marker[2], o.marker[3])
    ctx.strokeStyle = 'rgb(200,200,200)'
    ctx.lineWidth = 1
    ctx.strokeRect(Math.round(ax) + 0.5, Math.round(ay) + 0.5, Math.round(bx - ax), Math.round(by - ay))
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

/**
 * RGBA canvas pixels → one byte per pixel (Gray8, 0..255).
 *
 * `threshold` > 0 binarizes: anything at or above it becomes 255, the rest 0.
 * Antialiased edges produce dozens of grey levels that the host's LZ4 cannot
 * compress; a binary frame of mostly-black runs is several times smaller on
 * the BLE link, which is the bottleneck on real glasses.
 */
export function toGray8(ctx: CanvasRenderingContext2D, width: number, height: number, threshold = 0): Uint8Array {
  const img = ctx.getImageData(0, 0, width, height).data
  const out = new Uint8Array(width * height)
  for (let i = 0, j = 0; i < img.length; i += 4, j++) {
    const v = (img[i] + img[i + 1] + img[i + 2]) / 3
    out[j] = threshold > 0 ? (v >= threshold ? 255 : 0) : v
  }
  return out
}

/**
 * Bytes → base64. The SDK accepts a base64 string for imageData and passes it
 * through, whereas a Uint8Array is expanded to a JSON number[] ("255,0,0,…")
 * on its way across the WebView bridge, several times larger and slower to
 * parse on the Flutter side.
 */
export function toBase64(bytes: Uint8Array): string {
  let s = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)))
  }
  return btoa(s)
}

/**
 * Canvas → base64 PNG (no data-URL prefix). This is the documented encoded-image
 * path for updateImageRawData: the host decodes the PNG and converts it to
 * Gray4 itself. A binarized, mostly-black ink frame is a few hundred bytes of
 * PNG, so the JSON crossing the WebView bridge is tiny compared with a
 * number[] of every pixel.
 */
export function toPngBase64(canvas: HTMLCanvasElement): string {
  return canvas.toDataURL('image/png').replace(/^data:image\/png;base64,/, '')
}

/**
 * Canvas → PNG bytes. The phone host (Even app 2.2.x, 2026-09-27) answers
 * sendFailed for any string imageData, base64 raw or base64 PNG alike, but
 * accepts a byte array, which the SDK marshals as number[]. PNG bytes keep
 * that array a few hundred entries long instead of one per pixel.
 */
export function toPngBytes(canvas: HTMLCanvasElement): Uint8Array {
  const b64 = toPngBase64(canvas)
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** Gray8 → packed Gray4 (two pixels per byte, high nibble first), half the bytes. */
export function packGray4(gray8: Uint8Array): Uint8Array {
  const out = new Uint8Array(Math.ceil(gray8.length / 2))
  for (let i = 0; i < gray8.length; i += 2) {
    const a = gray8[i] >> 4
    const b = i + 1 < gray8.length ? gray8[i + 1] >> 4 : 0
    out[i >> 1] = (a << 4) | b
  }
  return out
}

// ── 1-bit PNG ────────────────────────────────────────────────────────────────
// The phone path costs ~70 ms + ~120 ms/KB per image update (ADR 006), so bytes matter. The
// browser's PNG encoder writes 8-bit RGBA with default compression; ink frames are black/white,
// so a 1-bit grayscale PNG at max deflate is several times smaller. The host decodes PNG and
// converts to Gray4 itself (fmt=png1 to opt in until it is verified on every host version).
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(bytes: Uint8Array, start: number, end: number): number {
  let c = 0xffffffff
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length)
  const v = new DataView(out.buffer)
  v.setUint32(0, data.length)
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i)
  out.set(data, 8)
  v.setUint32(8 + data.length, crc32(out, 4, 8 + data.length))
  return out
}

/** Canvas → 1-bit grayscale PNG bytes (white where the pixel is at or above `threshold`). */
export function toPng1Bytes(ctx: CanvasRenderingContext2D, width: number, height: number, threshold = 96): Uint8Array {
  const img = ctx.getImageData(0, 0, width, height).data
  const stride = Math.ceil(width / 8)
  const raw = new Uint8Array((stride + 1) * height) // each row: filter byte 0, then packed bits
  for (let y = 0; y < height; y++) {
    const row = y * (stride + 1) + 1
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      if ((img[i] + img[i + 1] + img[i + 2]) / 3 >= threshold) raw[row + (x >> 3)] |= 0x80 >> (x & 7)
    }
  }
  const ihdr = new Uint8Array(13)
  const v = new DataView(ihdr.buffer)
  v.setUint32(0, width)
  v.setUint32(4, height)
  ihdr[8] = 1 // bit depth
  ihdr[9] = 0 // grayscale
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlibSync(raw, { level: 9 })),
    chunk('IEND', new Uint8Array(0)),
  ]
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

/**
 * Loupe camera: frames the pen for a view that refreshes only a few times a second.
 *
 * It frames writing the way a reader follows it:
 * - Steady: the frame holds still while the pen moves inside a generous middle region.
 * - Writing direction: the frame leads along the *trend* of motion (smoothed over ~1 s), not the
 *   instantaneous direction, which flips inside every letter. With no clear trend it assumes
 *   left-to-right writing. When it re-frames, the pen lands near the trailing edge so most of
 *   the window is room ahead.
 * - Lines: a return to the left on a lower line (a new line of writing) re-frames at the start
 *   of that line instead of panning back across.
 * - Speed zoom: fast strokes widen the window; slow, careful writing returns to the base zoom.
 * - Context zoom: given the recent writing near the pen (the word or phrase being formed), the
 *   window widens just enough to keep it in view, up to 2.5× the base; with no nearby recent ink
 *   it returns to the base zoom for detail. The wider of speed and context wins.
 */
export class LoupeCamera {
  private cx = 0.5
  private cy = 0.5
  private win = 0
  private speed = 0 // page widths per second, smoothed
  private vx = 0 // trend velocity (page widths per second, ~1 s smoothing)
  private vy = 0
  private last: [number, number] | null = null
  private lastT = 0

  constructor(
    private aspect: number, // loupe height / width in pixels
    private pageAspect: number, // page width / height (Paper Pro 1620/2160)
  ) {}

  /** The window in page coords [x0, y0, x1, y1] for the last update (for a minimap marker). */
  rect(): [number, number, number, number] {
    const w = this.win
    const h = w * this.aspect * this.pageAspect // normalized page height of the window
    return [this.cx - w / 2, this.cy - h / 2, this.cx + w / 2, this.cy + h / 2]
  }

  /** Advance the camera to the pen; returns the window centre and width to render with. */
  update(
    pen: [number, number] | null,
    baseWin: number,
    now: number,
    context: [number, number, number, number] | null = null, // recent nearby ink, normalized
  ): { center: [number, number]; window: number } {
    if (!this.win) this.win = baseWin
    if (!pen) return { center: [this.cx, this.cy], window: this.win }
    if (!this.last) {
      this.last = pen
      this.lastT = now
      this.place(pen, 1)
      return { center: [this.cx, this.cy], window: this.win }
    }
    const dt = Math.max(0.016, (now - this.lastT) / 1000)
    const dx = pen[0] - this.last[0]
    const dy = (pen[1] - this.last[1]) / this.pageAspect // in page-width units
    const jump = Math.hypot(dx, dy) > this.win * 0.6 // pen lifted and set down elsewhere
    if (!jump) {
      const k = Math.min(1, dt / 1.0) // ~1 s trend
      this.vx += (dx / dt - this.vx) * k
      this.vy += (dy / dt - this.vy) * k
      this.speed = 0.75 * this.speed + 0.25 * (Math.hypot(dx, dy) / dt)
    }
    this.last = pen
    this.lastT = now

    let target = baseWin * Math.min(2.2, 1 + this.speed / 0.6)
    if (context) {
      // widen to hold the recent writing with a margin: by its width, and by its height through
      // the window's proportions (height = width × aspect × pageAspect in page coords)
      const needW = (context[2] - context[0]) * 1.3
      const needH = (context[3] - context[1]) * 1.3 / (this.aspect * this.pageAspect)
      target = Math.max(target, Math.min(baseWin * 2.5, Math.max(needW, needH)))
    }
    this.win += (target - this.win) * 0.35
    const winH = this.win * this.aspect * this.pageAspect // normalized page height
    const relX = (pen[0] - this.cx) / this.win // -0.5 .. 0.5 inside the frame
    const relY = (pen[1] - this.cy) / winH

    const newLine = dy > (winH / this.pageAspect) * 0.25 && dx < -this.win * 0.25 // dy is in page-width units
    if (jump || newLine || Math.abs(relX) > 0.5 || Math.abs(relY) > 0.5) {
      // outside the frame, a new line, or a stroke elsewhere: frame it fresh
      this.place(pen, 1)
    } else {
      // steady while inside [15%, 85%] horizontally and the middle 60% vertically
      const dir = this.direction()
      if (relX * dir > 0.35) this.place(pen, dir) // reached the leading edge: move ahead
      else if (relX * dir < -0.35) this.place(pen, -dir) // went back past the trailing edge
      if (Math.abs(relY) > 0.3) this.cy = pen[1] // vertical: re-centre on the line
    }
    return { center: [this.cx, this.cy], window: this.win }
  }

  /** +1 writing right, -1 writing left (only when the trend clearly says so). */
  private direction(): number {
    return this.vx < -0.05 ? -1 : 1
  }

  /** Put the pen 30% in from the trailing edge, so 70% of the window is room ahead. */
  private place(pen: [number, number], dir: number) {
    this.cx = pen[0] + dir * this.win * 0.2
    this.cy = pen[1]
  }
}
