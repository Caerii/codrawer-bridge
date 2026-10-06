/**
 * The teach flow, end to end through the engine: a new glyph beside a line becomes a candidate;
 * the ask waits for a lull and is batched; the answer defines the mark; later uses fire with a
 * quiet confirmation, then a notify, then silently once earned; a decline is never asked again;
 * built-in marks keep their meaning; consequential actions always ask; retract stops a mark.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bounds, layoutCard, type Pt } from 'delegate'
import { elder, sketcher } from 'hand'
import { withDefaults, effectOf } from '../src/actions'
import { MarkEngine } from '../src/engine'
import type { MarkAsk, MarkInvoke } from '../src/protocol'
import { askCard, ASK_GAP_MS, CONFIRM_FIRST, LULL_MS, SILENT_AFTER } from '../src/teach'
import { BUILTIN_SHAPES, GLYPHS, instance, writing, type TestStroke } from './glyphs'

const T0 = 1_790_000_000_000
const OWNER = 'alif'

/** A page with five lines of the owner's writing, and an engine that has read it. */
function setup(persona = sketcher) {
  const sent: Record<string, any>[] = []
  const eng = new MarkEngine({ owner: OWNER, send: (m) => sent.push(m as Record<string, any>) })
  const lines = ['notes for the panel order', 'ask about the refresh rate', 'two boards by November', 'check the proof of lemma 3', 'call Sam about the budget']
    .map((t, i) => writing(t, persona, 300 + i, [22, 40 + i * 16], T0 + i * 20_000, 0.9))
  for (const l of lines) for (const s of l) eng.stroke(s)
  let now = T0 + 120_000
  eng.tick(now)
  const ends = lines.map((l) => bounds(l.flatMap((s) => s.pts)))
  /** Draw `glyph` beside line `i`'s end at time `at`, then let it settle. */
  const draw = (glyph: Pt[][], i: number, seed: number, p = persona) => {
    now += 30_000
    const ss = instance(glyph, p, seed, [ends[i % 5].x1 + 7, ends[i % 5].y0 - 1], now)
    for (const s of ss) eng.stroke(s)
    now = Math.max(...ss.map((s) => s.t1)) + 1000
    return { strokes: ss, out: eng.tick(now) }
  }
  const later = (ms: number) => { now += ms; return eng.tick(now) }
  const at = () => now
  return { eng, sent, draw, later, at, ends, lines }
}

const of = <T extends string>(sent: Record<string, any>[], t: T) => sent.filter((m) => m.t === t)

test('a new glyph beside a line is a candidate; the ask waits for a lull and is batched', () => {
  const { sent, draw, later } = setup()
  const a = draw(GLYPHS.bolt, 0, 1)
  assert.equal(a.out[0]?.kind, 'candidate', JSON.stringify(a.out))
  assert.equal(of(sent, 'mark_ask').length, 0, 'not while the pen is still near')
  const b = draw(GLYPHS.spiral, 1, 2)
  assert.equal(b.out[0]?.kind, 'candidate', JSON.stringify(b.out))
  later(LULL_MS + 10)
  const asks = of(sent, 'mark_ask') as unknown as MarkAsk[]
  assert.equal(asks.length, 1, 'one ask for both: ' + JSON.stringify(asks.map((a) => a.items.map((i) => i.reason))))
  assert.equal(asks[0].items.length, 2, JSON.stringify(asks[0].items.map((i) => i.reason)))
  assert.ok(asks[0].options.includes('flashcard') && asks[0].options.includes('delegate'))
  assert.ok(asks[0].items.every((i) => i.ink_mm.length > 0 && i.bbox.every((v) => v >= 0 && v <= 1)))
  // a third glyph right after: no second ask until the gap has passed
  const c = draw(GLYPHS.star, 2, 3)
  assert.equal(c.out[0]?.kind, 'candidate', JSON.stringify(c.out))
  later(LULL_MS + 10)
  assert.equal(of(sent, 'mark_ask').length, 1)
  later(ASK_GAP_MS)
  assert.equal(of(sent, 'mark_ask').length, 2)
})

test('ordinary writing is never asked about, and a built-in shape is drawing, not a candidate', () => {
  const { sent, eng, draw, later, at } = setup(elder)
  const w = writing('see you at noon', elder, 77, [22, 130], at() + 1000, 0.9)
  for (const s of w) eng.stroke(s)
  later(5000)
  const c = draw(BUILTIN_SHAPES.circle, 0, 4)
  const mine = c.out.find((o) => o.gesture.includes(c.strokes[0].id))
  assert.equal(mine?.kind, 'drawing', JSON.stringify(c.out))
  later(LULL_MS + 10)
  assert.equal(of(sent, 'mark_ask').length, 0)
})

test('the answer defines the mark; it then fires, confirmed at first, then with notice, then silently', () => {
  const { eng, sent, draw, later, at } = setup()
  draw(GLYPHS.bolt, 0, 3)
  later(LULL_MS + 10)
  const ask = of(sent, 'mark_ask')[0] as unknown as MarkAsk
  const err = eng.handle({ t: 'mark_define', op: 'create', by: OWNER, ask: ask.ask, occurrence: ask.items[0].occurrence, meaning: withDefaults('flashcard'), ts: at() }, at())
  assert.equal(err, null)
  const mark = eng.registry.active(OWNER)[0]
  assert.ok(mark, 'defined')
  assert.equal(mark.lineage[0].op, 'create')

  const modes: string[] = []
  for (let i = 0; i < CONFIRM_FIRST + SILENT_AFTER + 1; i++) {
    const before = sent.length
    draw(GLYPHS.bolt, i, 100 + i)
    const inv = sent.slice(before).find((m) => m.t === 'mark_invoke') as unknown as MarkInvoke
    assert.ok(inv, `use ${i + 1} fired`)
    modes.push(inv.mode)
    const effects = sent.slice(before).filter((m) => m.t === 'primer_request')
    if (inv.mode === 'confirm') {
      assert.equal(effects.length, 0, 'a confirm waits for the accept')
      eng.handle({ t: 'mark_feedback', invocation: inv.invocation, verdict: 'accept', by: OWNER, via: 'phone', ts: at() }, at())
      assert.equal(sent.filter((m) => m.t === 'primer_request').length, of(sent, 'primer_request').length)
      assert.equal(sent.slice(before).filter((m) => m.t === 'primer_request').length, 1, 'and runs on accept')
    } else {
      assert.equal(effects.length, 1, `${inv.mode} runs at once`)
      assert.ok(inv.target.strokes.length > 0, 'it acts on the line beside it')
      if (inv.mode === 'notify') eng.handle({ t: 'mark_feedback', invocation: inv.invocation, verdict: 'accept', by: OWNER, via: 'phone', ts: at() }, at())
    }
  }
  assert.deepEqual(modes.slice(0, CONFIRM_FIRST), Array(CONFIRM_FIRST).fill('confirm'))
  assert.equal(modes[CONFIRM_FIRST], 'notify')
  assert.equal(modes[modes.length - 1], 'silent', modes.join(' '))
})

test('"not a mark" is remembered: the same shape is never asked about again', () => {
  const { eng, sent, draw, later, at } = setup()
  draw(GLYPHS.star, 0, 1)
  later(LULL_MS + 10)
  const ask = of(sent, 'mark_ask')[0] as unknown as MarkAsk
  eng.handle({ t: 'mark_define', op: 'decline', by: OWNER, ask: ask.ask, occurrence: ask.items[0].occurrence, ts: at() }, at())
  const again = draw(GLYPHS.star, 2, 9)
  assert.notEqual(again.out[0]?.kind === 'candidate' && again.out[0].detail === 'isolated', true)
  later(ASK_GAP_MS + LULL_MS)
  assert.equal(of(sent, 'mark_ask').length, 1)
})

test('an unanswered ask lapses, and is not repeated; a lasso brings the shape back', () => {
  const { eng, sent, draw, later, at } = setup()
  const d = draw(GLYPHS.flag, 0, 1)
  later(LULL_MS + 10)
  later(16 * 60_000) // past ASK_TTL
  assert.equal(eng.flow.candidates[0].status, 'dismissed')
  draw(GLYPHS.flag, 1, 2)
  later(ASK_GAP_MS + LULL_MS)
  assert.equal(of(sent, 'mark_ask').length, 1)
  assert.equal(eng.handle({ t: 'dock_action', id: 'mark_teach', strokes: d.strokes.map((s) => s.id) }, at()), null)
  later(LULL_MS + 10)
  assert.equal(of(sent, 'mark_ask').length, 2, 'the user asked')
  assert.equal((of(sent, 'mark_ask')[1] as unknown as MarkAsk).items[0].reason, 'lasso')
})

test('a built-in shape cannot be taught, and a look-alike of an existing mark is refused', () => {
  const { eng, at } = setup()
  const circle = BUILTIN_SHAPES.circle
  const e1 = eng.handle({ t: 'mark_define', op: 'create', by: OWNER, meaning: withDefaults('tag'), examples: [circle], ts: at() }, at())
  assert.match(e1 ?? '', /circle/)
  const tick = eng.handle({ t: 'mark_define', op: 'create', by: OWNER, meaning: withDefaults('tag'), examples: [BUILTIN_SHAPES.tick], ts: at() }, at())
  assert.match(tick ?? '', /tick/)
  const bolt = instance(GLYPHS.bolt, sketcher, 3).map((s) => s.pts)
  assert.equal(eng.handle({ t: 'mark_define', op: 'create', by: OWNER, meaning: withDefaults('tag'), examples: [bolt], ts: at() }, at()), null)
  const bolt2 = instance(GLYPHS.bolt, sketcher, 4).map((s) => s.pts)
  const e2 = eng.handle({ t: 'mark_define', op: 'create', by: OWNER, meaning: withDefaults('flashcard'), examples: [bolt2], ts: at() }, at())
  assert.match(e2 ?? '', /looks like your mark/)
})

test("built-ins first: a personal mark drawn on a card is the card's, never a personal mark", () => {
  const { eng, sent, at, later } = setup()
  const star = instance(GLYPHS.star, sketcher, 3).map((s) => s.pts)
  eng.handle({ t: 'mark_define', op: 'create', by: OWNER, meaning: withDefaults('tag'), examples: [star], ts: at() }, at())
  const card = layoutCard({ pod: 'research', requester: 'Alif', title: 'Which controller?', status: 'needs_you', choices: [{ id: 'a', label: 'IT8951' }, { id: 'b', label: 'T1000' }] }, [92, 150])
  eng.setCards([{ task: 't1', layout: card }])
  // a star (a cornered loop to the grammar) on the card: a built-in reading or nothing, never the tag
  const r = card.rect
  for (const [dx, dy] of [[0.5, 0.5], [0.3, 0.8], [0.7, 0.25]]) {
    const ss = instance(GLYPHS.star, sketcher, 5, [r.x0 + (r.x1 - r.x0) * dx - 5, r.y0 + (r.y1 - r.y0) * dy - 5], at() + 1000)
    for (const s of ss) eng.stroke(s)
    const out = later(5000)
    assert.ok(out[0]?.kind === 'builtin' || out[0]?.kind === 'drawing', JSON.stringify(out))
  }
  assert.equal(of(sent, 'mark_invoke').length, 0)
  // and the same star off the card is the tag
  const ss = instance(GLYPHS.star, sketcher, 6, [20, 200], at() + 1000)
  for (const s of ss) eng.stroke(s)
  later(5000)
  assert.equal(of(sent, 'mark_invoke').length, 1)
})

test('an ask drawn as a card is answered by circling an option, read by the built-in grammar', () => {
  const { eng, sent, draw, later, at } = setup()
  draw(GLYPHS.spiral, 0, 1)
  later(LULL_MS + 10)
  const ask = of(sent, 'mark_ask')[0] as unknown as MarkAsk
  const layout = layoutCard(askCard(1), [100, 150])
  eng.showAsk(ask.ask, layout)
  const option = layout.choices.find((c) => c.id === 'ask_agent')!
  const l = option.label
  const loop: Pt[] = []
  for (let a = -2.4; a <= -2.4 + 2 * Math.PI + 0.35; a += 0.18) loop.push([(l.x0 + l.x1) / 2 + ((l.x1 - l.x0) / 2 + 3) * Math.cos(a), (l.y0 + l.y1) / 2 + ((l.y1 - l.y0) / 2 + 2.4) * Math.sin(a)])
  const circle = instance([loop], sketcher, 2, [l.x0 - 3, l.y0 - 2.4], at() + 1000) as TestStroke[]
  for (const s of circle) eng.stroke(s)
  const out = later(5000)
  assert.equal(out[0]?.kind, 'answered', JSON.stringify(out))
  const mark = eng.registry.active(OWNER)[0]
  assert.equal(mark?.meaning.action, 'ask_agent')
  assert.ok(of(sent, 'mark_define').some((m) => m.op === 'create'), 'the pen answer is relayed as a mark_define')
})

test('a consequential meaning always asks, and retracting a mark stops it', () => {
  const { eng, sent, draw, at } = setup()
  const ex = [1, 2, 3].map((s) => instance(GLYPHS.flag, sketcher, s).map((x) => x.pts))
  eng.handle({ t: 'mark_define', op: 'create', by: OWNER, meaning: withDefaults('send', { to: 'Sam' }), examples: ex, ts: at() }, at())
  const id = eng.registry.active(OWNER)[0].id
  for (let i = 0; i < 6; i++) {
    const before = sent.length
    draw(GLYPHS.flag, i, 50 + i)
    const inv = sent.slice(before).find((m) => m.t === 'mark_invoke') as unknown as MarkInvoke
    assert.equal(inv?.mode, 'confirm')
    eng.handle({ t: 'mark_feedback', invocation: inv.invocation, verdict: 'accept', by: OWNER, via: 'pen', ts: at() }, at())
    const effect = sent.slice(before).find((m) => m.t === 'task_create')!
    assert.equal(effect.pod, 'drafts')
    assert.equal(effect.authority, 'act_with_consent', 'the send itself still needs initials on the card')
  }
  eng.handle({ t: 'mark_define', op: 'retract', by: OWNER, mark: id, ts: at() }, at())
  const before = sent.length
  draw(GLYPHS.flag, 3, 90)
  assert.equal(sent.slice(before).filter((m) => m.t === 'mark_invoke').length, 0)
})

test('a lapsed confirm does nothing; a rejected invocation runs nothing and becomes a negative', () => {
  const { eng, sent, draw, later, at } = setup()
  const ex = [1, 2, 3].map((s) => instance(GLYPHS.infinity, sketcher, s).map((x) => x.pts))
  eng.handle({ t: 'mark_define', op: 'create', by: OWNER, meaning: withDefaults('ask_agent'), examples: ex, ts: at() }, at())
  const mark = eng.registry.active(OWNER)[0]
  draw(GLYPHS.infinity, 1, 61)
  assert.equal(mark.invocations.length, 1)
  later(3 * 60_000)
  assert.equal(mark.invocations[0].verdict, 'expired')
  const before = sent.length
  draw(GLYPHS.infinity, 0, 60)
  const inv = sent.slice(before).find((m) => m.t === 'mark_invoke') as unknown as MarkInvoke
  assert.ok(inv)
  eng.handle({ t: 'mark_feedback', invocation: inv.invocation, verdict: 'reject', by: OWNER, via: 'phone', ts: at() }, at())
  assert.equal(sent.filter((m) => m.t === 'term_prompt').length, 0, 'neither ever asked the agent')
  assert.equal(mark.negatives?.length, 1)
  assert.equal(mark.lineage[mark.lineage.length - 1].op, 'add_negative')
})

test('every action maps onto an existing primitive', () => {
  const target = { page: 'p1', strokes: ['1:2'], region: [0.1, 0.2, 0.3, 0.25] as [number, number, number, number], since: T0 }
  const o = { owner: OWNER, mark: 'mk_1', invocation: 'iv_1' }
  assert.equal(effectOf(withDefaults('delegate'), target, o, T0)?.t, 'task_create')
  assert.equal(effectOf(withDefaults('delegate'), target, o, T0)?.trigger, 'mark')
  assert.equal(effectOf(withDefaults('send', { to: 'Sam' }), target, o, T0)?.pod, 'drafts')
  assert.equal(effectOf(withDefaults('flashcard'), target, o, T0)?.what, 'flashcard')
  assert.equal(effectOf(withDefaults('ask_agent'), target, o, T0)?.t, 'term_prompt')
  assert.equal(effectOf(withDefaults('latex'), target, o, T0)?.t, 'latex_recognize')
  assert.equal(effectOf(withDefaults('tag', { tag: 'idea' }), target, o, T0), null)
  assert.equal(effectOf(withDefaults('replay_from'), target, o, T0), null)
})
