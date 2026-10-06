// The Primer's readings as the app keeps them (src/primer/model.ts): parsing, merging, the
// glasses' line, the learner name and the requests. The sample is a flawed proof that √2 is
// irrational, as the Primer would read it: lowest terms never assumed, so "both even" proves
// nothing.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  acceptReading,
  checkLine,
  currentWeek,
  daysUntil,
  foldName,
  GLANCE_MAX,
  glanceFor,
  glanceOf,
  gradeLine,
  modeLine,
  moveHeading,
  parseReading,
  primer,
  primerRequest,
  setLearnerName,
  activeLearner,
} from '../src/primer/model'
import { mockActive, mockLine, parseMock } from '../src/primer/mock'

const step = (n: number, latex: string, text: string, status: string, extra: Record<string, unknown> = {}) => ({
  n,
  latex,
  text,
  justification: '',
  refs: n > 1 ? [n - 1] : [],
  concepts: ['contradiction'],
  confidence: 0.9,
  status,
  note: '',
  strokes: [`u_${n}a`, `u_${n}b`],
  bbox: [0.1, 0.3 + n * 0.06, 0.7, 0.34 + n * 0.06],
  ...extra,
})

const weeks = [
  ['2026-10-12', ['proof techniques', 'induction', 'pigeonhole'], 12, null],
  ['2026-10-19', ['number theory'], 14, null],
  ['2026-10-26', ['inequalities', 'polynomials'], 12, '2026-10-31'],
  ['2026-11-02', ['combinatorics', 'generating functions'], 14, null],
  ['2026-11-09', ['linear algebra'], 12, '2026-11-14'],
  ['2026-11-16', ['analysis', 'series'], 14, null],
  ['2026-11-23', ['probability', 'functional equations', 'complex numbers'], 12, '2026-11-28'],
  ['2026-11-30', ['taper: review the technique notebook'], 6, null],
].map(([start, focus, problems, mock], i) => ({ n: i + 1, start, focus, problems, mock }))

const SAMPLE = {
  t: 'primer',
  v: 1,
  id: 'pr_3',
  learner: { name: 'nell', summary: 'Contradiction set-ups are solid; the closing step needs its reason.', mastery: [{ concept: 'parity', label: 'Parity', p: 0.71 }, { concept: 'irreducible_fraction', label: 'Lowest terms', p: 1.4 }], misconceptions: [{ id: 'sqrt2_no_lowest_terms', label: 'Forgets the lowest-terms assumption', count: 2 }], due: ['induction'] },
  mode: 'offline',
  model: null,
  proof: {
    title: '√2 is irrational',
    goal: '\\sqrt{2}\\notin\\mathbb{Q}',
    technique: 'contradiction',
    steps: [
      step(1, '\\sqrt{2}=\\tfrac{p}{q},\\ p,q\\in\\mathbb{Z},\\ q\\neq 0', 'Suppose √2 = p/q', 'gap', { note: 'lowest terms is never assumed', justification: 'assumption for contradiction' }),
      step(2, 'p^2 = 2q^2', 'Square both sides', 'ok'),
      step(3, 'p^2 \\text{ even} \\Rightarrow p \\text{ even}', 'So p is even', 'ok'),
      step(4, 'p = 2k \\Rightarrow q^2 = 2k^2', 'Substitute', 'ok'),
      step(5, 'q \\text{ even}', 'So q is even', 'ok'),
      step(6, '\\text{both even} \\Rightarrow \\bot', 'Contradiction', 'error', { note: 'nothing was assumed that "both even" contradicts' }),
    ],
    tex: '\\documentclass{article}\\begin{document}…\\end{document}',
    check: { prover: 'lean', status: 'failed', detail: 'step 6: omega could not prove the goal\nmore lines' },
  },
  findings: [{ id: 'sqrt2_no_lowest_terms', label: 'Never assumes p/q is in lowest terms', step: 1, kind: 'missing_rigor' }],
  grade: { score: 2, max: 10, band: 'partial', estimate: true, rigor: 'The descent is right but the contradiction has nothing to contradict.', exposition: 'Clear and well ordered.' },
  move: { kind: 'socratic', text: 'In step 6 you conclude both p and q are even. Why is that a contradiction? What did you assume about p and q at the start?', glance: 'Primer: why is "both even" a contradiction?', step: 6, hint_level: 0 },
  plan: { exam: '2026-12-05', weeks, queue: [{ id: 'pigeonhole_square', title: 'Five points in a unit square', why: 'stretch' }] },
}

test('a reading is parsed with every section, numbers clamped to their ranges', () => {
  const r = parseReading(SAMPLE)
  assert.ok(r)
  assert.equal(r.learner, 'nell')
  assert.equal(r.mode, 'offline')
  assert.equal(r.proof?.steps.length, 6)
  assert.equal(r.proof?.steps[0].status, 'gap')
  assert.equal(r.proof?.steps[5].status, 'error')
  assert.deepEqual(r.proof?.steps[2].strokes, ['u_3a', 'u_3b'])
  assert.equal(r.proof?.steps[2].bbox?.length, 4)
  assert.equal(r.proof?.check.status, 'failed')
  assert.equal(r.findings[0].kind, 'missing_rigor')
  assert.equal(r.grade?.score, 2)
  assert.equal(r.move?.kind, 'socratic')
  assert.equal(r.move?.step, 6)
  assert.equal(r.learnerSummary?.mastery[1].p, 1, 'mastery is a probability')
  assert.equal(r.plan?.weeks.filter((w) => w.mock).length, 3)
  assert.equal(r.plan?.weeks[2].mock, '2026-10-31')
})

test('garbage fields become empty values, never exceptions', () => {
  assert.equal(parseReading(null), null)
  assert.equal(parseReading('primer'), null)
  const r = parseReading({ t: 'primer', mode: 'sideways', proof: { steps: [null, 7, { status: 'maybe', bbox: [1, 2], confidence: 9 }], check: 'x' }, move: { kind: 'shout', text: 42 }, grade: { score: 99 } })
  assert.ok(r)
  assert.equal(r.mode, 'offline')
  assert.equal(r.proof?.steps.length, 1)
  assert.equal(r.proof?.steps[0].status, 'unclear')
  assert.equal(r.proof?.steps[0].bbox, null)
  assert.equal(r.proof?.steps[0].confidence, 1)
  assert.equal(r.proof?.check.status, 'not_checked')
  assert.equal(r.move?.kind, 'socratic')
  assert.equal(r.grade?.score, 10, 'clamped to max')
})

test('an answer without a proof keeps the previous proof; a new proof replaces findings and grade', () => {
  primer.latest = null
  acceptReading(parseReading(SAMPLE)!)
  const merged = acceptReading(parseReading({ t: 'primer', learner: { name: 'nell', summary: 'fresh' }, plan: { exam: '2026-12-05', weeks: [], queue: [] } })!)
  assert.equal(merged.proof?.steps.length, 6)
  assert.equal(merged.grade?.score, 2)
  assert.equal(merged.findings.length, 1)
  assert.equal(merged.learnerSummary?.summary, 'fresh')
  const next = acceptReading(parseReading({ t: 'primer', proof: { title: 'Odd sums', steps: [] } })!)
  assert.equal(next.proof?.title, 'Odd sums')
  assert.equal(next.findings.length, 0)
  assert.equal(next.grade, null)
  assert.equal(primer.count, 3)
})

test('the glasses get one short line, and nothing for silence', () => {
  const r = parseReading(SAMPLE)!
  assert.equal(glanceFor(r.move), 'Primer: why is "both even" a contradiction?')
  assert.ok(glanceFor(r.move).length <= GLANCE_MAX)
  const long = glanceOf('In step six you conclude that both p and q are even numbers; why is that a contradiction?')
  assert.ok(long.length <= GLANCE_MAX)
  assert.ok(long.endsWith('…'))
  assert.equal(glanceFor({ kind: 'silence', text: '', glance: '', step: 0, hintLevel: 0 }), '')
  assert.equal(glanceFor(null), '')
})

test('learner names fold to the protocol alphabet and ride on requests', () => {
  assert.equal(foldName('  Nell Smith! '), 'nell-smith')
  assert.equal(foldName('x'.repeat(40)).length, 32)
  assert.equal(setLearnerName('Nell'), 'nell') // no localStorage under node: used, not remembered
  assert.equal(activeLearner(), 'nell')
  assert.deepEqual(primerRequest('hint', 'nell', 5), { t: 'primer_request', what: 'hint', learner: 'nell', ts: 5 })
  assert.equal(primerRequest('proof', '***', 1).learner, 'learner')
})

test('the panel lines say what they are: an estimate, the mode, the check', () => {
  const r = parseReading(SAMPLE)!
  assert.equal(gradeLine(r.grade!), 'Estimated Putnam score 2/10 (partial)')
  assert.equal(moveHeading(r.move!), 'The Primer asks')
  assert.equal(moveHeading({ ...r.move!, kind: 'hint', hintLevel: 2 }), 'Hint 2')
  assert.equal(checkLine(r.proof!.check), 'Lean: failed: step 6: omega could not prove the goal')
  assert.equal(checkLine({ prover: '', status: 'not_checked', detail: '' }), 'Formal check: not checked')
  assert.equal(modeLine(r), 'offline: fixture transcription')
  assert.equal(modeLine({ ...r, mode: 'live', model: 'claude-opus-5-5' }), 'live · claude-opus-5-5')
})

test('the plan knows the days left and the current week', () => {
  const plan = parseReading(SAMPLE)!.plan!
  const today = new Date(2026, 10, 3) // 3 Nov 2026, local
  assert.equal(daysUntil('2026-12-05', today), 32)
  assert.equal(daysUntil('nope', today), null)
  assert.equal(currentWeek(plan, today), 3) // week 4 started 2 Nov
  assert.equal(currentWeek(plan, new Date(2026, 9, 1)), -1)
})

test('the coach view is parsed with its reasons, and kept when a reading has none', () => {
  primer.latest = null
  const withCoach = parseReading({
    t: 'primer',
    coach: {
      watching: true,
      next: [{ id: 'pigeonhole_square', title: 'Five points in a square', why: 'Matches what you were just reading (pigeonhole).', kind: 'reading' }],
      weak: [{ kind: 'misconception', id: 'sqrt2_no_lowest_terms', label: 'Never assumes p/q is in lowest terms', why: 'seen 2 times' }],
      attempts: 3,
      last_reading: { title: 'Engel 4 Pigeonhole', page: 'p7' },
      nudge: 'Seen before: never assumes p/q is in lowest terms.',
    },
  })!
  assert.equal(withCoach.coach?.watching, true)
  assert.equal(withCoach.coach?.next[0].label, 'Five points in a square')
  assert.match(withCoach.coach?.next[0].why ?? '', /reading/)
  assert.equal(withCoach.coach?.weak[0].label, 'Never assumes p/q is in lowest terms')
  assert.equal(withCoach.coach?.lastReading, 'Engel 4 Pigeonhole')
  acceptReading(withCoach)
  const merged = acceptReading(parseReading({ t: 'primer', move: { kind: 'notice', text: "I can't read this page offline." } })!)
  assert.equal(merged.coach?.attempts, 3)
  assert.equal(moveHeading(merged.move!), 'The Primer says')
  assert.deepEqual(primerRequest('coach_on', 'nell', 1), { t: 'primer_request', what: 'coach_on', learner: 'nell', ts: 1 })
})

test('a mock exam is parsed, and the glasses line counts down quietly', () => {
  const now = Date.UTC(2026, 9, 24, 15, 0)
  const m = parseMock({
    id: 'mock-20261024-1100',
    status: 'running',
    phase: 'session',
    session: 2,
    of: 4,
    until: now + 46.2 * 60_000,
    cursor: 3,
    problems: [{ n: 1, id: 'squares_mod_4', title: 'Sums of two squares', statement: 'Prove that…' }],
    fresh_page: true,
  })!
  assert.equal(mockActive(m), true)
  assert.equal(mockLine(m, now), 'Mock S2/4 · 47 min · P3')
  assert.equal(m.freshPage, true)
  assert.equal(mockLine({ ...m, phase: 'break', session: 3 }, now), 'Break · S3 in 47 min')
  const graded = parseMock({ status: 'graded', phase: 'done', report: { total: 64, max: 120, problems: [{ session: 1, n: 1, title: 'x', score: 8, band: 'minor_flaws', findings: ['a'] }] } })!
  assert.equal(mockActive(graded), false)
  assert.equal(mockLine(graded, now), 'Mock graded: 64/120 (estimate)')
  assert.equal(graded.report?.problems[0].score, 8)
  assert.equal(parseMock('nope'), null)
  const r = parseReading({ t: 'primer', mock: { status: 'awaiting_grading', phase: 'done', grade_after: now } })!
  assert.equal(mockLine(r.mock, now), 'Mock done · graded tomorrow morning')
  assert.deepEqual(primerRequest('mock_problem', 'nell', 1, { n: 2 }), { t: 'primer_request', what: 'mock_problem', learner: 'nell', ts: 1, n: 2 })
})
