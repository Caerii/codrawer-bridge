// Pacing of the glasses' text container (src/glasses/text.ts) with a fake clock and a fake link
// whose calls complete only when the test says so.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { INK_LULL_MS, QUIET_FLOOR_MS, TYPING_MS, TextPusher } from '../src/glasses/text'

function rig() {
  let now = 10_000
  const sent: string[] = []
  const pending: (() => void)[] = [] // resolvers of the calls on the wire
  let overlap = 0
  let fail = false
  const p = new TextPusher(
    (c) => {
      sent.push(c)
      if (pending.length) overlap++
      return new Promise<void>((resolve, reject) => pending.push(() => (fail ? reject(new Error('sendFailed')) : resolve())))
    },
    () => now,
  )
  return {
    p,
    sent,
    at: (t: number) => (now = t),
    /** Complete the call on the wire and let the pusher react. */
    finish: async () => {
      pending.shift()?.()
      await new Promise((r) => setTimeout(r, 0))
    },
    overlaps: () => overlap,
    failNext: (f: boolean) => (fail = f),
    idle: { typingAt: -1e9, inkActive: false, lastInkAt: -1e9 },
    typing: () => ({ typingAt: now, inkActive: false, lastInkAt: -1e9 }),
  }
}

test('the first line always goes; unchanged content never goes twice', async () => {
  const { p, sent, idle, finish } = rig()
  assert.equal(p.push('a', { ...idle, inkActive: true }), true)
  await finish()
  assert.equal(p.push('a', idle), true)
  assert.deepEqual(sent, ['a'])
})

test(`while idle, at most one update every ${QUIET_FLOOR_MS} ms`, async () => {
  const { p, sent, at, idle, finish } = rig()
  p.push('a', idle)
  await finish()
  at(10_000 + QUIET_FLOOR_MS - 1)
  assert.equal(p.push('b', idle), false)
  at(10_000 + QUIET_FLOOR_MS)
  assert.equal(p.push('b', idle), true)
  assert.deepEqual(sent, ['a', 'b'])
})

test('ink holds non-typing text back, including the lull after the last stroke message', async () => {
  const { p, at, idle, finish } = rig()
  p.push('a', idle)
  await finish()
  at(20_000)
  assert.equal(p.push('b', { ...idle, inkActive: true }), false)
  assert.equal(p.push('b', { ...idle, lastInkAt: 20_000 - INK_LULL_MS + 1 }), false)
  assert.equal(p.push('b', { ...idle, lastInkAt: 20_000 - INK_LULL_MS }), true)
})

test('typing has no floor and ink does not hold it back: a key goes as soon as the link is free', async () => {
  const { p, sent, at, finish } = rig()
  p.push('>', { typingAt: 10_000, inkActive: true, lastInkAt: 10_000 })
  await finish()
  at(10_001) // 1 ms later, still within the old 150 ms floor
  assert.equal(p.push('> h', { typingAt: 10_001, inkActive: true, lastInkAt: 10_001 }), true)
  assert.deepEqual(sent, ['>', '> h'])
})

test('one update in flight: keys typed meanwhile coalesce into one update with the newest text', async () => {
  const { p, sent, at, finish, typing, overlaps } = rig()
  p.push('h', typing())
  for (const [i, line] of ['he', 'hel', 'hell'].entries()) {
    at(10_010 + i * 10)
    assert.equal(p.push(line, typing()), true) // accepted, waiting for the link
  }
  assert.deepEqual(sent, ['h']) // nothing overlapped the call in flight
  await finish() // the moment it returns, only the newest waiting text goes
  assert.deepEqual(sent, ['h', 'hell'])
  await finish()
  assert.deepEqual(sent, ['h', 'hell']) // and nothing else is queued behind it
  assert.equal(overlaps(), 0)
})

test('text that returns to what is on the wire while waiting is not sent again', async () => {
  const { p, sent, finish, typing } = rig()
  p.push('ab', typing())
  p.push('abc', typing()) // waits
  p.push('ab', typing()) // Backspace: back to what the call in flight carries
  await finish()
  assert.deepEqual(sent, ['ab'])
})

test('a failed call does not wedge the queue', async () => {
  const { p, sent, finish, typing, failNext } = rig()
  const err = console.error
  console.error = () => {}
  try {
    failNext(true)
    p.push('a', typing())
    p.push('ab', typing())
    await finish()
    failNext(false)
    assert.deepEqual(sent, ['a', 'ab'])
    await finish()
    assert.equal(p.push('abc', typing()), true)
    assert.deepEqual(sent, ['a', 'ab', 'abc'])
  } finally {
    console.error = err
  }
})

test(`typing ends ${TYPING_MS} ms after the last key: the quiet rules are back`, async () => {
  const { p, at, finish } = rig()
  const pace = { typingAt: 10_000, inkActive: true, lastInkAt: 10_000 + TYPING_MS }
  p.push('a', pace)
  await finish()
  at(10_000 + TYPING_MS - 1)
  assert.equal(p.push('b', pace), true)
  await finish()
  at(10_000 + TYPING_MS)
  assert.equal(p.push('c', pace), false) // ink flowing, not typing any more
})

test('forget: the next content goes out unconditionally', async () => {
  const { p, idle, finish } = rig()
  p.push('a', idle)
  await finish()
  assert.equal(p.push('b', { ...idle, inkActive: true }), false)
  p.forget()
  assert.equal(p.push('b', { ...idle, inkActive: true }), true)
})
