// Loupe geometry (src/glasses/loupe.ts) and the phone view mirroring the glasses (src/phone/mirror.ts).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loupeBaseWindow, writingContext, zoomForBoxWidth } from '../src/glasses/loupe'
import { initialPhoneView, phoneViewFor } from '../src/phone/mirror'
import { StrokeStore, type Stroke } from '../src/strokes'

test('the phone shows Follow while the glasses follow and Fit while they show the page', () => {
  assert.equal(phoneViewFor('follow'), 'follow')
  assert.equal(phoneViewFor('full'), 'focus')
  assert.equal(initialPhoneView('page', 'follow'), 'page')
  assert.equal(initialPhoneView(null, 'full'), 'focus')
  assert.equal(initialPhoneView('nonsense', 'follow'), 'follow')
})

test('the loupe base window scales with the follow window, the loupe width and the zoom', () => {
  assert.equal(loupeBaseWindow(0.2, 128, 1), 0.2 * 0.45)
  assert.ok(Math.abs(loupeBaseWindow(0.2, 192, 2) - 0.2 * 0.45 * 1.5 * 2) < 1e-12)
  assert.equal(zoomForBoxWidth(0.2, 0.1), 2)
  assert.equal(zoomForBoxWidth(10, 0.1), 6) // clamped
  assert.equal(zoomForBoxWidth(0.001, 0.1), 0.15)
})

test('dragging the loupe box lands the base window at the dragged width, whatever the zoom was', () => {
  const unzoomed = loupeBaseWindow(0.5, 192, 1)
  for (const width of [0.1, 0.3, 0.5]) {
    const zoom = zoomForBoxWidth(width, unzoomed)
    assert.ok(Math.abs(loupeBaseWindow(0.5, 192, zoom) - width) < 1e-9)
    // a second drag to the same width gives the same zoom (it used to compound)
    assert.equal(zoomForBoxWidth(width, unzoomed), zoom)
  }
})

/** A finished user stroke from (x0, y) to (x1, y), ended at `endedAt`. */
function stroke(s: StrokeStore, id: string, x0: number, x1: number, y: number, endedAt: number, layer: 'user' | 'peer' = 'user'): Stroke {
  s.begin(id, layer)
  s.points(id, [[x0, y, 0.5, 0], [x1, y, 0.5, 0]], layer)
  s.end(id)
  const st = s.all().find((x) => x.id === id)!
  st.endedAt = endedAt
  return st
}

test('the writing context is the recent user ink near the pen', () => {
  const s = new StrokeStore()
  const now = 100_000
  stroke(s, 'far', 0.9, 0.95, 0.9, now - 1000) // a different place on the page
  stroke(s, 'a', 0.30, 0.34, 0.5, now - 1000)
  stroke(s, 'b', 0.35, 0.40, 0.5, now - 500)
  stroke(s, 'p', 0.36, 0.38, 0.5, now - 100, 'peer') // other participants' ink does not count
  const box = writingContext(s.all(), [0.4, 0.5], 0.05, now)
  assert.ok(box)
  assert.ok(Math.abs(box[0] - 0.30) < 1e-9 && Math.abs(box[2] - 0.40) < 1e-9)
  assert.equal(writingContext(s.all(), null, 0.05, now), null)
})

test('the writing context stops at the first stroke older than 12 s', () => {
  const s = new StrokeStore()
  const now = 100_000
  stroke(s, 'old', 0.30, 0.34, 0.5, now - 13_000)
  assert.equal(writingContext(s.all(), [0.32, 0.5], 0.05, now), null)
  stroke(s, 'new', 0.35, 0.36, 0.5, now - 100)
  const box = writingContext(s.all(), [0.35, 0.5], 0.05, now)
  assert.ok(box && Math.abs(box[0] - 0.35) < 1e-9)
})
