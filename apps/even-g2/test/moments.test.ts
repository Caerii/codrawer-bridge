// Moments of thought (src/replay/moments.ts): pauses, erasures, rewrites, hesitations, bursts and
// contributions, each relative to the writer's own rhythm.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BURST_RATIO, eraserCuts, findMoments, HESITATION_RATIO, median, PAUSE_ALWAYS_MS, PAUSE_FLOOR_MS, strokeLength, writerName, type MomentKind } from '../src/replay/moments'
import { LEAD_MS, type ReplayStroke, type Timeline } from '../src/replay/timeline'

/**
 * A page written by hand, built stroke by stroke on the timeline's clock: `pen(dur, gap)` adds a
 * horizontal stroke of length `len` (page widths) lasting `dur` ms after a pen-up of `gap` ms,
 * moving right along the current line.
 */
function page() {
  const strokes: ReplayStroke[] = []
  let t = LEAD_MS
  let x = 0.1
  let y = 0.2
  let n = 0
  const add = (o: { dur: number; gap?: number; len?: number; layer?: ReplayStroke['layer']; brush?: string; author?: string; at?: [number, number]; pts?: number[][] }) => {
    t += o.gap ?? 0
    const len = o.len ?? 0.03
    const k = 8
    const [x0, y0] = o.at ?? [x, y]
    const pts = o.pts ?? Array.from({ length: k }, (_, j) => [x0 + (j / (k - 1)) * len, y0 + (j % 2) * 0.004, 0.5])
    const at = pts.map((_, j) => t + (j / (pts.length - 1)) * o.dur)
    const s: ReplayStroke = { id: `s${n++}`, layer: o.layer ?? 'user', brush: o.brush ?? 'pen', author: o.author, pts, at, base: false, ended: true }
    strokes.push(s)
    t += o.dur
    if (!o.at) {
      x += len + 0.01
      if (x > 0.8) {
        x = 0.1
        y += 0.05
      }
    }
    return s
  }
  const tl = (): Timeline => ({ strokes, durationMs: t + 600, originMs: 0, baseCount: 0, source: 'live' })
  return { add, tl, now: () => t, pos: () => [x, y] as [number, number] }
}

/** Ordinary handwriting: `count` strokes of 300 ms with 200 ms pen-ups. */
function write(p: ReturnType<typeof page>, count: number) {
  for (let i = 0; i < count; i++) p.add({ dur: 300, gap: 200 })
}

const kinds = (ms: { kind: MomentKind }[]) => ms.map((m) => m.kind)

test('steady writing has no moments; its rhythm is the baseline', () => {
  const p = page()
  write(p, 20)
  const { moments, summary } = findMoments(p.tl())
  assert.deepEqual(moments, [])
  const w = summary.writers[0]
  assert.equal(w.writer, 'user')
  assert.equal(w.medianGapMs, 200)
  assert.equal(w.pauseThresholdMs, PAUSE_FLOOR_MS) // 4 × 200 ms is under the floor
  assert.ok(Math.abs(w.medianSpeed! - strokeLength(p.tl().strokes[0].pts) / 0.3) < 1e-9)
  assert.equal(summary.primary, 'user')
})

test('a long pause, relative to the writer, is marked from pen-up to pen-down', () => {
  const p = page()
  write(p, 10)
  const before = p.now()
  p.add({ dur: 300, gap: 3_000 }) // 15× the usual gap
  write(p, 10)
  p.add({ dur: 300, gap: 1_000 }) // 5×, but under the floor
  write(p, 3)
  const { moments, summary } = findMoments(p.tl())
  const pauses = moments.filter((m) => m.kind === 'pause')
  assert.equal(pauses.length, 1)
  assert.equal(pauses[0].t, before)
  assert.equal(pauses[0].end, before + 3_000)
  assert.equal(pauses[0].label, 'Pause · 3.0 s')
  assert.equal(summary.longestPauseMs, 3_000)
})

test('a slow writer gets a higher pause threshold, capped at the absolute one', () => {
  const p = page()
  for (let i = 0; i < 10; i++) p.add({ dur: 300, gap: 1_500 }) // pauses 1.5 s between strokes
  p.add({ dur: 300, gap: 3_500 })
  p.add({ dur: 300, gap: 4_500 })
  const { moments, summary } = findMoments(p.tl())
  assert.equal(summary.writers[0].pauseThresholdMs, PAUSE_ALWAYS_MS)
  assert.deepEqual(moments.filter((m) => m.kind === 'pause').map((m) => m.end - m.t), [4_500])
})

test('slow strokes are hesitations; consecutive ones are one moment', () => {
  const p = page()
  write(p, 12)
  const slow1 = p.add({ dur: 300 / (HESITATION_RATIO * 0.6), gap: 200 })
  const slow2 = p.add({ dur: 1_200, gap: 200 })
  write(p, 6)
  const { moments, summary } = findMoments(p.tl())
  const h = moments.filter((m) => m.kind === 'hesitation')
  assert.equal(h.length, 1)
  assert.deepEqual(h[0].strokeIds, [slow1.id, slow2.id])
  assert.match(h[0].label, /^Slow writing · 2 strokes at 0\.\d\d×$/)
  assert.equal(summary.hesitantStrokes, 2)
})

test('a fast run of writing is a burst', () => {
  const p = page()
  for (let r = 0; r < 4; r++) {
    write(p, 4)
    p.add({ dur: 300, gap: 1_000 }) // breaks between runs (under the pause threshold)
  }
  const first = p.add({ dur: 120, gap: 1_000 })
  for (let i = 0; i < 5; i++) p.add({ dur: 120, gap: 60 })
  p.add({ dur: 300, gap: 1_000 })
  write(p, 4)
  const { moments, summary } = findMoments(p.tl())
  const b = moments.filter((m) => m.kind === 'burst')
  assert.equal(b.length, 1, JSON.stringify(kinds(moments)))
  assert.equal(b[0].strokeIds[0], first.id)
  assert.equal(b[0].strokeIds.length, 6)
  assert.ok(Number(/at ([\d.]+)×/.exec(b[0].label)![1]) >= BURST_RATIO)
  assert.equal(summary.burstStrokes, 6)
})

test('an eraser that cuts ink is an erasure; ink written there afterwards is a rewrite', () => {
  const p = page()
  const victims = [p.add({ dur: 300, gap: 200 }), p.add({ dur: 300, gap: 200 })]
  write(p, 8)
  // the eraser sweeps the first two strokes (y 0.2, x 0.1..0.18)
  const eraser = p.add({ dur: 400, gap: 800, brush: 'eraser', at: [0.1, 0.202], len: 0.05 })
  const re = p.add({ dur: 300, gap: 600, at: [0.11, 0.2] })
  p.add({ dur: 300, gap: 200, at: [0.15, 0.2] })
  p.add({ dur: 300, gap: 200, at: [0.6, 0.6] }) // elsewhere: not part of the rewrite
  const { moments, summary } = findMoments(p.tl())
  const e = moments.filter((m) => m.kind === 'erase')
  assert.equal(e.length, 1)
  assert.equal(e[0].t, eraser.at[0])
  assert.deepEqual(e[0].strokeIds, [eraser.id, victims[0].id, victims[1].id])
  assert.equal(e[0].label, 'Erased · 2 strokes cut')
  assert.equal(summary.strokesErased, 2)
  const r = moments.filter((m) => m.kind === 'rewrite')
  assert.equal(r.length, 1)
  assert.equal(r[0].t, re.at[0])
  assert.equal(r[0].strokeIds.length, 2)
  assert.equal(summary.rewriteStrokes, 2)
})

test('the eraser cuts only earlier tablet ink, each point once', () => {
  const p = page()
  const a = p.add({ dur: 300, at: [0.3, 0.5], len: 0.05 })
  const peer = p.add({ dur: 300, gap: 100, at: [0.3, 0.5], len: 0.05, layer: 'peer', author: 'Ann' })
  const e1 = p.add({ dur: 300, gap: 100, brush: 'eraser', at: [0.3, 0.5], len: 0.05 })
  const e2 = p.add({ dur: 300, gap: 100, brush: 'eraser', at: [0.3, 0.5], len: 0.05 })
  const later = p.add({ dur: 300, gap: 100, at: [0.3, 0.5], len: 0.05 })
  const cuts = eraserCuts(p.tl())
  const tl = p.tl()
  const idx = (s: ReplayStroke) => tl.strokes.indexOf(s)
  assert.deepEqual(cuts.get(idx(e1))!.ids, [a.id])
  assert.deepEqual(cuts.get(idx(e2))!.ids, []) // nothing left to cut
  assert.ok(!cuts.get(idx(e1))!.ids.includes(peer.id) && !cuts.get(idx(e1))!.ids.includes(later.id))
})

test('strokes taken back at one moment are one erasure', () => {
  const p = page()
  write(p, 6)
  const tl = p.tl()
  tl.strokes[4].removedAt = 9_000
  tl.strokes[5].removedAt = 9_100
  const { moments, summary } = findMoments(tl)
  const e = moments.filter((m) => m.kind === 'erase')
  assert.equal(e.length, 1)
  assert.equal(e[0].label, 'Took back 2 strokes')
  assert.equal(summary.strokesTakenBack, 2)
})

test("other writers' ink is a contribution, one per run; the agent's timing is not read", () => {
  const p = page()
  write(p, 8)
  p.add({ dur: 2_000, gap: 500, layer: 'ai', author: 'hand:sketcher', at: [0.1, 0.7] })
  p.add({ dur: 2_000, gap: 9_000, layer: 'ai', author: 'hand:sketcher', at: [0.2, 0.7] }) // a long agent pause: no pause marker
  p.add({ dur: 300, gap: 200, layer: 'peer', author: 'Ann', at: [0.5, 0.8] })
  write(p, 3)
  const { moments, summary } = findMoments(p.tl())
  const c = moments.filter((m) => m.kind === 'contribution')
  assert.deepEqual(
    c.map((m) => m.label),
    ['Agent (hand:sketcher) wrote · 1 stroke', 'Agent (hand:sketcher) wrote · 1 stroke', 'Ann drew · 1 stroke'],
  )
  // the tablet's own wait while the others wrote is its pause; the agent's 9 s gap is none
  assert.deepEqual(moments.filter((m) => m.kind === 'pause').map((m) => m.writer), ['user'])
  assert.equal(summary.contributedStrokes, 3)
  assert.equal(summary.counts.contribution, 3)
})

test('without tablet ink the busiest human is the primary writer', () => {
  const p = page()
  for (let i = 0; i < 3; i++) p.add({ dur: 300, gap: 200, layer: 'peer', author: 'Ann' })
  p.add({ dur: 300, gap: 200, layer: 'peer', author: 'Bo' })
  const { summary, moments } = findMoments(p.tl())
  assert.equal(summary.primary, 'peer:Ann')
  assert.deepEqual(moments.map((m) => m.label), ['Bo drew · 1 stroke'])
})

test('helpers', () => {
  assert.equal(median([]), null)
  assert.equal(median([3, 1, 2]), 2)
  assert.equal(median([4, 1, 2, 3]), 2.5)
  assert.equal(writerName('user'), 'Tablet')
  assert.equal(writerName('ai:ai'), 'Agent')
  assert.equal(writerName('peer:peer'), 'A peer')
  // y counts 4/3 of x: a vertical stroke of 0.3 page heights is 0.4 page widths
  assert.ok(Math.abs(strokeLength([[0, 0], [0, 0.3]]) - 0.4) < 1e-12)
})

test('moments come sorted, with every stroke id real', () => {
  const p = page()
  write(p, 10)
  p.add({ dur: 300, gap: 5_000 })
  p.add({ dur: 300, gap: 200, brush: 'eraser', at: [0.1, 0.2], len: 0.1 })
  write(p, 5)
  const tl = p.tl()
  const { moments } = findMoments(tl)
  const ids = new Set(tl.strokes.map((s) => s.id))
  for (let i = 1; i < moments.length; i++) assert.ok(moments[i - 1].t <= moments[i].t)
  for (const m of moments) for (const id of m.strokeIds) assert.ok(ids.has(id), id)
})
