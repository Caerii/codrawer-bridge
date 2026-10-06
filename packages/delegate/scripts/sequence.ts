/**
 * The delegation loop as a sequence of frames, for docs/media/delegate-*.
 *
 * A page of the user's notes (written by packages/hand's `sketcher`), then: the user lassoes two
 * lines and writes `@research`; the research pod's card appears in its own hand (`archivist`),
 * queued, then working; it returns with a summary, sources and three choices; the user circles
 * one; the card is done. Then phase 2: the user draws an arrow from that card to a new one, the
 * drafts pod (`mathematician`) proposes an email with a consent box and code, the user initials
 * it, and the card records the send.
 *
 * Nothing here is mocked except the pods' words: placement is card.ts's `place` against the
 * page's real stroke boxes, the user's circle, arrow and initials are simulated pen strokes, and
 * the captions print what marks.ts and consent.ts actually concluded from them.
 *
 * Output: `out/delegate-sequence.json` (strokes in mm per frame; not committed), rendered to PNG
 * frames and a GIF in docs/media by `render_sequence.py`.
 */

import { writeFileSync, mkdirSync } from 'node:fs'
import { simulate, sketcher, archivist, mathematician, type Persona } from 'hand'
import { PAPER_PRO_MM } from 'hand'
import { CARD, layoutCard, place, statusMark, type CardContent, type CardLayout } from '../src/card'
import { bounds, inflate, rect, type Pt, type Rect } from '../src/geometry'
import { gestures, interpret, type CardOnPage } from '../src/marks'
import { actionHash, consentCode, type Action } from '../src/task'
import { verifyConsent } from '../src/consent'
import { pen, written, circlePath, arrowPaths } from '../test/fixtures'

type Ink = { pts: [number, number, number][]; color: string; w: number }
interface Frame { name: string; caption: string; glasses: string; ink: Ink[]; overlay: { pts: Pt[]; dashed: boolean }[] }

const USER = '#1a1a1a', RESEARCH = '#2453b8', DRAFTS = '#1f7a4d'
const PAGE = PAPER_PRO_MM as Pt
const T0 = 1_790_000_000_000

// --- writing -----------------------------------------------------------------------------------

const cache = new Map<string, Ink[]>()
function hand(text: string, at: Pt, persona: Persona, scale: number, color: string, seed = 3): Ink[] {
  const key = `${persona.id}|${text}|${at}|${scale}|${seed}`
  if (!cache.has(key)) {
    const r = simulate(text, persona, { seed })
    cache.set(key, r.strokes.map((s) => ({ pts: s.pts.map((p) => [at[0] + p[0] * scale, at[1] + p[1] * scale, p[2]] as [number, number, number]), color, w: 0.35 })))
  }
  return cache.get(key)!
}
const lines = (paths: Pt[][], color: string, w = 0.3): Ink[] => paths.map((p) => ({ pts: p.map(([x, y]) => [x, y, 0.6] as [number, number, number]), color, w }))
const fromStrokes = (ss: { pts: Pt[]; pressure: number[] }[], color = USER): Ink[] => ss.map((s) => ({ pts: s.pts.map((p, i) => [p[0], p[1], s.pressure[i]] as [number, number, number]), color, w: 0.4 }))

function cardInk(l: CardLayout, c: CardContent, persona: Persona, color: string): Ink[] {
  return [
    ...lines(l.paths, color),
    ...lines(statusMark(c.status, l.status), color, 0.35),
    ...l.text.flatMap((t, i) => hand(t.text, t.at, persona, t.scale, color, 11 + i)),
  ]
}

// --- the user's page ---------------------------------------------------------------------------

const notes = [
  'G3 display notes',
  'partial refresh < 150 ms',
  'controller? IT8951 / T1000',
  'two boards by Nov',
]
const userInk: Ink[] = notes.flatMap((t, i) => hand(t, [12, 30 + i * 13], sketcher, 0.62, USER, 21 + i))
const strokeBoxes: Rect[] = userInk.map((s) => bounds(s.pts.map((p) => [p[0], p[1]] as Pt)))
const selected = inflate(bounds(userInk.slice(0).filter((s) => s.pts[0][1] > 48 && s.pts[0][1] < 76).flatMap((s) => s.pts.map((p) => [p[0], p[1]] as Pt))), 2)
const lasso = circlePath(selected, 3, 0.1)
const atResearch = hand('@research', [selected.x0 + 2, selected.y1 + 9], sketcher, 0.6, USER, 41)

// --- card 1: the research pod --------------------------------------------------------------------

const base: CardContent = {
  pod: 'research', requester: 'Alif', status: 'queued',
  title: 'Which e-ink controller for the G3 prototype?',
  grant: 'G3 notebook, this task only',
  trail: ['10:02 queued'],
}
const returned: CardContent = {
  ...base, status: 'needs_you',
  body: ['T1000: ~120 ms partial; IT8951: ~260 ms'],
  evidence: ['[1] T1000 datasheet  [2] your p. 3'],
  choices: [{ id: 'it8951', label: 'IT8951' }, { id: 't1000', label: 'T1000' }, { id: 'vendor', label: 'ask the vendor' }],
  write: true,
  trail: ['10:02 queued', '10:03 working', '10:19 needs you'],
}
const anchor = selected
const boxes = [...strokeBoxes, bounds(atResearch.flatMap((s) => s.pts.map((p) => [p[0], p[1]] as Pt)))]
const p1 = place([CARD.width, layoutCard(returned, [0, 0]).rect.y1], anchor, boxes, [], PAGE)
const at1 = p1.at

const frames: Frame[] = []
const push = (f: Frame) => frames.push(f)
const page = [...userInk]

push({ name: 'dispatch', caption: 'Lasso two lines, write @research: a task with that ink, the recognised text and a one-time scope', glasses: '', ink: [...page, ...atResearch], overlay: [{ pts: lasso, dashed: true }] })

const queued = layoutCard(base, at1)
push({ name: 'queued', caption: 'The research pod\'s card appears in its own hand, on its own layer: queued', glasses: '[ ] research · queued', ink: [...page, ...atResearch, ...cardInk(queued, base, archivist, RESEARCH)], overlay: [] })

const working: CardContent = { ...base, status: 'working', trail: ['10:02 queued', '10:03 working'] }
push({ name: 'working', caption: 'Working: one stroke in the box. No animation; e-ink shows states, not motion', glasses: '[/] research · working', ink: [...page, ...atResearch, ...cardInk(layoutCard(working, at1), working, archivist, RESEARCH)], overlay: [] })

const L1 = layoutCard(returned, at1)
const card1Ink = cardInk(L1, returned, archivist, RESEARCH)
push({ name: 'needs-you', caption: 'It returns: a summary, sources, and a decision as drawn choices. The doubled rule means it needs you', glasses: '[!] research: pick a controller (3)', ink: [...page, ...atResearch, ...card1Ink], overlay: [] })

// the user circles T1000
const circle = pen([circlePath(L1.choices[1].label, 3)], sketcher, 5, T0 + 60_000)
const cards1: CardOnPage[] = [{ task: 't1', layout: L1 }]
const m1 = interpret(gestures(circle)[0], cards1)
const circled = fromStrokes(circle)
push({ name: 'circle', caption: `The user circles T1000. Read against the card's regions: ${m1.kind} ${'option' in m1 ? m1.option : ''} (${'confidence' in m1 ? m1.confidence.toFixed(2) : ''})`, glasses: '[!] research: T1000 chosen, finishing', ink: [...page, ...atResearch, ...card1Ink, ...circled], overlay: [] })

const done: CardContent = { ...returned, status: 'done', trail: ['10:02 queued', '10:19 needs you', '10:21 done'] }
const L1done = layoutCard(done, at1)
const card1Done = cardInk(L1done, done, archivist, RESEARCH)
push({ name: 'done', caption: 'Done: the box gets its tick; the thread page keeps the sources and the history', glasses: '[v] research · done (T1000)', ink: [...page, ...atResearch, ...card1Done, ...circled], overlay: [] })

// --- phase 2: an arrow to a drafts card, consent by pen ------------------------------------------

const action: Action = {
  task: 't2', kind: 'email.send', nonce: 'n-7f3a',
  params: { to: ['sales@panel-vendor.example'], subject: 'Two T1000 boards for the G3 prototype', body: 'Could you send two T1000 evaluation boards…' },
  compensate: 'email.unsend within 30 s',
}
const hash = actionHash(action)
const code = consentCode(hash)
const draft: CardContent = {
  pod: 'drafts', requester: 'Alif', status: 'needs_you',
  title: 'Email the vendor for two T1000 boards',
  body: ['to sales@panel-vendor, 4 lines'],
  consent: { verb: 'Send', code, hash },
  trail: ['10:22 queued', '10:24 needs you'],
}
const boxes2 = [...boxes, ...circled.map((s) => bounds(s.pts.map((p) => [p[0], p[1]] as Pt)))]
const p2 = place([CARD.width, layoutCard(draft, [0, 0]).rect.y1], rect(L1done.rect.x0, L1done.rect.y1, L1done.rect.x1, L1done.rect.y1 + 1), boxes2, [L1done.rect], PAGE)
const L2 = layoutCard(draft, p2.at)
const arrow = pen(arrowPaths([L1done.rect.x0 + 40, L1done.rect.y1 - 1], [L2.rect.x0 + 40, L2.rect.y0 + 1]), sketcher, 4, T0 + 120_000)
const cards2: CardOnPage[] = [{ task: 't1', layout: L1done }, { task: 't2', layout: L2 }]
const arrowInk = fromStrokes(arrow)
// the arrow was drawn to an empty spot first: the broker reads it once the drafts card exists there
const m2 = interpret(gestures(arrow)[0], cards2)
const card2Ink = cardInk(L2, draft, mathematician, DRAFTS)
push({ name: 'chain', caption: `An arrow from the done card hands off to the drafts pod (read as: ${m2.kind}). It proposes an email; sending needs your initials`, glasses: `[!] drafts: send email? ${code}`, ink: [...page, ...atResearch, ...card1Done, ...circled, ...arrowInk, ...card2Ink], overlay: [] })

const bx = L2.consent!.box
const initials = written('AJ', [bx.x0 + 6, bx.y1 - 3], sketcher, 8, T0 + 180_000, 0.9)
const m3 = interpret(gestures(initials)[0], cards2)
const enrolled = [1, 2, 3].map((s) => written('AJ', [0, 0], sketcher, 100 + s, T0, 0.9))
const v = verifyConsent({ action, hash, code, shownAt: T0 + 150_000, expires: T0 + 900_000, requester: { participant: 'p_alif', device: 'paperpro-01' }, highStakes: false, used: new Set() }, initials, enrolled, T0 + 182_000)
const sent: CardContent = { ...draft, status: 'done', trail: ['10:22 queued', '10:24 needs you', '10:25 sent'] }
push({ name: 'consent', caption: `Initials in the box: ${m3.kind}; consent ${v.ok ? 'valid' : 'refused'} for ${code} (similarity ${v.similarity?.toFixed(2)}${v.needsSecondFactor ? ', ring tap asked' : ''}). Sent; undo for 30 s`, glasses: `[v] drafts · sent ${code} · undo 30 s`, ink: [...page, ...atResearch, ...card1Done, ...circled, ...arrowInk, ...cardInk(layoutCard(sent, p2.at), sent, mathematician, DRAFTS), ...fromStrokes(initials)], overlay: [] })

mkdirSync('out', { recursive: true })
writeFileSync('out/delegate-sequence.json', JSON.stringify({ page: PAGE, frames }))
console.log(frames.map((f) => `${f.name}: ${f.caption}`).join('\n'))
console.log(`placement: card 1 at ${at1.map((v) => v.toFixed(0))} (stub ${p1.stub}), card 2 at ${p2.at.map((v) => v.toFixed(0))} (stub ${p2.stub})`)
