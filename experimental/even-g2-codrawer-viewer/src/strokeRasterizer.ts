import type { Stroke } from "./strokeTypes";
import sharp from "sharp";

/**
 * Options controlling how the rasteriser projects strokes onto a
 * pixel canvas.
 */
export interface RasteriseOptions {
  /**
   * Output width in pixels.  Even G2 image containers are limited to
   * widths between 20 and 200 pixels, so typical values will be
   * 200 or less.
   */
  width: number;

  /**
   * Output height in pixels.  Even G2 image containers are limited
   * to heights between 20 and 100 pixels.
   */
  height: number;

  /**
   * Optionally crop the view to a normalised bounding box.  The
   * values should lie in `[0, 1]`.  If omitted the entire
   * codrawer page is rendered.
   */
  crop?: {
    x0: number;
    y0: number;
    x1: number;
    y1: number;
  };

  /**
   * Which layer to highlight.  When set to "user" user strokes are
   * drawn at full brightness while AI strokes are dimmed; when set
   * to "ai" the inverse occurs.  When set to "all" (the default)
   * both layers are drawn with balanced intensities.
   */
  highlightLayer?: "user" | "ai" | "all";
}

/**
 * Rasterise an array of strokes into a PNG buffer.  This helper uses
 * the skia-canvas library to draw green ink on a dark background
 * without introducing any dependencies on browser APIs.  The caller
 * chooses the resolution and crop window.
 */
export async function rasteriseStrokes(
  strokes: Stroke[],
  opts: RasteriseOptions
): Promise<Buffer> {
  const width = opts.width;
  const height = opts.height;
  const crop = opts.crop ?? { x0: 0, y0: 0, x1: 1, y1: 1 };
  // Sanity clamp crop bounds
  const x0 = Math.max(0, Math.min(1, crop.x0));
  const y0 = Math.max(0, Math.min(1, crop.y0));
  const x1 = Math.max(0, Math.min(1, crop.x1));
  const y1 = Math.max(0, Math.min(1, crop.y1));
  const dx = x1 - x0 || 1;
  const dy = y1 - y0 || 1;

  const channels = 4; // RGBA
  const background = [0, 32, 0, 255];
  const pixelData = new Uint8Array(width * height * channels);
  for (let i = 0; i < width * height; i++) {
    const o = i * channels;
    pixelData[o] = background[0];
    pixelData[o + 1] = background[1];
    pixelData[o + 2] = background[2];
    pixelData[o + 3] = background[3];
  }

  // Determine alpha values based on highlight layer.  These values
  // control the brightness of user and AI strokes.  Highlighted
  // layer receives alpha 0.9 and the other layer receives 0.3.
  const highlight = opts.highlightLayer ?? "all";
  let alphaUser = 0.9;
  let alphaAI = 0.3;
  if (highlight === "ai") {
    alphaUser = 0.2;
    alphaAI = 0.9;
  } else if (highlight === "user") {
    alphaUser = 0.9;
    alphaAI = 0.2;
  } else if (highlight === "all") {
    alphaUser = 0.8;
    alphaAI = 0.5;
  }

  const drawCircle = (cx: number, cy: number, radius: number, alpha: number) => {
    const minX = Math.max(0, Math.floor(cx - radius));
    const maxX = Math.min(width - 1, Math.ceil(cx + radius));
    const minY = Math.max(0, Math.floor(cy - radius));
    const maxY = Math.min(height - 1, Math.ceil(cy + radius));

    for (let y = minY; y <= maxY; y++) {
      const dyLocal = y - cy;
      for (let x = minX; x <= maxX; x++) {
        const dxLocal = x - cx;
        if (dxLocal * dxLocal + dyLocal * dyLocal > radius * radius) {
          continue;
        }
        const idx = (y * width + x) * channels;
        // Blend green ink onto the dark background.
        const incomingA = alpha;
        const invA = 1 - incomingA;
        pixelData[idx] = Math.min(255, Math.round(pixelData[idx] * invA + 0 * incomingA));
        pixelData[idx + 1] = Math.min(255, Math.round(pixelData[idx + 1] * invA + 255 * incomingA));
        pixelData[idx + 2] = Math.min(255, Math.round(pixelData[idx + 2] * invA + 0 * incomingA));
        pixelData[idx + 3] = 255;
      }
    }
  };

  const drawLine = (
    x0p: number,
    y0p: number,
    x1p: number,
    y1p: number,
    lineWidth: number,
    alpha: number
  ) => {
    const steps = Math.max(1, Math.ceil(Math.hypot(x1p - x0p, y1p - y0p)));
    const radius = Math.max(0.5, lineWidth / 2);
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const x = x0p + (x1p - x0p) * t;
      const y = y0p + (y1p - y0p) * t;
      drawCircle(x, y, radius, alpha);
    }
  };

  for (const stroke of strokes) {
    if (stroke.points.length === 0) continue;
    const isAI = stroke.layer === "ai";
    const alpha = isAI ? alphaAI : alphaUser;
    for (let i = 1; i < stroke.points.length; i++) {
      const [nx0, ny0, p0] = stroke.points[i - 1];
      const [nx1, ny1, p1] = stroke.points[i];
      if (nx0 < x0 || nx0 > x1 || ny0 < y0 || ny0 > y1) continue;
      if (nx1 < x0 || nx1 > x1 || ny1 < y0 || ny1 > y1) continue;
      const xA = ((nx0 - x0) / dx) * width;
      const yA = ((ny0 - y0) / dy) * height;
      const xB = ((nx1 - x0) / dx) * width;
      const yB = ((ny1 - y0) / dy) * height;
      const lineWidth = Math.max(1, (1 + ((p0 + p1) / 2 || 0.5) * 2));
      drawLine(xA, yA, xB, yB, lineWidth, alpha);
    }
  }

  const buffer: Buffer = await sharp(
    Buffer.from(pixelData),
    { raw: { width, height, channels } }
  ).png().toBuffer();
  return buffer;
}
