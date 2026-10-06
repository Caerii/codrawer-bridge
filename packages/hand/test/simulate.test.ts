// The simulator as a whole: deterministic per seed, finite and bounded, monotonic in time,
// stable across the arm's parameter ranges, and responsive to confidence.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { definePersona, mathematician, mirror, PERSONAS, sketcher, elder } from '../src/persona'
import { simulate } from '../src/simulate'
import { bounded, userStats } from '../src/stats'

const TEXTS = ['what if ink could travel?', 'x² + y² = r², so r = 5', 'Quietly — then all at once.\nA second line, wrapped if it must be.', 'αβ ≈ π/2 → ∞ ±1 ÷ 3 × 4', 'i j ! ? . , ; :']

test('same persona, text and seed: identical strokes; another seed: different ones', () => {
  for (const p of PERSONAS) {
    const a = simulate(TEXTS[0], p, { seed: 42 })
    const b = simulate(TEXTS[0], p, { seed: 42 })
    assert.deepEqual(a, b, `${p.id} is deterministic`)
    const c = simulate(TEXTS[0], p, { seed: 43 })
    assert.notDeepEqual(a.strokes, c.strokes, `${p.id} varies with the seed`)
  }
})

test('every persona: no NaNs, coordinates inside the text box, pressure in 0..1', () => {
  for (const p of PERSONAS)
    for (const text of TEXTS)
      for (const confidence of [0, 1]) {
        const r = simulate(text, p, { seed: 1, width: 120, confidence })
        assert.ok(r.strokes.length > 0, `${p.id} wrote something`)
        // a 120 mm column, a few lines tall, with generous room for arcs and overshoot
        assert.ok(bounded(r.strokes, [-25, -40, 175, 140]), `${p.id} bounded on ${JSON.stringify(text)} at confidence ${confidence}`)
      }
})

test('timing is monotonic: points within strokes, strokes and flights in order', () => {
  for (const p of PERSONAS) {
    const r = simulate(TEXTS[2], p, { seed: 9, width: 100, confidence: 0.3 })
    let last = -Infinity
    for (const s of r.strokes) {
      assert.ok(s.down >= last, `${p.id}: a stroke begins after the previous lift`)
      for (let i = 1; i < s.pts.length; i++) assert.ok(s.pts[i][3] > s.pts[i - 1][3], `${p.id}: point times strictly increase`)
      assert.equal(s.pts[0][3], s.down)
      assert.equal(s.pts[s.pts.length - 1][3], s.up)
      last = s.up
    }
    for (const f of r.flights) assert.ok(f.land > f.lift, `${p.id}: a pen-up takes time`)
    assert.equal(r.duration, r.strokes[r.strokes.length - 1].up)
  }
})

test('the arm stays stable across its parameter ranges', () => {
  for (const stiffness of [0.3, 1, 3])
    for (const damping of [0.1, 0.5, 1, 2])
      for (const activation of [0.005, 0.02, 0.05]) {
        const p = definePersona({ ...sketcher, arm: { ...sketcher.arm, stiffness, damping, activation }, tremor: { ...sketcher.tremor, amplitude: 0.3 } })
        const r = simulate('loop the loop', p, { seed: 2 })
        const tag = `stiffness ${stiffness}, damping ${damping}, activation ${activation}`
        assert.ok(bounded(r.strokes, [-30, -40, 120, 40]), `bounded at ${tag}`)
      }
})

test('doubt slows the hand down and adds hesitation', () => {
  for (const p of [sketcher, elder]) {
    const sure = simulate('perhaps the answer is seven', p, { seed: 4, confidence: 1 })
    const unsure = simulate('perhaps the answer is seven', definePersona({ ...p, timing: { ...p.timing, correction: 0 } }), { seed: 4, confidence: 0.1 })
    assert.ok(unsure.duration > 1.3 * sure.duration, `${p.id}: ${unsure.duration} vs ${sure.duration} ms`)
    const gap = (r: typeof sure) => Math.max(...r.flights.map((f) => f.land - f.lift))
    assert.ok(gap(unsure) > gap(sure), `${p.id}: longer pauses`)
  }
})

test('a doubtful word can be struck through and rewritten (persona-gated)', () => {
  const p = definePersona({ ...sketcher, timing: { ...sketcher.timing, correction: 1 } })
  const r = simulate('certainly travel', p, { seed: 6, confidence: 0 })
  assert.ok(r.strokes.some((s) => s.kind === 'strike'), 'a strike-through')
  assert.ok(r.words.some((w) => w.struck) && r.words.length > 2, 'the slip and the rewrite')
  const never = simulate('certainly travel', definePersona({ ...sketcher, timing: { ...sketcher.timing, correction: 0 } }), { seed: 6, confidence: 0 })
  assert.ok(!never.strokes.some((s) => s.kind === 'strike'))
  const sure = simulate('certainly travel', p, { seed: 6, confidence: 1 })
  assert.ok(!sure.strokes.some((s) => s.kind === 'strike'), 'certainty never corrects')
})

test('the Mathematician pauses before "=" and after the result', () => {
  const r = simulate('a + b = c then', mathematician, { seed: 3 })
  const firstOf = (w: number) => r.strokes.findIndex((s) => s.word === w)
  const pauseBefore = (w: number) => {
    const i = firstOf(w)
    return r.strokes[i].down - r.strokes[i - 1].up
  }
  // words: a + b = c then → "=" is word 3, the result "c" word 4, "then" word 5
  assert.ok(pauseBefore(3) > pauseBefore(2) + 300, `before "=": ${pauseBefore(3)} vs ${pauseBefore(2)} ms`)
  assert.ok(pauseBefore(5) > pauseBefore(2) + 250, `after the result: ${pauseBefore(5)} ms`)
})

test('raw paths are drawn in order, one stroke each', () => {
  const r = simulate({ paths: [[[0, 0], [10, 0], [10, 10]], [[20, 0], [25, 5]]] }, sketcher, { seed: 1 })
  assert.equal(r.strokes.length, 2)
  const end = r.strokes[0].pts[r.strokes[0].pts.length - 1]
  assert.ok(Math.hypot(end[0] - 10, end[1] - 10) < 1.5, 'the hand reaches the end of the path')
})

test('the Mirror adapts tempo and size to the user', () => {
  // a user writing big and slow: 12 mm strokes at ~15 mm/s, as protocol points
  const strokes = [0, 1, 2].map((k) => Array.from({ length: 40 }, (_, i) => [0.2 + k * 0.1 + i * 0.0005, 0.3 + (12 / 239.5) * Math.sin((i / 39) * Math.PI), 0.5, 1e12 + k * 5000 + i * 40]))
  const st = userStats(strokes)
  assert.ok(st.height! > 10 && st.height! < 14, `height ${st.height}`)
  const m = mirror(st)
  assert.ok(m.motor.tempo < sketcher.motor.tempo && m.letters.capHeight > sketcher.letters.capHeight)
})
