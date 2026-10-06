/**
 * Performing a simulation in real time, without talking over the user.
 *
 * codrawer's AI is a co-thinker that "does not talk over you while you are mid-thought"
 * (alifjakir.com/codrawer). The simulator's timeline is computed ahead; this player sends it on
 * the clock and *yields*: before each stroke it asks `userActive()`, and while the user is
 * writing, and for a `lull` after they stop, it holds the pen up. When the lull comes it
 * continues where it left off, and every later timestamp shifts by the time it waited, so the
 * ink's own rhythm is kept.
 *
 * Yielding happens at stroke boundaries, mid-phrase or mid-word: a stroke already begun is
 * finished (a pen-down cut in half reads as a glitch, not as courtesy), and strokes are short:
 * a print letter's stroke lasts a fraction of a second, a cursive word a second or two.
 *
 * The clock is injected (`now`, `sleep`) so tests drive it virtually; by default it is the
 * wall clock.
 */

import { dueAt, strokeMessages, type HandMessage, type ProtocolOptions } from './protocol'
import type { HandResult } from './simulate'

/** What the player needs from its surroundings. */
export interface PerformOptions extends ProtocolOptions {
  /** deliver one message (a WebSocket send, a file write, a test's array push) */
  send: (m: HandMessage) => void | Promise<void>
  /** the clock, Unix ms (default Date.now) */
  now?: () => number
  /** wait (default setTimeout) */
  sleep?: (ms: number) => Promise<void>
  /** is the user writing right now? (default: never) */
  userActive?: () => boolean
  /** quiet the user must leave before the hand resumes, ms (default 1500) */
  lull?: number
  /** how often to look at `userActive` while waiting, ms (default 50) */
  poll?: number
  /** stop early */
  signal?: AbortSignal
  /** told when the hand starts writing, starts yielding, or finishes */
  onState?: (s: 'writing' | 'yielding' | 'done', at: number) => void
}

/** What a performance did. */
export interface Performance {
  /** messages sent */
  sent: number
  /** total time spent yielding to the user, ms */
  yielded: number
  /** Unix ms of the performance's t = 0 (ids and timestamps derive from it) */
  startTs: number
}

/** Play `result` in real time through `opts.send`, yielding to the user (see the overview). */
export async function perform(result: HandResult, opts: PerformOptions): Promise<Performance> {
  const now = opts.now ?? (() => Date.now())
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const active = opts.userActive ?? (() => false)
  const lull = opts.lull ?? 1500
  const poll = opts.poll ?? 50
  const startTs = opts.startTs ?? now()
  const run = opts.run ?? startTs.toString(36)
  let offset = 0 // ms the schedule has shifted by yielding
  let yielded = 0
  let sent = 0
  let lastActive = -Infinity
  const look = () => {
    if (active()) lastActive = now()
  }
  const aborted = () => opts.signal?.aborted === true
  /** wait until `until` (Unix ms), watching the user meanwhile */
  const waitUntil = async (until: number) => {
    for (let t = now(); t < until && !aborted(); t = now()) {
      look()
      await sleep(Math.min(poll, until - t))
    }
  }
  opts.onState?.('writing', now())
  for (let n = 0; n < result.strokes.length && !aborted(); n++) {
    const s = result.strokes[n]
    // the pen-up before this stroke runs on schedule while the user is quiet
    await waitUntil(startTs + offset + s.down)
    look()
    if (now() - lastActive < lull) {
      opts.onState?.('yielding', now())
      const from = now()
      while (!aborted() && now() - lastActive < lull) {
        await sleep(poll)
        look()
      }
      const waited = now() - from
      yielded += waited
      offset += Math.max(0, now() - (startTs + offset + s.down))
      opts.onState?.('writing', now())
    }
    const msgs = strokeMessages(s, n, { ...opts, run }, startTs + offset)
    for (let k = 0; k < msgs.length; k++) {
      const m = msgs[k]
      if (aborted()) {
        // never leave a stroke open on the clients
        if (k > 0) await opts.send({ t: 'stroke_end', id: m.id, ts: now() })
        break
      }
      const due = dueAt(m)
      const t = now()
      if (due > t) await sleep(due - t)
      await opts.send(m)
      sent++
    }
  }
  opts.onState?.('done', now())
  return { sent, yielded, startTs }
}
