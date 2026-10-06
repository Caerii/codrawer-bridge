/**
 * The mark classifier against two cards, with marks written by three of packages/hand's personas
 * over several seeds. A mark must mean the same thing whoever's hand drew it, and a mark that is
 * not on a card must mean nothing.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { layoutCard, type CardContent } from '../src/card'
import { gestures, interpret, shapeOf, type CardOnPage } from '../src/marks'
import { rect, type Pt } from '../src/geometry'
import { HANDS, pen, written, circlePath, tickPath, strikePath, arrowPaths } from './fixtures'

const research: CardContent = {
  pod: 'research', requester: 'Alif', title: 'Which e-ink controller for the G3 prototype?', status: 'needs_you',
  body: ['Three candidates fit the 10.3 in panel.'],
  choices: [{ id: 'a', label: 'IT8951' }, { id: 'b', label: 'T1000 (EPDC)' }, { id: 'c', label: 'Ask a vendor' }],
  write: true,
}
const drafting: CardContent = {
  pod: 'drafts', requester: 'Alif', title: 'Email to the panel vendor', status: 'needs_you',
  consent: { verb: 'Send', code: 'K7Q-3XM', hash: '0'.repeat(64) },
}

const A = layoutCard(research, [92, 20])
const B = layoutCard(drafting, [92, A.rect.y1 + 30])
const cards: CardOnPage[] = [{ task: 't1', layout: A }, { task: 't2', layout: B }]

const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8]
const T0 = 1_790_000_000_000

function read(paths: Pt[][], hand = HANDS[0], seed = 1) {
  const g = gestures(pen(paths, hand, seed, T0))
  assert.equal(g.length, 1, 'one gesture')
  return interpret(g[0], cards)
}

for (const hand of HANDS) {
  test(`${hand.id}: circling a label chooses it`, () => {
    for (const seed of SEEDS) {
      const m = read([circlePath(A.choices[1].label)], hand, seed)
      assert.equal(m.kind, 'choose', JSON.stringify(m))
      if (m.kind === 'choose') { assert.equal(m.option, 'b'); assert.equal(m.via, 'circle'); assert.equal(m.task, 't1') }
    }
  })

  test(`${hand.id}: a tick in a box chooses it`, () => {
    for (const seed of SEEDS) {
      const bx = A.choices[0].box
      const m = read([tickPath([bx.x0 + 2, bx.y1 - 1])], hand, seed)
      assert.equal(m.kind, 'choose', JSON.stringify(m))
      if (m.kind === 'choose') { assert.equal(m.option, 'a'); assert.equal(m.via, 'tick') }
    }
  })

  test(`${hand.id}: a strike through a label rejects that option`, () => {
    for (const seed of SEEDS) {
      const m = read([strikePath(A.choices[2].label)], hand, seed)
      assert.equal(m.kind, 'reject_option', JSON.stringify(m))
      if (m.kind === 'reject_option') assert.equal(m.option, 'c')
    }
  })

  test(`${hand.id}: a strike through the title cancels the task`, () => {
    for (const seed of SEEDS) {
      const t = A.title
      const m = read([[[t.x0 + 4, (t.y0 + t.y1) / 2 + 1], [t.x1 - 6, (t.y0 + t.y1) / 2 - 1]]], hand, seed)
      assert.equal(m.kind, 'cancel', JSON.stringify(m))
    }
  })

  test(`${hand.id}: an arrow from one card to another chains them`, () => {
    for (const seed of SEEDS) {
      const from: Pt = [A.rect.x0 + 30, A.rect.y1 - 2]
      const to: Pt = [B.rect.x0 + 32, B.rect.y0 + 2]
      const m = read(arrowPaths(from, to), hand, seed)
      assert.equal(m.kind, 'chain', JSON.stringify(m))
      if (m.kind === 'chain') { assert.equal(m.from, 't1'); assert.equal(m.to, 't2') }
    }
  })

  test(`${hand.id}: an ✗ over a card cancels it`, () => {
    for (const seed of SEEDS) {
      const r = B.rect
      const m = read([[[r.x0 + 15, r.y0 + 3], [r.x1 - 15, r.y1 - 3]], [[r.x1 - 15, r.y0 + 3], [r.x0 + 15, r.y1 - 3]]], hand, seed)
      assert.equal(m.kind, 'cancel', JSON.stringify(m))
      if (m.kind === 'cancel') assert.equal(m.task, 't2')
    }
  })

  test(`${hand.id}: initials in the consent box are a consent candidate`, () => {
    for (const seed of SEEDS) {
      const bx = B.consent!.box
      const g = gestures(written('AJ', [bx.x0 + 4, bx.y1 - 3], hand, seed, T0, 1))
      assert.equal(g.length, 1)
      const m = interpret(g[0], cards)
      assert.equal(m.kind, 'initials', JSON.stringify(m))
    }
  })

  test(`${hand.id}: writing in the box is a correction`, () => {
    for (const seed of SEEDS) {
      const w = A.write!
      const g = gestures(written('only 10 in', [w.x0 + 3, w.y1 - 4], hand, seed, T0, 0.8))
      const m = interpret(g[0], cards)
      assert.equal(m.kind, 'write', JSON.stringify(m))
    }
  })
}

test('a loop around two options is ambiguous, not a guess', () => {
  const r = rect(A.choices[0].label.x0, A.choices[0].label.y0, A.choices[1].label.x1, A.choices[1].label.y1)
  for (const seed of SEEDS) {
    const m = read([circlePath(r, 2.5)], HANDS[2], seed)
    assert.equal(m.kind, 'ambiguous', JSON.stringify(m))
  }
})

test('a circle on the user\'s own page, away from every card, means nothing', () => {
  const m = read([circlePath(rect(20, 150, 50, 160))])
  assert.equal(m.kind, 'none', JSON.stringify(m))
})

test('writing elsewhere on the page means nothing', () => {
  const g = gestures(written('send the money to Bob', [10, 200], HANDS[0], 1, T0))
  for (const x of g) assert.equal(interpret(x, cards).kind, 'none')
})

test('shapes: a circle is a loop, a tick a tick, a strike a line', () => {
  const [c] = gestures(pen([circlePath(rect(10, 10, 30, 16))], HANDS[1], 2, T0))
  assert.equal(shapeOf(c).kind, 'loop')
  const [t] = gestures(pen([tickPath([40, 40])], HANDS[1], 2, T0))
  assert.equal(shapeOf(t).kind, 'tick')
  const [s] = gestures(pen([strikePath(rect(10, 60, 40, 64))], HANDS[1], 2, T0))
  assert.equal(shapeOf(s).kind, 'line')
})
