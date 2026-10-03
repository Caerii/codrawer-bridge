/**
 * Pacing for the glasses' text container: send only real changes, and never in the way of ink.
 *
 * A text update is cheaper than an image (one host call, ~60–80 ms measured; ADR 006) but it
 * rides the same link as the ink frames, so while the pen is moving it would delay the loupe by
 * that much on every update. The rules (ADR 006, "text never competes with ink"):
 *
 * - Unchanged content is never resent.
 * - While ink is flowing, including the short gaps between handwritten letters
 *   ({@link INK_LULL_MS}), text waits.
 * - At most one update every 2 s, except while typing (a key within the last 1.5 s), where the
 *   line must follow the keys: then the floor is 150 ms and ink does not hold it back.
 * - The very first line (replacing the layout's "connecting…") always goes out at once.
 *
 * A deferred push returns false and the caller (the render loop) simply tries again next tick, so
 * the newest content is what eventually goes. Updates are chained, never overlapped.
 * Times are performance.now() ms.
 */

/** Ink counts as still flowing for this long after the last stroke message, ms. */
export const INK_LULL_MS = 700
/** A keystroke this recent means the user is typing, ms. */
const TYPING_MS = 1500
/** Minimum spacing between text updates while typing / otherwise, ms. */
const TYPING_FLOOR_MS = 150
const QUIET_FLOOR_MS = 2000

/** What the pacing looks at, all performance.now() ms. */
export interface TextPace {
  typingAt: number
  inkActive: boolean
  lastInkAt: number
}

export class TextPusher {
  private lastSent = ''
  private lastAt = 0
  private chain: Promise<void> = Promise.resolve()

  constructor(
    /** Send the content to the text container (glasses/display.ts wraps textContainerUpgrade). */
    private transmit: (content: string) => Promise<unknown>,
    private now: () => number = () => performance.now(),
  ) {}

  /** Send `content` if due. False: deferred (call again later); true: sent or unchanged. */
  push(content: string, pace: TextPace): boolean {
    if (content === this.lastSent) return true
    if (this.lastSent !== '') {
      const now = this.now()
      const typing = now - pace.typingAt < TYPING_MS
      if (!typing && (pace.inkActive || now - pace.lastInkAt < INK_LULL_MS)) return false
      if (now - this.lastAt < (typing ? TYPING_FLOOR_MS : QUIET_FLOOR_MS)) return false
    }
    this.lastSent = content
    this.lastAt = this.now()
    this.chain = this.chain.then(async () => {
      try {
        await this.transmit(content)
      } catch (e) {
        console.error('[codrawer] text update threw', e)
      }
    })
    return true
  }

  /**
   * Forget what the container shows: something else overwrote it (a page rebuild carried fresh
   * content, the link probe wrote its own lines), so the next content goes out unconditionally.
   */
  forget() {
    this.lastSent = ''
  }
}
