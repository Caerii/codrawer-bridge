/**
 * Frame encoding: a rasterized surface → the bytes an image update carries.
 *
 * The glasses show 4-bit grey, and the phone host converts whatever we send into that. What we
 * choose is only how the frame crosses the WebView bridge, and the facts that decided it are:
 *
 * - The phone host rejects any string `imageData` (base64 raw or PNG) with `sendFailed`; PNG bytes
 *   as a number array work (2026-09-26). `?enc=b64` remains for the simulator and the bench.
 * - Cost per send is ~200 ms whatever the size (ADR 006), so bytes matter less than once thought;
 *   a 1-bit PNG (png1, the default) is still ~4x smaller than the browser's PNG and keeps the big
 *   canvas send short.
 * - Ink is drawn white on black and binarized at 96/255: long runs compress well, and grey
 *   antialiasing would cost bytes for detail the glasses barely show.
 *
 * The encoders themselves (PNG writers, Gray8/Gray4 packing) live in strokes.ts.
 */
import { packGray4, toBase64, toGray8, toPng1Bytes, toPngBase64, toPngBytes } from '../strokes'
import type { Frame } from './scheduler'

export interface EncodeOptions {
  fmt: 'png' | 'png1' | 'gray8' | 'gray4'
  enc: 'b64' | 'array'
  /** Snap to black/white (threshold 96) before encoding. */
  binarize: boolean
}

/** An encoder for one configuration: (surface, width, height in device px) → frame. */
export function makeEncoder(o: EncodeOptions): (c: CanvasRenderingContext2D, w: number, h: number) => Frame {
  return (c, w, h) => {
    if (o.fmt === 'png1') {
      const bytes = toPng1Bytes(c, w, h, 96)
      return o.enc === 'b64' ? toBase64(bytes) : bytes
    }
    if (o.fmt === 'png') {
      if (o.binarize) {
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
      return o.enc === 'b64' ? toPngBase64(c.canvas) : toPngBytes(c.canvas)
    }
    const g8 = toGray8(c, w, h, o.binarize ? 96 : 0)
    const bytes = o.fmt === 'gray4' ? packGray4(g8) : g8
    return o.enc === 'b64' ? toBase64(bytes) : bytes
  }
}
