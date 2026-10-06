/**
 * Playout: agent ink drawn at the pace it was written, however it arrives.
 *
 * An agent writing with packages/hand stamps every point with the time its simulated hand put it
 * down (docs/protocol.md: points are `[x, y, p, t]`, t Unix ms). Streamed live (the hand CLI, the
 * hand lab) the points already arrive at that pace and the stage draws them as they come. But an
 * agent may also post a whole turn at once, or the network may bunch batches together; drawn on
 * arrival, a sentence would then appear in one frame and the hand's rhythm, its pauses and
 * hesitations, would be lost. The protocol says clients may animate AI strokes; this module
 * decides *when* each point of an `ai` stroke shows.
 *
 * Each timed AI stroke gets an offset, local clock minus sender clock, fixed when its first
 * points arrive: the point stamped t shows at t + offset. A stroke that arrives while earlier AI
 * ink is still playing keeps the running offset (so a burst plays in sequence, gaps included);
 * one that arrives after everything has played anchors afresh at its arrival (so a live stream
 * plays with about one batch of delay, the jitter buffer ADR 008 asks for, and clock skew
 * between machines never matters). Strokes without sender times, and other layers, show at once.
 */

/** Offsets for timed AI strokes. Times are ms; `now` is this device's Unix ms. */
export class Playout {
  private offset = 0
  /** local time the last scheduled point is due */
  private busyUntil = -Infinity

  /** The offset for a stroke whose first point is stamped `t0`, arriving at `now`. */
  start(t0: number, now: number): number {
    const lag = now - t0
    this.offset = now >= this.busyUntil ? lag : Math.max(this.offset, lag)
    return this.offset
  }

  /** A point stamped `t` was scheduled with `offset`. */
  extend(t: number, offset: number): void {
    this.busyUntil = Math.max(this.busyUntil, t + offset)
  }

  /** Whether anything scheduled is still to show at `now`. */
  pending(now: number): boolean {
    return now < this.busyUntil
  }

  /** Forget the schedule (a clear). */
  reset(): void {
    this.offset = 0
    this.busyUntil = -Infinity
  }
}

/** How many of a stroke's points show at `now`: those with times[i] + offset ≤ now. */
export function visibleCount(times: number[], offset: number, now: number): number {
  let lo = 0, hi = times.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (times[mid] + offset <= now) lo = mid + 1
    else hi = mid
  }
  return lo
}
