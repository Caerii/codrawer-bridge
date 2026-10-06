/**
 * The paper: where the hand's ink appears, at the moment the hand puts it down.
 *
 * The lab never draws a stroke ahead of time. The player (main.ts) feeds the same protocol
 * messages a codrawer session would receive, and the paper reveals each stroke's points as their
 * `stroke_pts` arrive ({@link Paper.reveal}), painting only the new segments every frame. Width
 * follows pressure (a 0.18–0.93 mm nib, the range a client draws from `p`), or, in speed mode,
 * colour follows the pen's speed from slow indigo through ochre to fast vermilion.
 *
 * A second, transparent canvas carries what is not ink: the pen itself (a filled dot while it
 * touches the paper, a hollow ring while it hovers, which is where hesitation shows) and the
 * motor plan's intended path when asked for. The user's own strokes go on the ink layer, in
 * graphite.
 *
 * Coordinates: the simulator's millimetres map to CSS pixels by a fit of the whole text into the
 * page with a margin, at no more than 9 px/mm; canvases are sized in device pixels.
 */

import type { HandResult, Trace } from 'hand'

export type InkMode = 'pressure' | 'speed'

/** Slow → fast: indigo, teal, ochre, vermilion (mm/s 0 → 160). */
const HEAT: [number, [number, number, number]][] = [
  [0, [52, 50, 120]],
  [45, [38, 112, 128]],
  [90, [196, 146, 52]],
  [160, [196, 70, 44]],
]

function heat(v: number): string {
  for (let i = 1; i < HEAT.length; i++) {
    if (v <= HEAT[i][0] || i === HEAT.length - 1) {
      const [a, ca] = HEAT[i - 1], [b, cb] = HEAT[i]
      const u = Math.min(1, Math.max(0, (v - a) / (b - a)))
      return `rgb(${ca.map((c, k) => Math.round(c + (cb[k] - c) * u)).join(',')})`
    }
  }
  return 'rgb(196,70,44)'
}

const INK = '#23263a'
const GRAPHITE = 'rgba(120, 110, 96, 0.85)'

/** A stroke the user drew on the lab's paper, in mm, with Unix ms times. */
export interface UserStroke {
  pts: [number, number, number, number][]
}

export class Paper {
  mode: InkMode = 'pressure'
  showPlan = false
  /** px per mm and the offset of the mm origin, CSS px */
  s = 5
  ox = 24
  oy = 60
  private result: HandResult | null = null
  private trace: Trace | null = null
  private revealed: number[] = []
  private drawn: number[] = []
  private rules: number[] = []
  readonly user: UserStroke[] = []
  private dpr = 1

  constructor(
    private readonly ink: HTMLCanvasElement,
    private readonly over: HTMLCanvasElement,
  ) {
    new ResizeObserver(() => this.resize()).observe(ink)
    this.resize()
  }

  private get w() {
    return this.ink.clientWidth
  }
  private get h() {
    return this.ink.clientHeight
  }

  private resize() {
    this.dpr = Math.min(3, window.devicePixelRatio || 1)
    for (const c of [this.ink, this.over]) {
      c.width = Math.round(c.clientWidth * this.dpr)
      c.height = Math.round(c.clientHeight * this.dpr)
    }
    this.fit()
    this.repaint()
  }

  /** Wrap width for the simulator, mm: what fits the paper at a comfortable size. */
  wrapWidth(): number {
    return Math.max(50, Math.min(150, (this.w - 48) / 5.2))
  }

  /** A new performance: fit it to the page and start from blank (the user's strokes stay). */
  setResult(r: HandResult, rules: number[]) {
    this.result = r
    this.trace = r.trace ?? null
    this.revealed = r.strokes.map(() => 0)
    this.drawn = r.strokes.map(() => 0)
    this.rules = rules
    this.fit()
    this.repaint()
  }

  /** Show the first `count` points of stroke `n`. */
  reveal(n: number, count: number) {
    if (n >= 0 && n < this.revealed.length) this.revealed[n] = Math.min(count, this.result!.strokes[n].pts.length)
  }

  /** How many points of stroke `n` are showing. */
  shown(n: number): number {
    return this.revealed[n] ?? 0
  }

  /** CSS px → mm (for the user's pointer). */
  toMm(px: number, py: number): [number, number] {
    return [(px - this.ox) / this.s, (py - this.oy) / this.s]
  }

  private fit() {
    const r = this.result
    if (!r || !r.strokes.length) {
      this.s = Math.max(2.5, Math.min(9, this.w / 175))
      this.ox = 24
      this.oy = this.h * 0.35
      return
    }
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
    for (const s of r.strokes)
      for (const [x, y] of s.pts) {
        x0 = Math.min(x0, x); x1 = Math.max(x1, x)
        y0 = Math.min(y0, y); y1 = Math.max(y1, y)
      }
    const m = 22
    this.s = Math.max(1.5, Math.min(9, (this.w - 2 * m) / (x1 - x0 + 1e-9), (this.h - 2 * m - 18) / (y1 - y0 + 1e-9)))
    this.ox = m - x0 * this.s
    this.oy = (this.h - 18 - (y1 - y0) * this.s) / 2 - y0 * this.s
  }

  /** Repaint everything shown so far (after a resize or a mode change). */
  repaint() {
    const c = this.ink.getContext('2d')!
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    c.clearRect(0, 0, this.w, this.h)
    // faint rules on the lines the text uses, as on a lined notebook page
    c.strokeStyle = '#ebe3d1'
    c.lineWidth = 1
    for (const b of this.rules) {
      const y = Math.round(this.oy + b * this.s) + 0.5
      c.beginPath()
      c.moveTo(16, y)
      c.lineTo(this.w - 16, y)
      c.stroke()
    }
    for (const u of this.user) this.paintUser(c, u, 0)
    this.drawn = this.revealed.map(() => 0)
    this.paintNew()
  }

  /** Paint the segments revealed since the last frame. */
  paintNew() {
    const r = this.result
    if (!r) return
    const c = this.ink.getContext('2d')!
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    c.lineCap = 'round'
    c.lineJoin = 'round'
    r.strokes.forEach((s, n) => {
      const upto = this.revealed[n]
      let i = Math.max(1, this.drawn[n])
      if (upto === 1 && this.drawn[n] === 0) {
        // a single point (a dot's first sample): a round tap
        const [x, y, p] = s.pts[0]
        c.fillStyle = this.mode === 'speed' ? heat(0) : INK
        c.beginPath()
        c.arc(this.ox + x * this.s, this.oy + y * this.s, Math.max(0.6, ((0.18 + 0.75 * p) * this.s) / 2), 0, Math.PI * 2)
        c.fill()
      }
      for (; i < upto; i++) {
        const a = s.pts[i - 1], b = s.pts[i]
        const p = (a[2] + b[2]) / 2
        c.lineWidth = Math.max(0.6, (0.18 + 0.75 * p) * this.s)
        if (this.mode === 'speed') {
          const v = Math.hypot(b[0] - a[0], b[1] - a[1]) / Math.max(1e-3, (b[3] - a[3]) / 1000)
          c.strokeStyle = heat(v)
        } else c.strokeStyle = s.kind === 'strike' ? '#5d3a3a' : INK
        c.beginPath()
        c.moveTo(this.ox + a[0] * this.s, this.oy + a[1] * this.s)
        c.lineTo(this.ox + b[0] * this.s, this.oy + b[1] * this.s)
        c.stroke()
      }
      this.drawn[n] = Math.max(this.drawn[n], upto)
    })
  }

  /** Paint a user stroke from point `from` on. */
  paintUser(c: CanvasRenderingContext2D, u: UserStroke, from: number) {
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    c.strokeStyle = GRAPHITE
    c.lineCap = 'round'
    c.lineJoin = 'round'
    for (let i = Math.max(1, from); i < u.pts.length; i++) {
      const a = u.pts[i - 1], b = u.pts[i]
      c.lineWidth = Math.max(0.8, (0.2 + 0.6 * b[2]) * this.s)
      c.beginPath()
      c.moveTo(this.ox + a[0] * this.s, this.oy + a[1] * this.s)
      c.lineTo(this.ox + b[0] * this.s, this.oy + b[1] * this.s)
      c.stroke()
    }
  }

  /** Extend the user's current stroke on screen. */
  userDrew(u: UserStroke, from: number) {
    this.paintUser(this.ink.getContext('2d')!, u, from)
  }

  /** The overlay for this frame: the pen (at `pen`, mm; null when out of view) and the plan. */
  overlay(pen: { x: number; y: number; down: boolean } | null) {
    const c = this.over.getContext('2d')!
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    c.clearRect(0, 0, this.w, this.h)
    const r = this.result, tr = this.trace
    if (this.showPlan && r && tr) {
      c.strokeStyle = 'rgba(90, 79, 176, 0.55)'
      c.lineWidth = 1
      c.setLineDash([3, 3])
      r.strokes.forEach((_, n) => {
        const k = this.revealed[n]
        if (k < 2) return
        c.beginPath()
        const pts = tr.intended[n]
        c.moveTo(this.ox + pts[0][0] * this.s, this.oy + pts[0][1] * this.s)
        for (let i = 1; i < k; i++) c.lineTo(this.ox + pts[i][0] * this.s, this.oy + pts[i][1] * this.s)
        c.stroke()
      })
      c.setLineDash([])
    }
    if (pen) {
      const x = this.ox + pen.x * this.s, y = this.oy + pen.y * this.s
      if (pen.down) {
        c.fillStyle = 'rgba(90, 79, 176, 0.9)'
        c.beginPath()
        c.arc(x, y, 2.6, 0, Math.PI * 2)
        c.fill()
      } else {
        // hovering: a soft shadow below and a ring, as a raised pen tip looks
        c.fillStyle = 'rgba(60, 50, 30, 0.08)'
        c.beginPath()
        c.arc(x + 3, y + 4, 6, 0, Math.PI * 2)
        c.fill()
        c.strokeStyle = 'rgba(90, 79, 176, 0.75)'
        c.lineWidth = 1.4
        c.beginPath()
        c.arc(x, y, 4.5, 0, Math.PI * 2)
        c.stroke()
      }
    }
  }

  /** Forget the user's strokes and repaint. */
  clearUser() {
    this.user.length = 0
    this.repaint()
  }
}
