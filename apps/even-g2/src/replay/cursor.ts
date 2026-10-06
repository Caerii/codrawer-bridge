/**
 * The replay cursor: the page as it stood at timeline ms t, as a stroke store every renderer
 * already knows how to draw.
 *
 * ## Why a store, not pixels
 *
 * The page at t must look exactly as it looked then: peers in their colours, agent ink in its
 * style, and the tablet's eraser cutting ink the way it did. All of that already lives in the
 * stroke store (strokes.ts): erasing is data there (each eraser point marks the ink it passes over
 * `gone`, erase.ts), so the phone stage and the glasses rasterizer draw the survivors with no
 * further knowledge. The cursor therefore *re-performs* the timeline into a fresh
 * {@link StrokeStore}, message by message as the router would have delivered it: the saved page
 * first (`applyPage`), then for each stroke in drawing order a `begin`, its points due by t, and
 * an `end` once all are due and it was finished; strokes taken back by t are removed. The stage
 * and the glasses then draw that store instead of the live one (phone/replay.ts).
 *
 * ## Cost
 *
 * Moving forward is incremental: only points newly due are fed, and an eraser's new points cut
 * through the store's grid index (erase.ts), so playback costs what the live session cost. Moving
 * backward rebuilds from t = 0, which is linear in the points up to t (a page of tens of thousands
 * of points rebuilds in milliseconds); the replay bar asks for at most one seek per animation frame.
 *
 * Points are fed without their times ([x, y, p]): agent ink with sender times would otherwise be
 * re-paced by playout.ts, and the timeline already paces it.
 *
 * Pure: no DOM, no configuration (test/replay.test.ts).
 */
import type { Box } from '../erase'
import { StrokeStore, type PageMessage } from '../strokes'
import { revealed, type Timeline } from './timeline'

/** What a {@link ReplayCursor.seek} changed, for the renderer. */
export interface SeekResult {
  /** the store was rebuilt from scratch (moving back, or the first seek): redraw everything */
  rebuilt: boolean
  /** a normalized region whose ink an eraser cut on the way (repaint it), or null */
  erased: Box | null
  /** anything changed at all */
  changed: boolean
}

export class ReplayCursor {
  /** The page at {@link t}. Replaced on a rebuild: read it after each seek. */
  store = new StrokeStore()
  /** timeline ms the store shows (−1 before the first seek) */
  t = -1
  private fed: number[] = [] // points fed per stroke
  private ended: boolean[] = []
  private removed: boolean[] = []

  /**
   * @param tl the timeline to perform
   * @param eraseRadius the eraser's radius, page px (the live store's, so cuts match it)
   */
  constructor(
    readonly tl: Timeline,
    private eraseRadius?: number,
  ) {}

  /** Bring the store to timeline ms `t`. */
  seek(t: number): SeekResult {
    let rebuilt = false
    if (this.t < 0 || t < this.t) {
      this.reset()
      rebuilt = true
    }
    if (t === this.t && !rebuilt) return { rebuilt, erased: null, changed: false }
    const store = this.store
    const strokes = this.tl.strokes
    let erased: Box | null = null
    let changed = rebuilt
    const gone: string[] = []
    for (let i = 0; i < strokes.length; i++) {
      const s = strokes[i]
      if (this.removed[i]) continue
      const storeId = s.base && !s.id.startsWith('rm:') ? 'rm:' + s.id : s.id // applyPage's ids
      if (s.removedAt !== undefined && s.removedAt <= t) {
        this.removed[i] = true
        if (s.base || this.fed[i] > 0) gone.push(storeId)
        continue
      }
      if (s.base) continue // on the page from the start (reset)
      const n = revealed(s, t)
      if (n > this.fed[i]) {
        if (this.fed[i] === 0) store.begin(s.id, s.layer, s.brush, undefined, s.layer !== 'user' ? { color: s.color, author: s.author } : undefined)
        const box = store.points(
          s.id,
          s.pts.slice(this.fed[i], n).map((p) => [p[0], p[1], p[2]]),
          s.layer,
        )
        if (box) erased = erased ? [Math.min(erased[0], box[0]), Math.min(erased[1], box[1]), Math.max(erased[2], box[2]), Math.max(erased[3], box[3])] : box
        this.fed[i] = n
        changed = true
      }
      if (!this.ended[i] && s.ended && this.fed[i] === s.pts.length && s.pts.length > 0) {
        store.end(s.id)
        this.ended[i] = true
        changed = true
      }
    }
    if (gone.length && store.remove(gone).length) {
      changed = true
      rebuilt = true // a removal is a redraw of everything (as stroke_delete is live)
    }
    this.t = t
    return { rebuilt, erased: rebuilt ? null : erased, changed }
  }

  /** A fresh store holding the saved page (the timeline's base strokes), nothing fed yet. */
  private reset() {
    const store = new StrokeStore()
    if (this.eraseRadius !== undefined) store.eraseRadius = this.eraseRadius
    const base = this.tl.strokes.filter((s) => s.base)
    if (base.length) {
      const page: PageMessage = {
        t: 'page',
        doc: 'replay',
        page: 'replay',
        rev: 0,
        strokes: base.map((s) => ({
          id: s.id.startsWith('rm:') ? s.id.slice(3) : s.id,
          tool: s.tool,
          rgba: s.color,
          size: s.size,
          layer: s.layer === 'ai' ? 'ai' : undefined,
          pts: s.pts,
        })),
      }
      store.applyPage(page)
    }
    this.store = store
    const n = this.tl.strokes.length
    this.fed = new Array(n).fill(0)
    this.ended = new Array(n).fill(false)
    this.removed = new Array(n).fill(false)
    this.t = 0
  }
}
