/**
 * Glyph skeletons: the centre lines a hand follows when it writes a character.
 *
 * The simulator does not draw letters; it plans movements along their skeletons and lets the
 * motor and arm models decide where the ink actually lands. Skeletons come from A. V. Hershey's
 * single-line fonts (1967, public domain), extracted at build time by
 * `scripts/gen_glyphs.py` into `glyphs.json` (faces `futural`, `scripts`, `rowmans`, and
 * `greek` re-keyed to Unicode). A few marks the faces lack, mostly mathematical, are drawn
 * here by hand in the same units.
 *
 * Units are Hershey's: x from the glyph's left edge, y down, baseline at 0, capitals reaching
 * y = -21 (`UNITS_PER_CAP`). Lowercase x-height is 14 in `futural` and 9 in `scripts`. A glyph is
 * its advance width and its strokes, each a polyline in Hershey's drawing order, which is the
 * order a hand would mostly use.
 */

import data from './glyphs.json'

/** A point in glyph units (x right, y down, baseline 0). */
export type GPt = [number, number]

/** A character's skeleton. */
export interface Glyph {
  /** horizontal advance to the next character, glyph units */
  advance: number
  /** pen-down polylines in drawing order */
  strokes: GPt[][]
}

/** Faces with Latin letters. `greek` and the extras fill in symbols whatever the face. */
export type Face = 'futural' | 'scripts' | 'rowmans'

/** Hershey units per cap height (all faces). */
export const UNITS_PER_CAP = 21

type RawGlyph = [number, number[][]]
const faces = (data as unknown as { faces: Record<string, Record<string, RawGlyph>> }).faces

function unpack([advance, strokes]: RawGlyph): Glyph {
  return {
    advance,
    strokes: strokes.map((flat) => {
      const pts: GPt[] = []
      for (let i = 0; i + 1 < flat.length; i += 2) pts.push([flat[i], flat[i + 1]])
      return pts
    }),
  }
}

/** An arc of an ellipse centred (cx, cy), radii (rx, ry), from a0 to a1 degrees, `n` segments. */
function arc(cx: number, cy: number, rx: number, ry: number, a0: number, a1: number, n = 16): GPt[] {
  const out: GPt[] = []
  for (let i = 0; i <= n; i++) {
    const a = ((a0 + ((a1 - a0) * i) / n) * Math.PI) / 180
    out.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)])
  }
  return out
}

/**
 * Hand-drawn marks in glyph units, for what the Hershey faces lack. Superscript digits are the
 * face's own digits, scaled and raised, so they are built in {@link glyph}.
 */
const EXTRAS: Record<string, Glyph> = {
  '×': { advance: 18, strokes: [[[4, -13], [14, -3]], [[14, -13], [4, -3]]] },
  '÷': { advance: 20, strokes: [[[3, -8], [17, -8]], [[10, -13], [10.6, -12.6]], [[10, -3], [10.6, -2.6]]] },
  '−': { advance: 20, strokes: [[[3, -8], [17, -8]]] },
  '±': { advance: 20, strokes: [[[10, -16], [10, -6]], [[4, -11], [16, -11]], [[4, -2], [16, -2]]] },
  '→': { advance: 24, strokes: [[[2, -8], [21, -8]], [[15, -13], [21, -8], [15, -3]]] },
  '←': { advance: 24, strokes: [[[22, -8], [3, -8]], [[9, -13], [3, -8], [9, -3]]] },
  '⇒': { advance: 24, strokes: [[[2, -11], [17, -11]], [[2, -5], [17, -5]], [[14, -15], [21, -8], [14, -1]]] },
  '≈': {
    advance: 20,
    strokes: [
      [[3, -9], [6, -11], [10, -9], [14, -7], [17, -9]],
      [[3, -4], [6, -6], [10, -4], [14, -2], [17, -4]],
    ],
  },
  '≠': { advance: 20, strokes: [[[3, -11], [17, -11]], [[3, -5], [17, -5]], [[13, -16], [7, 0]]] },
  '≤': { advance: 20, strokes: [[[16, -16], [4, -10], [16, -4]], [[4, -1], [16, -1]]] },
  '≥': { advance: 20, strokes: [[[4, -16], [16, -10], [4, -4]], [[4, -1], [16, -1]]] },
  '√': { advance: 16, strokes: [[[1, -9], [4, -11], [8, 1], [14, -22], [24, -22]]] },
  '∞': { advance: 24, strokes: [[...arc(7, -8, 5, 4, 0, 360, 14), ...arc(17, -8, 5, 4, 180, -180, 14)]] },
  '∫': { advance: 14, strokes: [[[14, -21], [11, -22], [9, -19], [7, -4], [5, 3], [2, 4], [0, 2]]] },
  '∂': { advance: 16, strokes: [[[4, -18], [7, -21], [11, -20], [13, -14], [12, -5], [8, 0], [4, 0], [2, -3], [3, -7], [7, -9], [12, -8]]] },
  '°': { advance: 8, strokes: [arc(4, -18, 2.6, 2.6, -90, 270, 12)] },
  '·': { advance: 8, strokes: [[[4, -8], [4.5, -7.6]]] },
  '…': { advance: 24, strokes: [[[4, 0], [4.5, 0.4]], [[12, 0], [12.5, 0.4]], [[20, 0], [20.5, 0.4]]] },
  '—': { advance: 26, strokes: [[[2, -8], [24, -8]]] },
  '–': { advance: 18, strokes: [[[2, -8], [16, -8]]] },
  '’': { advance: 8, strokes: [[[5, -21], [5, -18], [3, -15]]] },
  '“': { advance: 14, strokes: [[[5, -15], [4, -18], [5, -21]], [[10, -15], [9, -18], [10, -21]]] },
  '”': { advance: 14, strokes: [[[4, -21], [5, -18], [4, -15]], [[9, -21], [10, -18], [9, -15]]] },
}

const SUPERSCRIPTS: Record<string, string> = { '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4', 'ⁿ': 'n', 'ˣ': 'x' }
const SUBSCRIPTS: Record<string, string> = { '₀': '0', '₁': '1', '₂': '2', '₃': '3', '₄': '4' }

const cache = new Map<string, Glyph | null>()

/**
 * The skeleton of `ch` in `face`: the face's own glyph, else Greek, else the hand-drawn extras,
 * else a superscript or subscript built from the face's digit or letter (0.6 size, raised to
 * the cap line or lowered below the baseline). Null when nothing fits; the layout then leaves a
 * gap the width of an `n`.
 */
export function glyph(face: Face, ch: string): Glyph | null {
  const key = face + '\u0000' + ch
  if (cache.has(key)) return cache.get(key)!
  let g: Glyph | null = null
  const raw = faces[face]?.[ch] ?? faces.greek?.[ch]
  if (raw) g = unpack(raw)
  else if (EXTRAS[ch]) g = EXTRAS[ch]
  else if (SUPERSCRIPTS[ch] || SUBSCRIPTS[ch]) {
    const base = glyph(face, SUPERSCRIPTS[ch] ?? SUBSCRIPTS[ch])
    if (base) {
      const dy = SUPERSCRIPTS[ch] ? -12 : 5
      g = { advance: base.advance * 0.6, strokes: base.strokes.map((s) => s.map(([x, y]) => [x * 0.6, y * 0.6 + dy] as GPt)) }
    }
  }
  cache.set(key, g)
  return g
}

/** Whether a face has its own glyph for `ch` (no fallback). */
export function hasOwnGlyph(face: Face, ch: string): boolean {
  return !!faces[face]?.[ch]
}
