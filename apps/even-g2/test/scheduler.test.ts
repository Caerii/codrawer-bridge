// The glasses frame scheduler (src/glasses/scheduler.ts) with a fake link: no SDK, no glasses.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FrameScheduler, sameFrame, type Frame, type Slot } from '../src/glasses/scheduler'

const bytes = (...v: number[]) => new Uint8Array(v)

/** A scheduler over a fake link that records sends and takes `sendMs` per send. */
function rig(o: { minMs?: Partial<Record<Slot, number>>; sendMs?: number; images?: () => boolean; fail?: () => boolean } = {}) {
  const sends: { slot: Slot; frame: Frame }[] = []
  let busy = 0
  let overlapped = false
  const s = new FrameScheduler({
    minMs: { loupe: 0, canvas: 0, ...o.minMs },
    inflight: 1,
    label: 'test',
    hasImages: o.images ?? (() => true),
    transmit: async (slot, frame) => {
      if (busy) overlapped = true
      busy++
      sends.push({ slot, frame })
      await new Promise((r) => setTimeout(r, o.sendMs ?? 1))
      busy--
      if (o.fail?.()) throw new Error('link down')
      return 'success'
    },
  })
  return { s, sends, overlapped: () => overlapped }
}

test('sameFrame compares bytes and strings, and nothing is the same as unknown', () => {
  assert.equal(sameFrame(bytes(1, 2), bytes(1, 2)), true)
  assert.equal(sameFrame(bytes(1, 2), bytes(1, 3)), false)
  assert.equal(sameFrame(bytes(1, 2), bytes(1, 2, 3)), false)
  assert.equal(sameFrame('ab', 'ab'), true)
  assert.equal(sameFrame(bytes(97, 98), 'ab'), false)
  assert.equal(sameFrame(null, 'ab'), false)
})

test('slots are latest-wins and sends never overlap', async () => {
  const { s, sends, overlapped } = rig({ sendMs: 20 })
  s.offer('canvas', bytes(1))
  s.offer('canvas', bytes(2)) // 1 is already on the wire: 2 waits in the slot…
  s.offer('canvas', bytes(3)) // …and is replaced by 3 before it is sent
  await new Promise((r) => setTimeout(r, 80))
  assert.equal(overlapped(), false)
  assert.deepEqual(sends.map((x) => (x.frame as Uint8Array)[0]), [1, 3])
})

test('the loupe goes before the canvas', async () => {
  const { s, sends } = rig({ sendMs: 5 })
  s.offer('canvas', bytes(0)) // occupies the link
  s.offer('canvas', bytes(9)) // waiting
  s.offer('loupe', bytes(1)) // queued later, sent first
  await new Promise((r) => setTimeout(r, 60))
  assert.deepEqual(sends.map((x) => `${x.slot}${(x.frame as Uint8Array)[0]}`), ['canvas0', 'loupe1', 'canvas9'])
})

test('a frame the container already shows is not sent again, from a frame or a recipe', async () => {
  const { s, sends } = rig()
  s.offer('loupe', bytes(1, 2, 3))
  await new Promise((r) => setTimeout(r, 20))
  s.offer('loupe', bytes(1, 2, 3))
  s.want('loupe', () => bytes(1, 2, 3))
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(sends.length, 1)
  s.forgetShown() // a page rebuild blanks the containers
  s.offer('loupe', bytes(1, 2, 3))
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(sends.length, 2)
})

test('a recipe is run when the link frees up, not when it is queued', async () => {
  const { s, sends } = rig({ sendMs: 30 })
  let pen = 1
  s.offer('loupe', bytes(0)) // occupies the link for 30 ms
  s.want('loupe', () => bytes(pen))
  pen = 2
  await new Promise((r) => setTimeout(r, 15))
  pen = 3 // moved again while the first frame was still on the wire
  await new Promise((r) => setTimeout(r, 80))
  assert.deepEqual(sends.map((x) => (x.frame as Uint8Array)[0]), [0, 3])
})

// Margins are wide (a 300 ms floor, checked at ~40 ms and again after 500 ms) so a busy machine's
// late timers cannot flip the result; it used to fail now and then with a 60 ms floor.
test('a slot waits its floor since its last send started', async () => {
  const { s, sends } = rig({ minMs: { canvas: 300 } })
  s.offer('canvas', bytes(1))
  await new Promise((r) => setTimeout(r, 5))
  s.offer('canvas', bytes(2))
  assert.equal(s.readySlot(), null)
  assert.ok(s.msUntilReady() > 1 && s.msUntilReady() <= 50) // never a longer sleep than 50 ms
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(sends.length, 1)
  await new Promise((r) => setTimeout(r, 500))
  assert.equal(sends.length, 2)
  assert.equal(s.sent.canvas, 2)
  assert.ok(s.rt.canvas >= 0)
})

test('without image containers the queue is dropped', async () => {
  const { s, sends } = rig({ images: () => false })
  s.offer('canvas', bytes(1))
  s.want('loupe', () => bytes(2))
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(sends.length, 0)
  assert.equal(s.readySlot(), null)
})

test('after a failed send the next identical frame still goes', async () => {
  let fail = true
  const { s, sends } = rig({ fail: () => fail })
  const errors = console.error
  console.error = () => {}
  try {
    s.offer('loupe', bytes(7))
    await new Promise((r) => setTimeout(r, 20))
    assert.equal(s.lastResult, 'error')
    fail = false
    s.offer('loupe', bytes(7))
    await new Promise((r) => setTimeout(r, 20))
    assert.equal(sends.length, 2)
    assert.equal(s.lastResult, 'success')
  } finally {
    console.error = errors
  }
})

test('busy covers a running drain', async () => {
  const { s } = rig({ sendMs: 20 })
  assert.equal(s.busy, false)
  s.offer('canvas', bytes(1))
  assert.equal(s.busy, true)
  await new Promise((r) => setTimeout(r, 40))
  assert.equal(s.busy, false)
})
