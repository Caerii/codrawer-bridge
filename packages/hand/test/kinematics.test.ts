// Statistics of the output that real handwriting has: the two-thirds power law and the
// physiological tremor band. Measured values are printed, so `pnpm test` reports them.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { definePersona, elder, PERSONAS, sketcher, type Persona } from '../src/persona'
import { Rng } from '../src/rng'
import { simulate, type Point } from '../src/simulate'
import { peakFrequency, powerLaw, spectrum } from '../src/stats'
import { bandNoise } from '../src/tremor'
import type { Pt } from '../src/layout'

const quiet = (p: Persona) => definePersona({ ...p, tremor: { ...p.tremor, amplitude: 0 } })

/** An ellipse traced `turns` times, a figure of eight, and a garland: classic power-law drawings. */
function curves(): Pt[][] {
  const ellipse: Pt[] = []
  for (let i = 0; i <= 3 * 96; i++) {
    const a = (2 * Math.PI * i) / 96
    ellipse.push([20 + 16 * Math.cos(a), 10 * Math.sin(a)])
  }
  const eight: Pt[] = []
  for (let i = 0; i <= 2 * 120; i++) {
    const a = (2 * Math.PI * i) / 120
    eight.push([70 + 12 * Math.sin(a), 9 * Math.sin(2 * a)])
  }
  const garland: Pt[] = []
  for (let i = 0; i <= 200; i++) {
    const a = (2 * Math.PI * i) / 40
    garland.push([100 + i * 0.3 + 4 * Math.cos(a), 6 * Math.abs(Math.sin(a / 2))])
  }
  return [ellipse, eight, garland]
}

/** The motor plan under the strokes (trace.intended), as points with the strokes' times. */
function planned(r: ReturnType<typeof simulate>): { pts: Point[] }[] {
  return r.trace!.intended.map((xy, i) => ({ pts: xy.map(([x, y], k) => [x, y, 0, r.strokes[i].pts[k][3]] as Point) }))
}

/**
 * β at the pen tip (what lands on the page), with the plan's aim (pre-compensated for the arm)
 * and what the lognormal plan alone produces (powerLaw 0) printed alongside.
 */
function exponents(input: Parameters<typeof simulate>[0], p: Persona, seed: number) {
  const r = simulate(input, quiet(p), { seed, trace: true, sampleHz: 200 })
  const bare = simulate(input, definePersona({ ...quiet(p), motor: { ...p.motor, powerLaw: 0 } }), { seed, sampleHz: 200 })
  return { tip: powerLaw(r.strokes), aim: powerLaw(planned(r)).beta, emergent: powerLaw(bare.strokes).beta }
}

test('two-thirds power law at the pen tip: drawn curves (ellipse, figure of eight, garland)', () => {
  for (const p of PERSONAS) {
    const { tip, aim, emergent } = exponents({ paths: curves() }, p, 3)
    console.log(`  ${p.id} curves: β tip ${tip.beta.toFixed(3)} (r² ${tip.r2.toFixed(2)}); plan aims ${aim.toFixed(3)}; lognormal alone ${emergent.toFixed(3)}`)
    assert.ok(Math.abs(tip.beta - 1 / 3) <= 0.08, `${p.id} tip β ${tip.beta}`)
  }
})

test('two-thirds power law at the pen tip: cursive text by every cursive persona', () => {
  const text = 'what if ink could travel? the quiet hand loops along'
  for (const p of PERSONAS.filter((q) => q.letters.join)) {
    const { tip, aim, emergent } = exponents(text, p, 5)
    console.log(`  ${p.id} text: β tip ${tip.beta.toFixed(3)} (n ${tip.n}); plan aims ${aim.toFixed(3)}; lognormal alone ${emergent.toFixed(3)}`)
    assert.ok(Math.abs(tip.beta - 1 / 3) <= 0.08, `${p.id} tip β ${tip.beta}`)
  }
})

test('the tremor generator peaks in its band, with unit RMS', () => {
  for (const f0 of [8.4, 10, 11.5]) {
    const x = bandNoise(60000, f0, 2.5, 1000, new Rng(9))
    let s = 0
    for (const v of x) s += v * v
    const rms = Math.sqrt(s / x.length)
    const pk = peakFrequency(spectrum(x, 1000, 4096, 40), 1, 40)
    assert.ok(Math.abs(pk - f0) < 0.8, `peak ${pk} for ${f0}`)
    assert.ok(rms > 0.8 && rms < 1.2, `rms ${rms}`)
  }
})

test('tremor in the ink: the difference tremor makes peaks in 8–12 Hz at about the persona amplitude', () => {
  for (const p of [elder, sketcher]) {
    const text = 'a steady line of thought, written slowly'
    const on = simulate(text, p, { seed: 11, sampleHz: 1000 })
    const off = simulate(text, quiet(p), { seed: 11, sampleHz: 1000 })
    const dx: number[] = []
    let ss = 0
    on.strokes.forEach((s, i) =>
      s.pts.forEach((q, k) => {
        const o = off.strokes[i].pts[k]
        dx.push(q[0] - o[0])
        ss += (q[0] - o[0]) ** 2 + (q[1] - o[1]) ** 2
      }),
    )
    const rms = Math.sqrt(ss / dx.length)
    const pk = peakFrequency(spectrum(dx, 1000, 2048, 40), 2, 40)
    console.log(`  ${p.id}: tremor peak ${pk.toFixed(2)} Hz, RMS ${rms.toFixed(3)} mm (persona ${p.tremor.amplitude} mm at ${p.tremor.frequency} Hz)`)
    assert.ok(pk >= 8 && pk <= 12, `${p.id} peak ${pk}`)
    assert.ok(rms > 0.5 * p.tremor.amplitude && rms < 1.6 * p.tremor.amplitude, `${p.id} rms ${rms}`)
  }
})
