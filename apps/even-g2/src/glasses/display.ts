/**
 * The glasses display as the render loop sees it: two drawing surfaces and two queues.
 *
 * Surfaces. The canvas and the loupe are rasterized (strokes.ts `rasterize`) into two small
 * <canvas> elements at the containers' exact device-pixel sizes. They double as the phone's
 * "Glasses" panel previews (shown at 2×; the toolbar's glasses button opens the panel), so what
 * you see there is exactly what is encoded and sent.
 *
 * Framing. The canvas frames the page by {@link view} (follow-crop or fit). The loupe has its own
 * camera that follows the pen, zooms with speed and widens to hold the word being written
 * (LoupeCamera, strokes.ts; inputs from glasses/loupe.ts); `?loupe_cam=0` replaces it with plain
 * re-centring on the pen.
 *
 * Queues. Image frames go through the {@link scheduler} (latest-wins slots, one send at a time,
 * just-in-time loupe frames); status text goes through the {@link textPusher} (held while ink
 * flows). Both send only once our page is up ({@link glasses}.bridge).
 */
import { ImageRawDataUpdate, ImageRawDataUpdateResult, TextContainerUpgrade } from '@evenrealities/even_hub_sdk'
import { BINARIZE, CANVAS_MIN_MS, ENC, FMT, HAS_LOUPE, IMG_H, IMG_W, INFLIGHT, INITIAL_LOUPE_ZOOM, LOUPE_CAM, LOUPE_H, LOUPE_MIN_MS, LOUPE_W, remember } from '../config'
import { glasses, isWide, store, view } from '../state'
import { LoupeCamera, rasterize, type RasterOptions } from '../strokes'
import { makeEncoder } from './encode'
import { IMG_ID, LOUPE_ID, TEXT_ID, WIDE_TILE_W } from './layout'
import { loupeBaseWindow, writingContext, zoomForBoxWidth } from './loupe'
import { FrameScheduler, type Frame, type Slot } from './scheduler'
import { KeyLatency } from '../keylat'
import { PACING, TextPusher } from './text'

// ── Surfaces ──────────────────────────────────────────────────────────────────────────────────

/** Size a preview canvas to a container (device px), shown at 2× on the phone; hidden at 0. */
function surface(id: string, w: number, h: number): CanvasRenderingContext2D {
  const c = document.getElementById(id) as HTMLCanvasElement
  c.width = Math.max(1, w)
  c.height = Math.max(1, h)
  c.style.width = `${w * 2}px`
  c.style.height = `${h * 2}px`
  c.style.display = w > 0 ? 'block' : 'none'
  return c.getContext('2d', { willReadFrequently: true })!
}

/** The canvas container's surface (twice as wide in the wide fit view; see {@link drawCanvas}). */
export const canvasCtx = surface('preview', IMG_W, IMG_H)

/** Offscreen copies of the wide view's two halves, encoded as the two tiles. */
function tileCtx(): CanvasRenderingContext2D {
  const c = document.createElement('canvas')
  c.width = WIDE_TILE_W
  c.height = IMG_H
  return c.getContext('2d', { willReadFrequently: true })!
}
const leftTile = tileCtx()
const rightTile = tileCtx()

/** Copy half of the wide canvas surface (`half` 0 left, 1 right) into its tile. */
function cutTile(tile: CanvasRenderingContext2D, half: 0 | 1): CanvasRenderingContext2D {
  tile.globalCompositeOperation = 'copy'
  tile.drawImage(canvasCtx.canvas, half * WIDE_TILE_W, 0, WIDE_TILE_W, IMG_H, 0, 0, WIDE_TILE_W, IMG_H)
  return tile
}
/** The loupe container's surface. */
export const loupeCtx = surface('loupe', LOUPE_W, LOUPE_H)

// ── Loupe framing ─────────────────────────────────────────────────────────────────────────────

/** The loupe's camera (aspect: loupe height / width in px). */
export const loupeCam = new LoupeCamera(LOUPE_H / Math.max(1, LOUPE_W), view.pageAspect)

/** Loupe zoom relative to the default (1), remembered across loads. */
let loupeZoom = INITIAL_LOUPE_ZOOM

/** The loupe's base window now (fraction of the page width). */
function loupeBase(): number {
  return loupeBaseWindow(view.window, LOUPE_W, loupeZoom)
}

/** The loupe box on the phone was dragged to `width` (fraction of the page width). */
export function resizeLoupe(width: number) {
  loupeZoom = zoomForBoxWidth(width, loupeBaseWindow(view.window, LOUPE_W, 1))
  remember('loupe_zoom', loupeZoom.toFixed(3))
}

/** The loupe's raster options for a frame drawn now (advances the camera when it is on). */
export function loupeOpts(): RasterOptions {
  const base = loupeBase()
  if (!LOUPE_CAM) return { ...view, width: LOUPE_W, height: LOUPE_H, mode: 'follow', window: base }
  const cam = loupeCam.update(store.lastPoint, base, performance.now(), writingContext(store.all(), store.lastPoint, base, Date.now()))
  return { ...view, width: LOUPE_W, height: LOUPE_H, mode: 'follow', window: cam.window, center: cam.center }
}

/** The loupe's view on the page [x0, y0, x1, y1], when the camera is on and has a pen to follow. */
export function loupeRect(): [number, number, number, number] | null {
  return HAS_LOUPE && LOUPE_CAM && store.lastPoint ? loupeCam.rect() : null
}

// ── Drawing frames ────────────────────────────────────────────────────────────────────────────

const encode = makeEncoder({ fmt: FMT, enc: ENC, binarize: BINARIZE })

/**
 * Re-rasterize the canvas surface. In the full-page view it outlines the loupe's view so you can
 * see where you are zoomed in (in follow view the canvas is zoomed in too, and only a stray edge
 * would show).
 */
export function drawCanvas() {
  if (isWide()) {
    // the whole page across both tiles; no loupe, so no marker
    if (canvasCtx.canvas.width !== 2 * WIDE_TILE_W) surface('preview', 2 * WIDE_TILE_W, IMG_H)
    rasterize(canvasCtx, store, { ...view, width: 2 * WIDE_TILE_W })
    return
  }
  if (canvasCtx.canvas.width !== IMG_W) surface('preview', IMG_W, IMG_H)
  const marked = HAS_LOUPE && LOUPE_CAM && view.mode === 'full'
  const plain = { ...view, fitZoom: 1 } // the ring zooms the fit view only in the wide layout
  rasterize(canvasCtx, store, marked ? { ...plain, marker: loupeCam.rect() } : plain)
}

/** Rasterize the loupe surface now. */
export function drawLoupe() {
  rasterize(loupeCtx, store, loupeOpts())
}

/** The canvas surface, encoded (in the wide fit view, its left tile). */
export function canvasFrame(): Frame {
  return isWide() ? encode(cutTile(leftTile, 0), WIDE_TILE_W, IMG_H) : encode(canvasCtx, IMG_W, IMG_H)
}

/** The wide fit view's right tile, encoded; it goes to the loupe's container (glasses/layout.ts). */
export function rightTileFrame(): Frame {
  return encode(cutTile(rightTile, 1), WIDE_TILE_W, IMG_H)
}

/** A loupe frame drawn and encoded now (the scheduler's just-in-time recipe). */
export function loupeFrame(): Frame {
  drawLoupe()
  return encode(loupeCtx, LOUPE_W, LOUPE_H)
}

// ── Queues to the glasses ─────────────────────────────────────────────────────────────────────

const containerOf: Record<Slot, { id: number; name: string }> = {
  loupe: { id: LOUPE_ID, name: 'loupe' },
  canvas: { id: IMG_ID, name: 'canvas' },
}

/** Image frames to the glasses (see scheduler.ts). Image containers exist in the canvas layout only. */
export const scheduler = new FrameScheduler({
  minMs: { loupe: LOUPE_MIN_MS, canvas: CANVAS_MIN_MS },
  inflight: INFLIGHT,
  label: `fmt=${FMT} inflight=${INFLIGHT}`,
  hasImages: () => glasses.pageMode === 'canvas',
  transmit: async (slot, frame) => {
    const r = await glasses.bridge!.updateImageRawData(
      new ImageRawDataUpdate({ containerID: containerOf[slot].id, containerName: containerOf[slot].name, imageData: frame }),
    )
    if (r !== ImageRawDataUpdateResult.success) console.warn('[codrawer] image update', slot, r)
    return String(r)
  },
})

/** Send `content` to the status text container (no pacing; see textPusher). */
export function sendStatusText(content: string) {
  return glasses.bridge!.textContainerUpgrade(new TextContainerUpgrade({ containerID: TEXT_ID, containerName: 'status', content }))
}

/** Per-key latency on the phone (keylat.ts); dev builds only, where the console reaches the desktop. */
export const keyTrace = import.meta.env.DEV ? new KeyLatency(PACING, (b) => console.log('[keylat] ' + JSON.stringify(b))) : null

/** Status text to the glasses, paced around the ink (see text.ts). */
export const textPusher = new TextPusher(async (content, renderedAt) => {
  const done = keyTrace?.sending(renderedAt)
  try {
    return await sendStatusText(content)
  } finally {
    done?.()
  }
})
