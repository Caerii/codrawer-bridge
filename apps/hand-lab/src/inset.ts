/**
 * The arm inset: the body doing the writing, seen from above.
 *
 * The simulator's arm (packages/hand/src/arm.ts) reports a pose 60 times a second: shoulder,
 * elbow, the wrist pivot where the heel of the hand rests, the knuckles and the pen tip, in page
 * millimetres. The inset draws them as tapered limbs over a sketch of the page and the ink so
 * far, framed to hold the whole movement (the shoulder sits ~40 cm from the writing, so the
 * letters are small here; what shows is which joint moves: the forearm gliding along the line,
 * the wrist rocking through each word, the fingers working the up-and-down of the letters).
 */

import type { ArmFrame, HandResult } from 'hand'

export class ArmInset {
  private frames: ArmFrame[] = []
  private result: HandResult | null = null
  private box = { x0: 0, y0: 0, x1: 1, y1: 1 }
  private dpr = 1

  constructor(private readonly canvas: HTMLCanvasElement) {
    new ResizeObserver(() => this.resize()).observe(canvas)
    this.resize()
  }

  private resize() {
    this.dpr = Math.min(3, window.devicePixelRatio || 1)
    this.canvas.width = Math.round(this.canvas.clientWidth * this.dpr)
    this.canvas.height = Math.round(this.canvas.clientHeight * this.dpr)
  }

  set(result: HandResult) {
    this.result = result
    this.frames = result.trace?.arm ?? []
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
    for (const f of this.frames)
      for (const p of [f.shoulder, f.elbow, f.wrist, f.tip]) {
        x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0])
        y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1])
      }
    const pad = 30
    this.box = { x0: x0 - pad, y0: y0 - pad, x1: x1 + pad, y1: y1 + pad }
  }

  /** Draw the pose at simulated time `t` (ms), with the first `shown(n)` points of each stroke. */
  draw(t: number, shown: (n: number) => number) {
    const c = this.canvas.getContext('2d')!
    const W = this.canvas.clientWidth, H = this.canvas.clientHeight
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    c.clearRect(0, 0, W, H)
    if (!this.frames.length || !this.result) return
    const b = this.box
    const s = Math.min(W / (b.x1 - b.x0), H / (b.y1 - b.y0))
    const ox = (W - (b.x1 - b.x0) * s) / 2 - b.x0 * s
    const oy = (H - (b.y1 - b.y0) * s) / 2 - b.y0 * s
    const X = (p: [number, number]) => ox + p[0] * s
    const Y = (p: [number, number]) => oy + p[1] * s

    // the page under the writing
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
    for (const st of this.result.strokes)
      for (const [x, y] of st.pts) {
        x0 = Math.min(x0, x); x1 = Math.max(x1, x)
        y0 = Math.min(y0, y); y1 = Math.max(y1, y)
      }
    c.fillStyle = '#fbf8f1'
    c.strokeStyle = '#e3d9c5'
    c.lineWidth = 1
    const px0 = ox + (x0 - 12) * s, py0 = oy + (y0 - 14) * s
    c.fillRect(px0, py0, (x1 - x0 + 24) * s, (y1 - y0 + 28) * s)
    c.strokeRect(px0 + 0.5, py0 + 0.5, (x1 - x0 + 24) * s, (y1 - y0 + 28) * s)
    c.strokeStyle = '#23263a'
    c.lineWidth = 1
    this.result.strokes.forEach((st, n) => {
      const k = shown(n)
      if (k < 2) return
      c.beginPath()
      c.moveTo(ox + st.pts[0][0] * s, oy + st.pts[0][1] * s)
      for (let i = 1; i < k; i++) c.lineTo(ox + st.pts[i][0] * s, oy + st.pts[i][1] * s)
      c.stroke()
    })

    const f = this.frames[Math.max(0, Math.min(this.frames.length - 1, Math.round((t / 1000) * 60)))]
    // limbs: tapered, skin-and-sleeve tones kept close to the paper's palette
    const limb = (a: [number, number], z: [number, number], wa: number, wz: number, fill: string) => {
      const dx = X(z) - X(a), dy = Y(z) - Y(a)
      const L = Math.hypot(dx, dy) || 1
      const nx = -dy / L, ny = dx / L
      c.fillStyle = fill
      c.beginPath()
      c.moveTo(X(a) + nx * wa, Y(a) + ny * wa)
      c.lineTo(X(z) + nx * wz, Y(z) + ny * wz)
      c.arc(X(z), Y(z), wz, Math.atan2(ny, nx), Math.atan2(-ny, -nx))
      c.lineTo(X(a) - nx * wa, Y(a) - ny * wa)
      c.arc(X(a), Y(a), wa, Math.atan2(-ny, -nx), Math.atan2(ny, nx))
      c.fill()
    }
    const mm = (v: number) => Math.max(1.2, v * s)
    limb(f.shoulder, f.elbow, mm(48), mm(38), 'rgba(132, 123, 108, 0.30)')
    limb(f.elbow, f.wrist, mm(36), mm(26), 'rgba(132, 123, 108, 0.38)')
    limb(f.wrist, f.knuckle, mm(30), mm(22), 'rgba(200, 160, 128, 0.55)')
    limb(f.knuckle, f.tip, mm(8), mm(3), 'rgba(184, 140, 110, 0.75)')
    // joints
    c.fillStyle = '#4a4c5e'
    for (const p of [f.shoulder, f.elbow, f.wrist, f.knuckle]) {
      c.beginPath()
      c.arc(X(p), Y(p), 2.2, 0, Math.PI * 2)
      c.fill()
    }
    // the pen
    c.beginPath()
    c.arc(X(f.tip), Y(f.tip), 3, 0, Math.PI * 2)
    if (f.down) {
      c.fillStyle = '#5a4fb0'
      c.fill()
    } else {
      c.strokeStyle = '#5a4fb0'
      c.lineWidth = 1.3
      c.stroke()
    }
    c.fillStyle = '#847b6c'
    c.font = '11px ui-sans-serif, system-ui, sans-serif'
    c.fillText('shoulder', X(f.shoulder) + 6, Y(f.shoulder) - 6)
    c.fillText('elbow', X(f.elbow) + 6, Y(f.elbow) + 12)
  }
}
