/**
 * A scripted page for testing thinking replay (apps/even-g2/src/phone/replay.ts) without a tablet.
 *
 * Streams into a router session, at real time, a short "proof" written as the tablet's own ink
 * (`layer: "user"`) by packages/hand's simulated hand, with the moments the replay marks: a long
 * pause before a step, a slowly drawn (hesitant) question mark, a line partly erased with the tablet's eraser
 * and written again, a quick burst, a peer's stroke in its colour, and the agent writing on the
 * `ai` layer. About 45 s in all.
 *
 *     pnpm --dir apps/even-g2 exec tsx ../../scripts/dev/replay_scene.ts ws://localhost:8584/ws/replaytest
 *
 * Needs Node 22+ (a WebSocket global). Run it against a scratch session, never session1.
 */
import { persona, simulate, toProtocol, type HandMessage } from '../../packages/hand/src/index'

const url = process.argv[2]
if (!url) {
  console.error('usage: replay_scene.ts <ws://host:port/ws/session>')
  process.exit(2)
}

const ws = new WebSocket(url)
const send = (m: object) => ws.send(JSON.stringify(m))
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Write `text` with a persona at the hand's own timing; resolves when the last stroke ends. */
async function write(text: string, o: { at: [number, number]; who?: string; layer?: 'user' | 'ai' | 'peer'; color?: string; author?: string; seed?: number; scale?: number; speed?: number }) {
  const p = persona(o.who ?? 'mathematician')!
  const result = simulate(text, p, { seed: o.seed ?? 7, width: 150 })
  const k = 1 / (o.speed ?? 1) // a faster hand: the same strokes in less time
  const startTs = Date.now() + 50
  const msgs: HandMessage[] = toProtocol(result, { layer: o.layer ?? 'user', origin: o.at, scale: o.scale ?? 1.6, startTs, idPrefix: `${o.layer ?? 'user'}_scene_`, run: `${Date.now().toString(36)}`, color: o.color, author: o.author })
  for (const m of msgs) {
    const due = m.t === 'stroke_pts' ? m.pts[m.pts.length - 1][3] : m.ts
    const wait = startTs + (due - startTs) * k - Date.now()
    if (wait > 0) await sleep(wait)
    if (m.t === 'stroke_pts') send({ ...m, pts: m.pts.map(([x, y, pr, t]) => [x, y, pr, Math.round(startTs + (t - startTs) * k)]) })
    else send({ ...m, ts: Math.round(startTs + (m.ts - startTs) * k) })
  }
}

/** One stroke along `pts` (normalized), `ms` long, at 125 Hz, sent in ~60 Hz batches. */
async function line(id: string, pts: [number, number][], ms: number, o: { brush?: string; layer?: string; color?: string; author?: string } = {}) {
  const n = Math.max(2, Math.round(ms / 8))
  const t0 = Date.now()
  send({ t: 'stroke_begin', id, layer: o.layer ?? 'user', brush: o.brush ?? 'pen', ts: t0, color: o.color, author: o.author })
  let batch: number[][] = []
  for (let j = 0; j < n; j++) {
    const f = (j / (n - 1)) * (pts.length - 1)
    const i = Math.min(pts.length - 2, Math.floor(f))
    const u = f - i
    const x = pts[i][0] + (pts[i + 1][0] - pts[i][0]) * u
    const y = pts[i][1] + (pts[i + 1][1] - pts[i][1]) * u
    const due = t0 + (j / (n - 1)) * ms
    const wait = due - Date.now()
    if (wait > 0) await sleep(wait)
    batch.push([+x.toFixed(5), +y.toFixed(5), 0.55, Math.round(due)])
    if (batch.length >= 2 || j === n - 1) {
      send({ t: 'stroke_pts', id, pts: batch })
      batch = []
    }
  }
  send({ t: 'stroke_end', id, ts: Date.now() })
}

async function scene() {
  await new Promise<void>((ok, fail) => {
    ws.onopen = () => ok()
    ws.onerror = () => fail(new Error(`cannot connect to ${url}`))
  })
  const run = Date.now().toString(36)
  console.log('scene: claim')
  await write('Claim: n odd => n^2 odd', { at: [0.1, 0.16], seed: 3 })
  await sleep(700)
  console.log('scene: a hesitant question mark')
  await line(`u_${run}_q`, [[0.88, 0.205], [0.9, 0.195], [0.915, 0.21], [0.9, 0.23], [0.898, 0.245]], 2600)
  await line(`u_${run}_qdot`, [[0.898, 0.258], [0.899, 0.26]], 150)
  console.log('scene: long pause (7 s)')
  await sleep(7000)
  await write('Let n = 2k + 1.', { at: [0.1, 0.25], seed: 5 })
  await sleep(900)
  await write('n^2 = 4k^2 + 2k + 1', { at: [0.1, 0.32], seed: 9 })
  console.log('scene: pause, then erase the wrong term')
  await sleep(3500)
  // the eraser end sweeps the "2k" term back and forth (x ≈ 0.57..0.65 on the line at y ≈ 0.31)
  await line(`u_${run}_erase`, [[0.565, 0.298], [0.655, 0.302], [0.565, 0.312], [0.655, 0.318]], 1600, { brush: 'eraser' })
  await sleep(1200)
  console.log('scene: rewrite')
  await write('4k', { at: [0.575, 0.325], seed: 11 })
  await sleep(800)
  console.log('scene: burst')
  await write('= 2(2k^2+2k) + 1', { at: [0.1, 0.39], seed: 13, speed: 2.2 })
  await sleep(1500)
  console.log('scene: a peer marks it')
  await line(`peer_${run}_tick`, [[0.66, 0.39], [0.68, 0.41], [0.72, 0.36]], 500, { layer: 'peer', color: '#e5484d', author: 'phone' })
  await sleep(1500)
  console.log('scene: the agent answers')
  await write('odd. QED', { at: [0.1, 0.47], who: 'sketcher', layer: 'ai', color: '#7c5cff', author: 'hand:sketcher', seed: 2 })
  await sleep(500)
  ws.close()
  console.log('scene: done')
}

scene().catch((e) => {
  console.error(e)
  process.exit(1)
})
