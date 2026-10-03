// The router reconnect policy (src/reconnect.ts): ordinary backoff, and patience with refusals.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ReconnectPolicy } from '../src/reconnect'

test('ordinary drops back off by 1.6x to a 5 s cap and reset once accepted', () => {
  const p = new ReconnectPolicy()
  const delays = [1, 2, 3, 4, 5, 6].map(() => p.delayAfterClose())
  assert.deepEqual(delays.map(Math.round), [800, 1280, 2048, 3277, 5000, 5000])
  p.opened()
  assert.equal(p.retryMs, 800)
  p.accepted()
  assert.equal(p.delayAfterClose(), 800)
})

test('a bad URL grows the delay before it is used', () => {
  const p = new ReconnectPolicy()
  assert.equal(Math.round(p.delayAfterBadUrl()), 1280)
  assert.equal(Math.round(p.delayAfterBadUrl()), 2048)
})

test('refusals retry after 5 s per refusal in a row, up to 30 s, and opening does not reset that', () => {
  const p = new ReconnectPolicy()
  const delays: number[] = []
  for (let i = 1; i <= 8; i++) {
    p.opened()
    p.refused(1000 * i)
    delays.push(p.delayAfterClose())
  }
  assert.deepEqual(delays, [5000, 10_000, 15_000, 20_000, 25_000, 30_000, 30_000, 30_000])
  assert.equal(p.refusedSince, 1000) // the first refusal of the streak
  p.accepted()
  assert.equal(p.refusedStreak, 0)
  assert.equal(p.delayAfterClose(), 800)
})

test('retrySoon shortens the delay, but a refusal streak still holds the next retry to 5 s', () => {
  const p = new ReconnectPolicy()
  p.refused(0)
  p.retrySoon()
  // the close that follows still honours the refusal streak (5 s), as the app always did
  assert.equal(p.delayAfterClose(), 5000)
  const q = new ReconnectPolicy()
  q.retrySoon()
  assert.equal(q.delayAfterClose(), 300)
})

test('only a copy refused in the background, 3+ times over 45 s, is stale', () => {
  const p = new ReconnectPolicy()
  p.refused(1000)
  p.refused(11_000)
  assert.equal(p.isStaleCopy(61_000, true), false) // two refusals
  p.refused(21_000)
  assert.equal(p.isStaleCopy(45_999, true), false) // not yet 45 s since the first
  assert.equal(p.isStaleCopy(46_000, true), true)
  assert.equal(p.isStaleCopy(91_000, false), false) // the copy on screen never closes itself
})
