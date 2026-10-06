import { test } from 'node:test'
import assert from 'node:assert/strict'
import { StrokeStore, type PageMessage } from '../src/strokes'
import { DEFAULT_ERASE_RADIUS, LIVE_INK_HALF_WIDTH, PAGE_H, PAGE_W, fullyErased, keptRuns } from '../src/erase'

// Page px → normalized page coords.
const nx = (px: number) => px / PAGE_W
const ny = (px: number) => px / PAGE_H

/** A horizontal live stroke at page-px height `y` from x0 to x1, one point per page px. */
function hline(s: StrokeStore, id: string, y: number, x0 = 400, x1 = 800, ts = 1000) {
  s.begin(id, 'user', 'pen', ts)
  const pts: number[][] = []
  for (let x = x0; x <= x1; x++) pts.push([nx(x), ny(y), 0.5])
  s.points(id, pts, 'user')
  s.end(id, ts + 1)
}

/** A vertical eraser stroke at page-px x from y0 to y1, sent in batches like the bridge does. */
function eraseV(s: StrokeStore, id: string, x: number, y0: number, y1: number, ts = 5000, end = true) {
  s.begin(id, 'user', 'eraser', ts)
  for (let y = y0; y <= y1; y += 8) {
    const batch: number[][] = []
    for (let k = 0; k < 8 && y + k <= y1; k += 2) batch.push([nx(x), ny(y + k), 0.5])
    s.points(id, batch, 'user')
  }
  if (end) s.end(id, ts + 500)
}

const byId = (s: StrokeStore, id: string) => s.all().find((x) => x.id === id)!

test('the eraser cuts a line where it passes, as xochitl does, at its true radius', () => {
  const s = new StrokeStore()
  hline(s, 'a', 500)
  eraseV(s, 'e', 600, 400, 600)
  const a = byId(s, 'a')
  const runs = keptRuns(a)
  assert.equal(runs.length, 2, 'split into two pieces')
  // the gap between the pieces' centrelines: twice (radius + the ink's half width)
  const left = a.pts[runs[0][1] - 1][0] * PAGE_W
  const right = a.pts[runs[1][0]][0] * PAGE_W
  const want = 2 * (DEFAULT_ERASE_RADIUS + LIVE_INK_HALF_WIDTH)
  assert.ok(Math.abs(right - left - want) <= 2, `gap ${right - left} ≈ ${want}`)
  assert.ok(Math.abs((left + right) / 2 - 600) <= 1, 'centred on the eraser')
})

test('the gap does not depend on pressure, and the radius is a setting', () => {
  const s = new StrokeStore()
  s.eraseRadius = 5 // the eraser tool's smallest size: thickness 1 × 5 px
  hline(s, 'a', 500)
  s.begin('e', 'user', 'eraser', 5000)
  s.points('e', [[nx(600), ny(450), 0.05], [nx(600), ny(550), 1]], 'user')
  const a = byId(s, 'a')
  assert.equal(a.goneCount, 2 * (5 + LIVE_INK_HALF_WIDTH) + 1) // whole page px either side, inclusive
})

test('a line wholly under the eraser goes; others are untouched', () => {
  const s = new StrokeStore()
  hline(s, 'small', 500, 595, 605)
  hline(s, 'far', 900)
  eraseV(s, 'e', 600, 400, 600)
  assert.ok(fullyErased(byId(s, 'small')))
  assert.equal(byId(s, 'far').goneCount, undefined)
})

test('it cuts only the tablet ink drawn before it: not later ink, not peers, not the AI', () => {
  const s = new StrokeStore()
  hline(s, 'before', 500)
  s.begin('peer', 'peer', 'pen')
  s.points('peer', [[nx(600), ny(490), 0.5], [nx(600), ny(510), 0.5]], 'peer')
  s.end('peer')
  s.begin('ai', 'ai', 'ghost')
  s.points('ai', [[nx(590), ny(500), 0.5], [nx(610), ny(500), 0.5]], 'ai')
  s.end('ai')
  eraseV(s, 'e', 600, 400, 600, 5000, false)
  hline(s, 'after', 510, 400, 800, 6000) // drawn after the eraser began (another pen, a replay)
  s.points('e', [[nx(600), ny(505), 0.5]], 'user')
  assert.ok(byId(s, 'before').goneCount! > 0)
  assert.equal(byId(s, 'peer').goneCount, undefined)
  assert.equal(byId(s, 'ai').goneCount, undefined)
  assert.equal(byId(s, 'after').goneCount, undefined)
})

test('cuts reach ink that finished after the index was built', () => {
  const s = new StrokeStore()
  hline(s, 'a', 500)
  eraseV(s, 'e1', 450, 400, 600) // builds the index
  hline(s, 'b', 700)
  eraseV(s, 'e2', 600, 600, 800)
  assert.equal(keptRuns(byId(s, 'b')).length, 2)
})

test('the change is reported as a region, for repainting only that', () => {
  const s = new StrokeStore()
  hline(s, 'a', 500)
  s.begin('e', 'user', 'eraser', 5000)
  assert.equal(s.points('e', [[nx(100), ny(100), 0.5]], 'user'), null) // nothing there
  const box = s.points('e', [[nx(600), ny(500), 0.5]], 'user')
  assert.ok(box)
  assert.ok(box[0] * PAGE_W <= 600 - DEFAULT_ERASE_RADIUS && box[2] * PAGE_W >= 600 + DEFAULT_ERASE_RADIUS)
  assert.ok(box[1] <= ny(500) && box[3] >= ny(500))
})

/** A saved page holding one horizontal stroke (the file's own [x, y, p, w]). */
function page(rev: number, y = 500): PageMessage {
  const pts: number[][] = []
  for (let x = 400; x <= 800; x++) pts.push([nx(x), ny(y), 0.5, 4 / PAGE_W])
  return { t: 'page', doc: 'd', page: 'p', rev, w: PAGE_W, h: PAGE_H, strokes: [{ id: '1:16', tool: 'fineliner', pts }] }
}

test("a save that does not hold the erase yet does not bring the erased ink back", () => {
  const s = new StrokeStore()
  s.applyPage(page(1000))
  eraseV(s, 'e', 600, 400, 600, 5000)
  assert.equal(keptRuns(byId(s, 'rm:1:16')).length, 2)
  // a save from before the erase arrives late (the page watcher, a reconnect): the snapshot's
  // stroke is whole again, and the eraser, not in it, cuts it again
  s.applyPage(page(2000))
  assert.ok(byId(s, 'e'), 'the eraser is kept')
  assert.equal(keptRuns(byId(s, 'rm:1:16')).length, 2)
  // the save that holds it: the eraser goes, the file's pieces are the page
  s.applyPage(page(6000))
  assert.equal(s.all().some((x) => x.id === 'e'), false)
})

test('a save taken while the pen was down keeps the stroke (xochitl commits at pen-up)', () => {
  const s = new StrokeStore()
  s.applyPage(page(1000))
  eraseV(s, 'e', 600, 400, 600, 5000, false)
  s.applyPage(page(5200)) // saved mid-erase: began before rev, not ended
  assert.ok(byId(s, 'e'))
  assert.equal(keptRuns(byId(s, 'rm:1:16')).length, 2)
  s.end('e', 5500)
  s.applyPage(page(5300)) // ended after rev: still not in the file
  assert.ok(byId(s, 'e'))
  hline(s, 'ink', 900, 400, 800, 7000)
  s.applyPage(page(7000.5)) // began at rev, ended after it: kept
  assert.ok(byId(s, 'ink'))
})

test('a replayed eraser starts over and cuts the same', () => {
  const s = new StrokeStore()
  hline(s, 'a', 500)
  eraseV(s, 'e', 600, 400, 600)
  const n = byId(s, 'a').goneCount
  s.begin('a', 'user', 'pen', 1000) // the router replays the page after a reconnect
  s.points('a', Array.from({ length: 401 }, (_, i) => [nx(400 + i), ny(500), 0.5]), 'user')
  s.end('a', 1001)
  assert.equal(byId(s, 'a').goneCount, undefined)
  eraseV(s, 'e', 600, 400, 600)
  assert.equal(byId(s, 'a').goneCount, n)
})

test('hit testing is fast: 5,000 strokes × a 200-point eraser', () => {
  // a page of handwriting: 5,000 strokes of 40 points (200k points), random small squiggles
  let seed = 7
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
  const s = new StrokeStore()
  const strokes: PageMessage['strokes'] = []
  for (let k = 0; k < 5000; k++) {
    let x = 100 + rnd() * 1420
    let y = 100 + rnd() * 1960
    const pts: number[][] = []
    for (let i = 0; i < 40; i++) {
      x += (rnd() - 0.5) * 6
      y += (rnd() - 0.5) * 6
      pts.push([nx(x), ny(y), 0.5, 4 / PAGE_W])
    }
    strokes.push({ id: `1:${k}`, tool: 'fineliner', pts })
  }
  s.applyPage({ t: 'page', doc: 'd', page: 'p', rev: 1, w: PAGE_W, h: PAGE_H, strokes })
  // a 200-point scribble across the page, in bridge-sized batches of 4
  const eraser: number[][] = []
  for (let i = 0; i < 200; i++) eraser.push([nx(200 + i * 6), ny(1000 + 300 * Math.sin(i / 10)), 0.5])
  s.begin('e', 'user', 'eraser', 10)
  const t0 = performance.now()
  s.points('e', eraser.slice(0, 1), 'user') // first batch: builds the index
  const t1 = performance.now()
  for (let i = 1; i < eraser.length; i += 4) s.points('e', eraser.slice(i, i + 4), 'user')
  const t2 = performance.now()
  const cut = s.all().filter((x) => x.goneCount).length
  console.log(`erase: index ${(t1 - t0).toFixed(1)} ms for 200k points; 199 segments ${(t2 - t1).toFixed(1)} ms (${((t2 - t1) / 50).toFixed(2)} ms per 4-point batch); ${cut} strokes cut`)
  assert.ok(cut > 50)
  assert.ok(t2 - t1 < 250, `cutting took ${t2 - t1} ms`)
})
