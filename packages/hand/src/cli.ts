/**
 * The hand on the command line: write text into a live codrawer session, or into a file.
 *
 *     pnpm --filter hand cli "what if ink could travel?" --persona sketcher --ws ws://localhost:8577/ws/handlab
 *     pnpm --filter hand cli "2 + 2 = 4" --persona mathematician --out turn.jsonl
 *
 * With `--ws` the strokes stream into the router at the simulated timing, as `stroke_*` on the
 * `ai` layer (any router relays those: docs/protocol.md), and the hand yields while anyone else
 * in the session is drawing (perform.ts): it watches the session's other strokes and resumes
 * after `--lull` ms of quiet. With `--out` it writes JSON Lines that
 * `scripts/dev/replay_to.py <ws-url> <file> <seconds>` replays. With neither it prints a summary.
 *
 * Needs a WebSocket global (Node 22 or later). Nothing here is used by the library itself.
 */

import { writeFileSync } from 'node:fs'
import { PERSONAS, persona as byId } from './persona'
import { perform } from './perform'
import { toJsonl, toProtocol, type HandMessage } from './protocol'
import { simulate } from './simulate'

const HELP = `usage: pnpm --filter hand cli "<text>" [options]

  --persona <id>      ${PERSONAS.map((p) => p.id).join(' | ')} (default sketcher)
  --ws <url>          stream live into a router session, e.g. ws://localhost:8577/ws/handlab
  --out <file.jsonl>  write JSON Lines for scripts/dev/replay_to.py
  --x <0..1> --y <0..1>  where the first baseline starts on the page (default 0.1 0.25)
  --scale <k>         magnify (default 1: true size on a Paper Pro)
  --width <mm>        wrap lines at this width (default: the page's width from --x)
  --confidence <0..1> how sure the writer is (default 1)
  --seed <n>          random seed (default: the clock)
  --color <#rrggbb>   ink colour hint (default #7c5cff)
  --lull <ms>         quiet needed before resuming after the user writes (default 1500)
`

function args(argv: string[]): { text: string; o: Record<string, string> } {
  const o: Record<string, string> = {}
  const rest: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) o[a.slice(2)] = argv[i + 1]?.startsWith('--') || i + 1 >= argv.length ? 'true' : argv[++i]
    else rest.push(a)
  }
  return { text: rest.join(' '), o }
}

async function main() {
  const { text, o } = args(process.argv.slice(2))
  if (!text || o.help) {
    process.stdout.write(HELP)
    process.exit(text ? 0 : 2)
  }
  const p = byId(o.persona ?? 'sketcher')
  if (!p) throw new Error(`unknown persona ${o.persona}; one of ${PERSONAS.map((q) => q.id).join(', ')}`)
  const x = Number(o.x ?? 0.1), y = Number(o.y ?? 0.25), scale = Number(o.scale ?? 1)
  const width = Number(o.width ?? ((0.95 - x) * 179.6) / scale)
  const seed = Number(o.seed ?? Date.now() % 1e9)
  const result = simulate(text, p, { seed, width, confidence: o.confidence !== undefined ? Number(o.confidence) : undefined })
  const place = { origin: [x, y] as [number, number], scale, color: o.color ?? '#7c5cff', author: `hand:${p.id}` }
  const summary = `${p.name}: ${result.strokes.length} strokes, ${(result.duration / 1000).toFixed(1)} s (seed ${seed})`

  if (o.out) {
    writeFileSync(o.out, toJsonl(toProtocol(result, place)))
    console.log(`${summary} → ${o.out}`)
  }
  if (!o.ws) {
    if (!o.out) console.log(summary)
    return
  }
  const ws = new WebSocket(o.ws)
  await new Promise<void>((ok, fail) => {
    ws.onopen = () => ok()
    ws.onerror = () => fail(new Error(`cannot connect to ${o.ws}`))
  })
  // anyone else's ink in the session means the user is mid-thought: the hand waits
  const open = new Set<string>()
  let lastSeen = 0
  const mine = (id: string) => id.startsWith('ai_hand_')
  ws.onmessage = (ev) => {
    let m: { t?: string; id?: string; layer?: string }
    try {
      m = JSON.parse(String(ev.data))
    } catch {
      return
    }
    if (!m.id || mine(m.id)) return
    if (m.t === 'stroke_begin' && m.layer !== 'ai') open.add(m.id)
    if (m.t === 'stroke_pts' && open.has(m.id)) lastSeen = Date.now()
    if (m.t === 'stroke_end') open.delete(m.id)
  }
  console.log(`${summary} → ${o.ws}`)
  const perf = await perform(result, {
    ...place,
    send: (m: HandMessage) => ws.send(JSON.stringify(m)),
    userActive: () => open.size > 0 || Date.now() - lastSeen < 300,
    lull: Number(o.lull ?? 1500),
    onState: (s) => s === 'yielding' && console.log('  … yielding to the user'),
  })
  console.log(`  sent ${perf.sent} messages${perf.yielded ? `, yielded ${(perf.yielded / 1000).toFixed(1)} s` : ''}`)
  ws.close()
}

main().catch((e) => {
  console.error(String(e?.message ?? e))
  process.exit(1)
})
