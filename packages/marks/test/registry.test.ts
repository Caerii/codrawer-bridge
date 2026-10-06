/**
 * The registry: lineage, ownership and sharing, conflicts between collaborators, drift, the
 * confidence a mark earns, and that it all survives a JSON round trip.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { archivist, sketcher } from 'hand'
import { withDefaults } from '../src/actions'
import { conflicts, drift, Registry, stats } from '../src/registry'
import { GLYPHS, instance } from './glyphs'

const T = 1_790_000_000_000
const ex = (g: keyof typeof GLYPHS, seed: number, p = sketcher) => ({ strokes: instance(GLYPHS[g], p, seed).map((s) => s.pts), source: 'phone' as const })

test('every change is in the lineage, with the meaning before and after', () => {
  const r = new Registry()
  const m = r.create({ owner: 'alif', meaning: withDefaults('tag', { tag: 'idea' }), examples: [ex('bolt', 1)], now: T })
  r.refine(m.id, withDefaults('flashcard'), 'alif', T + 1)
  r.rename(m.id, 'spark', 'alif', T + 2)
  r.addExample(m.id, ex('bolt', 2), 'alif', T + 3)
  r.retract(m.id, 'alif', T + 4, 'too eager')
  r.restore(m.id, 'alif', T + 5)
  assert.deepEqual(m.lineage.map((e) => e.op), ['create', 'refine', 'rename', 'add_example', 'retract', 'restore'])
  assert.equal(m.lineage[1].from?.action, 'tag')
  assert.equal(m.lineage[1].to?.action, 'flashcard')
  assert.equal(m.name, 'spark')
  assert.equal(m.examples.length, 2)
  assert.ok(m.changedAt > m.createdAt)
  assert.ok(m.examples.every((e) => e.strokes.every((s) => s.length <= 48)), 'stored small')
})

test('a collaborator may adopt a shared mark, never change it; the copies then evolve apart', () => {
  const r = new Registry()
  const m = r.create({ owner: 'alif', meaning: withDefaults('tag', { tag: 'idea' }), examples: [ex('star', 1)], now: T })
  assert.throws(() => r.refine(m.id, withDefaults('flashcard'), 'kim', T + 1), /adopt/)
  assert.throws(() => r.adopt(m.id, 'kim', T + 1), /not shared/)
  assert.deepEqual(r.visibleTo('kim'), [])
  r.share(m.id, 'alif', T + 2)
  assert.deepEqual(r.visibleTo('kim').map((x) => x.id), [m.id])
  assert.equal(r.active('kim').length, 0, 'visible is not active: alif\'s mark does not read kim\'s ink')
  const k = r.adopt(m.id, 'kim', T + 3)
  assert.equal(k.owner, 'kim')
  assert.deepEqual(k.adoptedFrom, { owner: 'alif', mark: m.id })
  assert.equal(k.lineage[0].op, 'adopt')
  r.refine(k.id, withDefaults('ask_agent'), 'kim', T + 4)
  assert.equal(m.meaning.action, 'tag', 'the original keeps its meaning')
  // same glyph, different meanings now: a visible conflict between collaborators
  const cs = conflicts(r.marks)
  assert.equal(cs.length, 1)
  assert.deepEqual(cs[0].owners, ['alif', 'kim'])
  assert.equal(cs[0].within, false)
  assert.match(cs[0].meanings.join(' / '), /tag #idea \/ ask the agent/)
})

test('alike marks that mean the same are not a conflict; unlike marks never are', () => {
  const r = new Registry()
  r.create({ owner: 'alif', meaning: withDefaults('tag', { tag: 'idea' }), examples: [ex('flag', 1)], now: T })
  r.create({ owner: 'kim', meaning: withDefaults('tag', { tag: 'idea' }), examples: [ex('flag', 2, archivist)], now: T })
  r.create({ owner: 'kim', meaning: withDefaults('latex'), examples: [ex('infinity', 3, archivist)], now: T })
  assert.deepEqual(conflicts(r.marks), [])
})

test('confidence is earned from verdicts; drift is seen when uses move away from the examples', () => {
  const r = new Registry()
  const m = r.create({ owner: 'alif', meaning: withDefaults('tag'), examples: [ex('bolt', 1)], now: T })
  assert.equal(stats(m).confidence, 0.5)
  const fire = (i: number, distance: number, verdict: 'accept' | 'reject') => {
    const inv = r.invoke(m.id, { at: T + i, meaning: m.meaning, mode: 'confirm', confidence: 0.8, distance, strokes: [`s${i}`], ink: ex('bolt', 10 + i).strokes })
    r.feedback(inv.id, verdict, T + i + 1, 'phone')
  }
  for (let i = 0; i < 8; i++) fire(i, 0.03, 'accept')
  fire(8, 0.03, 'reject')
  const s = stats(m)
  assert.equal(s.accepts, 8)
  assert.equal(s.rejects, 1)
  assert.ok(Math.abs(s.confidence - 9 / 11) < 1e-9)
  assert.equal(m.negatives?.length, 1, 'the rejected occurrence is kept as a negative')
  assert.equal(drift(m), null, 'too little history to say')
  for (let i = 9; i < 15; i++) fire(i, 0.07, 'accept')
  const d = drift(m)!
  assert.ok(d.drifting, `ratio ${d.ratio}`)
  assert.ok(d.suggest, 'with a recent occurrence to add as an example')
})

test('the registry survives JSON, and its models are cached until a mark changes', () => {
  const r = new Registry()
  const m = r.create({ owner: 'alif', meaning: withDefaults('delegate', { pod: 'research' }), examples: [ex('asterisk', 1), ex('asterisk', 2)], now: T })
  const back = Registry.fromJSON(JSON.parse(JSON.stringify(r)))
  assert.equal(JSON.stringify(back), JSON.stringify(r))
  const a = back.models('alif')[0]
  assert.equal(back.models('alif')[0], a, 'cached')
  back.addExample(m.id, ex('asterisk', 3), 'alif', T + 10)
  assert.notEqual(back.models('alif')[0], a, 'recompiled after a change')
  assert.equal(Registry.fromJSON({ v: 99 }).marks.length, 0, 'an unknown version loads empty, never half')
})
