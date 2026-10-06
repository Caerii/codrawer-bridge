// Diagnostic (not shipped): how far each wrapped line's first word departs from the same word
// written alone. Prints mm per persona; see test/linestart.test.ts for the regression bound.
import { PERSONAS } from '../src/persona'
import { lineStartDeviation } from '../test/linestart'

const TEXT = 'Reading you loud and clear: "Testing," circled, with two wavy lines beside it, like a signal going out. What would you like to try next?'
for (const p of PERSONAS) {
  const devs = lineStartDeviation(TEXT, p, 110, 7)
  console.log(p.id.padEnd(14), devs.map((d) => `${d.word}:${d.mm.toFixed(2)}`).join('  '))
  const all = lineStartDeviation(TEXT, p, 110, 7, true).filter((d) => !devs.some((e) => e.word === d.word))
  console.log('  mid-line'.padEnd(14), all.map((d) => `${d.word}:${d.mm.toFixed(2)}`).join('  '))
}
