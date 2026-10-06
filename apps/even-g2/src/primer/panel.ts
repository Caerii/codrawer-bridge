/**
 * The Proof panel: the Primer's latest reading on the phone, typeset (ADR 010).
 *
 * A sheet over the page (on the right on wide screens, from the bottom on phones) with three tabs:
 *
 *   Proof     the learner's proof re-typeset step by step (KaTeX), each step's status and the
 *             Primer's note, what it found, the Putnam-style score estimate (labelled as one), the
 *             formal check's honest status, and the Primer's next move; buttons ask for a reading
 *             or the next hint and save the LaTeX document
 *   Plan      the weeks to the exam, the current week picked out, and the problem queue
 *   Mock      a Putnam mock exam: start one, the countdown, the session's problems (the text
 *             fallback when agent ink is off), which problem is being written, and the report
 *   Coach     the practice coach: whether it is watching (and the switch), its last nudge, the
 *             next problems and the weak spots it found, each with the reason it gives
 *   Learner   the learner's name (who the requests are for), mastery, misconceptions seen, what is
 *             due for review, and deleting the learner's file on the desktop
 *
 * Tapping a step picks out the strokes it was read from on the phone stage (Stage.highlight):
 * the step carries their `stroke_begin` ids and bounds. Tapping it again, or another reading,
 * clears it.
 *
 * KaTeX is loaded on first use (a dynamic import with its stylesheet and fonts), so the app's base
 * bundle and the glasses path pay nothing for it. Until it arrives, and wherever it rejects an
 * expression, the raw LaTeX shows as code: the learner always sees what was read.
 *
 * Everything the Primer sends is shown as text (textContent) or through KaTeX with its default
 * `trust: false`; nothing from the wire becomes markup.
 */
import { link } from '../link'
import { mockLine } from './mock'
import { stage } from '../phone/screen'
import { shareOrDownload, stampedName } from '../phone/share'
import {
  activeLearner,
  checkLine,
  chosenLearner,
  currentWeek,
  daysUntil,
  gradeLine,
  modeLine,
  moveHeading,
  primer,
  primerRequest,
  setLearnerName,
  type Reading,
  type RequestWhat,
} from './model'

const panel = document.getElementById('primer') as HTMLElement
const body = panel.querySelector('.pbody') as HTMLDivElement
const tabs = Array.from(panel.querySelectorAll<HTMLButtonElement>('.ptabs button[data-tab]'))

type Tab = 'proof' | 'plan' | 'mock' | 'coach' | 'learner'
let tab: Tab = 'proof'
/** The step whose strokes are picked out on the stage, or 0. */
let marked = 0
/** Shown under the buttons for a moment: "asked", "not connected", … */
let notice = ''
let noticeTimer: ReturnType<typeof setTimeout> | undefined
/** The inline confirm for deleting the learner file is open. */
let confirmForget = false

// ── KaTeX, on first use ───────────────────────────────────────────────────────────────────────

type Katex = typeof import('katex').default
let katex: Katex | null = null
let katexLoading = false

/** Start loading KaTeX and its stylesheet; the panel redraws when they arrive. */
function loadKatex() {
  if (katex || katexLoading) return
  katexLoading = true
  Promise.all([import('katex'), import('katex/dist/katex.min.css')])
    .then(([k]) => {
      katex = k.default
      if (isOpen()) render()
    })
    .catch((e) => console.warn('[codrawer] KaTeX did not load; showing LaTeX source', e))
}

/** `latex` typeset into a new element (display or inline), or as code when KaTeX is absent or rejects it. */
function math(latex: string, display = false): HTMLElement {
  const el = document.createElement(display ? 'div' : 'span')
  el.className = display ? 'pmath display' : 'pmath'
  if (katex && latex) {
    try {
      katex.render(latex, el, { displayMode: display, throwOnError: true, output: 'htmlAndMathml' })
      return el
    } catch {
      el.replaceChildren()
    }
  }
  const code = document.createElement('code')
  code.textContent = latex
  el.append(code)
  return el
}

// ── Small builders ────────────────────────────────────────────────────────────────────────────

/** An element with a class and text. */
function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  if (cls) el.className = cls
  if (text) el.textContent = text
  return el
}

function button(label: string, onclick: () => void, cls = ''): HTMLButtonElement {
  const b = h('button', cls, label)
  b.type = 'button'
  b.onclick = onclick
  return b
}

/** Send a request for the active learner and say what happened, briefly. */
function ask(what: RequestWhat) {
  const ok = link.send(primerRequest(what))
  const asked: Partial<Record<RequestWhat, string>> = {
    proof: 'Asked the Primer to read the page…',
    hint: 'Asked for the next hint…',
    forget: 'Asked the desktop to delete the file…',
    coach_on: 'Asked the coach to start watching…',
    coach_off: 'Asked the coach to stop watching…',
    mock_start: 'Starting a mock exam…',
    mock_grade: 'Asked the Primer to grade the mock now…',
    mock_stop: 'Stopping the mock…',
  }
  say(ok ? (asked[what] ?? 'Asked…') : 'Not connected to a router')
}

function say(text: string) {
  notice = text
  clearTimeout(noticeTimer)
  noticeTimer = setTimeout(() => {
    notice = ''
    if (isOpen()) render()
  }, 4000)
  render()
}

// ── The tabs ──────────────────────────────────────────────────────────────────────────────────

function emptyState(text: string): HTMLElement {
  return h('p', 'pempty', text)
}

function renderProof(r: Reading | null): HTMLElement[] {
  const out: HTMLElement[] = []
  const p = r?.proof
  if (!r || !p) {
    out.push(emptyState('No reading yet. Write a proof on the page, then pause, type /proof on the keyboard, or press Read my proof.'))
  } else {
    const head = h('div', 'phead')
    head.append(h('div', 'ptitle', p.title || 'Proof'))
    if (p.goal) head.append(math(p.goal, true))
    const chips = h('div', 'pchips')
    if (p.technique) chips.append(h('span', 'pchip', p.technique.replace(/_/g, ' ')))
    chips.append(h('span', `pchip mode ${r.mode}`, modeLine(r)))
    head.append(chips)
    out.push(head)

    if (r.grade) {
      const g = h('div', 'pgrade')
      g.append(h('div', 'pscore', gradeLine(r.grade)))
      g.append(h('div', 'pfine', 'An estimate by the Primer, not an official grade.'))
      if (r.grade.rigor) g.append(h('div', 'pline', `Rigor: ${r.grade.rigor}`))
      if (r.grade.exposition) g.append(h('div', 'pline', `Exposition: ${r.grade.exposition}`))
      out.push(g)
    }

    if (r.move && r.move.kind !== 'silence' && r.move.text) {
      const q = h('blockquote', `pmove ${r.move.kind}`)
      q.append(h('div', 'pmovehead', moveHeading(r.move) + (r.move.step ? ` · step ${r.move.step}` : '')))
      q.append(h('div', 'pmovetext', r.move.text))
      out.push(q)
    }

    const ol = h('ol', 'psteps')
    for (const s of p.steps) {
      const li = h('li', `pstep ${s.status}${marked === s.n ? ' marked' : ''}`)
      li.dataset.step = String(s.n)
      li.tabIndex = 0
      li.setAttribute('role', 'button')
      li.setAttribute('aria-pressed', String(marked === s.n))
      li.title = s.strokes.length || s.bbox ? 'Show this step’s ink on the page' : 'No ink linked to this step'
      const top = h('div', 'pstephead')
      top.append(h('span', 'pnum', String(s.n)))
      top.append(h('span', `pstatus ${s.status}`, s.status))
      if (s.confidence < 0.6) top.append(h('span', 'pconf', `read with ${Math.round(s.confidence * 100)}% confidence`))
      li.append(top)
      if (s.latex) li.append(math(s.latex, true))
      if (s.text) li.append(h('div', 'ptext', s.text))
      if (s.justification) li.append(h('div', 'pjust', `Because: ${s.justification}`))
      if (s.note) li.append(h('div', 'pnote', s.note))
      ol.append(li)
    }
    out.push(ol)

    if (r.findings.length) {
      const f = h('div', 'pfindings')
      f.append(h('div', 'plabel', 'What the Primer noticed'))
      const ul = h('ul')
      for (const x of r.findings) ul.append(h('li', '', `${x.label}${x.step ? ` (step ${x.step})` : ''}${x.kind ? ` · ${x.kind.replace(/_/g, ' ')}` : ''}`))
      f.append(ul)
      out.push(f)
    }

    out.push(h('div', `pcheck ${p.check.status}`, checkLine(p.check)))
  }

  const actions = h('div', 'pactions')
  actions.append(button('Read my proof', () => ask('proof'), 'go'))
  actions.append(button('Hint', () => ask('hint')))
  const tex = button('Download .tex', () => void downloadTex())
  tex.disabled = !p?.tex
  actions.append(tex)
  out.push(actions)
  return out
}

function renderPlan(r: Reading | null): HTMLElement[] {
  const plan = r?.plan
  if (!plan || (!plan.weeks.length && !plan.queue.length)) return [emptyState('No plan yet. The Primer sends one with its first reading.'), planButton()]
  const out: HTMLElement[] = []
  if (plan.exam) {
    const d = daysUntil(plan.exam)
    out.push(h('div', 'pexam', `Exam ${plan.exam}${d === null ? '' : d > 0 ? ` · ${d} days left` : d === 0 ? ' · today' : ' · past'}`))
  }
  const now = currentWeek(plan)
  const ol = h('ol', 'pweeks')
  plan.weeks.forEach((w, i) => {
    const li = h('li', `pweek${i === now ? ' now' : ''}`)
    const top = h('div', 'pweekhead')
    top.append(h('span', 'pnum', `Week ${w.n}`))
    if (w.start) top.append(h('span', 'pfine', w.start))
    if (i === now) top.append(h('span', 'pchip', 'this week'))
    li.append(top)
    if (w.focus.length) li.append(h('div', 'ptext', w.focus.join(' · ')))
    const meta = h('div', 'pfine', `${w.problems} problems${w.mock ? ` · mock exam ${w.mock}` : ''}`)
    li.append(meta)
    ol.append(li)
  })
  out.push(ol)
  if (plan.queue.length) {
    out.push(h('div', 'plabel', 'Next problems'))
    const ul = h('ul', 'pqueue')
    for (const q of plan.queue) {
      const li = h('li')
      li.append(h('span', 'ptext', q.title || q.id))
      if (q.why) li.append(h('span', 'pchip', q.why))
      ul.append(li)
    }
    out.push(ul)
  }
  out.push(planButton())
  return out
}

function planButton(): HTMLElement {
  const a = h('div', 'pactions')
  a.append(button('Refresh plan', () => ask('plan')))
  return a
}

function renderMock(r: Reading | null): HTMLElement[] {
  const out: HTMLElement[] = []
  const m = r?.mock ?? null
  const now = Date.now()
  if (!m || m.status === 'abandoned') {
    out.push(h('p', 'ptext', 'A mock exam runs like the 2026 Putnam: four 90-minute sessions of three problems, with breaks of 15 minutes, about 1 h 45 and 15 minutes. The Primer stays quiet until it grades the write-ups the next morning.'))
    const mocks = (r?.plan?.weeks ?? []).map((w) => w.mock).filter((d): d is string => !!d)
    if (mocks.length) out.push(h('p', 'pfine', `Scheduled mocks: ${mocks.join(', ')}`))
    const a = h('div', 'pactions')
    a.append(button('Start a mock now', () => ask('mock_start'), 'go'))
    out.push(a)
    return out
  }
  out.push(h('div', 'pclock', mockLine(m, now) || 'Mock'))
  if (m.status === 'running' && m.phase === 'session') {
    if (m.freshPage) out.push(h('p', 'pnotice', 'Turn to a fresh page: the problems will be written there.'))
    for (const p of m.problems) {
      const box = h('div', `pmockprob${p.n === m.cursor ? ' now' : ''}`)
      box.append(h('div', 'plabel', `Problem ${p.n} · ${p.title}`))
      box.append(h('div', 'ptext', p.statement))
      const pick = button(p.n === m.cursor ? 'Writing this one' : 'Write this one', () => link.send(primerRequest('mock_problem', undefined, undefined, { n: p.n })))
      pick.disabled = p.n === m.cursor
      box.append(pick)
      out.push(box)
    }
    out.push(h('p', 'pfine', 'Or type /p 1, /p 2, /p 3 on the keyboard. Ink is collected for the problem you are writing.'))
  } else if (m.status === 'running') {
    out.push(h('p', 'ptext', 'Break. Pens down: ink drawn now is not collected.'))
  }
  if (m.status === 'awaiting_grading') {
    const when = m.gradeAfter ? new Date(m.gradeAfter).toLocaleString() : 'tomorrow morning'
    out.push(h('p', 'ptext', `All four sessions are done. The write-ups are graded at ${when}.`))
  }
  if (m.report) {
    out.push(h('div', 'pscore', `Estimated total ${Math.round(m.report.total)}/${Math.round(m.report.max)}`))
    out.push(h('div', 'pfine', 'Estimates by the Primer, Putnam-style (0–10 per problem), not official grades.'))
    const ol = h('ol', 'psteps')
    for (const p of m.report.problems) {
      const li = h('li', `pstep ${p.score >= 8 ? 'ok' : p.score >= 1 ? 'gap' : 'error'}`)
      const top = h('div', 'pstephead')
      top.append(h('span', 'pnum', `S${p.session}·P${p.n}`))
      top.append(h('span', 'pscorecell', `${Math.round(p.score)}/10`))
      top.append(h('span', 'ptext', p.title))
      li.append(top)
      if (p.rigor) li.append(h('div', 'pline', `Rigor: ${p.rigor}`))
      if (p.exposition) li.append(h('div', 'pline', `Exposition: ${p.exposition}`))
      if (p.findings.length) li.append(h('div', 'pnote', p.findings.join(' · ')))
      ol.append(li)
    }
    out.push(ol)
  }
  const a = h('div', 'pactions')
  if (m.status === 'running') a.append(button('Stop mock', () => ask('mock_stop')))
  if (m.status === 'running' || m.status === 'awaiting_grading') a.append(button('Grade now', () => ask('mock_grade')))
  if (m.status === 'graded') a.append(button('Start another mock', () => ask('mock_start'), 'go'))
  out.push(a)
  return out
}

function renderCoach(r: Reading | null): HTMLElement[] {
  const out: HTMLElement[] = []
  const c = r?.coach
  const watching = c?.watching === true
  const state = h('div', `pwatch${watching ? ' on' : ''}`)
  state.append(h('span', 'pdot'))
  state.append(h('span', '', watching ? 'The coach is watching: reading position and attempts are logged on the desktop.' : 'The coach is not watching. Nothing is logged until you turn it on.'))
  out.push(state)
  const toggle = h('div', 'pactions')
  toggle.append(button(watching ? 'Stop watching' : 'Start watching', () => ask(watching ? 'coach_off' : 'coach_on'), watching ? '' : 'go'))
  toggle.append(button('Refresh', () => ask('plan')))
  out.push(toggle)
  if (!c) {
    out.push(emptyState('No word from the coach yet.'))
    return out
  }
  if (c.nudge) out.push(h('blockquote', 'pmove coach', c.nudge))
  if (c.next.length) {
    out.push(h('div', 'plabel', 'Try next'))
    const ul = h('ul', 'pqueue')
    for (const q of c.next) {
      const li = h('li')
      li.append(h('span', 'ptext', q.label))
      if (q.kind) li.append(h('span', 'pchip', q.kind))
      if (q.why) li.append(h('div', 'pfine', `Why: ${q.why}`))
      ul.append(li)
    }
    out.push(ul)
  }
  if (c.weak.length) {
    out.push(h('div', 'plabel', 'Weak spots'))
    const ul = h('ul')
    for (const w of c.weak) ul.append(h('li', '', `${w.label}${w.why ? ` (${w.why})` : ''}`))
    out.push(ul)
  }
  const facts = [`${c.attempts} attempt${c.attempts === 1 ? '' : 's'} logged`]
  if (c.lastReading) facts.push(`last reading: ${c.lastReading}`)
  out.push(h('p', 'pfine', facts.join(' · ')))
  return out
}

function renderLearner(r: Reading | null): HTMLElement[] {
  const out: HTMLElement[] = []
  const who = h('label', 'pwho')
  who.append(h('span', 'plabel', 'Learner'))
  const input = h('input')
  input.value = chosenLearner()
  input.placeholder = 'your name (requests go as “learner” until set)'
  input.maxLength = 32
  input.autocomplete = 'off'
  input.spellcheck = false
  input.onchange = () => {
    input.value = setLearnerName(input.value)
    say(input.value ? `Requests are now for ${input.value}` : 'Name cleared')
  }
  who.append(input)
  out.push(who)
  out.push(h('p', 'pfine', 'Your learner file lives on the desktop, is yours to read and delete, and is sent nowhere except the model call that reads a turn.'))

  const l = r?.learnerSummary
  if (!l || (!l.mastery.length && !l.summary && !l.misconceptions.length)) {
    out.push(emptyState('Nothing recorded yet.'))
  } else {
    if (l.summary) out.push(h('p', 'ptext', l.summary))
    if (l.mastery.length) {
      out.push(h('div', 'plabel', 'Mastery (estimated)'))
      const ul = h('ul', 'pbars')
      for (const m of l.mastery) {
        const li = h('li')
        li.append(h('span', 'pbarlabel', m.label))
        const bar = h('span', 'pbar')
        const fill = h('span', 'pfill')
        fill.style.width = `${Math.round(m.p * 100)}%`
        bar.append(fill)
        li.append(bar)
        li.append(h('span', 'pfine', `${Math.round(m.p * 100)}%`))
        ul.append(li)
      }
      out.push(ul)
    }
    if (l.misconceptions.length) {
      out.push(h('div', 'plabel', 'Seen in your proofs'))
      const ul = h('ul')
      for (const m of l.misconceptions) ul.append(h('li', '', `${m.label}${m.count > 1 ? ` ×${m.count}` : ''}`))
      out.push(ul)
    }
    if (l.due.length) {
      out.push(h('div', 'plabel', 'Due for review'))
      out.push(h('div', 'ptext', l.due.map((d) => d.replace(/_/g, ' ')).join(', ')))
    }
  }

  const del = h('div', 'pforget')
  if (!confirmForget) {
    del.append(
      button(
        'Delete my learner file…',
        () => {
          confirmForget = true
          render()
        },
        'danger-link',
      ),
    )
  } else {
    del.append(h('p', '', `Delete everything the Primer knows about ${activeLearner()} on the desktop? This cannot be undone.`))
    del.append(
      button(
        'Delete',
        () => {
          confirmForget = false
          ask('forget')
        },
        'danger',
      ),
    )
    del.append(
      button('Cancel', () => {
        confirmForget = false
        render()
      }),
    )
  }
  out.push(del)
  return out
}

// ── Drawing the panel ─────────────────────────────────────────────────────────────────────────

/** Redraw the panel's current tab from the latest reading (cheap; on every reading and action). */
function render() {
  const r = primer.latest
  for (const b of tabs) b.setAttribute('aria-selected', String(b.dataset.tab === tab))
  const parts = tab === 'proof' ? renderProof(r) : tab === 'plan' ? renderPlan(r) : tab === 'mock' ? renderMock(r) : tab === 'coach' ? renderCoach(r) : renderLearner(r)
  const coachTab = tabs.find((b) => b.dataset.tab === 'coach')
  if (coachTab) coachTab.textContent = r?.coach?.watching ? 'Coach ●' : 'Coach'
  if (notice) parts.push(h('div', 'pnotice', notice))
  const scroll = body.scrollTop
  body.replaceChildren(...parts)
  body.scrollTop = scroll
}

/** Pick out step `n`'s ink on the stage, or clear it when `n` is 0 or already picked. */
function markStep(n: number) {
  marked = n === marked ? 0 : n
  const s = marked ? primer.latest?.proof?.steps.find((x) => x.n === marked) : null
  stage.highlight(s ? s.strokes : null, s?.bbox ?? null)
  render()
}

async function downloadTex() {
  const tex = primer.latest?.proof?.tex
  if (!tex) return
  const blob = new Blob([tex], { type: 'application/x-tex' })
  const how = await shareOrDownload(blob, stampedName('primer-proof', 'tex'), 'Proof (LaTeX)')
  console.log('[codrawer] primer .tex', how)
}

// ── Opening, closing, wiring ──────────────────────────────────────────────────────────────────

export function isOpen(): boolean {
  return !panel.hidden
}

/** Show or hide the panel; `onToggle` listeners (the menu's checkbox) hear about it. */
export function setPanelOpen(open: boolean) {
  panel.hidden = !open
  document.body.classList.toggle('primer-open', open)
  if (open) {
    loadKatex()
    render()
  } else if (marked) {
    markStep(marked) // closing the panel clears the stage highlight
  }
}

export function togglePanel() {
  setPanelOpen(!isOpen())
}

/** A new reading arrived (main.ts after model.acceptReading): drop a stale highlight, redraw. */
export function onReading() {
  if (marked) {
    marked = 0
    stage.highlight(null)
  }
  if (isOpen()) render()
}

/** Wire the tabs, the step taps and the close button; open at load with `?panel=proof|plan|learner`. */
export function setupPrimerPanel() {
  for (const b of tabs)
    b.onclick = () => {
      tab = b.dataset.tab as Tab
      render()
    }
  ;(panel.querySelector('.pclose') as HTMLButtonElement).onclick = () => setPanelOpen(false)
  body.addEventListener('click', (e) => {
    const li = (e.target as HTMLElement).closest<HTMLElement>('.pstep')
    if (li) markStep(Number(li.dataset.step))
  })
  body.addEventListener('keydown', (e) => {
    const li = (e.target as HTMLElement).closest<HTMLElement>('.pstep')
    if (li && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault()
      markStep(Number(li.dataset.step))
    }
  })
  panel.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') setPanelOpen(false)
  })
  const want = new URLSearchParams(location.search).get('panel')
  if (want === 'proof' || want === 'plan' || want === 'mock' || want === 'coach' || want === 'learner') {
    tab = want
    setPanelOpen(true)
  }
}
