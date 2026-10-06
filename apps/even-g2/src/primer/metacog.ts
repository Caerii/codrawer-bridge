/**
 * Her side of the learner model on the app: calibration, goals, what she lets the Primer watch,
 * the next review, and the insights she can confirm or dismiss (ADR 010; the Primer side is
 * src/codrawer_bridge/primer/metacog.py, fsrs.py and reflect.py).
 *
 * Everything the model believes about her is shown here, and everything can be changed or
 * disputed from here: goals are hers to set, each kind of watching is a switch, an insight can be
 * marked "not right", and a mastery estimate can be called wrong (the Primer keeps the correction
 * as evidence). The `metacog` block of a `primer` message carries the state; requests carry the
 * changes back.
 *
 * Pure (no DOM): tested under tsx (test/primer.test.ts).
 */

export interface CalibrationBin {
  confidence: number
  outcome: number
  n: number
}

export interface Calibration {
  curve: CalibrationBin[]
  brier: number | null
  /** mean confidence − outcome: positive is overconfident */
  gap: number | null
  n: number
}

export interface Goals {
  target: string
  targetScore: number | null
  topics: string[]
  weeklyHours: number | null
  /** off · light · normal */
  nudging: string
  revisitDays: number
}

export interface Feature {
  id: string
  label: string
  on: boolean
}

export interface ReviewItem {
  id: string
  kind: string
  prompt: string
}

export interface Insight {
  id: string
  kind: string
  text: string
  suggestion: string
  confidence: number
}

export interface Metacog {
  calibration: Calibration
  calibrationNudge: string
  goals: Goals
  goalsRevisit: boolean
  features: Feature[]
  review: ReviewItem | null
  insights: Insight[]
}

export interface Report {
  file: string
  url: string
  error: string
}

type Obj = Record<string, unknown>
const obj = (v: unknown): Obj | null => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : null)
const str = (v: unknown, max = 2000): string => (typeof v === 'string' ? v.slice(0, max) : '')
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])

/** The `metacog` block; null when absent. */
export function parseMetacog(v: unknown): Metacog | null {
  const m = obj(v)
  if (!m) return null
  const c = obj(m.calibration) ?? {}
  const g = obj(m.goals) ?? {}
  const f = obj(m.features) ?? {}
  const rv = obj(m.review)
  return {
    calibration: {
      curve: arr(c.curve)
        .map(obj)
        .filter((b): b is Obj => b !== null)
        .map((b) => ({ confidence: num(b.confidence) ?? 0, outcome: num(b.outcome) ?? 0, n: num(b.n) ?? 0 })),
      brier: num(c.brier),
      gap: num(c.gap),
      n: num(c.n) ?? 0,
    },
    calibrationNudge: str(m.calibration_nudge, 300),
    goals: {
      target: str(g.target, 200),
      targetScore: num(g.target_score),
      topics: arr(g.topics).filter((t): t is string => typeof t === 'string'),
      weeklyHours: num(g.weekly_hours),
      nudging: str(g.nudging, 10) || 'light',
      revisitDays: num(g.revisit_days) ?? 7,
    },
    goalsRevisit: m.goals_revisit === true,
    features: Object.entries(f).map(([id, x]) => ({ id, label: str(obj(x)?.label, 200) || id, on: obj(x)?.on === true })),
    review: rv ? { id: str(rv.id, 120), kind: str(rv.kind, 20), prompt: str(rv.prompt, 400) } : null,
    insights: arr(m.insights)
      .map(obj)
      .filter((x): x is Obj => x !== null)
      .map((x) => ({ id: str(x.id, 120), kind: str(x.kind, 40), text: str(x.text, 400), suggestion: str(x.suggestion, 400), confidence: num(x.confidence) ?? 0 })),
  }
}

/** The `report` block; null when absent. */
export function parseReport(v: unknown): Report | null {
  const r = obj(v)
  return r ? { file: str(r.file, 200), url: str(r.url, 400), error: str(r.error, 300) } : null
}

/**
 * The http(s) URL of a report on the desktop router, from the session's ws(s) address: the same
 * host and port, the report's path. '' when the address is not a ws URL.
 */
export function reportUrl(wsAddress: string, path: string): string {
  const m = /^(wss?):\/\/([^/]+)/.exec(wsAddress)
  if (!m || !path.startsWith('/')) return ''
  return `${m[1] === 'wss' ? 'https' : 'http'}://${m[2]}${path}`
}

/** "+12 points (more sure than the grades)" or "−5 points (less sure)"; '' with no data. */
export function gapLine(c: Calibration): string {
  if (c.gap === null || !c.n) return ''
  const pts = Math.round(c.gap * 100)
  return `${pts >= 0 ? '+' : '−'}${Math.abs(pts)} points (${pts >= 0 ? 'more' : 'less'} sure than the grades) over ${c.n} proofs`
}
