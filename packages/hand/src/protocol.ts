/**
 * From simulated strokes to codrawer protocol messages (docs/protocol.md).
 *
 * An agent joins a session as an ordinary client and draws with `stroke_begin` / `stroke_pts` /
 * `stroke_end` on `layer: "ai"`; the tablet's Go and Rust routers carry no `ai_stroke_*`, so this
 * is the form every router relays (protocol.md, "Layer semantics"). Points are `[x, y, p, ts]`:
 * x and y normalized to the page, p in 0..1, ts Unix milliseconds. Unlike the old `ai_stroke_*`
 * points, these carry *real* timestamps, so a client can replay the hand's rhythm exactly, and
 * the even-g2 phone stage animates agent ink at its own timing (apps/even-g2/src/playout.ts).
 *
 * The simulator works in millimetres from the start of the first baseline. Placement maps them
 * onto the page: `origin` is where that baseline starts (normalized), `scale` magnifies, and the
 * page size in millimetres converts (the Paper Pro's 1620 × 2160 px at 229 ppi is
 * 179.6 × 239.5 mm, so writing has its true physical size on the tablet at scale 1).
 *
 * Points are batched the way the tablet bridge batches pen samples: every `batchMs` (16 ms,
 * ~60 Hz), each batch due when its last point was drawn. {@link dueAt} says when to send any
 * message; perform.ts sends them on that schedule.
 */

import type { HandResult, Stroke } from './simulate'

/** The Paper Pro page in millimetres (1620 × 2160 px at 229 ppi). */
export const PAPER_PRO_MM: [number, number] = [179.6, 239.5]

/** Where and how strokes land in a session. */
export interface ProtocolOptions {
  /** stroke id prefix; ids are `${idPrefix}${run}_${n}` (default `ai_hand_`) */
  idPrefix?: string
  /** run tag inside ids, unique per performance (default: startTs in base 36) */
  run?: string
  /** protocol layer (default `ai`) */
  layer?: 'ai' | 'peer' | 'user'
  /** brush hint (default `pen`) */
  brush?: string
  /** ink colour hint, e.g. `#7c5cff` */
  color?: string
  /** participant id, sent with the colour */
  author?: string
  /** normalized page position of the start of the first baseline (default [0.1, 0.25]) */
  origin?: [number, number]
  /** magnification of the simulated millimetres (default 1: true size on a Paper Pro) */
  scale?: number
  /** page size, mm (default {@link PAPER_PRO_MM}) */
  page?: [number, number]
  /** Unix ms of the performance's t = 0 (default: now) */
  startTs?: number
  /** point batch interval, ms (default 16) */
  batchMs?: number
}

/** The messages this module produces. */
export type HandMessage =
  | { t: 'stroke_begin'; id: string; layer: string; brush: string; ts: number; color?: string; author?: string }
  | { t: 'stroke_pts'; id: string; pts: [number, number, number, number][] }
  | { t: 'stroke_end'; id: string; ts: number }

const clamp01 = (v: number) => Math.min(1, Math.max(0, v))
const r5 = (v: number) => Math.round(v * 1e5) / 1e5
const r3 = (v: number) => Math.round(v * 1e3) / 1e3

/** The id of stroke `n` of a run. */
export function strokeId(n: number, opts: ProtocolOptions, startTs: number): string {
  return `${opts.idPrefix ?? 'ai_hand_'}${opts.run ?? startTs.toString(36)}_${n}`
}

/**
 * The messages for one stroke: begin, ~60 Hz point batches, end. `startTs` is the Unix ms of the
 * performance's t = 0 (a player that pauses shifts it for later strokes).
 */
export function strokeMessages(s: Stroke, n: number, opts: ProtocolOptions, startTs: number): HandMessage[] {
  const [ox, oy] = opts.origin ?? [0.1, 0.25]
  const scale = opts.scale ?? 1
  const [pw, ph] = opts.page ?? PAPER_PRO_MM
  const batch = opts.batchMs ?? 16
  const id = strokeId(n, opts, startTs)
  const begin: HandMessage = { t: 'stroke_begin', id, layer: opts.layer ?? 'ai', brush: opts.brush ?? 'pen', ts: startTs + s.down }
  if (opts.color) begin.color = opts.color
  if (opts.author) begin.author = opts.author
  const out: HandMessage[] = [begin]
  let cur: [number, number, number, number][] = []
  let due = s.down + batch
  for (const [x, y, p, t] of s.pts) {
    if (t >= due && cur.length) {
      out.push({ t: 'stroke_pts', id, pts: cur })
      cur = []
      while (due <= t) due += batch
    }
    cur.push([r5(clamp01(ox + (scale * x) / pw)), r5(clamp01(oy + (scale * y) / ph)), r3(clamp01(p)), startTs + t])
  }
  if (cur.length) out.push({ t: 'stroke_pts', id, pts: cur })
  out.push({ t: 'stroke_end', id, ts: startTs + s.up })
  return out
}

/** Every message of a simulation, in sending order. */
export function toProtocol(result: HandResult | Stroke[], opts: ProtocolOptions = {}): HandMessage[] {
  const strokes = Array.isArray(result) ? result : result.strokes
  const startTs = opts.startTs ?? Date.now()
  return strokes.flatMap((s, n) => strokeMessages(s, n, opts, startTs))
}

/** When a message is due, Unix ms: its ts, or a point batch's last point's. */
export function dueAt(m: HandMessage): number {
  return m.t === 'stroke_pts' ? m.pts[m.pts.length - 1][3] : m.ts
}

/**
 * JSON Lines for `scripts/dev/replay_to.py`: one `{"ts": <due ms>, "msg": {...}}` per line.
 * (replay_to compresses pauses: it waits a third less than the gaps, at most 0.3 s; the CLI's
 * own `--ws` streams at the true timing.)
 */
export function toJsonl(messages: HandMessage[]): string {
  return messages.map((m) => JSON.stringify({ ts: dueAt(m), msg: m })).join('\n') + '\n'
}
