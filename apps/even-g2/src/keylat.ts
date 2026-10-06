/**
 * Keystroke latency tracing: how long each key waits on the phone before the glasses show it.
 *
 * The keyboard path ends here (scripts/dev/keylat.py has the whole map): a `key` message arrives
 * from the router, the line editor changes the text, the text pacing (glasses/text.ts) decides
 * when an update goes, and one host call puts it on the glasses (~60–80 ms; ADR 006). Only the
 * phone sees the last three steps, so it measures them itself, per key, on performance.now():
 *
 *   wait    key received → the text update that carries it starts
 *   glass   that update's start → the host's answer
 *   total   key received → the host's answer (what the wearer waits once the phone has the key)
 *   net     the bridge's `ts` → receive, on the two wall clocks (meaningful only when they agree,
 *           e.g. a local router and simulator on one PC; the harness aligns real clocks itself)
 *
 * A text update carries a key when its content was rendered after the key arrived. Keys that
 * change nothing on the glasses (an arrow at the end of the line, a modifier chord) are never
 * carried; they are dropped once {@link STALE_MS} old instead of being charged to a later update.
 *
 * Records are batched (one console line per {@link BATCH} keys or {@link BATCH_MS}) so tracing
 * adds no per-key traffic: dev builds forward the console to the desktop (phone/devlog.ts), where
 * `keylat.py phonelog` picks the `[keylat] {…}` lines out of `.codrawer/logs/phone.log`.
 * Times are ms.
 */

/** A key not carried by an update within this long changed nothing visible; forget it, ms. */
export const STALE_MS = 2000
/** Keys per logged batch, and the longest a partial batch waits, ms. */
const BATCH = 16
const BATCH_MS = 5000

/** One logged batch: parallel arrays, one entry per carried key, ms. */
export interface KeyLatencyBatch {
  /** Which pacing produced these numbers (glasses/text.ts PACING). */
  v: string
  net: (number | null)[]
  wait: number[]
  glass: number[]
  total: number[]
}

interface PendingKey {
  recv: number
  net: number | null
}

export class KeyLatency {
  private pending: PendingKey[] = []
  private batch: KeyLatencyBatch
  private lastFlush: number

  constructor(
    private version: string,
    private sink: (b: KeyLatencyBatch) => void,
    private now: () => number = () => performance.now(),
    private wall: () => number = () => Date.now(),
  ) {
    this.batch = this.empty()
    this.lastFlush = this.now()
  }

  /** A `key` message arrived; `ts` is the bridge's wall-clock stamp, when present. */
  key(ts?: number) {
    this.pending.push({ recv: this.now(), net: typeof ts === 'number' ? this.wall() - ts : null })
  }

  /**
   * A text update starts now, carrying content rendered at `renderedAt`. Returns the callback to
   * run when the host answers (success or not: the wearer waited either way).
   */
  sending(renderedAt: number): () => void {
    const start = this.now()
    this.pending = this.pending.filter((k) => start - k.recv < STALE_MS)
    const carried = this.pending.filter((k) => k.recv <= renderedAt)
    if (!carried.length) return () => {}
    this.pending = this.pending.filter((k) => k.recv > renderedAt)
    return () => {
      const done = this.now()
      for (const k of carried) {
        this.batch.net.push(k.net === null ? null : Math.round(k.net))
        this.batch.wait.push(Math.round(start - k.recv))
        this.batch.glass.push(Math.round(done - start))
        this.batch.total.push(Math.round(done - k.recv))
      }
      if (this.batch.wait.length >= BATCH || done - this.lastFlush >= BATCH_MS) this.flush()
    }
  }

  /** Hand the current batch to the sink (if it has anything). */
  flush() {
    this.lastFlush = this.now()
    if (!this.batch.wait.length) return
    this.sink(this.batch)
    this.batch = this.empty()
  }

  private empty(): KeyLatencyBatch {
    return { v: this.version, net: [], wait: [], glass: [], total: [] }
  }
}
