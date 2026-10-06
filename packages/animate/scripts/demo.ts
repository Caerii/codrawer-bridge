/**
 * The in-betweening spike: two hand-drawn-looking key frames of a stick figure (crouched, then
 * jumping with arms up and a "spark" that only the second key has), five generated in-betweens,
 * played ping-pong; and "animate this" on a drawn ball (a bounce with squash and stretch).
 *
 * It writes one JSON file per demo for scripts/render_gif.py, which draws each GIF frame as two
 * panels: the editing view (the current frame in ink over its onion skin, previous red, next
 * blue, as the phone and the Paper Pro's colour overlay would show it) and clean playback.
 *
 *   pnpm --filter animate demo <out-dir>
 *   uv run --with pillow python packages/animate/scripts/render_gif.py <out-dir> docs/media
 *
 * Page geometry is the Paper Pro's (1620 × 2160 page px), normalised on the way out.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Rng } from 'hand'
import {
  addFrame,
  animateStrokes,
  bbox,
  bounce,
  createAnim,
  fillBetween,
  onionGhosts,
  passOrder,
  setLoop,
  setStrokes,
  type Anim,
  type AnimStroke,
  type Pt,
} from '../src/index'

const W = 1620
const H = 2160
type P = [number, number]

const rng = new Rng(11)

/** A path in page px → a stroke in normalised coords, with a little hand wobble and pressure. */
function ink(id: string, path: P[], color?: string): AnimStroke {
  const pts: Pt[] = path.map(([x, y], k) => [
    (x + (rng.next() - 0.5) * 2.4) / W,
    (y + (rng.next() - 0.5) * 2.4) / H,
    0.45 + 0.25 * Math.sin((Math.PI * k) / Math.max(1, path.length - 1)),
  ])
  return { id, pts, ...(color ? { color } : {}) }
}

function seg(a: P, b: P, n = 12): P[] {
  return Array.from({ length: n }, (_, k) => [a[0] + ((b[0] - a[0]) * k) / (n - 1), a[1] + ((b[1] - a[1]) * k) / (n - 1)])
}

function poly(pts: P[], per = 8): P[] {
  const out: P[] = []
  for (let i = 0; i + 1 < pts.length; i++) out.push(...seg(pts[i], pts[i + 1], per).slice(i ? 1 : 0))
  return out
}

function circle(cx: number, cy: number, r: number, n = 30): P[] {
  return Array.from({ length: n }, (_, k) => {
    const a = -Math.PI / 2 + (2.1 * Math.PI * k) / (n - 1)
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)]
  })
}

/** Key 1: crouched, arms back, ready to jump. */
function crouch(): AnimStroke[] {
  const hip: P = [800, 1260]
  const sh: P = [790, 1150]
  return [
    ink('head', circle(800, 1100, 34)),
    ink('body', seg([798, 1134], hip)),
    ink('legs', poly([[730, 1360], [700, 1300], hip, [880, 1300], [860, 1360]])),
    ink('arms', poly([[700, 1260], [730, 1200], sh, [850, 1200], [880, 1260]])),
  ]
}

/** Key 2: in the air, arms up, legs tucked, with a spark of joy that key 1 does not have. */
function leap(): AnimStroke[] {
  const hip: P = [820, 1010]
  const sh: P = [815, 890]
  return [
    ink('head', circle(818, 840, 34)),
    ink('body', seg([818, 874], hip)),
    ink('legs', poly([[760, 1110], [740, 1060], hip, [900, 1050], [890, 1110]])),
    ink('arms', poly([[720, 760], [750, 820], sh, [880, 820], [910, 760]])),
    ink('spark', poly([[940, 760], [990, 720], [960, 790], [1020, 770]]), '#d03030'),
    ink('ground', seg([600, 1365], [1040, 1365], 20)),
  ]
}

const ground = () => ink('ground', seg([600, 1365], [1040, 1365], 20))

interface DemoOut {
  name: string
  fps: number
  /** normalised crop [x0, y0, x1, y1] */
  view: [number, number, number, number]
  frames: { key: boolean; strokes: { pts: Pt[]; color?: string; agent: boolean }[] }[]
  /** what plays, in order (frame indices, one entry per tick) */
  play: number[]
  /** per frame: onion ghosts (frame index, opacity, colour) */
  onion: { frame: number; opacity: number; color: string }[][]
}

function out(name: string, anim: Anim, view: DemoOut['view']): DemoOut {
  const play: number[] = []
  for (const i of passOrder(anim)) for (let h = 0; h < anim.frames[i].hold; h++) play.push(i)
  return {
    name,
    fps: anim.fps,
    view,
    frames: anim.frames.map((f) => ({
      key: !!f.key,
      strokes: f.strokes.map((s) => ({ pts: s.pts, color: s.color, agent: s.provenance === 'agent' })),
    })),
    play,
    onion: anim.frames.map((_, i) => onionGhosts(anim, i, { before: 2, after: 1, look: 'tint', wrap: false }).map((g) => ({ frame: g.frame, opacity: g.opacity, color: g.color }))),
  }
}

// --- 1. in-betweening between two keys ---------------------------------------------------------
let jump = addFrame(createAnim('jump', 'jump', 'k1', 12), 0, 'k2')
jump = setStrokes(jump, 0, [...crouch(), ground()])
jump = setStrokes(jump, 1, leap())
jump = fillBetween(jump, 0, 5, 'tw')
jump = { ...jump, frames: jump.frames.map((f, i) => (i === 0 || i === jump.frames.length - 1 ? { ...f, hold: 3 } : f)) }
jump = setLoop(jump, 'pingpong')

// --- 2. "animate this": a drawn ball, bounced -------------------------------------------------
const ball: AnimStroke[] = [
  ink('ball', circle(560, 700, 90, 40)),
  ink('eye1', seg([582, 670], [585, 688], 5)),
  ink('eye2', seg([620, 670], [623, 688], 5)),
  ink('smile', circle(600, 716, 24, 12).slice(2, 9)),
]
const floor = ink('floor', seg([380, 1360], [1250, 1360], 24))
const sets = animateStrokes(ball, bounce(bbox(ball), { ground: 1358 / H, drop: (1358 - 790) / H, vx: 0.11 }), 24, 3400)
let bounced = createAnim('bounce', 'bounce', 'b0', 24)
sets.forEach((strokes, k) => {
  if (k > 0) bounced = addFrame(bounced, k - 1, `b${k}`)
  bounced = setStrokes(bounced, k, [...strokes.map((s) => ({ ...s, provenance: 'agent' as const })), floor])
})
// only the drawing is a key; the motion's frames are generated
bounced = { ...bounced, frames: bounced.frames.map((f, i) => ({ ...f, key: i === 0, hold: i === bounced.frames.length - 1 ? 18 : 1 })) }
bounced = setLoop(bounced, 'loop')

const dir = process.argv[2] ?? 'animate-demo'
mkdirSync(dir, { recursive: true })
const demos = [out('inbetween', jump, [560 / W, 680 / H, 1080 / W, 1400 / H]), out('bounce', bounced, [420 / W, 560 / H, 1260 / W, 1400 / H])]
for (const d of demos) writeFileSync(join(dir, `${d.name}.json`), JSON.stringify(d))
console.log(demos.map((d) => `${d.name}: ${d.frames.length} frames, ${d.play.length} ticks at ${d.fps} fps`).join('\n'))
