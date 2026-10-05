// Pacing of the glasses' text container (src/glasses/text.ts) with a fake clock and link.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { INK_LULL_MS, TextPusher } from '../src/glasses/text'

function rig() {
  let now = 10_000
  const sent: string[] = []
  const p = new TextPusher(async (c) => void sent.push(c), () => now)
  return { p, sent, at: (t: number) => (now = t), idle: { typingAt: -1e9, inkActive: false, lastInkAt: -1e9 } }
}
const flush = () => new Promise((r) => setTimeout(r, 0))

test('the first line always goes; unchanged content never goes twice', async () => {
  const { p, sent, idle } = rig()
  assert.equal(p.push('a', { ...idle, inkActive: true }), true)
  assert.equal(p.push('a', idle), true)
  await flush()
  assert.deepEqual(sent, ['a'])
})

test('while idle, at most one update every 2 s', async () => {
  const { p, sent, at, idle } = rig()
  p.push('a', idle)
  at(11_999)
  assert.equal(p.push('b', idle), false)
  at(12_000)
  assert.equal(p.push('b', idle), true)
  await flush()
  assert.deepEqual(sent, ['a', 'b'])
})

test('ink holds text back, including the lull after the last stroke message', () => {
  const { p, at, idle } = rig()
  p.push('a', idle)
  at(20_000)
  assert.equal(p.push('b', { ...idle, inkActive: true }), false)
  assert.equal(p.push('b', { ...idle, lastInkAt: 20_000 - INK_LULL_MS + 1 }), false)
  assert.equal(p.push('b', { ...idle, lastInkAt: 20_000 - INK_LULL_MS }), true)
})

test('typing follows the keys at a 150 ms floor, even while ink flows', () => {
  const { p, at, idle } = rig()
  p.push('a', idle)
  at(10_149)
  const typing = { typingAt: 10_100, inkActive: true, lastInkAt: 10_100 }
  assert.equal(p.push('b', typing), false)
  at(10_150)
  assert.equal(p.push('b', typing), true)
})

test('forget: the next content goes out unconditionally', () => {
  const { p, idle } = rig()
  p.push('a', idle)
  assert.equal(p.push('b', { ...idle, inkActive: true }), false)
  p.forget()
  assert.equal(p.push('b', { ...idle, inkActive: true }), true)
})
