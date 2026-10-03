/**
 * The frame scheduler: what goes over the link to the glasses' two image containers, and when.
 *
 * The constraint everything here follows from (ADR 006): an image update costs ~200 ms whatever
 * its size, it rides one link, and the glasses refuse two at once (the phone host answers
 * `sendFailed` to overlapping updates). Sending every change would queue seconds of stale frames
 * behind the pen. Instead each container has a **slot** that holds at most one frame, the latest:
 *
 *   loupe   small and frequent: the live window around the pen
 *   canvas  big and rare: the page, after the writing pauses
 *
 * A single drain loop serves the slots, loupe first, one send at a time. A slot may send again
 * once its previous send has completed and its floor (`minMs`) has passed since that send
 * started; the measured round trip (`rt`) is part of the gate, so a slow link degrades to a lower
 * frame rate, never to lag.
 *
 * Two refinements keep the frames fresh and the link quiet:
 *
 * - **Just in time.** A slot may hold a recipe instead of a frame; the drain runs it at the moment
 *   the link is free, so the frame shows the pen where it is at send time, not where it was up to
 *   ~65 ms earlier (50 ms tick + 15 ms poll) when it was queued.
 * - **Dedupe.** A frame identical to the one the container already shows is never sent. After a
 *   failed send we no longer know what it shows, so the next frame always goes.
 *
 * The scheduler knows nothing of the SDK: it is given a `transmit` function (glasses/display.ts
 * wraps `updateImageRawData`) and can be tested with a fake one. Times are performance.now() ms.
 */

/** An image container on the glasses. */
export type Slot = 'loupe' | 'canvas'

/** An encoded frame: bytes (sent as a number array), or a base64 string (`?enc=b64`). */
export type Frame = Uint8Array | string

/** Slots in drain priority order: the small live view first. */
const SLOTS: Slot[] = ['loupe', 'canvas']

/** Whether two frames are byte-for-byte the same (`a` null: nothing known, never the same). */
export function sameFrame(a: Frame | null, b: Frame): boolean {
  if (a === null || typeof a !== typeof b) return false
  if (typeof a === 'string') return a === b
  const x = a as Uint8Array
  const y = b as Uint8Array
  if (x.length !== y.length) return false
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false
  return true
}

export interface SchedulerOptions {
  /** Per-slot floor between the starts of two sends, ms. */
  minMs: Record<Slot, number>
  /** Sends allowed on the wire at once (1 on real glasses; see config INFLIGHT). */
  inflight: number
  /** Send one frame; resolves with the host's result ('success' or a reason), throws on failure. */
  transmit: (slot: Slot, frame: Frame) => Promise<string>
  /** Whether the page currently has image containers (false in the text and editor layouts). */
  hasImages: () => boolean
  /** Appended to the periodic perf log line (e.g. "fmt=png1 inflight=1"). */
  label: string
  now?: () => number
}

export class FrameScheduler {
  /** Last measured round trip per slot, ms (0 when several sends overlap: it no longer paces). */
  readonly rt: Record<Slot, number> = { loupe: 0, canvas: 0 }
  /** Sends started per slot since load (the HUD's `L…/n · C…/n`). */
  readonly sent: Record<Slot, number> = { loupe: 0, canvas: 0 }
  /** The host's answer to the last send ('success', a failure reason, or 'error' if it threw). */
  lastResult = ''

  private pending: Record<Slot, Frame | null> = { loupe: null, canvas: null }
  private produce: Record<Slot, (() => Frame) | null> = { loupe: null, canvas: null }
  private lastPushAt: Record<Slot, number> = { loupe: 0, canvas: 0 } // when the last send started
  private lastFrame: Record<Slot, Frame | null> = { loupe: null, canvas: null } // what the container shows
  private stats: Record<Slot, { n: number; ms: number; bytes: number }> = { loupe: { n: 0, ms: 0, bytes: 0 }, canvas: { n: 0, ms: 0, bytes: 0 } }
  private statsAt: number
  private draining = false
  private inFlight = 0
  private now: () => number

  constructor(private o: SchedulerOptions) {
    this.now = o.now ?? (() => performance.now())
    this.statsAt = this.now()
  }

  /** Queue a finished frame for a slot, unless the container already shows exactly that. */
  offer(slot: Slot, frame: Frame) {
    if (sameFrame(this.lastFrame[slot], frame)) return
    this.pending[slot] = frame
    void this.drain()
  }

  /** Queue a recipe for a slot: it is drawn and encoded only when the link is free. */
  want(slot: Slot, recipe: () => Frame) {
    this.produce[slot] = recipe
    void this.drain()
  }

  /** Drop everything queued (a layout switch makes it moot). */
  clear() {
    this.pending.loupe = null
    this.pending.canvas = null
    this.produce.loupe = null
    this.produce.canvas = null
  }

  /** Forget what the containers show (a page rebuild blanks them), so nothing is deduped away. */
  forgetShown() {
    this.lastFrame.loupe = this.lastFrame.canvas = null
  }

  /** A send is on the wire or the drain loop is running: never rebuild the page now. */
  get busy(): boolean {
    return this.draining || this.inFlight > 0
  }

  /** When the slot's last send started, ms (0: never). */
  startedAt(slot: Slot): number {
    return this.lastPushAt[slot]
  }

  /**
   * The slot that may send now, by priority, or null. A slot is ready once its previous send has
   * completed and max(minMs, rt) has passed since that send started: awaiting the call already
   * serializes on the link, so waiting the measured round trip again after completion would halve
   * the frame rate.
   */
  readySlot(): Slot | null {
    const now = this.now()
    for (const s of SLOTS) {
      if ((this.pending[s] || this.produce[s]) && now - this.lastPushAt[s] >= Math.max(this.o.minMs[s], this.rt[s])) return s // rt: the send has completed
    }
    return null
  }

  /** ms until some wanted slot may send (an exact wait instead of polling); 1..50. */
  msUntilReady(): number {
    const now = this.now()
    let wait = 50
    for (const s of SLOTS) {
      if (this.pending[s] || this.produce[s]) wait = Math.min(wait, this.lastPushAt[s] + Math.max(this.o.minMs[s], this.rt[s]) - now)
    }
    return Math.max(1, Math.ceil(wait))
  }

  /**
   * The drain loop: while anything is queued, wait for a ready slot, take its frame (running a
   * recipe now if it holds one), skip it if the container already shows it, and send it. Only one
   * loop runs at a time; with no image containers on the page the queue is simply dropped.
   * Resolves when the queue is empty and nothing is in flight.
   */
  async drain() {
    if (this.draining) return
    if (!this.o.hasImages()) {
      this.clear()
      return
    }
    this.draining = true
    try {
      while (this.pending.loupe || this.pending.canvas || this.produce.loupe || this.produce.canvas) {
        const slot = this.inFlight < this.o.inflight ? this.readySlot() : null
        if (!slot) {
          await new Promise((r) => setTimeout(r, this.inFlight ? 5 : this.msUntilReady()))
          continue
        }
        let frame = this.pending[slot]
        this.pending[slot] = null
        const recipe = this.produce[slot]
        if (recipe) {
          this.produce[slot] = null
          frame = recipe() // drawn now, with the latest points
          if (sameFrame(this.lastFrame[slot], frame)) continue // nothing new to show
        }
        if (!frame) continue
        this.lastFrame[slot] = frame
        const sending = this.send(slot, frame)
        if (this.o.inflight === 1) await sending
      }
      while (this.inFlight) await new Promise((r) => setTimeout(r, 5))
    } finally {
      this.draining = false
    }
  }

  /** One send, with its bookkeeping: start time, round trip, counters, result. */
  private async send(slot: Slot, frame: Frame) {
    this.inFlight++
    const t0 = this.now()
    this.lastPushAt[slot] = t0
    try {
      this.lastResult = await this.o.transmit(slot, frame)
    } catch (e) {
      this.lastResult = 'error'
      this.lastFrame[slot] = null // unknown what the glasses show; never skip the next frame
      console.error('[codrawer] image update threw', slot, e)
    } finally {
      const ms = this.now() - t0
      // With several in flight the round trip no longer paces the slot; minMs still does.
      this.rt[slot] = this.o.inflight === 1 ? ms : 0
      this.sent[slot]++
      this.stats[slot].n++
      this.stats[slot].ms += ms
      this.stats[slot].bytes += frame.length
      this.inFlight--
      this.logStats()
    }
  }

  /** Every 5 s while sending, one console line per slot: fps, ms per send, bytes per frame. */
  private logStats() {
    const now = this.now()
    if (now - this.statsAt < 5000) return
    const secs = (now - this.statsAt) / 1000
    const parts = SLOTS.filter((k) => this.stats[k].n).map(
      (k) => `${k} ${(this.stats[k].n / secs).toFixed(1)} fps ${Math.round(this.stats[k].ms / this.stats[k].n)} ms ${Math.round(this.stats[k].bytes / this.stats[k].n)} B`,
    )
    if (parts.length) console.log(`[codrawer] perf ${parts.join(' | ')} (${this.o.label})`)
    for (const k of SLOTS) this.stats[k] = { n: 0, ms: 0, bytes: 0 }
    this.statsAt = now
  }
}
