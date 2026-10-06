// Onion skin (src/onion.ts): the right neighbours, nearest drawn last, tinted red before and
// blue after; wrapping in loops; and an ordered dither whose density is exactly the opacity.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AFTER_COLOR, BEFORE_COLOR, addFrame, createAnim, ditherKeeps, onionGhosts, setLoop, type Anim } from '../src/index'

function strip(n: number): Anim {
  let a = createAnim('a', 't', 'f0')
  for (let i = 1; i < n; i++) a = addFrame(a, i - 1, `f${i}`)
  return a
}

test('two before and one after, furthest first, tinted and fading', () => {
  const g = onionGhosts(setLoop(strip(6), 'once'), 3, { before: 2, after: 1, look: 'tint' })
  assert.deepEqual(g.map((x) => x.frame), [1, 2, 4])
  assert.deepEqual(g.map((x) => x.color), [BEFORE_COLOR, BEFORE_COLOR, AFTER_COLOR])
  assert.ok(g[0].opacity < g[1].opacity, 'further is fainter')
  assert.equal(g[1].opacity, g[2].opacity, 'equal distance, equal opacity')
})

test('the ends: no ghosts past them unless the animation loops', () => {
  const once = setLoop(strip(4), 'once')
  assert.deepEqual(onionGhosts(once, 0, { before: 2, after: 1, look: 'mono' }).map((x) => x.frame), [1])
  const loop = setLoop(strip(4), 'loop')
  assert.deepEqual(onionGhosts(loop, 0, { before: 1, after: 1, look: 'mono' }).map((x) => x.frame).sort(), [1, 3])
})

test('a short loop never shows the current frame or a frame twice', () => {
  const g = onionGhosts(setLoop(strip(2), 'loop'), 0, { before: 3, after: 3, look: 'tint' })
  assert.deepEqual(g.map((x) => x.frame), [1])
})

test('the dither keeps round(opacity × 16) of every 4 × 4 tile, at fixed positions', () => {
  for (const op of [0, 0.1, 0.25, 0.45, 0.5, 0.8, 1]) {
    let kept = 0
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) if (ditherKeeps(x + 40, y + 8, op)) kept++
    assert.equal(kept, Math.round(op * 16), `opacity ${op}`)
  }
  // nested: every pixel kept at a lower opacity is kept at a higher one (no crawl as ghosts fade)
  for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) if (ditherKeeps(x, y, 0.3)) assert.ok(ditherKeeps(x, y, 0.6))
})
