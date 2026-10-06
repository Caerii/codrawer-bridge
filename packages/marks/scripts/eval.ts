/**
 * Print the recogniser's precision and recall on synthetic ink (test/evaluate.ts):
 *
 *     pnpm --filter marks eval
 *
 * One table for all five personas, then recall and false accepts per persona at three examples,
 * and the confusions. The numbers are for packages/hand's synthetic hands; real-ink tuning is
 * pending.
 */

import { evaluate, table } from '../test/evaluate'

const t0 = performance.now()
const rs = evaluate()
console.log(table(rs))
const three = rs.find((r) => r.k === 3)!
console.log('\nper persona, 3 examples:')
for (const [p, x] of Object.entries(three.perPersona)) console.log(`  ${p.padEnd(14)} recall ${(100 * x.tp / x.n).toFixed(1)}%  false accepts ${x.fa}/${x.neg}`)
for (const r of rs) if (Object.keys(r.confusions).length) console.log(`confusions (k=${r.k}):`, r.confusions)
console.log(`\n${((performance.now() - t0) / 1000).toFixed(1)} s`)
