/**
 * Measurements on ink: the two-thirds power law, spectra, and a writer's habits.
 *
 * The tests use these to check that the simulator's output has the statistics of real
 * handwriting rather than looking like it; the lab plots them; the Mirror persona reads a user's
 * habits from their strokes with {@link userStats}.
 *
 * - {@link powerLaw}: regress log speed on log curvature over pen-down samples, within strokes.
 *   The two-thirds power law (Lacquaniti, Terzuolo & Viviani 1983) predicts a slope of −1/3; we
 *   report β = −slope. Samples near a stroke's ends, near-stops, and each stroke's curvature
 *   extremes (inflections and cusps, the outer 5 % at either end) are left out: there the law is
 *   undefined or swamped by noise (Viviani & Flash 1995, J. Exp. Psychol. HPP 21, 32–53, discuss
 *   both).
 * - {@link spectrum}: a Hann-windowed periodogram (Welch averaging over half-overlapping
 *   segments) of a uniformly sampled signal, for the tremor band.
 */

import type { Point, Stroke } from './simulate'

/** Result of a power-law fit. */
export interface PowerLawFit {
  /** the exponent: speed ∝ curvature^(−beta) */
  beta: number
  /** coefficient of determination of the log–log fit */
  r2: number
  /** samples used */
  n: number
}

/**
 * Fit speed ∝ curvature^−β over strokes of `[x, y, p, t]` points (mm, ms), uniformly sampled in
 * time within each stroke. `trim` points are skipped at each end of every stroke.
 *
 * The fit is *within strokes*: each stroke's log speed and log curvature are centred on their
 * own means before pooling. The law's gain factor K changes from one movement unit to the next
 * (Viviani & Cenzato 1985, "Segmentation and coupling in complex movements", J. Exp. Psychol.
 * HPP 11, 828–845), and bigger letters are both faster and flatter (isochrony), so a pooled fit
 * across strokes would mix that between-unit trend into the exponent.
 */
export function powerLaw(strokes: { pts: Point[] }[], trim = 3, smoothMs = 12): PowerLawFit {
  let sxx = 0, sxy = 0, syy = 0, n = 0
  for (const s of strokes) {
    const lv: number[] = [], lk: number[] = []
    const P = smooth(s.pts, smoothMs)
    for (let i = Math.max(1, trim); i < P.length - Math.max(1, trim); i++) {
      const a = P[i - 1], b = P[i], c = P[i + 1]
      const dt1 = (b[3] - a[3]) / 1000, dt2 = (c[3] - b[3]) / 1000
      if (dt1 <= 0 || dt2 <= 0) continue
      const h = (dt1 + dt2) / 2
      const xd = (c[0] - a[0]) / (dt1 + dt2), yd = (c[1] - a[1]) / (dt1 + dt2)
      const xdd = ((c[0] - b[0]) / dt2 - (b[0] - a[0]) / dt1) / h
      const ydd = ((c[1] - b[1]) / dt2 - (b[1] - a[1]) / dt1) / h
      const v = Math.hypot(xd, yd)
      if (v < 1) continue // a near-stop: direction (and curvature) is noise
      const k = Math.abs(xd * ydd - yd * xdd) / (v * v * v)
      if (!(k > 0)) continue
      lv.push(Math.log(v))
      lk.push(Math.log(k))
    }
    // drop the stroke's curvature extremes: inflections (κ → 0) and cusps (κ → ∞)
    const order = lk.map((_, i) => i).sort((i, j) => lk[i] - lk[j])
    const keep = order.slice(Math.floor(order.length * 0.05), Math.ceil(order.length * 0.95))
    if (keep.length < 8) continue
    let mx = 0, my = 0
    for (const i of keep) (mx += lk[i]), (my += lv[i])
    mx /= keep.length
    my /= keep.length
    for (const i of keep) {
      const dx = lk[i] - mx, dy = lv[i] - my
      sxx += dx * dx
      sxy += dx * dy
      syy += dy * dy
    }
    n += keep.length
  }
  if (n < 10 || sxx <= 0) return { beta: NaN, r2: 0, n }
  return { beta: -sxy / sxx, r2: (sxy * sxy) / (sxx * syy), n }
}

/**
 * Gaussian smoothing of a stroke's positions in time (standard deviation `sd` ms), the usual
 * low-pass before differentiating pen data twice: curvature from raw samples is dominated by
 * sample-scale noise, and noise in the regressor biases a fitted slope toward zero.
 */
function smooth(P: Point[], sd: number): Point[] {
  if (sd <= 0) return P
  return P.map((p, i) => {
    let sw = 0, sx = 0, sy = 0
    for (let j = i; j >= 0 && p[3] - P[j][3] <= 3 * sd; j--) {
      const w = Math.exp(-0.5 * ((p[3] - P[j][3]) / sd) ** 2)
      sw += w; sx += w * P[j][0]; sy += w * P[j][1]
    }
    for (let j = i + 1; j < P.length && P[j][3] - p[3] <= 3 * sd; j++) {
      const w = Math.exp(-0.5 * ((P[j][3] - p[3]) / sd) ** 2)
      sw += w; sx += w * P[j][0]; sy += w * P[j][1]
    }
    return [sx / sw, sy / sw, p[2], p[3]] as Point
  })
}

/** Power spectrum: frequencies (Hz) and power, from Welch-averaged Hann periodograms. */
export function spectrum(signal: ArrayLike<number>, fs: number, segment = 1024, fMax = fs / 2): { f: number[]; p: number[] } {
  const N = Math.min(segment, signal.length)
  const w = new Float64Array(N)
  for (let i = 0; i < N; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1))
  const kMax = Math.min(Math.floor(N / 2), Math.floor((fMax * N) / fs))
  const f: number[] = []
  const p = new Array(kMax + 1).fill(0)
  for (let k = 0; k <= kMax; k++) f.push((k * fs) / N)
  let segs = 0
  for (let start = 0; start + N <= signal.length; start += N >> 1) {
    let mean = 0
    for (let i = 0; i < N; i++) mean += signal[start + i]
    mean /= N
    for (let k = 0; k <= kMax; k++) {
      let re = 0, im = 0
      const w0 = (2 * Math.PI * k) / N
      for (let i = 0; i < N; i++) {
        const v = (signal[start + i] - mean) * w[i]
        re += v * Math.cos(w0 * i)
        im -= v * Math.sin(w0 * i)
      }
      p[k] += re * re + im * im
    }
    segs++
  }
  return { f, p: p.map((v) => v / Math.max(1, segs)) }
}

/** The frequency of the spectrum's largest peak within [fLo, fHi], Hz. */
export function peakFrequency(spec: { f: number[]; p: number[] }, fLo = 0.5, fHi = Infinity): number {
  let best = -1, at = NaN
  spec.f.forEach((f, i) => {
    if (f >= fLo && f <= fHi && spec.p[i] > best) (best = spec.p[i]), (at = f)
  })
  return at
}

/**
 * A writer's habits from their strokes, for the Mirror persona: `strokes` are protocol points
 * `[x, y, p, t]` in normalized page coordinates and Unix ms (a user's `stroke_pts`); `page` is
 * the page size in mm (the Paper Pro's by default). Strokes of fewer than 4 points are ignored.
 */
export function userStats(strokes: number[][][], page: [number, number] = [179.6, 239.5]): { speed?: number; height?: number; pressure?: number; slant?: number } {
  const speeds: number[] = [], heights: number[] = [], pressures: number[] = [], leans: number[] = []
  for (const s of strokes) {
    if (s.length < 4) continue
    let y0 = Infinity, y1 = -Infinity
    for (let i = 0; i < s.length; i++) {
      const [x, y, p, t] = s[i]
      y0 = Math.min(y0, y * page[1])
      y1 = Math.max(y1, y * page[1])
      if (typeof p === 'number') pressures.push(p)
      if (i > 0 && typeof t === 'number') {
        const q = s[i - 1]
        const dt = (t - q[3]) / 1000
        const dx = (x - q[0]) * page[0], dy = (y - q[1]) * page[1]
        if (dt > 0 && dt < 0.2) speeds.push(Math.hypot(dx, dy) / dt)
        // mostly vertical movements carry the lean: −dx/dy on downstrokes and upstrokes alike
        if (Math.abs(dy) > 1.5 * Math.abs(dx) && Math.abs(dy) > 0.05) leans.push(-dx / dy)
      }
    }
    heights.push(y1 - y0)
  }
  const median = (a: number[]) => (a.length ? [...a].sort((p, q) => p - q)[a.length >> 1] : undefined)
  return { speed: median(speeds), height: median(heights), pressure: median(pressures), slant: median(leans) }
}

/** Every point of every stroke is finite and inside the box [x0, y0, x1, y1] (mm). */
export function bounded(strokes: Stroke[], box: [number, number, number, number]): boolean {
  return strokes.every((s) => s.pts.every(([x, y, p, t]) => Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(p) && Number.isFinite(t) && x >= box[0] && x <= box[2] && y >= box[1] && y <= box[3] && p >= 0 && p <= 1))
}
