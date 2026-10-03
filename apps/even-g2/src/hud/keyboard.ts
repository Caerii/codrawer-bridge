/**
 * The tablet's keyboard: where each key goes.
 *
 * A keyboard bonded to the Paper Pro arrives as `key` messages, one per key-down
 * (docs/protocol.md); the app owns all line editing. A key goes one of two ways:
 *
 * - In the editor layout, to the document (plain keys edit; Ctrl chords below), unless the
 *   command line is open over it (Ctrl+K), in which case it edits that line and Escape closes it.
 * - Everywhere else, to the input line: printable keys type, Backspace deletes, Enter commits
 *   (hud/commands.ts), Escape clears, ArrowUp/Down and PageUp/Down scroll the transcript, Ctrl+L
 *   clears it. While a bare `/word` is typed, the completion popup takes the arrows: Up/Down
 *   highlight, Tab or ArrowRight completes, and Enter completes a single match.
 *
 * Editor chords: Ctrl+K command line · Ctrl+S save and share · Ctrl+E leave the editor ·
 * Ctrl+Left/Right by word · Ctrl+Home/End to the ends of the document.
 *
 * The ring reaches here too: in the text and editor layouts its scroll is ArrowUp/Down
 * (glasses/input.ts). Every key restarts the typing view's clock; a key that meant something marks
 * the text dirty.
 */
import { editedLocally, editor, saveDoc } from '../doc/document'
import { setPageMode } from '../glasses/page'
import type { KeyMessage, KeyMods } from '../protocol'
import { dirty, glasses, hud } from '../state'
import { commitLine } from './commands'
import { suggestions } from './completion'
import { clearTranscript, scrollTranscript } from './transcript'

/** Rows PageUp/PageDown move the editor's cursor. */
const EDITOR_PAGE_ROWS = 6

/** A key in the editor (command line closed). Returns whether the key meant anything. */
function editorKey(key: string, ch: string, mods: KeyMods): boolean {
  if (mods.ctrl) {
    switch (key.toLowerCase()) {
      case 'k':
        hud.commandOverlay = true
        hud.input = ''
        return true
      case 's':
        saveDoc('save')
        hud.notice = 'saved'
        return true
      case 'e':
        void setPageMode('text')
        return true
      case 'arrowleft':
        editor.wordLeft()
        return true
      case 'arrowright':
        editor.wordRight()
        return true
      case 'home':
        editor.row = 0
        editor.col = 0
        return true
      case 'end':
        editor.row = editor.lines.length - 1
        editor.end()
        return true
      default:
        return false
    }
  }
  if (ch) editor.insert(ch)
  else if (key === 'Enter') editor.newline()
  else if (key === 'Backspace') editor.backspace()
  else if (key === 'Delete') editor.delete()
  else if (key === 'ArrowLeft') editor.left()
  else if (key === 'ArrowRight') editor.right()
  else if (key === 'ArrowUp') editor.up()
  else if (key === 'ArrowDown') editor.down()
  else if (key === 'Home') editor.home()
  else if (key === 'End') editor.end()
  else if (key === 'PageUp') editor.pageUp(EDITOR_PAGE_ROWS)
  else if (key === 'PageDown') editor.pageDown(EDITOR_PAGE_ROWS)
  else if (key === 'Tab') editor.insert('  ')
  else if (key === 'Escape') {
    hud.notice = ''
  } else return false
  if (editor.dirty) editedLocally()
  return true
}

/** A key for the input line (and the completion popup). Returns whether the key meant anything. */
function lineKey(key: string, ch: string, mods: KeyMods): boolean {
  const sugg = suggestions(hud.input)
  if (mods.ctrl && key.toLowerCase() === 'l') {
    clearTranscript()
  } else if (sugg.length && (key === 'Tab' || key === 'ArrowRight')) {
    // complete the highlighted command; a trailing space invites the argument
    const pick = sugg[Math.min(hud.suggestIndex, sugg.length - 1)]
    hud.input = pick.name + ' '
    hud.suggestIndex = 0
  } else if (sugg.length && (key === 'ArrowUp' || key === 'ArrowDown')) {
    hud.suggestIndex = (hud.suggestIndex + (key === 'ArrowDown' ? 1 : sugg.length - 1)) % sugg.length
  } else if (sugg.length && key === 'Enter' && sugg.length === 1 && hud.input !== sugg[0].name) {
    hud.input = sugg[0].name + ' '
    hud.suggestIndex = 0
  } else if (ch) {
    hud.input += ch
    hud.suggestIndex = 0
  } else if (key === 'Backspace') {
    hud.input = hud.input.slice(0, -1)
    hud.suggestIndex = 0
  } else if (key === 'Enter') {
    commitLine(hud.input)
    hud.input = ''
    hud.suggestIndex = 0
    if (glasses.pageMode === 'edit') hud.commandOverlay = false // one command, then back to the document
  } else if (key === 'Escape') {
    hud.input = ''
    hud.notice = ''
    hud.suggestIndex = 0
  } else if (key === 'ArrowUp' || key === 'PageUp') {
    scrollTranscript(key === 'PageUp' ? 5 : 1)
  } else if (key === 'ArrowDown' || key === 'PageDown') {
    scrollTranscript(key === 'PageDown' ? -5 : -1)
  } else {
    return false
  }
  return true
}

/** A `key` message (or a key synthesized from the ring). */
export function onKey(m: KeyMessage) {
  const key = String(m.key || '')
  const ch = typeof m.char === 'string' ? m.char : ''
  const mods = m.mods || {}
  hud.typingAt = performance.now()
  if (glasses.pageMode === 'edit' && !hud.commandOverlay) {
    if (editorKey(key, ch, mods)) dirty.text = true
    return
  }
  if (glasses.pageMode === 'edit' && hud.commandOverlay && key === 'Escape') {
    hud.commandOverlay = false
    hud.input = ''
    dirty.text = true
    return
  }
  if (lineKey(key, ch, mods)) dirty.text = true
}
