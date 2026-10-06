// Session recording (src/recording.ts): the replay tools' JSONL, and the memory bounds.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { jsonlLine, messageType, recordingName, SessionRecording } from '../src/recording'

test('lines are {"ts", "dir", "msg"} with the frame embedded verbatim, as replay_jsonl reads them', () => {
  const raw = '{"t":"stroke_pts","id":"u_1","pts":[[0.12,0.34,0.6,1730000000130]]}'
  const line = jsonlLine({ ts: 1730000000131.6, dir: 'in', raw })
  assert.equal(line, `{"ts":1730000000132,"dir":"in","msg":${raw}}`)
  const o = JSON.parse(line)
  assert.equal(typeof o.ts, 'number') // replay_jsonl: int(ts) when it is a number
  assert.deepEqual(o.msg, JSON.parse(raw)) // replay_jsonl / replay_to.py: obj["msg"] is the message
})

test('only protocol messages are kept, liveness pings are not, and nothing while off', () => {
  const r = new SessionRecording()
  assert.equal(r.add('in', '{"t":"hello"}', 1), false) // off
  r.start(1000)
  assert.equal(r.add('in', '{"t":"ping"}', 2), false)
  assert.equal(r.add('in', 'not json', 3), false)
  assert.equal(r.add('in', '[1,2]', 4), false)
  assert.equal(r.add('in', '{"x":1}', 5), false)
  assert.equal(r.add('out', '{"t":"stroke_begin","id":"p_a_1"}', 6), true)
  assert.equal(r.size, 1)
  r.stop()
  assert.equal(r.add('in', '{"t":"stroke_end","id":"p_a_1"}', 7), false)
  assert.equal(r.size, 1) // stopping keeps what was recorded
  r.start(2000)
  assert.equal(r.size, 0) // a new start begins afresh
  assert.equal(r.startedAt, 2000)
})

test('past the message bound the oldest go, counted', () => {
  const r = new SessionRecording(3)
  r.start(0)
  for (let i = 0; i < 10; i++) r.add('in', `{"t":"stroke_pts","i":${i}}`, i)
  assert.equal(r.size, 3)
  assert.equal(r.dropped, 7)
  assert.deepEqual(
    r.messages().map((m) => JSON.parse(m.raw).i),
    [7, 8, 9],
  )
})

test('past the character bound the oldest go too, but the newest message always stays', () => {
  const r = new SessionRecording(1000, 50)
  r.start(0)
  r.add('in', '{"t":"a","pad":"xxxxxxxxxx"}', 1) // 28 chars
  r.add('in', '{"t":"b","pad":"xxxxxxxxxx"}', 2) // 56 in all: over
  assert.equal(r.size, 1)
  assert.equal(r.dropped, 1)
  r.add('in', `{"t":"page","pad":"${'x'.repeat(100)}"}`, 3) // alone over the bound: kept alone
  assert.equal(r.size, 1)
  assert.equal(messageType(r.messages()[0].raw), 'page')
})

test('compaction keeps order across many drops', () => {
  const r = new SessionRecording(100)
  r.start(0)
  for (let i = 0; i < 20_000; i++) r.add(i % 2 ? 'out' : 'in', `{"t":"stroke_pts","i":${i}}`, i)
  const kept = r.messages().map((m) => JSON.parse(m.raw).i)
  assert.equal(kept.length, 100)
  assert.equal(kept[0], 19_900)
  assert.equal(kept[99], 19_999)
  assert.equal(r.dropped, 19_900)
  const parts = r.jsonlParts()
  assert.equal(parts.length, 100)
  assert.ok(parts.every((p) => p.endsWith('\n') && JSON.parse(p).msg.t === 'stroke_pts'))
})

test('recordings are named by their start time', () => {
  assert.equal(recordingName(Date.UTC(2026, 9, 5, 14, 3, 12)), 'codrawer-session-2026-10-05-14-03-12.jsonl')
})
