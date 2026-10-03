import { test } from 'node:test'
import assert from 'node:assert/strict'
import { StrokeStore } from '../src/strokes'

const pt = (x: number, y: number) => [x, y, 0.5, 0]

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
