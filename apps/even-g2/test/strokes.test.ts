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
