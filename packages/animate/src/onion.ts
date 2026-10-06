/**
 * Onion skin: which neighbouring frames show behind the one being drawn, and how.
 *
 * The animator draws frame i while seeing faint copies of frames i-1, i-2, … ("before") and
 * i+1, … ("after"). Classic practice, from paper flipbooks to Flipnote, tints them: previous
 * frames red, next frames blue, fading with distance. On the Paper Pro the overlay that shows
 * them is codrawer's own QML item over the page, never ink on the page
 * (docs/investigations/codrawer-animate.md, "Onion skin"), so the ghosts are never saved, synced
 * or undone, and turning them off costs one refresh.
 *
 * Two looks, because the display has two regimes:
 *
 * - `tint`: red before, blue after, opacity falling off with distance. Right for the phone, the
 *   desktop, and the Paper Pro's colour waveform. Colour e-ink is slow to change (the Content
 *   waveform; E Ink quotes 500–1500 ms for Gallery 3 colour), which is acceptable because the
 *   onion skin changes only when the current frame changes, not while drawing.
 * - `mono`: grey ghosts made by **ordered dithering** (a 4×4 Bayer matrix) instead of alpha.
 *   E-ink's fast waveforms are one- or two-level; alpha greys there are dithered by the driver
 *   anew on every refresh and shimmer, while an ordered pattern is fixed to page pixels, so a
 *   ghost looks the same on every frame and never "crawls". Nearer frames get a denser pattern.
 *
 * Pure functions; a renderer asks {@link onionGhosts} what to draw, and {@link ditherKeeps}
 * whether a given device pixel of a ghost is inked.
 */

import type { Anim, AnimStroke } from './model'

export type OnionLook = 'tint' | 'mono'

export interface OnionOptions {
  /** how many earlier frames to show (0–3 is useful) */
  before: number
  /** how many later frames to show */
  after: number
  look: OnionLook
  /** opacity of the nearest ghost, 0..1 */
  opacity?: number
  /** each step further away multiplies opacity by this, 0..1 */
  falloff?: number
  /** in a looping animation, the frame before 0 is the last one (and vice versa) */
  wrap?: boolean
}

/** One ghost to draw behind the current frame. */
export interface Ghost {
  frame: number
  /** -1 for the previous frame, +1 for the next, -2, … */
  offset: number
  /** 0..1; in `mono` the fraction of a ghost stroke's pixels that are inked */
  opacity: number
  /** `#rrggbb` */
  color: string
}

/** Before: red; after: blue (the colours Probe 1 committed, so they exist as Paper Pro ARGB ink). */
export const BEFORE_COLOR = '#d03030'
export const AFTER_COLOR = '#1f6fe0'
export const MONO_COLOR = '#000000'

export const DEFAULTS = { opacity: 0.45, falloff: 0.55 } as const

/**
 * The ghosts for frame `index`, ordered furthest first so nearer ghosts paint over further ones
 * and the current frame (not included) paints over all of them. A neighbour that does not exist
 * (past either end without `wrap`) or that is the current frame itself (a short looping
 * animation) is left out.
 */
export function onionGhosts(anim: Anim, index: number, o: OnionOptions): Ghost[] {
  const n = anim.frames.length
  const base = o.opacity ?? DEFAULTS.opacity
  const falloff = o.falloff ?? DEFAULTS.falloff
  const wrap = o.wrap ?? anim.loop !== 'once'
  const out: Ghost[] = []
  const seen = new Set<number>([index])
  const reach = Math.max(o.before, o.after)
  for (let d = 1; d <= reach; d++) {
    for (const sign of [-1, 1] as const) {
      if ((sign < 0 ? o.before : o.after) < d) continue
      let f = index + sign * d
      if (f < 0 || f >= n) {
        if (!wrap) continue
        f = ((f % n) + n) % n
      }
      if (seen.has(f)) continue
      seen.add(f)
      out.push({
        frame: f,
        offset: sign * d,
        opacity: base * falloff ** (d - 1),
        color: o.look === 'mono' ? MONO_COLOR : sign < 0 ? BEFORE_COLOR : AFTER_COLOR,
      })
    }
  }
  return out.sort((a, b) => Math.abs(b.offset) - Math.abs(a.offset) || a.offset - b.offset)
}

/** The ghosts with their strokes, ready for a renderer. */
export function onionStrokes(anim: Anim, index: number, o: OnionOptions): { ghost: Ghost; strokes: AnimStroke[] }[] {
  return onionGhosts(anim, index, o).map((ghost) => ({ ghost, strokes: anim.frames[ghost.frame].strokes }))
}

// ------------------------------------------------------------------------------------------------
// Ordered dither for e-ink ghosts
// ------------------------------------------------------------------------------------------------

/** The 4×4 Bayer matrix, thresholds 0..15. */
const BAYER4 = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
]

/**
 * Whether device pixel (px, py) of a ghost with `opacity` is inked. Exactly round(opacity × 16)
 * of every 16 pixels in a 4×4 tile are kept, at the same positions on every frame, so a ghost's
 * texture is stable as frames change. Pixel coordinates are device pixels (1620 × 2160 on the
 * Paper Pro), not page units, so the pattern stays one pixel fine under zoom.
 */
export function ditherKeeps(px: number, py: number, opacity: number): boolean {
  const level = Math.round(Math.max(0, Math.min(1, opacity)) * 16)
  return BAYER4[((py % 4) + 4) % 4][((px % 4) + 4) % 4] < level
}
