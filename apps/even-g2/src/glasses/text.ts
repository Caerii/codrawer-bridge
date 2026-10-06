/**
 * Pacing for the glasses' text container: keys show as fast as the link allows, and nothing else
 * gets in the way of ink.
 *
 * A text update is cheaper than an image (one host call, ~60–80 ms measured; ADR 006) but it
 * rides the same link as the ink frames, and the host refuses overlapping calls. The rules:
 *
 * - Unchanged content is never resent.
 * - **One update in flight, always the newest text.** At most one call is on the wire. Content
 *   offered while one is in flight replaces whatever was waiting (only the newest is worth
 *   showing) and goes the moment the call returns, without waiting for the render loop. So keys
 *   typed during an update are coalesced into the next one, and calls never overlap.
 * - **Typing** (a key within the last {@link TYPING_MS}): no other floor. The line follows the
 *   keys at the link's own pace (one update per ~70 ms round trip), and ink does not hold it back:
 *   the hand is on the keyboard, not the pen. The caller offers text on the key event itself
 *   (loop.ts `flushText`), not on the next 50 ms tick.
 * - **Otherwise** (ADR 006, "text never competes with ink"): while ink is flowing, including the
 *   short gaps between handwritten letters ({@link INK_LULL_MS}), text waits; and at most one
 *   update every {@link QUIET_FLOOR_MS}.
 * - The very first line (replacing the layout's "connecting…") always goes out at once.
 *
 * A deferred push returns false and the caller (the render loop) simply offers again next tick, so
 * the newest content is what eventually goes. Measured in the simulator with the G2's text cost
 * (scripts/dev/keylat.py, docs/investigations/keyboard-latency.md). Times are performance.now() ms.
 */

/** Ink counts as still flowing for this long after the last stroke message, ms. */
export const INK_LULL_MS = 700
/** Names this pacing in latency traces (keylat.ts). */
export const PACING = 'inflight1'
/** A keystroke this recent means the user is typing, ms. */
export const TYPING_MS = 1500
/** Minimum spacing between the starts of two text updates when not typing, ms. */
export const QUIET_FLOOR_MS = 2000

/** What the pacing looks at, all performance.now() ms. */
export interface TextPace {
  typingAt: number
  inkActive: boolean
  lastInkAt: number
}

export class TextPusher {
  /** The content of the last update started ('' after {@link forget}: nothing known). */
  private lastSent = ''
  /** When that update started. */
  private lastAt = 0
  private inFlight = false
  /** The newest content offered while a call was in flight, and when it was offered. */
  private waiting: { content: string; at: number } | null = null

  constructor(
    /**
     * Send the content to the text container (glasses/display.ts wraps textContainerUpgrade);
     * `renderedAt` is when the content was offered, for latency tracing (keylat.ts).
     */
    private transmit: (content: string, renderedAt: number) => Promise<unknown>,
    private now: () => number = () => performance.now(),
  ) {}

  /**
   * Offer `content`. True: it went, will go when the call in flight returns, or is already shown;
   * false: deferred by the pacing (offer again later).
   */
  push(content: string, pace: TextPace): boolean {
    const target = this.waiting?.content ?? this.lastSent // what the glasses will show next
    if (content === target) return true
    const now = this.now()
    if (this.lastSent !== '') {
      const typing = now - pace.typingAt < TYPING_MS
      if (!typing && (pace.inkActive || now - pace.lastInkAt < INK_LULL_MS)) return false
      if (!typing && now - this.lastAt < QUIET_FLOOR_MS) return false
    }
    if (this.inFlight) this.waiting = { content, at: now }
    else this.start(content, now)
    return true
  }

  /**
   * Forget what the container shows: something else overwrote it (a page rebuild carried fresh
   * content, the link probe wrote its own lines), so the next content goes out unconditionally.
   */
  forget() {
    this.lastSent = ''
  }

  /** Put `content` on the wire; when the call returns, send whatever newer content waited. */
  private start(content: string, at: number) {
    this.inFlight = true
    this.lastSent = content
    this.lastAt = this.now()
    void (async () => {
      try {
        await this.transmit(content, at)
      } catch (e) {
        console.error('[codrawer] text update threw', e)
      }
      this.inFlight = false
      const next = this.waiting
      this.waiting = null
      if (next && next.content !== this.lastSent) this.start(next.content, next.at)
    })()
  }
}
