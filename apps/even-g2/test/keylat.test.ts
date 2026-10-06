// Per-key latency tracing (src/keylat.ts) with fake clocks.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { KeyLatency, STALE_MS, type KeyLatencyBatch } from '../src/keylat'

function rig() {
  let now = 1000
  const batches: KeyLatencyBatch[] = []
  const t = new KeyLatency('v1', (b) => batches.push(b), () => now, () => 50_000 + now)
  return { t, batches, at: (x: number) => (now = x) }
}

test('an update carries the keys that arrived before its content was rendered', () => {
  const { t, batches, at } = rig()
  t.key(50_000 + 1000 - 30) // 30 ms on the wire
  at(1010)
  t.key()
  at(1020) // rendered at 1015: carries both keys, not one arriving after
  const done = t.sending(1015)
  at(1018)
  t.key()
  at(1090)
  done()
  t.flush()
  assert.deepEqual(batches, [{ v: 'v1', net: [30, null], wait: [20, 10], glass: [70, 70], total: [90, 80] }])
})

test('keys that change nothing are dropped once stale, not charged to a later update', () => {
  const { t, batches, at } = rig()
  t.key()
  at(1000 + STALE_MS)
  t.sending(1000 + STALE_MS)()
  t.flush()
  assert.deepEqual(batches, [])
})
