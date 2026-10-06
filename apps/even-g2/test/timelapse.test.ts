// Timelapse pacing (src/timelapse.ts): stroke order, the time mapping, and the recorder format pick.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BASE_SHARE, compressGap, HOLD_MS, MAX_GAP_MS, MIN_STROKE_MS, PEN_RATE_MS, pickVideoType, planTimelapse, revealedPoints, strokeTiming, videoExtension } from '../src/timelapse'

/** A live stroke of n points starting at `start`, one point every `every` ms. */
const live = (start: number, n: number, every = 10) => ({ n, start, times: Array.from({ length: n }, (_, j) => start + j * every) })

test('the drawing fills the length minus the hold; the hold ends the video', () => {
  const plan = planTimelapse([live(1_000, 20), live(5_000, 20)], 10_000)
  assert.equal(plan.holdMs, HOLD_MS)
  assert.equal(plan.drawMs, 10_000 - HOLD_MS)
  assert.equal(plan.totalMs, 10_000)
  assert.equal(plan.strokes[0].start, 0)
  assert.ok(Math.abs(plan.strokes[1].end - plan.drawMs) < 1e-6)
})

test('strokes appear in drawing order, never before the one drawn before them', () => {
  const plan = planTimelapse([live(10_000, 5), live(9_000, 5), live(12_000, 5)], 20_000)
  const starts = plan.strokes.map((s) => s.start)
  assert.ok(starts[0] <= starts[1] && starts[1] <= starts[2])
})

test('long pauses compress; short ones keep their rhythm', () => {
  assert.equal(compressGap(200), 200)
  assert.equal(compressGap(-5), 0)
  assert.ok(compressGap(5_000) < 5_000)
  assert.equal(compressGap(10 * 60_000), MAX_GAP_MS)
  for (let g = 0; g < 20_000; g += 250) assert.ok(compressGap(g + 250) >= compressGap(g)) // monotonic

  // a ten-minute think between two strokes costs no more than MAX_GAP_MS of real time
  const a = live(0, 11, 10) // 100 ms
  const b = live(600_100, 11, 10)
  const plan = planTimelapse([a, b], 10_000, 0)
  const k = plan.drawMs / (100 + MAX_GAP_MS + 100)
  assert.ok(Math.abs(plan.strokes[1].start - (100 + MAX_GAP_MS) * k) < 1e-6)
})

test('a stroke animates at its own relative pen speed', () => {
  // slow first half (30 ms per point), fast second half (5 ms per point)
  const times = [0, 30, 60, 90, 95, 100, 105].map((t) => 1_000 + t)
  const plan = planTimelapse([{ n: times.length, start: 1_000, times }], 6_500)
  const at = plan.strokes[0].at
  const slow = at[1] - at[0]
  const fast = at[5] - at[4]
  assert.ok(Math.abs(slow / fast - 6) < 1e-6)
})

test('strokes without usable times are drawn evenly at the nominal pen rate', () => {
  const burst = { n: 11, start: 0, times: new Array(11).fill(500) } // all arrived at once
  const t = strokeTiming(burst)
  assert.equal(t.duration, 10 * PEN_RATE_MS)
  assert.deepEqual(t.offsets.map((o) => Math.round(o)), [0, 8, 16, 24, 32, 40, 48, 56, 64, 72, 80])
  assert.equal(strokeTiming({ n: 1, start: 0 }).duration, MIN_STROKE_MS)
  assert.equal(strokeTiming({ n: 3, start: 0 }).offsets.length, 3) // no times at all
})

test('concurrent strokes keep their overlap', () => {
  const plan = planTimelapse([live(0, 101, 10), live(500, 11, 10)], 11_500) // the second starts mid-first
  const [a, b] = plan.strokes
  assert.ok(b.start > a.start && b.start < a.end)
})

test('saved-page strokes come first in file order, as a quick base before live ink', () => {
  const page = [
    { n: 10, fromPage: true },
    { n: 30, fromPage: true },
  ]
  const plan = planTimelapse([...page, live(1_000, 10)], 10_000)
  const base = plan.drawMs * BASE_SHARE
  assert.equal(plan.strokes[0].start, 0)
  assert.ok(Math.abs(plan.strokes[0].end - base * 0.25) < 1e-6) // slots follow point counts
  assert.ok(Math.abs(plan.strokes[1].end - base) < 1e-6)
  assert.ok(Math.abs(plan.strokes[2].start - base) < 1e-6)

  // a page with nothing live: the saved page takes the whole drawing time
  const only = planTimelapse(page, 10_000)
  assert.ok(Math.abs(only.strokes[1].end - only.drawMs) < 1e-6)
})

test('empty strokes get an empty slot; revealedPoints counts what shows at a time', () => {
  const plan = planTimelapse([{ n: 0, start: 0 }, live(0, 5, 10)], 3_000, 1_000)
  assert.deepEqual(plan.strokes[0].at, [])
  assert.equal(revealedPoints(plan.strokes[0], 1e9), 0)
  const s = plan.strokes[1]
  assert.equal(revealedPoints(s, -1), 0)
  assert.equal(revealedPoints(s, s.start), 1)
  assert.equal(revealedPoints(s, (s.at[2] + s.at[3]) / 2), 3)
  assert.equal(revealedPoints(s, s.end), 5)
  assert.equal(revealedPoints(s, plan.totalMs), 5)
})

test('MP4 (H.264) is preferred, then WebM; none means null', () => {
  assert.equal(pickVideoType(() => true), 'video/mp4;codecs=avc1')
  assert.equal(pickVideoType((t) => t.startsWith('video/webm')), 'video/webm;codecs=vp9')
  assert.equal(pickVideoType((t) => t === 'video/webm;codecs=vp8'), 'video/webm;codecs=vp8')
  assert.equal(pickVideoType(() => false), null)
  assert.equal(
    pickVideoType((t) => {
      if (t.includes('mp4')) throw new Error('unknown')
      return true
    }),
    'video/webm;codecs=vp9',
  )
  assert.equal(videoExtension('video/mp4;codecs=avc1'), 'mp4')
  assert.equal(videoExtension('video/webm;codecs=vp8'), 'webm')
})
