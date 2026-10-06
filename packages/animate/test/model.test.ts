// The frame model (src/model.ts) and the anim_* reducer (src/protocol.ts): editing keeps ids
// unique and inputs untouched; timing honours holds, loop modes and the device schedule's rule
// that a slow display drops frames instead of slowing the animation.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  addFrame,
  applyAnim,
  createAnim,
  deleteFrame,
  deviceSchedule,
  duplicateFrame,
  frameAt,
  moveFrame,
  passMs,
  passOrder,
  setHold,
  setLoop,
  toDoc,
  type Anim,
} from '../src/index'

function strip(n: number, fps = 10): Anim {
  let a = createAnim('a', 'test', 'f0', fps)
  for (let i = 1; i < n; i++) a = addFrame(a, i - 1, `f${i}`)
  return a
}

test('add, duplicate, move and delete keep order and never mutate the input', () => {
  const a = strip(3)
  const frozen = JSON.stringify(a)
  const withStroke = { ...a, frames: a.frames.map((f, i) => (i === 1 ? { ...f, strokes: [{ id: 's', pts: [[0.1, 0.2, 0.5]] as [number, number, number][] }] } : f)) }
  const d = duplicateFrame(withStroke, 1, 'f1b')
  assert.deepEqual(d.frames.map((f) => f.id), ['f0', 'f1', 'f1b', 'f2'])
  assert.equal(d.frames[2].strokes[0].id, 'f1b/0')
  d.frames[2].strokes[0].pts[0][0] = 0.9
  assert.equal(withStroke.frames[1].strokes[0].pts[0][0], 0.1, 'duplicate copies points')
  assert.deepEqual(moveFrame(d, 3, 0).frames.map((f) => f.id), ['f2', 'f0', 'f1', 'f1b'])
  assert.deepEqual(deleteFrame(d, 0).frames.map((f) => f.id), ['f1', 'f1b', 'f2'])
  assert.throws(() => addFrame(a, 0, 'f1'), /already exists/)
  assert.throws(() => deleteFrame(strip(1), 0), /only frame/)
  assert.equal(JSON.stringify(a), frozen)
})

test('ping-pong does not repeat its end frames', () => {
  const a = setLoop(strip(4), 'pingpong')
  assert.deepEqual(passOrder(a), [0, 1, 2, 3, 2, 1])
  assert.deepEqual(passOrder(setLoop(strip(2), 'pingpong')), [0, 1])
})

test('frameAt honours holds and loop modes', () => {
  const a = setHold(strip(3, 10), 1, 3) // ticks: 0 | 1 1 1 | 2  = 5 ticks = 500 ms
  assert.equal(passMs(a), 500)
  const at = (ms: number) => frameAt(a, ms)
  assert.deepEqual([0, 99, 100, 399, 400, 499, 500, 650].map(at), [0, 0, 1, 1, 2, 2, 0, 1])
  const once = setLoop(a, 'once')
  assert.equal(frameAt(once, 10_000), 2)
  assert.equal(frameAt(a, -50), 0)
})

test('a slow display drops frames but keeps the animation\'s clock', () => {
  const a = strip(12, 12) // 1 s per pass
  const s = deviceSchedule(a, 4)
  assert.equal(s.length, 4)
  assert.deepEqual(s.map((x) => x.frame), [0, 3, 6, 9])
  const total = s.reduce((t, x) => t + x.ms, 0)
  assert.ok(Math.abs(total - 1000) < 1e-6, `pass lasts ${total} ms`)
})

test('a display faster than the animation shows every frame for its hold, merging nothing', () => {
  const a = setHold(strip(3, 4), 0, 2)
  assert.deepEqual(deviceSchedule(a, 10), [
    { frame: 0, ms: 500 },
    { frame: 1, ms: 250 },
    { frame: 2, ms: 250 },
  ])
})

test('held frames cost one refresh: consecutive samples of one frame merge', () => {
  const a = setHold(strip(2, 8), 0, 8) // frame 0 for 1 s, frame 1 for 125 ms
  const s = deviceSchedule(a, 4)
  assert.equal(s[0].frame, 0)
  assert.ok(Math.abs(s[0].ms - 1000) < 1e-6)
  assert.equal(s.length, 2)
})

test('the reducer: structure from anim, ops by id, unknown ids ignored', () => {
  let a: Anim | null = applyAnim(null, toDoc(strip(2), 1))
  assert.deepEqual(a!.frames.map((f) => f.id), ['f0', 'f1'])
  a = applyAnim(a, { t: 'anim_frame', anim: 'a', op: 'add', frame: { id: 'x', hold: 2 }, after: 'f0' })
  a = applyAnim(a, { t: 'anim_frame', anim: 'a', op: 'add', frame: { id: 'y', hold: 1 }, after: 'nope' })
  a = applyAnim(a, { t: 'anim_frame', anim: 'a', op: 'delete', frame: 'nope' })
  a = applyAnim(a, { t: 'anim_frame', anim: 'other', op: 'delete', frame: 'f0' })
  assert.deepEqual(a!.frames.map((f) => [f.id, f.hold]), [['f0', 1], ['x', 2], ['f1', 1]])
  a = applyAnim(a, { t: 'anim_frame', anim: 'a', op: 'strokes', frame: 'x', strokes: [{ id: 'k', pts: [[0, 0, 1]] }] })
  a = applyAnim(a, { t: 'anim_frame', anim: 'a', op: 'move', frame: 'x', to: 99 })
  a = applyAnim(a, { t: 'anim_set', anim: 'a', fps: 12, loop: 'pingpong' })
  assert.deepEqual(a!.frames.map((f) => f.id), ['f0', 'f1', 'x'])
  assert.equal(a!.fps, 12)
  // a fresh `anim` keeps the strokes of frames it still lists
  const again = applyAnim(a, toDoc(a!, 2))
  assert.equal(again!.frames[2].strokes[0].id, 'k')
  assert.equal(applyAnim(a, { t: 'anim_play', anim: 'a', state: 'play', at: 0 }), a)
})
