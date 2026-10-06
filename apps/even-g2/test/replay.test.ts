// Thinking replay (src/replay/timeline.ts, src/replay/cursor.ts): one clock for a page's strokes,
// the page at any t, and the scrubber's compressed axis.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Stroke } from '../src/strokes'
import { ReplayCursor } from '../src/replay/cursor'
import { compressIdle, fromRecording, fromStore, inkBox, KEEP_IDLE_MS, LEAD_MS, MAX_IDLE_MS, nextStrokeEnd, prevStrokeEnd, revealed, sourceLag, TAIL_MS, TimeMap, type Timeline } from '../src/replay/timeline'

/** A live stroke as the store keeps it: n points along y = `y`, from x0 to x0 + w, one every `every` ms. */
function live(id: string, start: number, n: number, o: { every?: number; y?: number; x0?: number; w?: number; layer?: Stroke['layer']; brush?: string; author?: string; color?: string; skew?: number } = {}): Stroke {
  const every = o.every ?? 10
  const x0 = o.x0 ?? 0.2
  const w = o.w ?? 0.1
  const y = o.y ?? 0.3
  const pts = Array.from({ length: n }, (_, j) => [x0 + (n > 1 ? (j / (n - 1)) * w : 0), y, 0.5])
  const times = Array.from({ length: n }, (_, j) => start - (o.skew ?? 0) + j * every)
  return { id, layer: o.layer ?? 'user', brush: o.brush ?? 'pen', pts, done: true, endedAt: 0, box: [x0, y, x0 + w, y], startedAt: start, times, author: o.author, color: o.color }
}

/** A saved-page stroke (no times). */
function saved(id: string, y = 0.6): Stroke {
  return { id: 'rm:' + id, layer: 'user', brush: 'pen', pts: [[0.1, y, 0.5, 0.003], [0.3, y, 0.5, 0.003]], done: true, endedAt: 0, box: [0.1, y, 0.3, y], fromPage: true, tool: 'fineliner', color: '#000000ff' }
}

test('saved-page strokes are on the page at t = 0; live strokes start after the lead', () => {
  const tl = fromStore([saved('a'), saved('b', 0.7), live('u1', 1_000_000, 5), live('u2', 1_002_000, 5)])
  assert.equal(tl.baseCount, 2)
  assert.deepEqual(tl.strokes[0].at, [0, 0])
  assert.ok(tl.strokes[0].base)
  assert.equal(tl.strokes[2].at[0], LEAD_MS)
  assert.equal(tl.strokes[3].at[0], LEAD_MS + 2000)
  assert.equal(tl.durationMs, LEAD_MS + 2040 + TAIL_MS)
  assert.equal(tl.originMs, 1_000_000 - LEAD_MS)
})

test('a stroke keeps its own pen timing; strokes never start before the one drawn before them', () => {
  const tl = fromStore([live('a', 5_000, 4, { every: 30 }), live('b', 4_000, 3)])
  assert.deepEqual(tl.strokes[0].at.map((t) => t - tl.strokes[0].at[0]), [0, 30, 60, 90])
  assert.ok(tl.strokes[1].at[0] >= tl.strokes[0].at[0])
})

test('each source gets one clock offset: a burst of replayed strokes keeps its spacing', () => {
  // the tablet's clock is 50 s behind ours; its strokes all arrive at once (a router replay)
  const a = live('a', 0, 5, { skew: 0 })
  const b = live('b', 0, 5, { skew: 0 })
  a.times = a.times!.map((t) => t - 50_000 + 0)
  b.times = b.times!.map((t) => t - 50_000 + 3_000)
  a.startedAt = b.startedAt = 9_000 // both arrive here together
  const tl = fromStore([a, b])
  assert.equal(tl.strokes[1].at[0] - tl.strokes[0].at[0], 3_000)
  assert.deepEqual(
    sourceLag([
      { writer: 'user', arrived: 10, t0: 4 },
      { writer: 'user', arrived: 20, t0: 18 },
      { writer: 'peer:x', arrived: 5 },
    ]),
    new Map([['user', 2]]),
  )
})

test('revealed() counts the points due; prev/next step by stroke ends', () => {
  const tl = fromStore([live('a', 1_000, 5, { every: 100 }), live('b', 3_000, 3, { every: 100 })])
  const a = tl.strokes[0]
  assert.equal(revealed(a, a.at[0] - 1), 0)
  assert.equal(revealed(a, a.at[0]), 1)
  assert.equal(revealed(a, a.at[0] + 250), 3)
  assert.equal(revealed(a, 1e9), 5)
  const endA = a.at[4]
  const endB = tl.strokes[1].at[2]
  assert.equal(nextStrokeEnd(tl, 0), endA)
  assert.equal(nextStrokeEnd(tl, endA), endB)
  assert.equal(nextStrokeEnd(tl, endB), null)
  assert.equal(prevStrokeEnd(tl, endB), endA)
  assert.equal(prevStrokeEnd(tl, endA), 0)
})

test('the compressed axis shrinks idle stretches only, monotonically, and inverts', () => {
  assert.equal(compressIdle(500), 500)
  assert.equal(compressIdle(10 * 60_000), MAX_IDLE_MS)
  for (let g = 0; g < 30_000; g += 500) assert.ok(compressIdle(g + 500) >= compressIdle(g))
  // two strokes of 1 s with a 10-minute think between them
  const tl = fromStore([live('a', 0, 101, { every: 10 }), live('b', 601_000, 101, { every: 10 })])
  const plain = new TimeMap(tl, false)
  assert.equal(plain.end, tl.durationMs)
  const map = new TimeMap(tl, true)
  assert.ok(map.end < 10_000, `axis ${map.end}`)
  const bStart = tl.strokes[1].at[0]
  // the pen's own time is kept: one second of writing is one second of axis
  assert.ok(Math.abs(map.toAxis(bStart + 1000) - map.toAxis(bStart) - 1000) < 1e-6)
  assert.ok(Math.abs(map.toAxis(bStart) - map.toAxis(tl.strokes[0].at[100]) - MAX_IDLE_MS) < 1e-6)
  for (const t of [0, 200, 1_000, 300_000, bStart, bStart + 500, tl.durationMs]) assert.ok(Math.abs(map.toTime(map.toAxis(t)) - t) < 1e-6)
  assert.ok(KEEP_IDLE_MS < MAX_IDLE_MS)
})

test('inkBox spans all ink ever drawn, erasers left out', () => {
  const tl = fromStore([live('a', 0, 3, { x0: 0.1, w: 0.2, y: 0.2 }), live('e', 100, 3, { brush: 'eraser', x0: 0.0, w: 0.9, y: 0.9 })])
  assert.deepEqual(inkBox(tl), [0.1, 0.2, 0.30000000000000004, 0.2])
})

// ── The cursor ────────────────────────────────────────────────────────────────────────────────

/** Two horizontal lines, then an eraser across the first, then a peer stroke. */
function scene(): Timeline {
  return fromStore([
    saved('old', 0.8),
    live('l1', 1_000, 21, { y: 0.3, x0: 0.2, w: 0.4 }),
    live('l2', 2_000, 21, { y: 0.5, x0: 0.2, w: 0.4 }),
    { ...live('e1', 4_000, 11, { y: 0.3, x0: 0.35, w: 0.1, brush: 'eraser' }), done: true },
    live('p1', 6_000, 5, { layer: 'peer', author: 'Ann', color: '#e5484d', y: 0.7 }),
  ])
}

test('the cursor shows the page at t: the saved page, strokes so far, erasers cutting as they did', () => {
  const tl = scene()
  const c = new ReplayCursor(tl)
  c.seek(0)
  assert.deepEqual(c.store.all().map((s) => s.id), ['rm:old'])
  const l1 = tl.strokes[1]
  c.seek(l1.at[10])
  const s1 = c.store.all().find((s) => s.id === 'l1')!
  assert.equal(s1.pts.length, 11)
  assert.equal(s1.done, false)
  // after the eraser: l1 is cut, l2 is not
  const r = c.seek(tl.strokes[3].at[10] + 1)
  assert.equal(r.rebuilt, false)
  assert.ok(r.erased, 'the eraser reports the region it cut')
  const cut = c.store.all().find((s) => s.id === 'l1')!
  assert.ok((cut.goneCount ?? 0) > 0 && (cut.goneCount ?? 0) < cut.pts.length)
  assert.equal(c.store.all().find((s) => s.id === 'l2')!.goneCount ?? 0, 0)
  // the peer stroke keeps its colour and author
  c.seek(tl.durationMs)
  const p = c.store.all().find((s) => s.id === 'p1')!
  assert.equal(p.layer, 'peer')
  assert.equal(p.color, '#e5484d')
  assert.equal(p.author, 'Ann')
})

test('seeking back rebuilds the same page as seeking there fresh', () => {
  const tl = scene()
  const t = tl.strokes[3].at[5]
  const a = new ReplayCursor(tl)
  a.seek(tl.durationMs)
  const back = a.seek(t)
  assert.equal(back.rebuilt, true)
  const b = new ReplayCursor(tl)
  for (let x = 0; x <= t; x += 37) b.seek(x) // played forward in small steps
  b.seek(t)
  const shape = (c: ReplayCursor) => c.store.all().map((s) => `${s.id}:${s.pts.length}:${s.goneCount ?? 0}:${s.done}`)
  assert.deepEqual(shape(a), shape(b))
})

test('strokes taken back leave at their time', () => {
  const tl = fromStore([live('a', 1_000, 5), live('b', 2_000, 5)])
  tl.strokes[0].removedAt = 3_000
  const c = new ReplayCursor(tl)
  c.seek(2_900)
  assert.equal(c.store.all().length, 2)
  const r = c.seek(3_000)
  assert.equal(r.rebuilt, true)
  assert.deepEqual(c.store.all().map((s) => s.id), ['b'])
})

// ── Recordings ────────────────────────────────────────────────────────────────────────────────

const line = (ts: number, msg: object, dir = 'in') => JSON.stringify({ ts, dir, msg })

test('a session recording becomes a timeline: saved page, strokes with their stamps, deletes, replays skipped', () => {
  const T = 1_760_000_000_000
  const text = [
    line(T, { t: 'hello', replay: true }),
    line(T + 5, { t: 'page', doc: 'd', page: 'p', rev: 1, strokes: [{ id: '1:1', tool: 'fineliner', rgba: '#000000ff', pts: [[0.1, 0.1, 0.5, 0.002], [0.2, 0.1, 0.5, 0.002]] }] }),
    line(T + 1000, { t: 'stroke_begin', id: 'u1', layer: 'user', brush: 'pen', ts: T - 20_000 + 1000 }),
    line(T + 1010, { t: 'stroke_pts', id: 'u1', pts: [[0.3, 0.3, 0.5, T - 20_000 + 1000], [0.4, 0.3, 0.5, T - 20_000 + 1050]] }),
    line(T + 1060, { t: 'stroke_end', id: 'u1' }),
    'not json',
    line(T + 4000, { t: 'stroke_begin', id: 'ph1', layer: 'peer', color: '#2f80ed', author: 'phone' }, 'out'),
    line(T + 4000, { t: 'stroke_pts', id: 'ph1', pts: [[0.5, 0.5, 0.5], [0.6, 0.5, 0.5]] }, 'out'),
    line(T + 4100, { t: 'stroke_end', id: 'ph1' }, 'out'),
    // the router replays the page after a reconnect: u1 again, skipped
    line(T + 6000, { t: 'stroke_begin', id: 'u1', layer: 'user', brush: 'pen' }),
    line(T + 6000, { t: 'stroke_pts', id: 'u1', pts: [[0.9, 0.9, 0.5]] }),
    line(T + 6000, { t: 'stroke_end', id: 'u1' }),
    line(T + 7000, { t: 'stroke_delete', ids: ['ph1'] }),
    line(T + 8000, { t: 'ai_stroke_begin', id: 'ai1' }),
    line(T + 8000, { t: 'ai_stroke_pts', id: 'ai1', pts: [[0.2, 0.9, 0.5], [0.3, 0.9, 0.5]] }),
    line(T + 8100, { t: 'ai_stroke_end', id: 'ai1' }),
  ].join('\n')
  const tl = fromRecording(text)
  assert.equal(tl.source, 'recording')
  assert.equal(tl.baseCount, 1)
  assert.deepEqual(tl.strokes.map((s) => s.id), ['rm:1:1', 'u1', 'ph1', 'ai1'])
  const [, u1, ph1, ai1] = tl.strokes
  assert.equal(u1.pts.length, 2)
  assert.equal(u1.at[0], LEAD_MS)
  assert.equal(u1.at[1] - u1.at[0], 50)
  assert.ok(u1.ended)
  assert.equal(ph1.layer, 'peer')
  assert.equal(ph1.color, '#2f80ed')
  assert.equal(ph1.at[0] - u1.at[0], 3000)
  assert.equal(ph1.removedAt, ph1.at[0] + 3000)
  assert.equal(ai1.layer, 'ai')
  // and it replays
  const c = new ReplayCursor(tl)
  c.seek(tl.durationMs)
  assert.deepEqual(c.store.all().map((s) => s.id), ['rm:1:1', 'u1', 'ai1'])
})

test('a recording that moves to another page clears what was there', () => {
  const T = 1_760_000_000_000
  const text = [
    line(T, { t: 'stroke_begin', id: 'a', layer: 'user' }),
    line(T, { t: 'stroke_pts', id: 'a', pts: [[0.1, 0.1, 0.5]] }),
    line(T + 10, { t: 'stroke_end', id: 'a' }),
    line(T + 500, { t: 'page', doc: 'd', page: 'p1', rev: 1, strokes: [] }),
    line(T + 900, { t: 'page', doc: 'd', page: 'p1', rev: 2, strokes: [] }),
    line(T + 1000, { t: 'page', doc: 'd', page: 'p2', rev: 3, strokes: [] }),
  ].join('\n')
  const tl = fromRecording(text)
  assert.equal(tl.baseCount, 0)
  // the first page came after live ink (not a base); the same page again is skipped; p2 clears "a"
  assert.equal(tl.strokes[0].removedAt, LEAD_MS + 1000)
})
