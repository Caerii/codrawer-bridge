/**
 * What a committed line does: slash commands, terminal lines, and answers.
 *
 * Enter commits the line being typed. It always goes into the transcript first. Then, in order of
 * precedence:
 *
 * 1. A pending terminal permission or question takes the whole line as its answer, whatever it
 *    says and whatever the mode.
 * 2. In `/mode term`, a plain (non-slash) line is an instruction to the terminal.
 * 3. A slash command does what the table below says; any other line just stays in the transcript.
 *
 *   /term, /t <text>     one instruction to the terminal (+ this turn's ink)       term_prompt
 *   /snap [text]         the whole page to the terminal, with a default question   term_prompt
 *   /mode ink|term       where plain lines go
 *   /hw, /write <text>   the AI handwrites <text> on the canvas                     prompt
 *   /draw, /d <text>     the AI draws <text>                                         prompt
 *   /new                 new drawing for every client                               clear
 *   /ai                  toggle the AI ghost layer
 *   /text                toggle the full-screen text view
 *   /clear               clear the transcript
 *   /edit                open or leave the document editor
 *   /doc [new]           share the document with the session (`new`: empty it)     doc
 *
 * Most commands leave a one-line notice (hud.notice) saying what happened or how to use them.
 */
import { applyAction } from '../actions'
import { editor, newDocument, saveDoc } from '../doc/document'
import { setPageMode } from '../glasses/page'
import { link } from '../link'
import { dirty, glasses, hud, view } from '../state'
import { sendTerm, term } from './terminal'
import { appendTyped, clearTranscript } from './transcript'

/** Carry out a committed line (see the module comment). Blank lines do nothing. */
export function commitLine(raw: string) {
  const line = raw.trim()
  if (!line) return
  appendTyped(line)
  const [cmd, ...rest] = line.split(/\s+/)
  const arg = rest.join(' ')
  const send = (o: Record<string, unknown>) => link.send({ ...o, ts: Date.now() })
  // A pending terminal permission/question takes the whole line, whatever the mode.
  if (term.pending) {
    sendTerm('term_answer', line)
    term.pending = null
    return
  }
  if (!line.startsWith('/') && term.mode === 'term') {
    sendTerm('term_prompt', line)
    return
  }
  switch (cmd.toLowerCase()) {
    case '/term':
    case '/t':
      if (arg) sendTerm('term_prompt', arg)
      hud.notice = arg ? '' : 'usage: /term <instruction>'
      break
    case '/snap':
      // whole page attached, whatever was drawn this turn
      link.send({ t: 'term_prompt', text: arg || 'Look at the attached drawing and describe what you see.', attach: 'page', ts: Date.now() })
      break
    case '/mode':
      term.mode = arg.toLowerCase() === 'term' ? 'term' : 'ink'
      hud.notice = `mode: ${term.mode}`
      break
    case '/hw':
    case '/write':
      if (arg) send({ t: 'prompt', text: arg, mode: 'handwriting' })
      hud.notice = arg ? `AI: writing "${arg.slice(0, 40)}"` : 'usage: /hw <text>'
      break
    case '/draw':
    case '/d':
      if (arg) send({ t: 'prompt', text: arg, mode: 'draw' })
      hud.notice = arg ? `AI: drawing "${arg.slice(0, 40)}"` : 'usage: /draw <text>'
      break
    case '/new':
      applyAction('new-drawing')
      hud.notice = 'new drawing'
      break
    case '/ai':
      applyAction('toggle-ai')
      hud.notice = view.showAi === false ? 'AI ghost off' : 'AI ghost on'
      break
    case '/text':
      applyAction('text-view')
      break
    case '/clear':
      clearTranscript()
      hud.notice = 'transcript cleared'
      break
    case '/edit':
      if (glasses.bridge) void setPageMode(glasses.pageMode === 'edit' ? 'text' : 'edit')
      else {
        // no glasses: just flip the mode (the phone's Glasses panel shows the text)
        glasses.pageMode = glasses.pageMode === 'edit' ? 'text' : 'edit'
        dirty.text = true
      }
      break
    case '/doc':
      if (arg.toLowerCase() === 'new') {
        newDocument()
        hud.notice = 'new document'
      } else {
        saveDoc('share')
        hud.notice = `document shared (${editor.text().length} chars)`
      }
      break
    default:
      hud.notice = ''
  }
}
