import { test } from 'node:test'
import assert from 'node:assert/strict'
import { StrokeStore } from '../src/strokes'

const pt = (x: number, y: number) => [x, y, 0.5, 0]

test("live points keep when they were drawn: the sender's t, else the arrival time", () => {
  const s = new StrokeStore()
  const before = Date.now()
  s.begin('u_1', 'user', 'pen', 1730000000000)
  s.points('u_1', [[0.1, 0.1, 0.5, 1730000000130], [0.2, 0.2, 0.5], [0.3, 0.3, 0.5, 0]], 'user')
  const st = s.all()[0]
  assert.equal(st.times?.[0], 1730000000130)
  assert.ok(st.times![1] >= before && st.times![2] >= before) // no t, or not a Unix ms: arrival
  assert.equal(st.times!.length, st.pts.length)
  assert.ok(st.startedAt! >= before)
  s.begin('u_1', 'user') // replayed: restarts its times too
  assert.deepEqual(s.all()[0].times, [])
})

test('a replayed stroke restarts in place instead of duplicating', () => {
  const s = new StrokeStore()
  s.begin('u_1', 'user')
  s.points('u_1', [pt(0.1, 0.1), pt(0.2, 0.2)], 'user')
  s.end('u_1')
  s.begin('u_2', 'user')
  // reconnect: the router replays the page
  s.begin('u_1', 'user')
  s.points('u_1', [pt(0.1, 0.1), pt(0.2, 0.2)], 'user')
  s.end('u_1')
  assert.deepEqual(s.all().map((x) => x.id), ['u_1', 'u_2'])
  assert.equal(s.all()[0].pts.length, 2)
  assert.equal(s.pointCount, 2)
})

test('prune drops the oldest finished strokes by point budget, never an open one', () => {
  const s = new StrokeStore()
  const big = Array.from({ length: 50_000 }, (_, i) => pt(i / 50_000, 0.5))
  s.begin('old', 'user')
  s.points('old', big, 'user')
  s.end('old')
  s.begin('mid', 'user')
  s.points('mid', big, 'user')
  s.end('mid')
  s.begin('live', 'user')
  s.points('live', big, 'user') // 150k points, over the 120k budget
  assert.equal(s.prune(), true)
  assert.deepEqual(s.all().map((x) => x.id), ['mid', 'live'])
  assert.equal(s.prune(), false)

  const t = new StrokeStore()
  t.begin('open', 'user')
  t.points('open', [...big, ...big, ...big], 'user')
  assert.equal(t.prune(), false, 'an open stroke is never dropped')
})

test('endOpen closes strokes cut off by a disconnect', () => {
  const s = new StrokeStore()
  s.begin('u_1', 'user')
  s.points('u_1', [pt(0.1, 0.1)], 'user')
  s.endOpen()
  assert.equal(s.all()[0].done, true)
})

test('follow tracks the user pen, not AI ink', () => {
  const s = new StrokeStore()
  s.begin('u_1', 'user')
  s.points('u_1', [pt(0.3, 0.4)], 'user')
  s.begin('ai_1', 'ai')
  s.points('ai_1', [pt(0.9, 0.9)], 'ai')
  assert.deepEqual(s.lastPoint, [0.3, 0.4])
  assert.deepEqual(s.all()[0].box, [0.3, 0.4, 0.3, 0.4])
})

test('loupe camera: room ahead, steady while writing, new line, jump, speed zoom', async () => {
  const { LoupeCamera } = await import('../src/strokes')
  const cam = new LoupeCamera(0.5, 1620 / 2160)
  const base = 0.1
  let t = 0
  let v = cam.update([0.5, 0.5], base, t)
  // first frame: pen near the left of the window, room ahead to the right
  assert.ok(v.center[0] > 0.5, 'room ahead on the first frame')
  const first = v.center[0]

  // writing to the right inside the window, with back-and-forth inside letters: no movement
  const xs = [0.505, 0.502, 0.51, 0.507, 0.515, 0.512, 0.52]
  for (const x of xs) v = cam.update([x, 0.5], base, (t += 120))
  assert.equal(v.center[0], first, 'steady while writing inside the frame')

  // reaching the leading edge: the frame moves ahead once (pen near its trailing side), then
  // holds still again while the writing fills the new room
  const centres: number[] = []
  for (let i = 1; i <= 12; i++) centres.push(cam.update([0.52 + i * 0.006, 0.5], base, (t += 120)).center[0])
  const moves = centres.filter((c, i) => i > 0 && c !== centres[i - 1]).length
  assert.equal(moves, 1, `moved once, not every frame: ${centres.map((c) => c.toFixed(3))}`)
  assert.ok(centres[11] > first + 0.04, 'frame advanced with the writing')

  // carriage return to the next line: frame the start of the new line
  v = cam.update([0.5, 0.5 + 0.05], base, (t += 300))
  assert.ok(Math.abs(v.center[1] - 0.55) < 1e-9 && v.center[0] > 0.5, 'new line framed at its start')

  // a stroke far away: framed there
  v = cam.update([0.1, 0.9], base, (t += 300))
  assert.ok(Math.abs(v.center[1] - 0.9) < 1e-9)

  // fast strokes widen the window; slow writing brings it back
  for (let i = 1; i <= 8; i++) v = cam.update([0.1 + i * 0.03, 0.9], base, (t += 50))
  assert.ok(v.window > base * 1.3, `fast: ${v.window}`)
  for (let i = 1; i <= 30; i++) v = cam.update([0.34 + i * 0.0005, 0.9], base, (t += 100))
  assert.ok(v.window < base * 1.1, `slow: ${v.window}`)
})

test('loupe window keeps the loupe proportions on the page (no squashing)', async () => {
  const { LoupeCamera } = await import('../src/strokes')
  const pageW = 1620
  const pageH = 2160
  const cam = new LoupeCamera(64 / 128, pageW / pageH)
  cam.update([0.5, 0.5], 0.1, 0)
  const [x0, y0, x1, y1] = cam.rect()
  const physical = ((x1 - x0) * pageW) / ((y1 - y0) * pageH)
  assert.ok(Math.abs(physical - 2) < 1e-9, `128x64 loupe frames a 2:1 patch of paper, got ${physical}`)
})

test('loupe widens to keep the recent writing in view, within limits', async () => {
  const { LoupeCamera } = await import('../src/strokes')
  const base = 0.1
  const settle = (cam: InstanceType<typeof LoupeCamera>, ctx: [number, number, number, number] | null) => {
    let v = cam.update([0.5, 0.5], base, 0, ctx)
    for (let t = 1; t <= 40; t++) v = cam.update([0.5, 0.5], base, t * 1000, ctx) // still pen: no speed zoom
    return v.window
  }
  const word: [number, number, number, number] = [0.44, 0.49, 0.6, 0.52] // a word 0.16 wide
  assert.ok(Math.abs(settle(new LoupeCamera(0.5, 0.75), null) - base) < 1e-3, 'no context: base zoom')
  const w = settle(new LoupeCamera(0.5, 0.75), word)
  assert.ok(Math.abs(w - 0.16 * 1.3) < 1e-3, `holds the word with a margin, got ${w}`)
  const page: [number, number, number, number] = [0, 0, 1, 1]
  assert.ok(Math.abs(settle(new LoupeCamera(0.5, 0.75), page) - base * 2.5) < 1e-3, 'capped at 2.5x the base')
})

// ── page snapshots (the tablet's saved page) ────────────────────────────────

const pageMsg = (page: string, rev: number, ids: string[], doc = 'd') => ({
  t: 'page' as const,
  doc,
  page,
  rev,
  strokes: ids.map((id) => ({ id, tool: 'calligraphy', color: 0, rgba: '#000000ff', size: 2, pts: [[0.1, 0.2, 0.5, 0.004], [0.3, 0.4, 0.6, 0.005]] })),
})

const live = (s: StrokeStore, id: string, ts: number, layer: 'user' | 'ai' = 'user') => {
  s.begin(id, layer, 'pen', ts)
  s.points(id, [pt(0.5, 0.5), pt(0.6, 0.6)], layer)
  s.end(id)
}

test('a page snapshot replaces saved ink and keeps strokes drawn after its rev', () => {
  const s = new StrokeStore()
  live(s, 'u_old', 1000) // saved in the file (or erased since): the snapshot decides
  live(s, 'u_new', 3000) // drawn after the save: not in any file yet
  live(s, 'u_nots', 0)
  s.begin('u_nots2', 'user') // no timestamp at all: cannot be placed after the save
  assert.equal(s.applyPage(pageMsg('p1', 2000, ['1:5', '1:6'])), true, 'first page counts as a change')
  assert.deepEqual(s.all().map((x) => x.id), ['rm:1:5', 'rm:1:6', 'u_new'])
  const rm = s.all()[0]
  assert.equal(rm.fromPage, true)
  assert.equal(rm.tool, 'calligraphy')
  assert.equal(rm.color, '#000000ff')
  assert.equal(rm.size, 2)
  assert.equal(rm.done, true)
  assert.deepEqual(rm.pts[1], [0.3, 0.4, 0.6, 0.005], 'per-point width kept')
  assert.deepEqual(rm.box, [0.1, 0.2, 0.3, 0.4])
  assert.equal(s.pointCount, 6)
  assert.deepEqual(s.page, { doc: 'd', page: 'p1', title: undefined, rev: 2000 })
})

test('a rewrite of the same page drops erased strokes and keeps the AI layer', () => {
  const s = new StrokeStore()
  s.applyPage(pageMsg('p1', 2000, ['1:5', '1:6']))
  live(s, 'ai_1', 0, 'ai')
  live(s, 'u_a', 2500)
  // the user erased 1:6 and paused: xochitl saves the page including u_a (now 1:7)
  assert.equal(s.applyPage(pageMsg('p1', 4000, ['1:5', '1:7'])), false)
  assert.deepEqual(s.all().map((x) => x.id), ['rm:1:5', 'rm:1:7', 'ai_1'])
  assert.equal(s.pointCount, 6)
})

test('agent ink the tablet committed natively replaces the live AI strokes, not duplicates them', () => {
  const s = new StrokeStore()
  s.applyPage(pageMsg('p1', 2000, ['1:5']))
  live(s, 'ai_1', 0, 'ai') // forwarded to the tablet (NATIVE_AGENT_INK) and committed there
  s.begin('ai_2', 'ai') // still being drawn
  const withAgent = pageMsg('p1', 4000, ['1:5', '1:305'])
  withAgent.strokes[1] = { ...withAgent.strokes[1], layer: 'ai' } as (typeof withAgent.strokes)[number]
  assert.equal(s.applyPage(withAgent), false)
  assert.deepEqual(s.all().map((x) => [x.id, x.layer]), [['rm:1:5', 'user'], ['rm:1:305', 'ai'], ['ai_2', 'ai']])
  // the next save without new agent ink keeps the snapshot's own agent strokes, not stale copies
  assert.equal(s.applyPage(withAgent), false)
  assert.deepEqual(s.all().map((x) => x.id), ['rm:1:5', 'rm:1:305', 'ai_2'])
})

test('a page turn clears the view, AI included, and shows the new page', () => {
  const s = new StrokeStore()
  s.applyPage(pageMsg('p1', 2000, ['1:5']))
  live(s, 'ai_1', 0, 'ai')
  live(s, 'u_before_turn', 2500)
  live(s, 'u_on_p2', 5100) // drawn on the new page right after the turn
  assert.ok(s.lastPoint)
  assert.equal(s.applyPage(pageMsg('p2', 5000, [])), true)
  assert.deepEqual(s.all().map((x) => x.id), ['u_on_p2'])
  assert.equal(s.lastPoint, null)
  assert.equal(s.applyPage(pageMsg('p2', 5000, [], 'other-doc')), true, 'another document is a change')
})

test('clear forgets the page; malformed snapshot entries are ignored', () => {
  const s = new StrokeStore()
  s.applyPage({ t: 'page', doc: 'd', page: 'p', rev: 1, strokes: [{ id: '1:1', pts: [[0.1, 0.1], 'x' as any, [0.2]] }, null as any, { id: 5 as any, pts: [] }] })
  assert.deepEqual(s.all().map((x) => x.id), ['rm:1:1'])
  assert.deepEqual(s.all()[0].pts, [[0.1, 0.1, 0.6]])
  s.clear()
  assert.equal(s.page, null)
  assert.equal(s.all().length, 0)
})

test('stroke_delete removes strokes and their points; unknown ids are ignored', () => {
  const s = new StrokeStore()
  s.begin('u_1', 'user')
  s.points('u_1', [pt(0.1, 0.1), pt(0.2, 0.2)], 'user')
  s.begin('ai_1', 'ai', 'pen', 1, { color: '#7a4fd8', author: 'agent' })
  s.points('ai_1', [pt(0.3, 0.3)], 'ai')
  s.begin('u_2', 'user')
  s.points('u_2', [pt(0.4, 0.4)], 'user')
  assert.deepEqual(s.remove(['ai_1', 'nope', 'u_1']), ['ai_1', 'u_1'])
  assert.deepEqual(s.all().map((x) => x.id), ['u_2'])
  assert.equal(s.pointCount, 1)
  assert.equal(s.has('u_1'), false)
  assert.equal(s.has('u_2'), true)
  assert.deepEqual(s.remove(['u_1']), [], 'a second delete is a no-op')
})

test('points arriving after a delete do not resurrect the stroke; a new begin does', () => {
  const s = new StrokeStore()
  s.begin('ai_9', 'ai')
  s.points('ai_9', [pt(0.1, 0.1)], 'ai')
  s.remove(['ai_9'])
  s.points('ai_9', [pt(0.2, 0.2)], 'ai') // still in flight when the delete was applied
  assert.equal(s.all().length, 0)
  s.begin('ai_9', 'ai') // the id reused for a new stroke
  s.points('ai_9', [pt(0.3, 0.3)], 'ai')
  assert.deepEqual(s.all().map((x) => x.pts.length), [1])
})

test('a deleted id never seen before is still remembered, so its first points stay away', () => {
  const s = new StrokeStore()
  assert.deepEqual(s.remove(['later']), [])
  s.points('later', [pt(0.5, 0.5)], 'user')
  assert.equal(s.all().length, 0)
  s.clear()
  s.points('later', [pt(0.5, 0.5)], 'user') // a new drawing forgets old deletes
  assert.equal(s.all().length, 1)
})
