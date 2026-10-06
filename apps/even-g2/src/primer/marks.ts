/**
 * The teacher's marks on the app: the Primer's red-pen markup of a proof, as data (ADR 010; the
 * Primer side is src/codrawer_bridge/primer/markup.py).
 *
 * The marks themselves arrive as ordinary agent ink (`stroke_*` on the `ai` layer, author
 * `primer:teacher`), so the stage draws them like any agent ink, at their own pace. What this
 * module adds is the `markup` block of the `primer` message that announced them: for every mark
 * its kind, the step and finding it is about, the short text on the page, the long explanation
 * and the step's LaTeX, and its stroke ids and bounds. The tablet carries the short version; the
 * phone carries the long one: tapping a mark (on the page or in the panel's list) shows it.
 *
 * Pure (no DOM): tested under tsx (test/primer.test.ts).
 */

/** The author tag the Primer's marks carry (hide or show them as one layer). */
export const TEACHER = 'primer:teacher'

export interface Mark {
  id: string
  /** circle · caret · underline · strike · question · check · comment · arrow · score · summary */
  kind: string
  /** The proof step it concerns (0: the whole proof). */
  step: number
  finding: string | null
  /** What is written on the page (at most ~8 words). */
  short: string
  /** The explanation for the phone. */
  long: string
  latex: string
  /** Normalized page bounds [x0, y0, x1, y1]. */
  bbox: [number, number, number, number] | null
  strokes: string[]
}

export interface Markup {
  layer: string
  color: string
  marks: Mark[]
}

type Obj = Record<string, unknown>
const obj = (v: unknown): Obj | null => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : null)
const str = (v: unknown, max = 2000): string => (typeof v === 'string' ? v.slice(0, max) : '')
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])

/** The `markup` block as {@link Markup}; null when absent. */
export function parseMarkup(v: unknown): Markup | null {
  const m = obj(v)
  if (!m) return null
  return {
    layer: str(m.layer, 80),
    color: str(m.color, 20),
    marks: arr(m.marks)
      .map(obj)
      .filter((x): x is Obj => x !== null)
      .map((x, i) => {
        const b = arr(x.bbox)
        return {
          id: str(x.id, 40) || `mk${i + 1}`,
          kind: str(x.kind, 20),
          step: typeof x.step === 'number' ? Math.round(x.step) : 0,
          finding: typeof x.finding === 'string' ? x.finding : null,
          short: str(x.short, 200),
          long: str(x.long),
          latex: str(x.latex),
          bbox: b.length === 4 && b.every((n) => typeof n === 'number' && Number.isFinite(n)) ? (b as [number, number, number, number]) : null,
          strokes: arr(x.strokes).filter((s): s is string => typeof s === 'string'),
        }
      }),
  }
}

/** The marks worth listing (arrows and the "est." label belong to another mark). */
export function listedMarks(m: Markup | null): Mark[] {
  return (m?.marks ?? []).filter((x) => x.kind !== 'arrow' && !(x.kind === 'comment' && x.short === 'est.'))
}

/**
 * The mark under a tap at normalized page point (x, y): the smallest whose bounds, grown by
 * `slop` (page widths), contain it; null when none. Small marks win over big ones (a "?" inside a
 * circle).
 */
export function markAt(m: Markup | null, x: number, y: number, slop = 0.012): Mark | null {
  let best: Mark | null = null
  let area = Infinity
  for (const k of m?.marks ?? []) {
    if (!k.bbox || k.kind === 'arrow') continue
    const [x0, y0, x1, y1] = k.bbox
    if (x >= x0 - slop && x <= x1 + slop && y >= y0 - slop && y <= y1 + slop) {
      const a = (x1 - x0) * (y1 - y0)
      if (a < area) {
        area = a
        best = k
      }
    }
  }
  return best
}

/** What a mark is called in the list: "Step 6 · circle · contradicts what?". */
export function markLabel(k: Mark): string {
  const where = k.step ? `Step ${k.step}` : k.kind === 'score' ? 'Score' : k.kind === 'summary' ? 'Summary' : 'Whole proof'
  const what = k.kind === 'question' ? '?' : k.kind
  return k.short && k.kind !== 'question' ? `${where} · ${what} · ${k.short}` : `${where} · ${what}`
}
