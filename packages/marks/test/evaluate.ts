/**
 * The recogniser's evaluation on synthetic ink: precision, recall and false accepts on handwriting.
 *
 * For each persona of packages/hand (a "user"):
 *
 * 1. Five lines of handwriting go on a page (context, and the inline negatives).
 * 2. The user teaches each glyph of test/glyphs.ts with k ∈ {1, 3, 5} examples, drawn beside the
 *    end of a line, as a margin mark would be.
 * 3. **Positives**: {@link POSITIVES} fresh instances of each glyph (new seeds, so new variation and
 *    new tremor), each beside the end of a line.
 * 4. **Negatives, inline**: every word of the five lines, read as its own gesture with the rest of
 *    its line as context. This is what most of a page is.
 * 5. **Negatives, beside**: short words, single letters and digits (`WORDS`) written on their own
 *    beside a line's end, exactly where a mark would go. The context gate cannot help here; only
 *    shape, path and size can.
 * 6. **Negatives, held out** (`HELD_OUT`): more words, written 1.3× larger, added after the
 *    constants were set. They did not change the constants; they showed that cursive pairs
 *    ("on", "as", "ex") come close to a lemniscate mark in both representations, which is why
 *    marks learn negatives from rejections (recognizer.ts step 6).
 * 7. **After feedback**: every held-out false accept is rejected once (its ink becomes a negative of
 *    the mark it hit, as the registry does), then the held-out words are written again with new
 *    seeds, and the positives are read again (to show recall does not pay for it).
 *
 * A positive read as its own glyph is a true positive; read as another glyph, a false positive
 * (and a miss); `none` or `ambiguous`, a miss. Any match on a negative is a false accept.
 * Precision = TP / (TP + FP over positives and the inline and beside negatives); recall =
 * TP / positives.
 *
 * Synthetic hands are a proxy. They vary a glyph the way the fixture's variation model says and
 * write letters from Hershey's single-line fonts. Real Paper Pro ink will differ; tuning on it is
 * pending (ADR 013).
 */

import { bounds, type Pt } from 'delegate'
import type { Persona } from 'hand'
import { contextOf, type InkBox } from '../src/context'
import { compile, recognize, type Example, type Model } from '../src/recognizer'
import { GLYPHS, HELD_OUT, LINES, PERSONAS, WORDS, instance, writing, type TestStroke } from './glyphs'

export const POSITIVES = 8
export const KS = [1, 3, 5] as const

interface Sample {
  strokes: Pt[][]
  boxes: InkBox[]
  glyph?: string
  label?: string
}

export interface Result {
  k: number
  tp: number
  fp: number
  fn: number
  ambiguous: number
  positives: number
  negInline: number
  faInline: number
  negBeside: number
  faBeside: number
  negHeld: number
  faHeld: number
  /** after one rejection of each held-out false accept (k = 3 only) */
  after?: { faHeld: number; negHeld: number; recall: number }
  confusions: Record<string, number>
  perPersona: Record<string, { tp: number; n: number; fa: number; neg: number }>
  precision: number
  /** precision counting the held-out false accepts too */
  precisionHeld: number
  recall: number
}

const boxesOf = (ss: TestStroke[]): InkBox[] => ss.map((s) => ({ id: s.id, box: bounds(s.pts) }))

function page(p: Persona) {
  const lines = LINES.map((t, i) => writing(t, p, 300 + i, [22, 40 + i * 16], 0, 0.9))
  const ends = lines.map((l) => bounds(l.flatMap((s) => s.pts)))
  return { lines, ends, ink: boxesOf(lines.flat()) }
}

/** Beside a line's end: a gap of 6–10 mm, the glyph's top a little above the line's. */
const beside = (end: { x1: number; y0: number }, j: number): Pt => [end.x1 + 6 + (j % 5), end.y0 - 1]

export function evaluate(personas: Persona[] = PERSONAS, positives = POSITIVES): Result[] {
  const names = Object.keys(GLYPHS)
  const data = personas.map((p) => {
    const pg = page(p)
    const teach: Record<string, Sample[]> = {}
    for (const g of names) teach[g] = [0, 1, 2, 3, 4].map((j) => {
      const s = instance(GLYPHS[g], p, 1000 + j * 31 + names.indexOf(g), beside(pg.ends[j], j))
      return { strokes: s.map((x) => x.pts), boxes: pg.ink, glyph: g }
    })
    const pos: Sample[] = []
    for (const g of names) for (let t = 0; t < positives; t++) {
      const s = instance(GLYPHS[g], p, 2000 + t * 13 + names.indexOf(g) * 101, beside(pg.ends[t % 5], t + 2))
      pos.push({ strokes: s.map((x) => x.pts), boxes: pg.ink, glyph: g })
    }
    const inline: Sample[] = []
    for (const line of pg.lines) {
      for (const w of [...new Set(line.map((s) => s.word))]) {
        const own = line.filter((s) => s.word === w)
        const ids = new Set(own.map((s) => s.id))
        inline.push({ strokes: own.map((s) => s.pts), boxes: pg.ink.filter((b) => !ids.has(b.id)) })
      }
    }
    const word = (w: string, j: number, seed: number, scale: number): Sample => {
      const end = pg.ends[j % 5]
      return { strokes: writing(w, p, seed, [end.x1 + 7, end.y1 - 1.5], 0, scale).map((x) => x.pts), boxes: pg.ink, label: w }
    }
    const besideNeg = WORDS.map((w, j) => word(w, j, 500 + j, 1))
    const held = HELD_OUT.map((w, j) => word(w, j, 900 + j, 1.3))
    const heldAgain = HELD_OUT.map((w, j) => word(w, j, 1900 + j, 1.3))
    return { p, teach, pos, inline, besideNeg, held, heldAgain }
  })

  return KS.map((k) => {
    const r: Result = { k, tp: 0, fp: 0, fn: 0, ambiguous: 0, positives: 0, negInline: 0, faInline: 0, negBeside: 0, faBeside: 0, negHeld: 0, faHeld: 0, confusions: {}, perPersona: {}, precision: 0, precisionHeld: 0, recall: 0 }
    let after = k === 3 ? { faHeld: 0, negHeld: 0, recall: 0 } : undefined
    let afterTp = 0
    for (const d of data) {
      const examples = (g: string): Example[] => d.teach[g].slice(0, k).map((s) => ({ strokes: s.strokes, relation: contextOf(bounds(s.strokes.flat()), s.boxes).relation }))
      const negatives: Record<string, Example[]> = Object.fromEntries(names.map((g) => [g, []]))
      const build = (): Model[] => names.map((g) => compile({ id: g, examples: examples(g), negatives: negatives[g] }))
      let models = build()
      const pp = (r.perPersona[d.p.id] = { tp: 0, n: 0, fa: 0, neg: 0 })
      const read = (s: Sample) => recognize(s.strokes, models, contextOf(bounds(s.strokes.flat()), s.boxes))
      for (const s of d.pos) {
        const x = read(s)
        r.positives++; pp.n++
        if (x.kind === 'match' && x.mark === s.glyph) { r.tp++; pp.tp++ }
        else {
          r.fn++
          if (x.kind === 'match') { r.fp++; r.confusions[`${s.glyph}→${x.mark}`] = (r.confusions[`${s.glyph}→${x.mark}`] ?? 0) + 1 }
          if (x.kind === 'ambiguous') r.ambiguous++
        }
      }
      for (const s of d.inline) { r.negInline++; pp.neg++; if (read(s).kind === 'match') { r.faInline++; r.fp++; pp.fa++ } }
      for (const s of d.besideNeg) {
        r.negBeside++; pp.neg++
        const x = read(s)
        if (x.kind === 'match') { r.faBeside++; r.fp++; pp.fa++; r.confusions[`"${s.label}"→${x.mark}`] = (r.confusions[`"${s.label}"→${x.mark}`] ?? 0) + 1 }
      }
      for (const s of d.held) {
        r.negHeld++
        const x = read(s)
        if (x.kind === 'match') {
          r.faHeld++
          r.confusions[`held "${s.label}"→${x.mark}`] = (r.confusions[`held "${s.label}"→${x.mark}`] ?? 0) + 1
          negatives[x.mark].push({ strokes: s.strokes }) // the user rejects it once
        }
      }
      if (after) {
        models = build()
        for (const s of d.heldAgain) { after.negHeld++; if (read(s).kind === 'match') after.faHeld++ }
        for (const s of d.pos) { const x = read(s); if (x.kind === 'match' && x.mark === s.glyph) afterTp++ }
      }
    }
    r.precision = r.tp / Math.max(1, r.tp + r.fp)
    r.precisionHeld = r.tp / Math.max(1, r.tp + r.fp + r.faHeld)
    r.recall = r.tp / Math.max(1, r.positives)
    if (after) after = { ...after, recall: afterTp / Math.max(1, r.positives) }
    r.after = after
    return r
  })
}

/** The results as markdown tables (the eval script prints them; ADR 013 quotes them). */
export function table(rs: Result[]): string {
  const pct = (x: number) => `${(100 * x).toFixed(1)}%`
  const frac = (a: number, b: number) => `${a}/${b} (${pct(a / Math.max(1, b))})`
  const rows = rs.map((r) => `| ${r.k} | ${pct(r.precision)} (${pct(r.precisionHeld)}) | ${pct(r.recall)} | ${r.ambiguous} | ${frac(r.faInline, r.negInline)} | ${frac(r.faBeside, r.negBeside)} | ${frac(r.faHeld, r.negHeld)} |`)
  const out = ['| examples | precision (with held-out) | recall | ambiguous | false accepts: words in a line | words beside a line | held-out words, 1.3× |', '| --- | --- | --- | --- | --- | --- | --- |', ...rows]
  const a = rs.find((r) => r.after)?.after
  if (a) out.push('', `After rejecting each held-out false accept once (3 examples): held-out words written again ${frac(a.faHeld, a.negHeld)} false accepts; recall ${pct(a.recall)}.`)
  return out.join('\n')
}
