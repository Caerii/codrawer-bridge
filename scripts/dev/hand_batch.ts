/**
 * Many `packages/hand` performances in one process, for the Primer's markup (ADR 010).
 *
 * The hand's CLI writes one text per run, and each run pays Node and tsx start-up (~2 s). A teacher's
 * markup is a dozen small pieces: comments, a "?", a score, circles, ticks and strikes. This
 * script reads them all as JSON on stdin and writes every piece's messages and bounds to stdout,
 * in one run. It uses only the package's public exports (simulate, toProtocol, persona).
 *
 *     pnpm --filter hand exec tsx <repo>/scripts/dev/hand_batch.ts < job.json > out.json
 *
 * Input:  {"persona": "teacher", "startTs": <Unix ms>, "gapMs": 250,
 *          "items": [{"key", "text"? | "paths"? (mm, from the origin), "origin": [x, y], "seed",
 *                     "color", "author", "layer", "brush", "idPrefix"}]}
 * Output: {"items": {"<key>": {"messages": [...], "bbox": [x0, y0, x1, y1], "ms": <duration>}}}
 *
 * Items are performed one after another (each starts `gapMs` after the previous one ends), so the
 * timestamps make one continuous performance. Coordinates are normalized page coordinates.
 */
import { persona as byId, simulate, toProtocol, type HandMessage } from '../../packages/hand/src/index'

interface Item {
  key: string
  text?: string
  paths?: [number, number][][]
  origin: [number, number]
  seed?: number
  color?: string
  author?: string
  layer?: 'ai' | 'peer' | 'user'
  brush?: string
  idPrefix?: string
}

interface Job {
  persona?: string
  startTs?: number
  gapMs?: number
  items: Item[]
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const c of process.stdin) chunks.push(c as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

async function main() {
  const job = JSON.parse(await readStdin()) as Job
  const who = byId(job.persona ?? 'teacher') ?? byId('mathematician')!
  let t = job.startTs ?? Date.now()
  const out: Record<string, { messages: HandMessage[]; bbox: [number, number, number, number]; ms: number }> = {}
  for (const it of job.items) {
    const input = it.paths ? { paths: it.paths } : (it.text ?? '')
    const result = simulate(input, who, { seed: it.seed ?? 1 })
    const messages = toProtocol(result, { origin: it.origin, color: it.color, author: it.author, layer: it.layer ?? 'ai', brush: it.brush ?? 'pen', startTs: t, idPrefix: it.idPrefix ?? 'ai_teacher_', run: it.key })
    let x0 = 1, y0 = 1, x1 = 0, y1 = 0, end = t
    for (const m of messages) {
      if (m.t === 'stroke_pts') {
        for (const [x, y, , ts] of m.pts) {
          x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y)
          end = Math.max(end, ts)
        }
      } else if (m.t === 'stroke_end') end = Math.max(end, m.ts)
    }
    out[it.key] = { messages, bbox: [x0, y0, x1, y1], ms: end - t }
    t = end + (job.gapMs ?? 250)
  }
  process.stdout.write(JSON.stringify({ items: out }))
}

void main()
