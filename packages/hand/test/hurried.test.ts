// A hand in a hurry (persona.ts `hurried`): faster, with pen-up time cut more than writing time,
// still bounded and deterministic, capped at MAX_HURRY.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { archivist, hurried, MAX_HURRY, PERSONAS } from '../src/persona'
import { simulate } from '../src/simulate'
import { bounded } from '../src/stats'

const TEXT = 'Mitochondria convert nutrients into ATP, and carry their own DNA.'

function penDownShare(r: ReturnType<typeof simulate>): number {
  return r.strokes.reduce((a, s) => a + (s.up - s.down), 0) / r.duration
}

test('hurried writes faster, cutting pen-up time more than writing time', () => {
  const calm = simulate(TEXT, archivist, { seed: 7, width: 120 })
  const fast = simulate(TEXT, hurried(archivist, 2), { seed: 7, width: 120 })
  assert.ok(fast.duration < calm.duration / 2, `${fast.duration} vs ${calm.duration}`)
  assert.ok(penDownShare(fast) > penDownShare(calm) + 0.05, 'dwell is cut more than strokes')
  assert.equal(fast.strokes.length, calm.strokes.length, 'the same letters')
})

test('hurried stays bounded and deterministic for every persona, and caps at MAX_HURRY', () => {
  for (const p of PERSONAS) {
    const a = simulate(TEXT, hurried(p, MAX_HURRY), { seed: 3, width: 120 })
    assert.ok(bounded(a.strokes, [-25, -40, 175, 140]), `${p.id} bounded`)
    assert.deepEqual(a, simulate(TEXT, hurried(p, MAX_HURRY), { seed: 3, width: 120 }), `${p.id} deterministic`)
  }
  assert.equal(hurried(archivist, 1), archivist)
  assert.equal(hurried(archivist, 9).motor.tempo, hurried(archivist, MAX_HURRY).motor.tempo)
})
