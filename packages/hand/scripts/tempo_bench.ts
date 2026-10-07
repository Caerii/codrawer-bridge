// Letters per second and legibility proxies for a hurried hand (persona.ts `hurried`).
// pnpm --filter hand exec tsx scripts/tempo_bench.ts
import { archivist, hurried, sketcher } from '../src/persona'
import { simulate } from '../src/simulate'

const TEXT = 'Mitochondria convert nutrients into ATP and carry their own small loop of DNA.'
const letters = TEXT.replace(/[^A-Za-z]/g, '').length
for (const base of [archivist, sketcher]) {
  for (const k of [1, 1.5, 2, 2.5, 3]) {
    const r = simulate(TEXT, hurried(base, k), { seed: 7, width: 120 })
    const ink = r.strokes.reduce((a, s) => a + (s.up - s.down), 0)
    console.log(
      `${base.id.padEnd(10)} k=${k}  ${(r.duration / 1000).toFixed(1)} s  ${(letters / (r.duration / 1000)).toFixed(1)} letters/s  pen-down ${(100 * ink / r.duration).toFixed(0)}%`,
    )
  }
}
