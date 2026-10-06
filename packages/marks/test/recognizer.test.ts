/**
 * The recogniser: point clouds, gates, thresholds, ambiguity, negatives, and its accuracy on
 * synthetic marks from three of packages/hand's personas (the eval script runs all five).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bounds, type Pt } from 'delegate'
import { elder, mathematician, sketcher } from 'hand'
import { greedyMatch, rotationMatch, toCloud, rotate } from '../src/cloud'
import { contextOf } from '../src/context'
import { compile, recognize, TAU_ONE } from '../src/recognizer'
import { evaluate } from './evaluate'
import { GLYPHS, instance, writing } from './glyphs'

const mm = (strokes: { pts: Pt[] }[]) => strokes.map((s) => s.pts)

test('a cloud matches itself exactly, and ignores stroke order and direction ($P)', () => {
  const a = toCloud(GLYPHS.asterisk)
  assert.ok(greedyMatch(a.pts, a.pts) < 1e-9)
  const shuffled = [[...GLYPHS.asterisk[2]].reverse(), GLYPHS.asterisk[0], [...GLYPHS.asterisk[1]].reverse()]
  assert.ok(greedyMatch(toCloud(shuffled).pts, a.pts) < 0.03, 'the same asterisk drawn in another order')
})

test('rotation is searched within the tolerance, and only within it', () => {
  const bolt = toCloud(GLYPHS.bolt).pts
  const tilted = rotate(bolt, (18 * Math.PI) / 180)
  assert.ok(rotationMatch(tilted, bolt, 25).d < 0.02, '18° is inside ±25°')
  const turned = rotate(bolt, Math.PI / 2)
  assert.ok(rotationMatch(turned, bolt, 25).d > TAU_ONE, '90° is outside ±25°: a turned glyph is another glyph')
  assert.ok(rotationMatch(turned, bolt, 180).d < 0.03, 'an orientation-free mark finds it')
})

test('scale is normalised; size is a gate, not a distance', () => {
  const big = GLYPHS.star.map((s) => s.map(([x, y]) => [x * 1.3, y * 1.3] as Pt))
  assert.ok(greedyMatch(toCloud(big).pts, toCloud(GLYPHS.star).pts) < 1e-6)
  const m = compile({ id: 'star', examples: [{ strokes: GLYPHS.star }] })
  const tiny = GLYPHS.star.map((s) => s.map(([x, y]) => [x * 0.4, y * 0.4] as Pt))
  const r = recognize(tiny, [m])
  assert.equal(r.kind, 'none')
  assert.match(r.why, /mm/)
})

test('a glyph between the words of a line is not a mark (the inline gate)', () => {
  const line = writing('notes for the panel order', sketcher, 3, [20, 60], 0, 0.9)
  const words = [...new Set(line.map((s) => s.word))]
  const third = line.filter((s) => s.word === words[2])
  const box = bounds(third.flatMap((s) => s.pts))
  const others = line.filter((s) => s.word !== words[2])
  // a bolt where the third word was
  const bolt = instance(GLYPHS.bolt, sketcher, 4, [box.x0 + 1, box.y0 - 2])
  const m = compile({ id: 'bolt', examples: [{ strokes: mm(instance(GLYPHS.bolt, sketcher, 5)), relation: 'beside' }] })
  const ctx = contextOf(bounds(bolt.flatMap((s) => s.pts)), others.map((s) => ({ id: s.id, box: bounds(s.pts) })))
  assert.equal(ctx.relation, 'inline')
  assert.equal(recognize(mm(bolt), [m], ctx).kind, 'none')
})

test('a gesture that fits two marks equally is ambiguous, never a guess', () => {
  // two marks with the same example (the engine refuses to teach this; ADR 013): neither may win
  const ex = [{ strokes: mm(instance(GLYPHS.flag, elder, 1)) }]
  const a = compile({ id: 'a', examples: ex }), b = compile({ id: 'b', examples: ex })
  for (let s = 10; s < 14; s++) {
    const r = recognize(mm(instance(GLYPHS.flag, elder, s)), [a, b])
    assert.notEqual(r.kind, 'match', r.why)
  }
})

test('a rejected occurrence teaches the mark what it is not', () => {
  const ex = [1, 2, 3].map((s) => ({ strokes: mm(instance(GLYPHS.infinity, mathematician, s)) }))
  const word = mm(writing('on', mathematician, 900, [0, 0], 0, 1.3))
  const before = recognize(word, [compile({ id: 'inf', examples: ex })])
  const after = recognize(mm(writing('on', mathematician, 1900, [0, 0], 0, 1.3)), [compile({ id: 'inf', examples: ex, negatives: [{ strokes: word }] })])
  if (before.kind === 'match') assert.notEqual(after.kind, 'match', after.why)
  // and the mark itself still reads
  const again = recognize(mm(instance(GLYPHS.infinity, mathematician, 40)), [compile({ id: 'inf', examples: ex, negatives: [{ strokes: word }] })])
  assert.equal(again.kind, 'match', again.why)
})

test('accuracy on synthetic marks: three personas, 1/3/5 examples, against handwriting', () => {
  const rs = evaluate([sketcher, elder, mathematician], 6)
  const three = rs.find((r) => r.k === 3)!
  for (const r of rs) {
    assert.ok(r.recall >= (r.k === 1 ? 0.85 : 0.9), `k=${r.k}: recall ${r.recall}`)
    assert.ok(r.precision >= 0.97, `k=${r.k}: precision ${r.precision}`)
    assert.ok(r.faInline / r.negInline <= 0.02, `k=${r.k}: inline false accepts ${r.faInline}/${r.negInline}`)
    assert.ok(r.faBeside / r.negBeside <= 0.03, `k=${r.k}: beside false accepts ${r.faBeside}/${r.negBeside}`)
    assert.ok(r.faHeld / r.negHeld <= 0.12, `k=${r.k}: held-out false accepts ${r.faHeld}/${r.negHeld}`)
  }
  assert.ok(three.recall >= 0.95, `k=3 recall ${three.recall}`)
  assert.ok(three.after!.faHeld <= three.faHeld, 'rejections do not make it worse')
  assert.ok(three.after!.recall >= three.recall - 0.02, 'and do not cost recall')
})
