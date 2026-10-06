/**
 * The velocity plot: one stroke's speed over time, and the lognormal impulses under it.
 *
 * In the Kinematic Theory a stroke's speed profile is a sum of overlapping lognormal bumps, one
 * per neuromotor command (packages/hand/src/lognormal.ts). The plot shows that decomposition for
 * the stroke being written (or the last one): each impulse's speed as a thin curve, the planned
 * speed (the impulses summed as vectors, after the power-law re-timing) dashed, and the pen tip's
 * actual speed, after the arm's inertia and tremor, as the solid line. A hairline marks now;
 * the pen-up margins either side are shaded. Axes: ms from the stroke's touchdown, mm/s.
 */

import type { StrokeProfile } from 'hand'

export class SpeedPlot {
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

  /**
   * Draw `prof` (null: an empty frame) for the pen-down from `down` to `up` (ms), with a cursor at
   * simulated time `t`. The margins before and after are pen-up: shaded, and left out of the scale
   * (the flight in and out of a stroke is often the fastest thing the hand does).
   */
  draw(prof: StrokeProfile | null, down: number, up: number, t: number) {
    const c = this.canvas.getContext('2d')!
    const W = this.canvas.clientWidth, H = this.canvas.clientHeight
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    c.clearRect(0, 0, W, H)
    const L = 34, R = 8, T = 8, B = 20
    c.strokeStyle = '#e3d9c5'
    c.lineWidth = 1
    c.beginPath()
    c.moveTo(L + 0.5, T)
    c.lineTo(L + 0.5, H - B + 0.5)
    c.lineTo(W - R, H - B + 0.5)
    c.stroke()
    if (!prof || prof.t.length < 2) return
    const t0 = prof.t[0], t1 = prof.t[prof.t.length - 1]
    let vmax = 1
    prof.t.forEach((ms, i) => {
      if (ms >= down && ms <= up) vmax = Math.max(vmax, prof.tip[i], prof.plan[i])
    })
    vmax = niceCeil(vmax * 1.05)
    const X = (ms: number) => L + ((ms - t0) / (t1 - t0)) * (W - L - R)
    const Y = (v: number) => H - B - (Math.min(v, vmax) / vmax) * (H - B - T)
    c.fillStyle = 'rgba(227, 217, 197, 0.35)'
    c.fillRect(L + 1, T, Math.max(0, X(down) - L - 1), H - B - T)
    c.fillRect(X(up), T, Math.max(0, W - R - X(up)), H - B - T)
    const line = (vals: number[], style: string, width: number, dash: number[] = []) => {
      c.strokeStyle = style
      c.lineWidth = width
      c.setLineDash(dash)
      c.beginPath()
      vals.forEach((v, i) => (i ? c.lineTo(X(prof.t[i]), Y(v)) : c.moveTo(X(prof.t[i]), Y(v))))
      c.stroke()
      c.setLineDash([])
    }
    // impulses first, quietly, each its own hue around the palette
    prof.components.forEach((comp, k) => {
      const hue = (230 + k * 47) % 360
      line(comp, `hsla(${hue}, 32%, 52%, 0.55)`, 1)
    })
    line(prof.plan, 'rgba(90, 79, 176, 0.9)', 1.3, [4, 3])
    line(prof.tip, '#23263a', 1.6)
    // axes labels
    c.fillStyle = '#847b6c'
    c.font = '10px ui-sans-serif, system-ui, sans-serif'
    c.textAlign = 'right'
    c.fillText(`${vmax}`, L - 4, T + 8)
    c.fillText('0', L - 4, H - B)
    c.save()
    c.translate(10, (H - B) / 2 + 10)
    c.rotate(-Math.PI / 2)
    c.textAlign = 'center'
    c.fillText('mm/s', 0, 0)
    c.restore()
    c.textAlign = 'left'
    c.fillText(`${Math.round(t0 - down)}`, L, H - 6)
    c.textAlign = 'right'
    c.fillText(`${Math.round(t1 - down)} ms`, W - R, H - 6)
    // now
    if (t >= t0 && t <= t1) {
      c.strokeStyle = 'rgba(154, 91, 46, 0.6)'
      c.lineWidth = 1
      c.beginPath()
      c.moveTo(X(t) + 0.5, T)
      c.lineTo(X(t) + 0.5, H - B)
      c.stroke()
    }
  }
}

function niceCeil(v: number): number {
  const p = Math.pow(10, Math.floor(Math.log10(v)))
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p
  return 10 * p
}
