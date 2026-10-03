/**
 * The text container's content: one function of the app's state, re-run whenever it may change.
 *
 * The same container says different things depending on the layout and on what you are doing:
 *
 *   canvas, idle     the agent's plan (with the AI layer on) or the metrics line, plus a notice
 *   canvas, typing   the 4-row strip becomes a mini transcript with the input line at the bottom
 *   text             9 rows of transcript, a header on spare rows
 *   edit             the document editor: a header line, the document, and (Ctrl+K) a command line
 *
 * Row budgets: the 288 px page at ~27 px per row minus padding gives 9 rows; the canvas layout's
 * strip below the images holds 4. Rows are filled from the bottom (hud/wrap.ts explains why): the
 * input line always, then the completion popup, then the terminal's live tail, then transcript
 * lines newest first until the budget is spent.
 *
 * The result goes to the glasses through the text pacing (glasses/text.ts) and to the phone's
 * Glasses panel. Output is capped at 1900 characters.
 */
import { HAS_LOUPE } from '../config'
import { editor } from '../doc/document'
import { scheduler } from '../glasses/display'
import { link } from '../link'
import { glasses, hud, store, view } from '../state'
import { suggestions } from './completion'
import { promptGlyph, term } from './terminal'
import { transcript } from './transcript'
import { COLS, wrapLine } from './wrap'

/** Rows of the full-screen text layouts, and of the canvas layout's status strip. */
const FULL_ROWS = 9
const STRIP_ROWS = 4

/** The typing view stays up this long after the last keystroke or terminal output, ms. */
const TYPING_VIEW_MS = 15000

/** Typing view: a line is being typed, a key was pressed recently, or the terminal is mid-answer. */
export function isTyping(): boolean {
  return hud.input.length > 0 || performance.now() - hud.typingAt < TYPING_VIEW_MS || term.stream.length > 0
}

/**
 * One line of state: ink counts, AI layer, framing, connection, then per-container round trip
 * and sends (`L<ms>/<count> · C<ms>/<count>`), and the last image result if it was not success.
 */
function metricsLine(): string {
  const conn = link.connected ? 'live' : 'reconnecting'
  const c = store.counts()
  const ai = view.showAi === false ? 'ai off' : `${c.ai} ai`
  const l = HAS_LOUPE ? ` · L${Math.round(scheduler.rt.loupe)}ms/${scheduler.sent.loupe}` : ''
  const k = ` · C${Math.round(scheduler.rt.canvas)}ms/${scheduler.sent.canvas}`
  const bad = scheduler.lastResult && scheduler.lastResult !== 'success' ? ' · img:' + scheduler.lastResult : ''
  return `${c.user} user · ${ai} · ${view.mode} · ${conn}${l}${k}${bad}`
}

/** The agent's plan, when there is one and the AI layer is shown. */
function planLine(): string | null {
  return hud.intent && view.showAi !== false ? `AI: ${hud.intent}` : null
}

/** The editor layout: header, document rows, and the command line when it is open. */
function renderEditor(): string {
  const overlayRows = hud.commandOverlay ? 1 : 0
  const v = editor.view(FULL_ROWS - 1 - overlayRows, COLS)
  const state = link.connected ? 'live' : 'offline'
  const head = hud.notice || `doc · Ln ${v.line}, Col ${v.col} · ${v.totalLines} lines · ${state}`
  const out = [head.slice(0, COLS), ...v.rows]
  while (out.length < FULL_ROWS - overlayRows) out.push('')
  if (hud.commandOverlay) out.push(wrapLine(`${promptGlyph()} ${hud.input}▌`).slice(-1)[0])
  return out.join('\n').slice(0, 1900)
}

/** The text container's content for the current layout and activity. */
export function renderText(): string {
  if (glasses.pageMode === 'edit') return renderEditor()
  const rows = glasses.pageMode === 'text' ? FULL_ROWS : STRIP_ROWS
  if (glasses.pageMode === 'canvas' && !isTyping()) {
    const plan = planLine()
    const head = plan ?? metricsLine()
    const foot = plan ? metricsLine() : hud.notice
    return foot ? `${head}\n${foot}` : head
  }

  // Bottom-up fill: the input line (always, at most two rows), then the completion popup.
  const bottom: string[] = []
  const inputRows = wrapLine(`${promptGlyph()} ${hud.input}▌${transcript.scrollBack ? `  ↑${transcript.scrollBack}` : ''}`)
  bottom.push(...inputRows.slice(-2)) // never more than two rows of input

  const sugg = suggestions(hud.input)
  if (sugg.length) {
    const max = glasses.pageMode === 'text' ? 5 : 2
    const start = Math.max(0, Math.min(hud.suggestIndex, sugg.length - max))
    const shown = sugg.slice(start, start + max)
    const popup = shown.map((c, i) => `${start + i === hud.suggestIndex ? '▸' : ' '} ${c.name}  ${c.help}`.slice(0, COLS))
    bottom.unshift(...popup)
  }

  // Above it: the terminal's live tail (two rows at most), then the transcript, newest first.
  let budget = rows - bottom.length
  const above: string[] = []
  if (term.stream && budget > 0) {
    const tail = wrapLine(term.stream)
    const take = tail.slice(-Math.min(2, budget))
    above.unshift(...take)
    budget -= take.length
  }
  const end = Math.max(0, transcript.lines.length - transcript.scrollBack)
  for (let i = end - 1; i >= 0 && budget > 0; i--) {
    const w = wrapLine(transcript.lines[i])
    const take = w.slice(-budget)
    above.unshift(...take)
    budget -= take.length
  }
  // A spare row on top: in the text layout a header (notice, plan or metrics); on the canvas
  // strip, the notice if there is one.
  if (glasses.pageMode === 'text' && budget > 0) {
    above.unshift(hud.notice || (planLine() ?? metricsLine()))
    budget--
  } else if (glasses.pageMode === 'canvas' && hud.notice && budget > 0) {
    above.unshift(hud.notice)
    budget--
  }
  return [...above, ...bottom].join('\n').slice(0, 1900)
}
