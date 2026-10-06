// Wrapped lines start cleanly: the first word of every line after the first has the shape the
// same word has when written on its own (linestart.ts). Before the carriage was filtered line by
// line (arm.ts carriageFilter), the forearm was still travelling back from the previous line
// while the next line's first letters were written, and they came out skewed by 3–10 mm: "clear"
// read as "∝lear", "beside" as "peside" (codrawer-agentd's first live answer, 2026-10-06).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { archivist, PERSONAS, sketcher } from '../src/persona'
import { lineStartDeviation } from './linestart'

const TEXT = 'Reading you loud and clear: "Testing," circled, with two wavy lines beside it, like a signal going out. What would you like to try next?'

test('archivist: the words that start wrapped lines match the word written alone', () => {
  const devs = lineStartDeviation(TEXT, archivist, 110, 7)
  assert.deepEqual(devs.map((d) => d.word), ['with', 'beside', 'going', 'you'])
  for (const d of devs) assert.ok(d.mm < 1.5, `${d.word} deviates ${d.mm.toFixed(2)} mm (was 3–5 mm with the bug)`)
})

test('every persona: a line start deviates no more than an ordinary mid-line word', () => {
  for (const p of PERSONAS) {
    if (p === sketcher) continue // joined cursive: a word's stroke count varies with its neighbours
    for (const seed of [7, 11]) {
      const starts = lineStartDeviation(TEXT, p, 110, seed).filter((d) => Number.isFinite(d.mm))
      const all = lineStartDeviation(TEXT, p, 110, seed, true).filter((d) => Number.isFinite(d.mm))
      const mid = all.filter((d) => !starts.some((s) => s.word === d.word) && d.word !== 'Reading')
      const worstMid = Math.max(...mid.map((d) => d.mm))
      for (const s of starts)
        assert.ok(s.mm <= worstMid + 0.5, `${p.id} seed ${seed}: line start "${s.word}" ${s.mm.toFixed(2)} mm vs mid-line worst ${worstMid.toFixed(2)} mm`)
    }
  }
})
