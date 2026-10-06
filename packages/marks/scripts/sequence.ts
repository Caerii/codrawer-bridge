/**
 * Marks that earn their meaning, as a sequence of frames for docs/media/marks-*.
 *
 * A page of the user's notes (packages/hand's `sketcher`). The user draws a glyph of their own, a
 * small bolt, beside a line. The engine reads it as a candidate; at the next lull the ask appears
 * beside it as a card in the agent's hand (`archivist`): "this mark → ?". The user circles
 * "flashcard"; the built-in grammar reads the circle on the card and the mark is defined. Later,
 * the bolt beside another line fires: a quiet confirmation first, then, once accepted a few times,
 * the action with only an undo.
 *
 * Nothing is mocked: the strokes are simulated pen strokes, the engine (src/engine.ts) reads them,
 * and the captions print what it concluded and sent. The renderer is packages/delegate's.
 *
 *     pnpm --filter marks sequence
 *
 * Output: out/marks-sequence.json (not committed), rendered to docs/media/marks-*.png and a GIF.
 */

import { writeFileSync, mkdirSync } from 'node:fs'
import { simulate, sketcher, archivist, PAPER_PRO_MM, type Persona } from 'hand'
import { bounds, CARD, inflate, layoutCard, place, statusMark, type CardContent, type CardLayout, type Pt, type Rect } from 'delegate'
import { MarkEngine } from '../src/engine'
import { askCard } from '../src/teach'
import { describe } from '../src/actions'
import type { MarkAsk, MarkInvoke } from '../src/protocol'
import { GLYPHS, instance } from '../test/glyphs'

type Ink = { pts: [number, number, number][]; color: string; w: number }
interface Frame { name: string; caption: string; glasses: string; ink: Ink[]; overlay: { pts: Pt[]; dashed: boolean }[] }

const USER = '#1a1a1a', AGENT = '#6a3fb0'
const PAGE = PAPER_PRO_MM as Pt
const T0 = 1_790_000_000_000
const OWNER = 'p_alif'

// --- ink -----------------------------------------------------------------------------------------

let n = 0
interface S { id: string; pts: Pt[]; pressure: number[]; t0: number; t1: number; author: string }
function write(text: string, at: Pt, persona: Persona, scale: number, seed: number, t0: number): S[] {
  return simulate(text, persona, { seed }).strokes.map((s) => ({
    id: `w${++n}`, pts: s.pts.map((p) => [at[0] + p[0] * scale, at[1] + p[1] * scale] as Pt), pressure: s.pts.map((p) => p[2]), t0: t0 + s.down, t1: t0 + s.up, author: OWNER,
  }))
}
const BOLT = GLYPHS.bolt.map((s) => s.map(([x, y]) => [x * 0.75, y * 0.75] as Pt))
function bolt(at: Pt, seed: number, t0: number): S[] {
  return instance(BOLT, sketcher, seed, at, t0, OWNER).map((s) => ({ ...s, pressure: s.pts.map(() => 0.6) }))
}
const inkOf = (ss: S[], color = USER): Ink[] => ss.map((s) => ({ pts: s.pts.map((p, i) => [p[0], p[1], s.pressure[i] ?? 0.6] as [number, number, number]), color, w: 0.4 }))
const lines = (paths: Pt[][], color: string, w = 0.3): Ink[] => paths.map((p) => ({ pts: p.map(([x, y]) => [x, y, 0.6] as [number, number, number]), color, w }))
/** A rectangle as a polyline of ~1 mm segments, so the renderer's dashes go all the way round. */
function box(r: Rect): Pt[] {
  const c: Pt[] = [[r.x0, r.y0], [r.x1, r.y0], [r.x1, r.y1], [r.x0, r.y1], [r.x0, r.y0]]
  const out: Pt[] = []
  for (let i = 1; i < c.length; i++) {
    const k = Math.max(1, Math.round(Math.hypot(c[i][0] - c[i - 1][0], c[i][1] - c[i - 1][1])))
    for (let j = 0; j < k; j++) out.push([c[i - 1][0] + ((c[i][0] - c[i - 1][0]) * j) / k, c[i - 1][1] + ((c[i][1] - c[i - 1][1]) * j) / k])
  }
  return [...out, c[4]]
}

function cardInk(l: CardLayout, c: CardContent): Ink[] {
  return [
    ...lines(l.paths, AGENT),
    ...lines(statusMark(c.status, l.status), AGENT, 0.35),
    ...l.text.flatMap((t, i) => inkOf(write(t.text, t.at, archivist, t.scale, 11 + i, 0), AGENT).map((k) => ({ ...k, w: 0.35 }))),
  ]
}

// --- the engine, reading everything ----------------------------------------------------------------

const sent: Record<string, any>[] = []
const eng = new MarkEngine({ owner: OWNER, send: (m) => sent.push(m as Record<string, any>) })
let now = T0
const feed = (ss: S[]) => { for (const s of ss) eng.stroke(s); now = Math.max(now, ...ss.map((s) => s.t1)) }
const settle = (ms = 1500) => { now += ms; return eng.tick(now) }

const notes = ['Putnam prep, week 3', 'pigeonhole: n+1 objects', 'invariants mod 3', 'AM-GM before Cauchy', 'telescoping sums', 'parity of permutations']
const page: S[] = []
notes.slice(0, 4).forEach((t, i) => { const s = write(t, [14, 34 + i * 14], sketcher, 0.72, 21 + i, now + i * 9000); page.push(...s); feed(s) })
settle(4000)
const lineBox = (i: number) => bounds(page.filter((s) => s.pts[0][1] > 34 + i * 14 - 9 && s.pts[0][1] < 34 + i * 14 + 5).flatMap((s) => s.pts))

const frames: Frame[] = []

// 1. a glyph of the user's own, beside line 2
const l2 = lineBox(1)
now += 20_000
const g1 = bolt([l2.x1 + 6, l2.y0 - 0.5], 3, now)
feed(g1)
const o1 = settle(1200)
frames.push({ name: 'glyph', caption: `A glyph of your own beside a line. The built-in grammar does not claim it, no mark of yours matches it, and it sits beside content: ${o1.map((o) => `${o.kind} (${o.detail})`).join(', ')}.`, glasses: '', ink: [...inkOf(page), ...inkOf(g1)], overlay: [] })

// 2. at the next lull, the ask: once, in the agent's hand, beside the mark
settle(4000)
const ask = sent.find((m) => m.t === 'mark_ask') as unknown as MarkAsk
const content = askCard(ask.items.length)
const size: Pt = [CARD.width, layoutCard(content, [0, 0]).rect.y1]
const g1box = bounds(g1.flatMap((s) => s.pts))
const at = place(size, g1box, page.map((s) => bounds(s.pts)).concat([g1box]), [], PAGE).at
const L = layoutCard(content, at)
eng.showAsk(ask.ask, L)
frames.push({ name: 'ask', caption: `At a lull the agent asks, once: a small card beside the glyph (one batched mark_ask; reason: ${ask.items[0].reason}). Answer with the pen or on the phone.`, glasses: 'new mark beside line 2 -> ?', ink: [...inkOf(page), ...inkOf(g1), ...cardInk(L, content)], overlay: [{ pts: box(inflate(g1box, 1.5)), dashed: true }] })

// 3. the user circles "flashcard": read by the built-in grammar, it defines the mark
const fl = L.choices.find((c) => c.id === 'flashcard')!.label
const loop: Pt[] = []
const cx = (fl.x0 + fl.x1) / 2, cy = (fl.y0 + fl.y1) / 2, rx = (fl.x1 - fl.x0) / 2 + 3, ry = (fl.y1 - fl.y0) / 2 + 2.4
for (let a = -2.4; a <= -2.4 + 2 * Math.PI + 0.3; a += 0.15) loop.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)])
now += 8000
const circle = instance([loop], sketcher, 5, [cx - rx, cy - ry], now, OWNER).map((s) => ({ ...s, pressure: s.pts.map(() => 0.6) }))
feed(circle)
const o3 = settle(1500)
const mark = eng.registry.active(OWNER)[0]
const doneCard: CardContent = { ...content, status: 'done', title: 'this mark -> flashcard' }
frames.push({ name: 'taught', caption: `You circle "flashcard". The circle is read against the card's regions (${o3.map((o) => `${o.kind}: ${o.detail}`).join('; ')}); the mark now means: ${mark ? describe(mark.meaning) : '(nothing)'}, with one example and its lineage begun.`, glasses: 'bolt = make a flashcard', ink: [...inkOf(page), ...inkOf(g1), ...cardInk(layoutCard(doneCard, at), doneCard), ...inkOf(circle)], overlay: [] })

// 4. later, the mark beside another line: it fires, with a quiet confirmation
const more: S[] = []
notes.slice(4).forEach((t, i) => { now += 60_000; const s = write(t, [14, 34 + (i + 4) * 14 + 40], sketcher, 0.72, 41 + i, now); more.push(...s); feed(s) })
settle(4000)
const l5box = bounds(more.filter((s) => s.pts[0][1] < 34 + 4 * 14 + 40 + 5).flatMap((s) => s.pts))
now += 30_000
const g2 = bolt([l5box.x1 + 6, l5box.y0 - 0.5], 7, now)
feed(g2)
settle(1500)
const inv = sent.filter((m) => m.t === 'mark_invoke').pop() as unknown as MarkInvoke
const all = [...inkOf(page), ...inkOf(g1), ...cardInk(layoutCard(doneCard, at), doneCard), ...inkOf(circle), ...inkOf(more)]
frames.push({ name: 'use', caption: `Days later, the bolt beside "telescoping sums": recognised (${inv.why.split(';')[0]}). Its first uses ask quietly first: mark_invoke mode ${inv.mode}; the flashcard (primer_request) waits for your tick.`, glasses: 'bolt: flashcard of "telescoping sums"?  v / x', ink: [...all, ...inkOf(g2)], overlay: [{ pts: box(inflate(l5box, 1.2)), dashed: true }] })

// 5. accepted three times, it acts with only an undo; five, silently
eng.handle({ t: 'mark_feedback', invocation: inv.invocation, verdict: 'accept', by: OWNER, via: 'glasses', ts: now }, now)
const l6box = bounds(more.filter((s) => s.pts[0][1] > 34 + 4 * 14 + 40 + 5).flatMap((s) => s.pts))
const uses: S[] = []
let last: MarkInvoke = inv
for (let k = 0; k < 3; k++) {
  now += 3_600_000
  const g = bolt([l6box.x1 + 6 + k * 0.4, l6box.y0 - 0.5], 20 + k, now)
  feed(g)
  settle(1500)
  last = sent.filter((m) => m.t === 'mark_invoke').pop() as unknown as MarkInvoke
  if (last.mode === 'confirm') eng.handle({ t: 'mark_feedback', invocation: last.invocation, verdict: 'accept', by: OWNER, via: 'phone', ts: now }, now)
  if (k === 2) uses.push(...g)
}
const s5 = mark ? `${mark.invocations.length} uses, ${mark.invocations.filter((i) => i.verdict === 'accept').length} accepted, ${mark.examples.length} examples` : ''
frames.push({ name: 'earned', caption: `Confirmed three times, it has earned trust: this use ran at once (mode ${last.mode}) with only an undo (${s5}). Silent after five. Inspect, refine or retract it in My marks.`, glasses: 'flashcard made: "parity of permutations" (undo)', ink: [...all, ...inkOf(g2), ...inkOf(uses)], overlay: [{ pts: box(inflate(l6box, 1.2)), dashed: true }] })

mkdirSync('out', { recursive: true })
writeFileSync('out/marks-sequence.json', JSON.stringify({ page: PAGE, frames }))
console.log(frames.map((f) => `${f.name}: ${f.caption}`).join('\n'))
