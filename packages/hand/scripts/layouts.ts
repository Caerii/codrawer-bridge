/**
 * One text, several wrap widths: the hand's strokes in millimetres, for a caller that places them.
 *
 * codrawer-agentd (src/codrawer_bridge/agentd) writes an agent's answer on the reMarkable page in
 * free space near what the user asked about. Where it fits depends on the block's size, and the
 * size depends on the wrap width, so the caller asks for several widths at once (one Node start,
 * ~1 s, instead of one per width) and chooses a block and a place itself.
 *
 *     echo '{"text":"…","persona":"archivist","seed":7,"widths":[50,70,90]}' |
 *       pnpm --filter hand exec tsx scripts/layouts.ts
 *
 * Output, one JSON object on stdout:
 *
 *     {"persona":"archivist","layouts":[{"width":50,"bbox":[x0,y0,x1,y1],"duration":12345,
 *       "strokes":[{"down":120,"up":410,"pts":[[x,y,p,t],…]},…]},…]}
 *
 * Units: x, y and `bbox` in mm from the start of the first baseline (y grows down the page, so
 * ascenders are negative); `p` pressure 0..1; `t`, `down`, `up` and `duration` ms from the
 * performance's start. Placement and protocol (normalized page coordinates, Unix ms) are the
 * caller's: protocol.ts's mapping is `x_norm = origin_x + scale · x / 179.6`, likewise y over 239.5.
 */

import { readFileSync } from 'node:fs'
import { persona as byId, PERSONAS } from '../src/persona'
import { simulate } from '../src/simulate'

interface Request {
  text: string
  persona?: string
  seed?: number
  widths?: number[]
}

const r3 = (v: number) => Math.round(v * 1e3) / 1e3

function main() {
  const req = JSON.parse(readFileSync(0, 'utf8')) as Request
  const p = byId(req.persona ?? 'archivist')
  if (!p) throw new Error(`unknown persona ${req.persona}; one of ${PERSONAS.map((q) => q.id).join(', ')}`)
  const layouts = (req.widths?.length ? req.widths : [80]).map((width) => {
    const res = simulate(req.text, p, { seed: req.seed ?? 1, width })
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
    for (const s of res.strokes)
      for (const [x, y] of s.pts) {
        x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y)
      }
    return {
      width,
      bbox: res.strokes.length ? [r3(x0), r3(y0), r3(x1), r3(y1)] : [0, 0, 0, 0],
      duration: Math.round(res.duration),
      strokes: res.strokes.map((s) => ({
        down: Math.round(s.down),
        up: Math.round(s.up),
        pts: s.pts.map(([x, y, pr, t]) => [r3(x), r3(y), r3(pr), Math.round(t)]),
      })),
    }
  })
  process.stdout.write(JSON.stringify({ persona: p.id, layouts }))
}

main()
