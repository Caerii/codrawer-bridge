// Timed agent ink plays at its own pace on the phone stage (src/playout.ts, StrokeStore.visible).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Playout, visibleCount } from '../src/playout'
import { StrokeStore } from '../src/strokes'

const T = 1_760_000_000_000

test('visibleCount: points due by now', () => {
  assert.equal(visibleCount([0, 10, 20, 30], 5, 4), 0)
  assert.equal(visibleCount([0, 10, 20, 30], 5, 15), 2)
  assert.equal(visibleCount([0, 10, 20, 30], 5, 99), 4)
})

test('a burst plays in sequence, gaps kept; a later stroke after the lull anchors afresh', () => {
  const p = new Playout()
  // two strokes written 0–200 ms and 500–700 ms, both arriving at local 1000
  const o1 = p.start(T, T + 1000)
  p.extend(T + 200, o1)
  const o2 = p.start(T + 500, T + 1000)
  p.extend(T + 700, o2)
  assert.equal(o2, o1, 'the second keeps the running offset: it shows at local 1500')
  assert.ok(p.pending(T + 1600) && !p.pending(T + 1701))
  // a stroke stamped T+5000 arriving at local 9000, after everything played: anchored at arrival
  assert.equal(p.start(T + 5000, T + 9000), 4000)
})

test('the store reveals a timed ai stroke over its own duration; user ink at once', () => {
  const s = new StrokeStore()
  s.begin('a', 'ai', 'pen', T)
  s.points('a', [[0.1, 0.1, 0.5, T], [0.2, 0.1, 0.5, T + 100], [0.3, 0.1, 0.5, T + 200]], 'ai')
  const a = s.all()[0]
  const now = Date.now()
  assert.equal(s.visible(a, now), 1, 'only the first point is due on arrival')
  assert.equal(s.visible(a, now + 150), 2)
  assert.equal(s.visible(a, now + 250), 3)
  assert.ok(s.playing(now + 100))
  s.begin('u', 'user', 'pen', T)
  s.points('u', [[0.1, 0.2, 0.5, T], [0.2, 0.2, 0.5, T + 100]], 'user')
  assert.equal(s.visible(s.all()[1], now), 2)
})
