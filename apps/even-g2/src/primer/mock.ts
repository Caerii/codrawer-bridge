/**
 * Putnam mock-exam mode on the app: the mock's state as the Primer sends it, and the quiet timer
 * line the glasses show (ADR 010; the Primer side is src/codrawer_bridge/primer/mock.py).
 *
 * A mock is four 90-minute sessions of three problems with the exam's breaks (15 min, about 1 h
 * 45, 15 min). The Primer sends the mock's state only when its phase changes (a `mock` block on a
 * `primer` message: the phase, when it ends as Unix ms, the session's problems, the problem being
 * written, and once graded the report); the app counts down by itself. On the glasses the countdown
 * is one line, refreshed at most once a minute, because a text update costs ~60–80 ms on the G2
 * (ADR 006) and an exam needs quiet: no tutoring line replaces it while the mock runs.
 *
 * Pure (no DOM): tested under tsx (test/primer.test.ts). primer/panel.ts draws the Mock tab;
 * main.ts runs the timer.
 */

/** One problem of the session on now (the statement is the text fallback for the page). */
export interface MockProblem {
  n: number
  id: string
  title: string
  statement: string
}

/** One graded problem of the report: an estimate, with the grader-style comments. */
export interface MockResult {
  session: number
  n: number
  problem: string
  title: string
  score: number
  band: string
  rigor: string
  exposition: string
  findings: string[]
}

export interface MockReport {
  total: number
  max: number
  problems: MockResult[]
}

/** The mock's state (the `mock` block of a `primer` message, docs/protocol.md). */
export interface MockView {
  id: string
  /** running · awaiting_grading · graded */
  status: string
  /** session · break · before · done */
  phase: string
  session: number
  of: number
  /** Unix ms when the current phase ends. */
  until: number
  /** The problem being written now (1..3). */
  cursor: number
  problems: MockProblem[]
  /** Unix ms after which the write-ups are graded, or 0. */
  gradeAfter: number
  /** The Primer is waiting for a fresh page before writing the problems. */
  freshPage: boolean
  report: MockReport | null
}

type Obj = Record<string, unknown>
const obj = (v: unknown): Obj | null => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : null)
const str = (v: unknown, max = 2000): string => (typeof v === 'string' ? v.slice(0, max) : '')
const num = (v: unknown, fallback = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])

/** The `mock` block as a {@link MockView}; null when absent or not an object. */
export function parseMock(v: unknown): MockView | null {
  const m = obj(v)
  if (!m) return null
  const r = obj(m.report)
  return {
    id: str(m.id, 80),
    status: str(m.status, 40),
    phase: str(m.phase, 20),
    session: Math.round(num(m.session, 1)),
    of: Math.round(num(m.of, 4)),
    until: num(m.until),
    cursor: Math.round(num(m.cursor, 1)),
    problems: arr(m.problems)
      .map(obj)
      .filter((p): p is Obj => p !== null)
      .map((p, i) => ({ n: Math.round(num(p.n, i + 1)), id: str(p.id, 80), title: str(p.title, 200), statement: str(p.statement) })),
    gradeAfter: num(m.grade_after),
    freshPage: m.fresh_page === true,
    report: r
      ? {
          total: num(r.total),
          max: num(r.max, 120),
          problems: arr(r.problems)
            .map(obj)
            .filter((p): p is Obj => p !== null)
            .map((p) => ({
              session: Math.round(num(p.session)),
              n: Math.round(num(p.n)),
              problem: str(p.problem, 80),
              title: str(p.title, 200),
              score: num(p.score),
              band: str(p.band, 40),
              rigor: str(p.rigor, 1000),
              exposition: str(p.exposition, 1000),
              findings: arr(p.findings).filter((f): f is string => typeof f === 'string'),
            })),
        }
      : null,
  }
}

/** True while the exam is on (a session, a break, or before the first session). */
export function mockActive(m: MockView | null): boolean {
  return !!m && m.status === 'running' && (m.phase === 'session' || m.phase === 'break' || m.phase === 'before')
}

/** Whole minutes from `now` to `until`, rounded up, never negative. */
export function minutesLeft(until: number, now: number): number {
  return Math.max(0, Math.ceil((until - now) / 60_000))
}

/**
 * The glasses' quiet line: "Mock S2/4 · 47 min · P1", "Break · S3 in 12 min", "Mock done · graded
 * tomorrow morning", "Mock graded: 64/120 (estimate)"; '' with no mock.
 */
export function mockLine(m: MockView | null, now: number): string {
  if (!m) return ''
  const left = minutesLeft(m.until, now)
  if (m.status === 'running' && m.phase === 'session') return `Mock S${m.session}/${m.of} · ${left} min · P${m.cursor}`
  if (m.status === 'running' && (m.phase === 'break' || m.phase === 'before')) return `Break · S${m.session} in ${left} min`
  if (m.status === 'awaiting_grading') return 'Mock done · graded tomorrow morning'
  if (m.status === 'graded' && m.report) return `Mock graded: ${Math.round(m.report.total)}/${Math.round(m.report.max)} (estimate)`
  return ''
}
