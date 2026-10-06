// Protocol output (docs/protocol.md) and the real-time player that yields to the user.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { perform } from '../src/perform'
import { archivist, sketcher } from '../src/persona'
import { dueAt, toJsonl, toProtocol, type HandMessage } from '../src/protocol'
import { simulate } from '../src/simulate'

const T0 = 1_760_000_000_000

test('toProtocol: begin / ~60 Hz point batches / end, on the ai layer, normalized, with real ts', () => {
  const r = simulate('ink travels', sketcher, { seed: 1 })
  const msgs = toProtocol(r, { startTs: T0, origin: [0.1, 0.3], color: '#7c5cff', author: 'hand:sketcher' })
  const begins = msgs.filter((m) => m.t === 'stroke_begin')
  assert.equal(begins.length, r.strokes.length)
  assert.ok(begins.every((m) => m.t === 'stroke_begin' && m.layer === 'ai' && m.color === '#7c5cff' && m.ts >= T0))
  let last = -Infinity
  for (const m of msgs) {
    if (m.t === 'stroke_pts') {
      for (const [x, y, p, ts] of m.pts) {
        assert.ok(x >= 0 && x <= 1 && y >= 0 && y <= 1 && p >= 0 && p <= 1)
        assert.ok(ts > last, 'point ts strictly increase across the whole performance')
        last = ts
      }
      const span = m.pts[m.pts.length - 1][3] - m.pts[0][3]
      assert.ok(span < 16, 'a batch covers less than 16 ms')
    }
    assert.ok(dueAt(m) >= T0)
  }
  // the first baseline starts at the origin: writing sits around it
  const first = msgs.find((m) => m.t === 'stroke_pts') as Extract<HandMessage, { t: 'stroke_pts' }>
  assert.ok(Math.abs(first.pts[0][0] - 0.1) < 0.05 && Math.abs(first.pts[0][1] - 0.3) < 0.05)
  const ids = new Set(begins.map((m) => m.id))
  assert.equal(ids.size, begins.length, 'unique ids')
  const lines = toJsonl(msgs).trim().split('\n').map((l) => JSON.parse(l))
  assert.equal(lines.length, msgs.length)
  assert.ok(lines.every((l) => typeof l.ts === 'number' && l.msg.t.startsWith('stroke_')))
})

/** A virtual clock: sleep advances it, nothing waits for real. */
function clock(start = T0) {
  let t = start
  return { now: () => t, sleep: async (ms: number) => void (t += Math.max(1, ms)) }
}

test('perform sends on the simulated schedule', async () => {
  const r = simulate('on time', archivist, { seed: 2 })
  const c = clock()
  const sent: { at: number; m: HandMessage }[] = []
  const res = await perform(r, { ...c, startTs: T0, send: (m) => void sent.push({ at: c.now(), m }) })
  assert.equal(res.yielded, 0)
  assert.equal(sent.length, toProtocol(r, { startTs: T0 }).length)
  for (const { at, m } of sent) assert.ok(at >= dueAt(m) && at - dueAt(m) <= 2, 'sent when due')
})

test('perform yields while the user writes and resumes after a lull, shifting later ink', async () => {
  const r = simulate('do not talk over me', sketcher, { seed: 3 })
  const c = clock()
  // the user writes from 1.0 s to 3.0 s after the start
  const userActive = () => c.now() - T0 >= 1000 && c.now() - T0 < 3000
  const sent: { at: number; m: HandMessage }[] = []
  const states: string[] = []
  const res = await perform(r, { ...c, startTs: T0, userActive, lull: 800, send: (m) => void sent.push({ at: c.now(), m }), onState: (s) => states.push(s) })
  assert.ok(states.includes('yielding'), 'it yielded')
  assert.ok(res.yielded > 0)
  // no stroke may begin while the user is writing or within the lull after (seen at 50 ms polls)
  for (const { at, m } of sent) if (m.t === 'stroke_begin') assert.ok(at - T0 < 1000 || at - T0 >= 3000 + 800 - 50, `a stroke began at ${at - T0} ms`)
  // timestamps stay monotonic and the ink still all arrives
  let last = -Infinity
  for (const { m } of sent) {
    const due = dueAt(m)
    assert.ok(due >= last - 0, 'monotonic')
    last = due
  }
  assert.equal(sent.filter((s) => s.m.t === 'stroke_begin').length, r.strokes.length)
})

test('perform stops when aborted and closes the open stroke', async () => {
  const r = simulate('stop here', sketcher, { seed: 4 })
  const c = clock()
  const ac = new AbortController()
  const sent: HandMessage[] = []
  await perform(r, {
    ...c,
    startTs: T0,
    signal: ac.signal,
    send: (m) => {
      sent.push(m)
      if (m.t === 'stroke_pts' && sent.length > 5) ac.abort()
    },
  })
  const open = new Set<string>()
  for (const m of sent) m.t === 'stroke_begin' ? open.add(m.id) : m.t === 'stroke_end' ? open.delete(m.id) : 0
  assert.equal(open.size, 0, 'no stroke left open')
  assert.ok(sent.length < toProtocol(r, { startTs: T0 }).length)
})
