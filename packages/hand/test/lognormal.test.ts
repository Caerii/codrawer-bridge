// The sigma-lognormal impulse (src/lognormal.ts): the closed-form displacement must be the
// integral of the analytic velocity, and its derivative the velocity, for straight and curved
// impulses alike.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { arcThrough, chord, displacement, erf, lognormal, lognormalCdf, support, timing, velocity, type Impulse } from '../src/lognormal'

const curved: Impulse = { D: 12, t0: 0.05, mu: Math.log(0.18), sigma: 0.3, thetaS: -0.4, thetaE: 1.9 }
const straight: Impulse = { D: 7, t0: 0, mu: Math.log(0.1), sigma: 0.22, thetaS: 2.2, thetaE: 2.2 }

test('erf matches known values to 1e-7', () => {
  const cases: [number, number][] = [[0, 0], [0.5, 0.5204998778], [1, 0.8427007929], [2, 0.995322265], [-1.3, -0.9340079449]]
  for (const [x, y] of cases) assert.ok(Math.abs(erf(x) - y) < 2e-7, `erf(${x})`)
})

test('the lognormal profile integrates to its CDF and to 1', () => {
  const k = curved
  const [a, b] = support(k, 6)
  let s = 0
  const n = 200000
  const h = (b - a) / n
  for (let i = 0; i < n; i++) s += lognormal(a + (i + 0.5) * h, k.t0, k.mu, k.sigma) * h
  assert.ok(Math.abs(s - 1) < 1e-5, `∫Λ = ${s}`)
  const tm = k.t0 + Math.exp(k.mu)
  assert.ok(Math.abs(lognormalCdf(tm, k.t0, k.mu, k.sigma) - 0.5) < 2e-7, 'median at t0 + e^μ')
})

for (const [name, k] of [['curved', curved], ['straight', straight]] as const) {
  test(`${name} impulse: integrating the analytic velocity gives the closed-form displacement`, () => {
    const [a, b] = support(k, 5)
    const n = 100000
    const h = (b - a) / n
    let x = 0, y = 0
    const v: [number, number] = [0, 0]
    const d: [number, number] = [0, 0]
    let worst = 0
    for (let i = 0; i < n; i++) {
      // midpoint rule on each step
      velocity(k, a + (i + 0.5) * h, v)
      x += v[0] * h
      y += v[1] * h
      if (i % 1000 === 999) {
        displacement(k, a + (i + 1) * h, d)
        const d0: [number, number] = [0, 0]
        displacement(k, a, d0)
        worst = Math.max(worst, Math.hypot(x - (d[0] - d0[0]), y - (d[1] - d0[1])))
      }
    }
    assert.ok(worst < 1e-4 * k.D, `max error ${worst} mm`)
    const c = chord(k)
    displacement(k, b + 10, d)
    assert.ok(Math.hypot(c[0] - d[0], c[1] - d[1]) < 1e-6, 'displacement tends to the chord')
  })

  test(`${name} impulse: the displacement's derivative is the analytic velocity`, () => {
    const [a, b] = support(k)
    const v: [number, number] = [0, 0]
    const p: [number, number] = [0, 0], q: [number, number] = [0, 0]
    const h = 1e-6
    for (let i = 1; i < 50; i++) {
      const t = a + ((b - a) * i) / 50
      displacement(k, t - h, p)
      displacement(k, t + h, q)
      velocity(k, t, v)
      const speed = Math.hypot(v[0], v[1])
      assert.ok(Math.hypot((q[0] - p[0]) / (2 * h) - v[0], (q[1] - p[1]) / (2 * h) - v[1]) < 1e-4 * Math.max(1, speed), `t=${t}`)
    }
  })
}

test('arcThrough lands an impulse exactly on the chord it was planned for', () => {
  for (const sweep of [-2.5, -1, -0.01, 0, 0.3, 1.7, 2.9]) {
    const L = 5.5, alpha = 0.8
    const arc = arcThrough(L, alpha, sweep)
    const { mu, t0 } = timing(0.1, 0.3, 0.27)
    const c = chord({ ...arc, mu, t0, sigma: 0.27 })
    assert.ok(Math.hypot(c[0] - L * Math.cos(alpha), c[1] - L * Math.sin(alpha)) < 1e-9, `sweep ${sweep}`)
  }
})

test('timing() inverts support(): the impulse runs from start for duration', () => {
  const { mu, t0 } = timing(1.25, 0.4, 0.33)
  const [a, b] = support({ D: 1, t0, mu, sigma: 0.33, thetaS: 0, thetaE: 0 })
  assert.ok(Math.abs(a - 1.25) < 1e-12 && Math.abs(b - 1.65) < 1e-12)
})
