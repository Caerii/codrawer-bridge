// In-betweening (src/inbetween.ts), easing (src/ease.ts) and motion (src/motion.ts): the
// assignment is optimal and direction-aware, a swinging limb keeps its length, unmatched strokes
// write on and retract, eases are monotone, and the bounce rests on the ground with squash
// conserving area.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  EASES,
  addFrame,
  animateStrokes,
  bbox,
  bounce,
  correspond,
  createAnim,
  fillBetween,
  hungarian,
  inbetween,
  resample,
  setStrokes,
  type AnimStroke,
  type Pt,
} from '../src/index'

const line = (x0: number, y0: number, x1: number, y1: number, n = 10): Pt[] =>
  Array.from({ length: n }, (_, k) => [x0 + ((x1 - x0) * k) / (n - 1), y0 + ((y1 - y0) * k) / (n - 1), 0.5] as Pt)
const S = (id: string, pts: Pt[]): AnimStroke => ({ id, pts })
const len = (pts: Pt[], aspect = 1) => pts.slice(1).reduce((s, p, i) => s + Math.hypot(p[0] - pts[i][0], (p[1] - pts[i][1]) * aspect), 0)

test('hungarian finds the optimum of a small matrix', () => {
  const c = [
    [4, 1, 3],
    [2, 0, 5],
    [3, 2, 2],
  ]
  const a = hungarian(c)
  const total = a.reduce((s, j, i) => s + c[i][j], 0)
  assert.equal(total, 5) // 1 + 2 + 2
  assert.deepEqual([...a].sort(), [0, 1, 2])
})

test('resample spaces points evenly and keeps the ends', () => {
  const r = resample(line(0, 0, 1, 0, 3), 5)
  assert.deepEqual(r.map((p) => +p[0].toFixed(6)), [0, 0.25, 0.5, 0.75, 1])
})

test('correspondence pairs shuffled strokes, detects reversal, and leaves outliers unmatched', () => {
  const a = [S('h', line(0.1, 0.1, 0.2, 0.1)), S('v', line(0.5, 0.5, 0.5, 0.6)), S('far', line(0.9, 0.9, 0.95, 0.95))]
  const b = [S('v2', line(0.51, 0.6, 0.51, 0.5)), S('h2', line(0.12, 0.11, 0.22, 0.11)), S('new', line(0.1, 0.8, 0.2, 0.85))]
  const c = correspond(a, b, { aspect: 1 })
  const byA = new Map(c.pairs.map((p) => [p.a, p]))
  assert.equal(byA.get(0)?.b, 1)
  assert.equal(byA.get(1)?.b, 0)
  assert.equal(byA.get(1)?.reversed, true)
  assert.deepEqual(c.vanish, [2])
  assert.deepEqual(c.appear, [2])
})

test('rigid in-betweens keep a swinging limb its length; linear ones shorten it', () => {
  // an arm from the shoulder at (0.5, 0.5), length 0.2, swinging from straight down to straight right
  const a = [S('arm', line(0.5, 0.5, 0.5, 0.7))]
  const b = [S('arm', line(0.5, 0.5, 0.7, 0.5))]
  const mid = (mode: 'rigid' | 'linear') => inbetween(a, b, 1, 'm', { aspect: 1, ease: EASES.linear, mode })[0][0].pts
  assert.ok(Math.abs(len(mid('rigid')) - 0.2) < 1e-6, `rigid ${len(mid('rigid'))}`)
  assert.ok(len(mid('linear')) < 0.15, `linear ${len(mid('linear'))}`)
})

test('appearing strokes write on, vanishing ones retract, and ids are new and agent-owned', () => {
  const a = [S('stay', line(0.1, 0.1, 0.3, 0.1)), S('gone', line(0.8, 0.2, 0.9, 0.2))]
  const b = [S('stay', line(0.1, 0.12, 0.3, 0.12)), S('hat', line(0.1, 0.9, 0.3, 0.9))]
  const sets = inbetween(a, b, 3, 'ib', { aspect: 1, ease: EASES.linear })
  assert.equal(sets.length, 3)
  const hatLen = sets.map((s) => len(s.find((x) => x.pts[0][1] > 0.8)!.pts))
  assert.ok(hatLen[0] < hatLen[1] && hatLen[1] < hatLen[2], `hat grows ${hatLen}`)
  const goneLen = sets.map((s) => len(s.find((x) => x.pts[0][0] > 0.7)!.pts))
  assert.ok(goneLen[0] > goneLen[2], 'gone shrinks')
  assert.equal(sets[1][0].id, 'ib2/0')
  assert.ok(sets.flat().every((s) => s.provenance === 'agent'))
})

test('fillBetween inserts non-key frames between two keys', () => {
  let anim = addFrame(createAnim('a', 't', 'k1'), 0, 'k2')
  anim = setStrokes(anim, 0, [S('s', line(0.1, 0.1, 0.2, 0.1))])
  anim = setStrokes(anim, 1, [S('s', line(0.1, 0.3, 0.2, 0.3))])
  const out = fillBetween(anim, 0, 2, 'tw')
  assert.deepEqual(out.frames.map((f) => f.id), ['k1', 'tw1', 'tw2', 'k2'])
  assert.deepEqual(out.frames.map((f) => !!f.key), [true, false, false, true])
  const ys = out.frames.map((f) => f.strokes[0].pts[0][1])
  assert.ok(ys[0] < ys[1] && ys[1] < ys[2] && ys[2] < ys[3], `monotone ${ys}`)
})

test('every ease is monotone with fixed ends; lognormal is an ease-in-out', () => {
  for (const [name, e] of Object.entries(EASES)) {
    assert.equal(e(0), 0, name)
    assert.ok(Math.abs(e(1) - 1) < 1e-12, name)
    let prev = 0
    for (let k = 1; k <= 100; k++) {
      const v = e(k / 100)
      assert.ok(v >= prev - 1e-12, `${name} at ${k}`)
      prev = v
    }
  }
  assert.ok(EASES.lognormal(0.1) < 0.1 && EASES.lognormal(0.9) > 0.9, 'slow at both ends')
})

test('a bounce falls, squashes with constant area, and comes to rest on the ground', () => {
  const ball = [S('ball', Array.from({ length: 24 }, (_, k) => {
    const a = (2 * Math.PI * k) / 23
    return [0.5 + 0.05 * Math.cos(a), 0.3 + 0.04 * Math.sin(a), 0.5] as Pt
  }))]
  const box = bbox(ball)
  const m = bounce(box, { ground: 0.8, drop: 0.4 })
  const frames = animateStrokes(ball, m, 24, 4000)
  const bottoms = frames.map((f) => bbox(f)[3])
  assert.ok(bottoms.every((b) => b <= 0.8 + 1e-9), 'never below the ground')
  assert.ok(Math.abs(bottoms[bottoms.length - 1] - 0.8) < 1e-9, 'rests on the ground')
  assert.ok(Math.abs(bottoms[0] - 0.4) < 0.01, 'starts at its drop height')
  const areas = frames.map((f) => {
    const [x0, y0, x1, y1] = bbox(f)
    return (x1 - x0) * (y1 - y0)
  })
  const a0 = (box[2] - box[0]) * (box[3] - box[1])
  assert.ok(areas.every((a) => Math.abs(a / a0 - 1) < 1e-6), 'squash and stretch keep area')
  assert.ok(areas.length > 10)
})
