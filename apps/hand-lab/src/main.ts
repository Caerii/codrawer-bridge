/**
 * Hand lab: watch codrawer's handwriting personas write, live, and tune them.
 *
 * The page is a thin shell around packages/hand. On Write it simulates the text for the chosen
 * persona (with its sliders applied), then *performs* it with the same player an agent uses to
 * write into a session (`perform`, packages/hand/src/perform.ts): messages go out on the real
 * clock, and the paper reveals exactly what they carry. "Send" performs again with every message
 * also going to a router over WebSocket. Either way the hand yields: while you draw on the paper
 * (or anyone else draws in the session) it finishes its stroke and waits for a lull.
 *
 * Reading order: state and persona → the controls → simulate and perform → the frame loop
 * (paper, pen, arm inset, speed plot) → your own drawing → the session.
 */

import './style.css'
import { definePersona, mirror, perform, PAPER_PRO_MM, PERSONAS, simulate, userStats, type HandMessage, type HandResult, type Persona } from 'hand'
import { ArmInset } from './inset'
import { Paper, type InkMode, type UserStroke } from './paper'
import { SpeedPlot } from './plot'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

// --- state ---------------------------------------------------------------------------------------

const paper = new Paper($('paper'), $('overlay'))
const inset = new ArmInset($('arm'))
const plot = new SpeedPlot($('plot'))
const MIRROR_ID = 'mirror'
let base: Persona = PERSONAS[1] // the Sketcher
let result: HandResult | null = null
let seed = 7
let pace = 1
/** the running performance */
let run: { ctrl: AbortController; startTs: number; begun: number; offset: number; yielding: boolean; done: boolean } | null = null
/** the user is drawing on the lab's paper */
let userDown = false
let userLast = 0

// --- personas and controls -----------------------------------------------------------------------

/** A slider: its label, range, and how it reads and writes a persona. */
interface Knob {
  key: string
  label: string
  min: number
  max: number
  step: number
  get: (p: Persona) => number
  set: (p: Persona, v: number) => void
  fmt: (v: number) => string
}

const KNOBS: Knob[] = [
  { key: 'tempo', label: 'Tempo', min: 0.3, max: 3, step: 0.05, get: (p) => p.motor.tempo, set: (p, v) => (p.motor.tempo = v), fmt: (v) => `${v.toFixed(2)}×` },
  { key: 'tremor', label: 'Tremor', min: 0, max: 0.3, step: 0.005, get: (p) => p.tremor.amplitude, set: (p, v) => (p.tremor.amplitude = v), fmt: (v) => `${v.toFixed(3)} mm` },
  { key: 'stiffness', label: 'Stiffness', min: 0.3, max: 2.5, step: 0.05, get: (p) => p.arm.stiffness, set: (p, v) => (p.arm.stiffness = v), fmt: (v) => v.toFixed(2) },
  { key: 'damping', label: 'Damping', min: 0.15, max: 1.5, step: 0.05, get: (p) => p.arm.damping, set: (p, v) => (p.arm.damping = v), fmt: (v) => `ζ ${v.toFixed(2)}` },
  { key: 'slant', label: 'Slant', min: -0.2, max: 0.6, step: 0.01, get: (p) => p.letters.slant, set: (p, v) => (p.letters.slant = v), fmt: (v) => `${Math.round((Math.atan(v) * 180) / Math.PI)}°` },
  { key: 'size', label: 'Size', min: 3, max: 14, step: 0.1, get: (p) => p.letters.capHeight, set: (p, v) => (p.letters.capHeight = v), fmt: (v) => `${v.toFixed(1)} mm` },
  { key: 'pressure', label: 'Pressure', min: 0.3, max: 1.8, step: 0.05, get: (p) => p.pressure.gain, set: (p, v) => (p.pressure.gain = v), fmt: (v) => `${v.toFixed(2)}×` },
]
const values = new Map<string, number>()
let confidence = 1

function buildControls() {
  const box = $('controls')
  box.innerHTML = ''
  const add = (key: string, label: string, min: number, max: number, step: number, v: number, fmt: (v: number) => string, onChange: (v: number) => void) => {
    const id = `k-${key}`
    const lab = document.createElement('label')
    lab.htmlFor = id
    lab.textContent = label
    const input = document.createElement('input')
    Object.assign(input, { type: 'range', id, min: String(min), max: String(max), step: String(step), value: String(v) })
    const out = document.createElement('output')
    out.htmlFor.add(id)
    out.textContent = fmt(v)
    input.addEventListener('input', () => (out.textContent = fmt(Number(input.value))))
    input.addEventListener('change', () => onChange(Number(input.value)))
    box.append(lab, input, out)
  }
  for (const k of KNOBS) add(k.key, k.label, k.min, k.max, k.step, values.get(k.key)!, k.fmt, (v) => (values.set(k.key, v), write()))
  const sep = document.createElement('div')
  sep.className = 'sep'
  box.append(sep)
  add('confidence', 'Confidence', 0, 1, 0.05, confidence, (v) => (v >= 0.95 ? 'sure' : v <= 0.15 ? 'unsure' : v.toFixed(2)), (v) => ((confidence = v), write()))
}

/** The persona as the sliders have it. */
function current(): Persona {
  const p = definePersona({ ...base })
  for (const k of KNOBS) k.set(p, values.get(k.key)!)
  return p
}

function choose(p: Persona) {
  base = p
  for (const k of KNOBS) values.set(k.key, k.get(p))
  buildControls()
  document.querySelectorAll<HTMLButtonElement>('.persona').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.id === (p.id === MIRROR_ID ? MIRROR_ID : p.id))))
}

function buildPersonas() {
  const box = $('personas')
  const all = [...PERSONAS.map((p) => ({ id: p.id, name: p.name, blurb: p.blurb })), { id: MIRROR_ID, name: 'Mirror', blurb: 'adapts tempo and size to your strokes' }]
  for (const p of all) {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'persona'
    b.dataset.id = p.id
    b.setAttribute('role', 'radio')
    b.title = p.blurb
    b.textContent = p.name
    b.addEventListener('click', () => {
      choose(p.id === MIRROR_ID ? mirror(userStatsFromPaper()) : PERSONAS.find((q) => q.id === p.id)!)
      write()
    })
    box.append(b)
  }
}

// --- simulate and perform ------------------------------------------------------------------------

/** The baselines the text uses, mm (for the paper's faint rules). */
function rules(p: Persona, r: HandResult): number[] {
  const lines = new Set(r.words.map((w) => w.line))
  return [...lines].map((l) => l * p.letters.lineSpacing * p.letters.capHeight)
}

function write(newSeed = true) {
  const text = ($('text') as HTMLTextAreaElement).value.trim()
  if (!text) return
  if (newSeed) seed = (seed * 48271 + 11) % 2147483647
  const p = current()
  result = simulate(text, p, { seed, width: paper.wrapWidth(), confidence, trace: true })
  paper.setResult(result, rules(p, result))
  inset.set(result)
  readout(result)
  play(null)
}

/** Perform the current result: locally, and into `ws` when given. */
function play(ws: WebSocket | null) {
  if (!result) return
  run?.ctrl.abort()
  paper.setResult(result, rules(current(), result))
  const r = result
  const t0 = Date.now()
  // the lab's clock may run faster than the wall (pace 2× / 4×); timestamps follow it
  const now = () => t0 + (Date.now() - t0) * pace
  const sleep = (ms: number) => new Promise<void>((ok) => setTimeout(ok, ms / pace))
  const me = { ctrl: new AbortController(), startTs: now(), begun: -1, offset: 0, yielding: false, done: false }
  run = me
  const counts = new Map<number, number>()
  const send = (m: HandMessage) => {
    if (run !== me) return
    const n = Number(m.id.slice(m.id.lastIndexOf('_') + 1))
    if (m.t === 'stroke_begin') {
      me.begun = n
      me.offset = m.ts - me.startTs - r.strokes[n].down
      counts.set(n, 0)
    } else if (m.t === 'stroke_pts') {
      counts.set(n, (counts.get(n) ?? 0) + m.pts.length)
      paper.reveal(n, counts.get(n)!)
    }
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m))
  }
  perform(r, {
    send,
    now,
    sleep,
    startTs: me.startTs,
    origin: [0.08, 0.2],
    color: '#5a4fb0',
    author: `hand:${base.id}`,
    userActive: () => userDown || Date.now() - userLast < 250 || sessionActive(),
    lull: 1200,
    signal: me.ctrl.signal,
    onState: (s) => {
      me.yielding = s === 'yielding'
      me.done = s === 'done'
    },
  }).catch(() => {})
  runClock = now
}
/** the running performance's clock (Unix ms, sped up by the pace) */
let runClock = () => Date.now()

// --- the frame loop ------------------------------------------------------------------------------

function frame() {
  requestAnimationFrame(frame)
  paper.paintNew()
  const r = result, me = run
  if (!r || !me) {
    paper.overlay(null)
    return
  }
  // simulated time: the clock minus the shift yielding has added; held at the next touchdown
  // while the hand waits for the user
  let t = runClock() - me.startTs - me.offset
  const next = r.strokes[me.begun + 1]
  if (me.yielding && next) t = Math.min(t, next.down)
  if (me.done) t = Math.min(t, r.duration + 400)
  const frames = r.trace?.arm ?? []
  const f = frames[Math.max(0, Math.min(frames.length - 1, Math.round((t / 1000) * 60)))]
  paper.overlay(f ? { x: f.tip[0], y: f.tip[1], down: f.down && !me.done } : null)
  inset.draw(t, (n) => paper.shown(n))
  // the stroke being written; once the hand is done, the longest one (the most to look at)
  const n = me.done ? longest(r) : Math.max(0, me.begun)
  const prof = r.trace?.profiles[n] ?? null
  plot.draw(prof, r.strokes[n]?.down ?? 0, r.strokes[n]?.up ?? 0, t)
  const st = $('state')
  const secs = (Math.max(0, Math.min(t, r.duration)) / 1000).toFixed(1)
  const what = me.done ? 'done' : me.yielding ? '<span class="yield">waiting for you to pause</span>' : f?.down ? 'writing' : t < 0 ? '' : 'pen up'
  st.innerHTML = `${secs} s · ${what}`
}

function longest(r: HandResult): number {
  let best = 0
  r.strokes.forEach((s, i) => s.up - s.down > r.strokes[best].up - r.strokes[best].down && (best = i))
  return best
}

function readout(r: HandResult) {
  const down = r.strokes.reduce((a, s) => a + s.up - s.down, 0)
  const path = r.strokes.reduce((a, s) => a + s.pts.slice(1).reduce((b, q, i) => b + Math.hypot(q[0] - s.pts[i][0], q[1] - s.pts[i][1]), 0), 0)
  $('readout').textContent = `${r.strokes.length} strokes · ${(r.duration / 1000).toFixed(1)} s · mean pen speed ${(path / (down / 1000)).toFixed(0)} mm/s · seed ${r.seed}`
}

// --- your own drawing ----------------------------------------------------------------------------

function wireDrawing() {
  const el = $('paper-wrap')
  let cur: UserStroke | null = null
  const at = (e: PointerEvent): [number, number, number, number] => {
    const rect = el.getBoundingClientRect()
    const [x, y] = paper.toMm(e.clientX - rect.left, e.clientY - rect.top)
    return [x, y, e.pressure > 0 && e.pointerType !== 'mouse' ? e.pressure : 0.5, Date.now()]
  }
  el.addEventListener('pointerdown', (e) => {
    el.setPointerCapture(e.pointerId)
    userDown = true
    userLast = Date.now()
    cur = { pts: [at(e)] }
    paper.user.push(cur)
  })
  el.addEventListener('pointermove', (e) => {
    if (!cur) return
    const from = cur.pts.length
    for (const ev of e.getCoalescedEvents?.() ?? [e]) cur.pts.push(at(ev))
    paper.userDrew(cur, from)
    userLast = Date.now()
  })
  const up = () => {
    cur = null
    userDown = false
    userLast = Date.now()
  }
  el.addEventListener('pointerup', up)
  el.addEventListener('pointercancel', up)
}

/** The user's strokes as protocol points (normalized to a Paper Pro page) for the Mirror. */
function userStatsFromPaper() {
  const [pw, ph] = PAPER_PRO_MM
  return userStats(paper.user.map((u) => u.pts.map(([x, y, p, t]) => [x / pw, y / ph, p, t])))
}

// --- the session ---------------------------------------------------------------------------------

let ws: WebSocket | null = null
const others = new Set<string>()
let othersLast = 0
function sessionActive() {
  return others.size > 0 || Date.now() - othersLast < 300
}

function note(text: string, live = false) {
  const n = $('session-note')
  n.textContent = text
  n.classList.toggle('live', live)
}

function send() {
  const url = ($('ws-url') as HTMLInputElement).value.trim()
  if (!result) write()
  if (ws && ws.url === url && ws.readyState === WebSocket.OPEN) {
    play(ws)
    note(`Streaming into ${url}`, true)
    return
  }
  ws?.close()
  note(`Connecting to ${url}…`)
  try {
    ws = new WebSocket(url)
  } catch {
    note(`Not a WebSocket URL: ${url}`)
    return
  }
  const sock = ws
  sock.onopen = () => {
    note(`Streaming into ${url}`, true)
    play(sock)
  }
  sock.onerror = () => note(`Could not reach ${url}. Is a router running there?`)
  sock.onclose = () => {
    if (ws === sock) note('Disconnected.')
  }
  sock.onmessage = (ev) => {
    let m: { t?: string; id?: string; layer?: string }
    try {
      m = JSON.parse(String(ev.data))
    } catch {
      return
    }
    if (!m.id || m.id.startsWith('ai_hand_')) return
    if (m.t === 'stroke_begin' && m.layer !== 'ai') others.add(m.id)
    if (m.t === 'stroke_pts' && others.has(m.id)) othersLast = Date.now()
    if (m.t === 'stroke_end') others.delete(m.id)
  }
}

// --- wiring --------------------------------------------------------------------------------------

function segmented(id: string, onPick: (v: string) => void) {
  const box = $(id)
  box.querySelectorAll<HTMLButtonElement>('button').forEach((b) =>
    b.addEventListener('click', () => {
      box.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)))
      onPick(b.dataset.v!)
    }),
  )
}

buildPersonas()
choose(base)
wireDrawing()
segmented('ink-mode', (v) => {
  paper.mode = v as InkMode
  paper.repaint()
})
segmented('pace', (v) => {
  pace = Number(v)
  play(null)
})
$('show-plan').addEventListener('change', (e) => (paper.showPlan = (e.target as HTMLInputElement).checked))
$('compose').addEventListener('submit', (e) => {
  e.preventDefault()
  write()
})
$('text').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    write()
  }
})
$('replay').addEventListener('click', () => play(null))
$('clear').addEventListener('click', () => {
  run?.ctrl.abort()
  run = null
  result = null
  paper.clearUser()
  paper.setResult({ strokes: [], flights: [], words: [], duration: 0, persona: '', seed: 0 }, [])
})
$('send').addEventListener('click', send)

// URL parameters, for links and screenshots: ?persona=elder&text=…&seed=3&confidence=0.4&pace=2
const q = new URLSearchParams(location.search)
const qp = PERSONAS.find((p) => p.id === q.get('persona'))
if (qp) choose(qp)
if (q.get('text')) ($('text') as HTMLTextAreaElement).value = q.get('text')!
if (q.get('confidence')) confidence = Number(q.get('confidence'))
if (q.get('pace')) {
  pace = Number(q.get('pace'))
  document.querySelectorAll('#pace button').forEach((b) => b.setAttribute('aria-pressed', String((b as HTMLElement).dataset.v === String(pace))))
}
if (q.get('ws')) ($('ws-url') as HTMLInputElement).value = q.get('ws')!
if (q.get('ink') === 'speed') {
  paper.mode = 'speed'
  document.querySelectorAll('#ink-mode button').forEach((b) => b.setAttribute('aria-pressed', String((b as HTMLElement).dataset.v === 'speed')))
}
if (q.get('plan') === '1') {
  paper.showPlan = true
  ;($('show-plan') as HTMLInputElement).checked = true
}
if (q.get('seed')) seed = Number(q.get('seed'))
buildControls()
write(!q.get('seed'))
// for automation (screenshots, recordings): the current result and whether it has finished
;(window as unknown as { hand: unknown }).hand = { get result() { return result }, get done() { return run?.done ?? false } }
requestAnimationFrame(frame)
