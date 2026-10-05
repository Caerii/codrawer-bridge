/**
 * When to reconnect to the router: capped backoff, and patience with a router that refuses us.
 *
 * A phone on Wi-Fi loses the router often and briefly (the tablet sleeps, the phone changes
 * networks), so the ordinary case is a quick retry growing by 1.6× to a 5 s cap, back to 800 ms
 * once we are in. The other case is a router that wants a pairing code (the tablet's
 * ROUTER_TOKEN) we do not have or have wrong: it answers `error: unauthorized` and closes, and
 * retrying every second only fills its log. Refusals therefore stretch the next retry to
 * 5 s × the number of refusals in a row, up to 30 s, until a `hello` says we are accepted.
 *
 * This module is pure (no sockets, no clock of its own) so the policy can be tested; link.ts
 * feeds it the connection's events and asks it for delays. All times are milliseconds.
 */
export class ReconnectPolicy {
  /** Delay before the next attempt, ms. */
  retryMs = 800
  /** Consecutive pairing refusals (0 once a `hello` arrives). */
  refusedStreak = 0
  /** performance.now() of the first refusal in the current streak, ms (0: none). */
  refusedSince = 0

  /** The URL would not even construct a WebSocket: grow the delay and return it. */
  delayAfterBadUrl(): number {
    this.retryMs = Math.min(5000, this.retryMs * 1.6)
    return this.retryMs
  }

  /** The socket opened. A refused client keeps its long delay until it is actually accepted. */
  opened() {
    this.retryMs = this.refusedStreak > 0 ? this.retryMs : 800
  }

  /**
   * The socket closed: the delay before the next attempt. A refused client waits 5 s, growing
   * with the streak to 30 s; the delay after that one grows by 1.6× to the ordinary 5 s cap.
   */
  delayAfterClose(): number {
    if (this.refusedStreak > 0) this.retryMs = Math.max(this.retryMs, Math.min(30_000, 5000 * this.refusedStreak))
    const delay = this.retryMs
    this.retryMs = Math.min(5000, this.retryMs * 1.6)
    return delay
  }

  /** `hello`: the router let us in. */
  accepted() {
    this.refusedStreak = 0
    this.refusedSince = 0
    this.retryMs = 800
  }

  /** `error: unauthorized` at time `now` (ms). */
  refused(now: number) {
    this.refusedStreak++
    if (!this.refusedSince) this.refusedSince = now
  }

  /**
   * A new pairing code was entered: try it almost at once. The earlier refusals were for the old
   * (or missing) code, so the streak starts over — otherwise the refusal backoff would still hold
   * the retry for 5 s or more.
   */
  retrySoon() {
    this.refusedStreak = 0
    this.refusedSince = 0
    this.retryMs = 300
  }

  /**
   * Is this copy of the app a stale one that should let go of the glasses? A copy that keeps
   * being refused while in the background (3+ refusals over 45 s or more) was almost always opened
   * before a new QR with the pairing code, and it still holds the glasses display, so the copy
   * you are looking at cannot get it. The copy on screen (`hidden` false) never qualifies: it asks
   * for the code instead.
   */
  isStaleCopy(now: number, hidden: boolean): boolean {
    if (!hidden) return false
    return this.refusedStreak >= 3 && now - this.refusedSince >= 45_000
  }
}
