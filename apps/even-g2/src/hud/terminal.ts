/**
 * The terminal: a Claude Code session in even-terminal, reached through the router's term bridge.
 *
 * Out: a line becomes a `term_prompt` (from `/term <text>`, or any plain line in `/mode term`),
 * or a `term_answer` when the terminal is waiting on a permission (`y / a / n`) or a question.
 * The router attaches the turn's ink (or, for `/snap`, the whole page) as a file the agent Reads
 * (ADR 002). From the editor, the document rides along as context: it is saved first so the
 * agent reads what is on screen.
 *
 * In: `term` events. Streamed assistant text arrives in fragments; it is broken into transcript
 * lines at newlines, and a long unbroken tail is cut at a space near 80 characters so the live
 * line never outgrows the glasses. Permissions and questions set {@link term}.pending, which makes
 * the next whole line an answer, whatever the mode.
 */
import { link } from '../link'
import type { TermMessage } from '../protocol'
import { dirty, glasses, hud } from '../state'
import { editor, saveDoc } from '../doc/document'
import { appendOutput } from './transcript'

/** Where a plain (non-slash) line goes: kept in the transcript, or sent to the terminal. */
export type LineMode = 'ink' | 'term'

export const term = {
  mode: 'ink' as LineMode,
  /** The terminal is waiting for an answer: the next line is it. */
  pending: null as 'permission' | 'question' | null,
  /** Assistant text still being streamed (not yet a transcript line). */
  stream: '',
}

/** Commit whatever streamed text is pending as a transcript line. */
function flushStream() {
  if (term.stream.trim()) appendOutput(term.stream)
  term.stream = ''
}

/** A `term` event from the router. Unknown kinds are ignored. */
export function onTerm(m: TermMessage) {
  const text = typeof m.text === 'string' ? m.text : ''
  hud.typingAt = performance.now() // keep the transcript view open while the terminal talks
  switch (m.kind) {
    case 'text': {
      term.stream += text
      // break streamed text into transcript lines at newlines; keep the tail live
      const parts = term.stream.split('\n')
      term.stream = parts.pop() ?? ''
      for (const p of parts) appendOutput(p)
      if (term.stream.length > 90) {
        const cut = term.stream.lastIndexOf(' ', 80)
        const head = cut > 30 ? term.stream.slice(0, cut) : term.stream.slice(0, 80)
        appendOutput(head)
        term.stream = term.stream.slice(head.length).trimStart()
      }
      break
    }
    case 'permission':
      flushStream()
      term.pending = 'permission'
      appendOutput(text)
      break
    case 'question':
      flushStream()
      term.pending = 'question'
      appendOutput(text)
      break
    case 'note':
      flushStream()
      if (text.startsWith('→ ') || text.startsWith('— done')) term.pending = null
      appendOutput(text)
      break
    case 'status':
      flushStream()
      hud.notice = text
      break
    default:
      return
  }
  dirty.text = true
}

/** Send a line to the terminal; from the editor, with the (saved) document as context. */
export function sendTerm(kind: 'term_prompt' | 'term_answer', text: string) {
  if (link.open) {
    // from the editor, the document rides along as context for the agent
    const context = glasses.pageMode === 'edit' ? 'doc' : undefined
    if (context && editor.dirty) saveDoc('prompt')
    link.send({ t: kind, text, context, ts: Date.now() })
  } else hud.notice = 'not connected'
}

/** The input prompt's glyph: what the next Enter will do with the line. */
export function promptGlyph(): string {
  return term.pending === 'permission' ? 'y/a/n' : term.pending === 'question' ? '?' : term.mode === 'term' ? '$' : '>'
}
