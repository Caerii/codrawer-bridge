/**
 * The Primer's readings, as the app keeps them: the pure half of the Proof panel.
 *
 * The Primer (ADR 010) reads a learner's handwritten proof and answers with one `primer` message
 * per reading (docs/protocol.md): the proof re-typeset step by step, what it found, a Putnam-style
 * score estimate, the tutor's next move, a summary of the learner's file and the practice plan.
 * The panel (primer/panel.ts) draws the latest reading; this module turns the wire message into
 * that reading and builds the requests the panel sends back.
 *
 * Facts it rests on:
 *
 * - Messages arrive from routers and agents of different vintages, so every field is read
 *   defensively: a missing or mistyped field becomes an empty value, never an exception, and the
 *   panel shows what is there. Numbers are clamped to their documented ranges (confidence and
 *   mastery 0..1, score 0..max).
 * - Identity is per person, not per device: one tablet and one Even account are shared by a
 *   family, so the learner names herself in the app and that name rides on every request. It is
 *   remembered in localStorage, which can throw or be empty (private windows, previews), so every
 *   access is guarded and the app works without it.
 * - The glasses get one line per reading (`move.glance`, at most 48 characters), shown through the
 *   HUD's intent line; a `silence` move puts nothing on the glasses.
 *
 * Pure (no DOM beyond the guarded storage): tested under tsx (test/primer.test.ts).
 */

// ── The reading ───────────────────────────────────────────────────────────────────────────────

/** How a step stands: sound, a gap in rigor, wrong, or not legible enough to judge. */
import { parseMock, type MockView } from './mock'

export type StepStatus = 'ok' | 'gap' | 'error' | 'unclear'

/** One logical step of the learner's proof, re-typeset. */
export interface ProofStep {
  /** 1-based step number, in reading order. */
  n: number
  /** The step as LaTeX (KaTeX-safe, no `$` delimiters). */
  latex: string
  /** A plain reading of the step. */
  text: string
  /** The reason the learner gave, or ''. */
  justification: string
  /** Earlier step numbers this step uses. */
  refs: number[]
  /** Concept ids from ADR 010's graph. */
  concepts: string[]
  /** The recognizer's confidence, 0..1. */
  confidence: number
  status: StepStatus
  /** The Primer's one-line comment, or ''. */
  note: string
  /** `stroke_begin` ids of the ink this step was read from. */
  strokes: string[]
  /** Normalized page bounds of that ink [x0, y0, x1, y1], or null when unknown. */
  bbox: [number, number, number, number] | null
}

/** A formal check: `checked` only ever follows a prover run that succeeded. */
export interface ProofCheck {
  prover: string
  status: 'checked' | 'failed' | 'not_checked'
  detail: string
}

export interface Proof {
  title: string
  /** The theorem as LaTeX. */
  goal: string
  technique: string
  steps: ProofStep[]
  /** A complete LaTeX document, or ''. */
  tex: string
  check: ProofCheck
}

/** A misconception or missing piece of rigor the Primer found. */
export interface Finding {
  id: string
  label: string
  /** The step it is about, or 0 for the proof as a whole. */
  step: number
  /** e.g. `misconception` or `missing_rigor`. */
  kind: string
}

/** A Putnam-style score: always an estimate. */
export interface Grade {
  score: number
  max: number
  /** complete (10) · minor_flaws (8–9) · partial (1–7) · none (0) */
  band: string
  rigor: string
  exposition: string
}

export type MoveKind = 'socratic' | 'hint' | 'worked_example' | 'affirm' | 'debrief' | 'notice' | 'silence'

/** What the Primer does next. */
export interface Move {
  kind: MoveKind
  text: string
  /** One line for the glasses (≤ 48 characters). */
  glance: string
  /** The step the move is about, or 0. */
  step: number
  /** The hint ladder's rung (0 before any hint). */
  hintLevel: number
}

export interface Mastery {
  concept: string
  label: string
  /** Estimated probability the concept is known, 0..1 (BKT, ADR 010). */
  p: number
}

export interface LearnerSummary {
  name: string
  summary: string
  mastery: Mastery[]
  misconceptions: { id: string; label: string; count: number }[]
  /** Concept ids due for spaced review. */
  due: string[]
}

export interface PlanWeek {
  n: number
  /** ISO date (YYYY-MM-DD) the week starts. */
  start: string
  focus: string[]
  /** Problems planned for the week. */
  problems: number
  /** ISO date of the week's mock exam, or null. */
  mock: string | null
}

export interface Plan {
  /** ISO date of the exam, or ''. */
  exam: string
  weeks: PlanWeek[]
  queue: { id: string; title: string; why: string }[]
}

/** A suggestion or weakness from the practice coach, with the reason it gives (ADR 010). */
export interface CoachItem {
  id: string
  label: string
  /** Why the coach chose it: every suggestion is inspectable. */
  why: string
  /** stretch · review · reading · warmup (suggestions); concept · misconception (weaknesses). */
  kind: string
}

/** The practice coach's view (primer/coach.py `coach_view`). */
export interface CoachView {
  /** The learner consented and the coach is observing (reading position, attempts). */
  watching: boolean
  next: CoachItem[]
  weak: CoachItem[]
  attempts: number
  /** The document she last had open on the tablet, when the coach is watching. */
  lastReading: string
  /** One short deliberate-practice line after an attempt, or ''. */
  nudge: string
}

/** One `primer` message, normalized. Absent sections are null (an answer to `plan` or `forget`). */
export interface Reading {
  id: string
  learner: string
  /** `live`: a model read the page (`model` names it); `offline`: a fixture transcription or nothing. */
  mode: 'live' | 'offline'
  model: string | null
  proof: Proof | null
  findings: Finding[]
  grade: Grade | null
  move: Move | null
  learnerSummary: LearnerSummary | null
  plan: Plan | null
  coach: CoachView | null
  /** A mock exam's state (primer/mock.ts), when one exists. */
  mock: MockView | null
}

// ── Reading a message defensively ─────────────────────────────────────────────────────────────

type Obj = Record<string, unknown>

const obj = (v: unknown): Obj | null => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : null)
const str = (v: unknown, max = 4000): string => (typeof v === 'string' ? v.slice(0, max) : '')
const num = (v: unknown, fallback = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const strs = (v: unknown): string[] => arr(v).filter((x): x is string => typeof x === 'string')

const STATUSES: StepStatus[] = ['ok', 'gap', 'error', 'unclear']
const MOVES: MoveKind[] = ['socratic', 'hint', 'worked_example', 'affirm', 'debrief', 'notice', 'silence']
const CHECKS: ProofCheck['status'][] = ['checked', 'failed', 'not_checked']

function parseStep(v: unknown, i: number): ProofStep | null {
  const s = obj(v)
  if (!s) return null
  const b = arr(s.bbox)
  const bbox = b.length === 4 && b.every((x) => typeof x === 'number' && Number.isFinite(x)) ? (b as [number, number, number, number]) : null
  const status = str(s.status) as StepStatus
  return {
    n: Math.round(num(s.n, i + 1)),
    latex: str(s.latex),
    text: str(s.text),
    justification: str(s.justification),
    refs: arr(s.refs).filter((x): x is number => typeof x === 'number'),
    concepts: strs(s.concepts),
    confidence: clamp(num(s.confidence, 1), 0, 1),
    status: STATUSES.includes(status) ? status : 'unclear',
    note: str(s.note),
    strokes: strs(s.strokes),
    bbox,
  }
}

function parseProof(v: unknown): Proof | null {
  const p = obj(v)
  if (!p) return null
  const c = obj(p.check)
  const status = str(c?.status) as ProofCheck['status']
  return {
    title: str(p.title, 200),
    goal: str(p.goal),
    technique: str(p.technique, 80),
    steps: arr(p.steps)
      .map(parseStep)
      .filter((s): s is ProofStep => s !== null),
    tex: str(p.tex, 200_000),
    check: { prover: str(c?.prover, 40), status: CHECKS.includes(status) ? status : 'not_checked', detail: str(c?.detail, 2000) },
  }
}

function parseGrade(v: unknown): Grade | null {
  const g = obj(v)
  if (!g) return null
  const max = Math.max(1, num(g.max, 10))
  return { score: clamp(num(g.score), 0, max), max, band: str(g.band, 40), rigor: str(g.rigor, 1000), exposition: str(g.exposition, 1000) }
}

function parseMove(v: unknown): Move | null {
  const m = obj(v)
  if (!m) return null
  const kind = str(m.kind) as MoveKind
  const text = str(m.text, 2000)
  return {
    kind: MOVES.includes(kind) ? kind : 'socratic',
    text,
    glance: glanceOf(str(m.glance, 200) || text),
    step: Math.round(num(m.step)),
    hintLevel: Math.round(num(m.hint_level)),
  }
}

function parseLearner(v: unknown): LearnerSummary | null {
  const l = obj(v)
  if (!l) return null
  return {
    name: str(l.name, 32),
    summary: str(l.summary, 2000),
    mastery: arr(l.mastery)
      .map(obj)
      .filter((m): m is Obj => m !== null)
      .map((m) => ({ concept: str(m.concept, 80), label: str(m.label, 80) || str(m.concept, 80), p: clamp(num(m.p), 0, 1) })),
    misconceptions: arr(l.misconceptions)
      .map(obj)
      .filter((m): m is Obj => m !== null)
      .map((m) => ({ id: str(m.id, 80), label: str(m.label, 200) || str(m.id, 80), count: Math.max(0, Math.round(num(m.count, 1))) })),
    due: strs(l.due),
  }
}

function parsePlan(v: unknown): Plan | null {
  const p = obj(v)
  if (!p) return null
  return {
    exam: str(p.exam, 10),
    weeks: arr(p.weeks)
      .map(obj)
      .filter((w): w is Obj => w !== null)
      .map((w, i) => ({ n: Math.round(num(w.n, i + 1)), start: str(w.start, 10), focus: strs(w.focus), problems: Math.max(0, Math.round(num(w.problems))), mock: str(w.mock, 10) || null })),
    queue: arr(p.queue)
      .map(obj)
      .filter((q): q is Obj => q !== null)
      .map((q) => ({ id: str(q.id, 80), title: str(q.title, 300), why: str(q.why, 200) })),
  }
}

function parseCoachItems(v: unknown, labelKey: 'title' | 'label'): CoachItem[] {
  return arr(v)
    .map(obj)
    .filter((x): x is Obj => x !== null)
    .map((x) => ({ id: str(x.id, 80), label: str(x[labelKey], 300) || str(x.id, 80), why: str(x.why, 300), kind: str(x.kind, 40) }))
}

function parseCoach(v: unknown): CoachView | null {
  const c = obj(v)
  if (!c) return null
  const last = obj(c.last_reading)
  return {
    watching: c.watching === true,
    next: parseCoachItems(c.next, 'title'),
    weak: parseCoachItems(c.weak, 'label'),
    attempts: Math.max(0, Math.round(num(c.attempts))),
    lastReading: last ? str(last.title, 200) : '',
    nudge: str(c.nudge, 300),
  }
}

/** A `primer` message as a {@link Reading}; null when it is not an object. */
export function parseReading(m: unknown): Reading | null {
  const o = obj(m)
  if (!o) return null
  // `learner` is the learner's name on a request-style message and the learner summary object on
  // a reading; accept either, and `learner_summary` for the summary, so a sender may carry both.
  const summary = parseLearner(o.learner_summary ?? (obj(o.learner) ? o.learner : undefined))
  return {
    id: str(o.id, 80),
    learner: typeof o.learner === 'string' ? o.learner.slice(0, 32) : (summary?.name ?? ''),
    mode: o.mode === 'live' ? 'live' : 'offline',
    model: typeof o.model === 'string' && o.model ? o.model.slice(0, 80) : null,
    proof: parseProof(o.proof),
    findings: arr(o.findings)
      .map(obj)
      .filter((f): f is Obj => f !== null)
      .map((f) => ({ id: str(f.id, 80), label: str(f.label, 300) || str(f.id, 80), step: Math.round(num(f.step)), kind: str(f.kind, 40) })),
    grade: parseGrade(o.grade),
    move: parseMove(o.move),
    learnerSummary: summary,
    plan: parsePlan(o.plan),
    coach: parseCoach(o.coach),
    mock: parseMock(o.mock),
  }
}

// ── The latest reading ────────────────────────────────────────────────────────────────────────

/**
 * What the panel shows. A reading replaces the last, except that sections it leaves out (an
 * answer to `plan` carries no proof) keep the previous reading's, so asking for the plan does not
 * blank the proof. A `forget` answer carries an empty learner and so replaces it.
 */
export const primer = {
  latest: null as Reading | null,
  /** Readings received since load. */
  count: 0,
}

/** Take in a reading; returns the merged reading now shown. */
export function acceptReading(r: Reading): Reading {
  const prev = primer.latest
  const merged: Reading = prev
    ? {
        ...r,
        proof: r.proof ?? prev.proof,
        findings: r.proof ? r.findings : prev.findings,
        grade: r.grade ?? (r.proof ? null : prev.grade),
        move: r.move ?? prev.move,
        learnerSummary: r.learnerSummary ?? prev.learnerSummary,
        plan: r.plan ?? prev.plan,
        coach: r.coach ?? prev.coach,
        mock: r.mock ?? prev.mock,
      }
    : r
  primer.latest = merged
  primer.count++
  return merged
}

// ── The glasses' line ─────────────────────────────────────────────────────────────────────────

/** Characters the glasses' one-line summary may hold. */
export const GLANCE_MAX = 48

/** One line of at most {@link GLANCE_MAX} characters: whitespace folded, cut at a word with '…'. */
export function glanceOf(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim()
  if (t.length <= GLANCE_MAX) return t
  const cut = t.slice(0, GLANCE_MAX - 1)
  const sp = cut.lastIndexOf(' ')
  return (sp > GLANCE_MAX / 2 ? cut.slice(0, sp) : cut).replace(/[\s,;:.]+$/, '') + '…'
}

/** What the glasses should show for a reading's move: '' for none or silence. */
export function glanceFor(move: Move | null): string {
  if (!move || move.kind === 'silence') return ''
  return move.glance || glanceOf(move.text)
}

// ── The learner's name ────────────────────────────────────────────────────────────────────────

const NAME_KEY = 'codrawer.primer.learner'

/**
 * A learner name in the protocol's alphabet: lowercase letters, digits, `-` and `_`, at most 32
 * characters; spaces become `-` and anything else is dropped. '' when nothing is left.
 */
export function foldName(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9_-]/g, '')
    .slice(0, 32)
}

/** Storage as the browser gives it, or null where it throws (private windows, previews). */
function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

/** The remembered learner name, or '' when none (or storage is unavailable). */
export function learnerName(): string {
  try {
    return foldName(storage()?.getItem(NAME_KEY) ?? '')
  } catch {
    return ''
  }
}

/** Remember the learner name (folded); returns what was stored. Works, unremembered, without storage. */
export function setLearnerName(name: string): string {
  const n = foldName(name)
  current = n
  try {
    if (n) storage()?.setItem(NAME_KEY, n)
    else storage()?.removeItem(NAME_KEY)
  } catch {
    // not remembered across loads; still used for this page
  }
  return n
}

let current: string | null = null

/** The name the learner chose (this load, else remembered), or '' when none. */
export function chosenLearner(): string {
  if (current === null) current = learnerName()
  return current
}

/** The name used in requests: the chosen one, else 'learner'. */
export function activeLearner(): string {
  return chosenLearner() || 'learner'
}

// ── Requests ──────────────────────────────────────────────────────────────────────────────────

export type RequestWhat = 'proof' | 'hint' | 'plan' | 'forget' | 'coach_on' | 'coach_off' | 'mock_start' | 'mock_problem' | 'mock_grade' | 'mock_stop' | 'mock_status'

/** A `primer_request` for the active learner (or `learner`), stamped `ts` (Unix ms). */
export function primerRequest(what: RequestWhat, learner = activeLearner(), ts = Date.now(), extra: Record<string, unknown> = {}) {
  return { t: 'primer_request', what, learner: foldName(learner) || 'learner', ts, ...extra }
}

// ── Small facts the panel shows ───────────────────────────────────────────────────────────────

/** "Estimated Putnam score 2/10 (partial)". */
export function gradeLine(g: Grade): string {
  const band = g.band.replace(/_/g, ' ')
  return `Estimated Putnam score ${Math.round(g.score)}/${Math.round(g.max)}${band ? ` (${band})` : ''}`
}

/** The heading over the move: "The Primer asks", "Hint 2", "Worked example", … */
export function moveHeading(m: Move): string {
  switch (m.kind) {
    case 'socratic':
      return 'The Primer asks'
    case 'hint':
      return m.hintLevel > 0 ? `Hint ${m.hintLevel}` : 'Hint'
    case 'worked_example':
      return 'Worked example'
    case 'affirm':
      return 'The Primer notes'
    case 'debrief':
      return 'Debrief'
    case 'notice':
      return 'The Primer says'
    case 'silence':
      return 'The Primer is waiting'
  }
}

/** "Lean: failed: <first line>" · "Lean: checked" · "Formal check: not checked". */
export function checkLine(c: ProofCheck): string {
  const who = c.prover ? c.prover[0].toUpperCase() + c.prover.slice(1) : 'Formal check'
  const status = c.status.replace('_', ' ')
  const detail = c.detail.split('\n')[0].trim()
  return detail ? `${who}: ${status}: ${detail}` : `${who}: ${status}`
}

/** "live · claude-opus-5-5" or "offline: fixture transcription". */
export function modeLine(r: Reading): string {
  return r.mode === 'live' ? `live · ${r.model ?? 'model'}` : 'offline: fixture transcription'
}

/** Whole days from `today` to the ISO date `iso` (negative once past); null when unparseable. */
export function daysUntil(iso: string, today = new Date()): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  if (!m) return null
  const target = Date.UTC(+m[1], +m[2] - 1, +m[3])
  const now = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate())
  return Math.round((target - now) / 86_400_000)
}

/** Index of the plan week containing `today` (the last week whose start is not after it), or -1. */
export function currentWeek(plan: Plan, today = new Date()): number {
  let at = -1
  plan.weeks.forEach((w, i) => {
    const d = daysUntil(w.start, today)
    if (d !== null && d <= 0) at = i
  })
  return at
}

/** The step a stroke-highlight should show, by number; null when the reading has none. */
export function stepByNumber(r: Reading | null, n: number): ProofStep | null {
  return r?.proof?.steps.find((s) => s.n === n) ?? null
}
