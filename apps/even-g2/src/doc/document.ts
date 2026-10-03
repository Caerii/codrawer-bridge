/**
 * The session document: one shared text, edited live by everyone, kept and saved here.
 *
 * Two objects do the work. The {@link editor} (editor.ts) is the view model: lines and a cursor,
 * wrapped for the glasses. The {@link collab} document (collab.ts) keeps a Yjs CRDT in step with
 * it, so every keystroke reaches the others within ~40 ms as a `doc_update`, concurrent edits
 * merge, and edits made offline merge on reconnect. This module is the glue between those two and
 * the rest of the app:
 *
 * - Persistence. The CRDT state and a plain-text copy go to WebView localStorage (`codrawer:ydoc`,
 *   `codrawer:doc`) and to the Even bridge's storage, which survives .ehpk packaging where
 *   WebView storage may not.
 * - Saving. A save (Ctrl+S, a ring click in the editor, leaving the editor, 2 s after the last
 *   edit) also sends a plain-text `doc` copy marked `crdt: true`: the desktop router writes it to
 *   `.codrawer/doc.md` so the terminal agent can Read it, and live-editing clients ignore it.
 * - Inbound. `doc_update` merges, `doc_compact` answers with the full state, and a plain `doc`
 *   from a participant without live editing (an agent) folds in as an ordinary edit.
 *
 * Keys reach the editor through hud/keyboard.ts; the editor layout is drawn by hud/render.ts.
 */
import { link } from '../link'
import type { Inbound } from '../protocol'
import { dirty, glasses, hud } from '../state'
import { CollabDoc } from './collab'
import { Editor } from './editor'

/** The document's view model: lines + cursor. */
export const editor = new Editor()

/** The document's CRDT, synced through the router. */
export const collab = new CollabDoc(editor, (msg) => link.send(msg))

collab.onRemoteChange = () => {
  dirty.text = true
  persistDoc()
}

/** performance.now() of the last unsaved local edit, ms (0: nothing waiting for autosave). */
let changedAt = 0

/** Autosave this long after the last edit, ms. */
const AUTOSAVE_MS = 2000

/**
 * Restore the document from local storage: the CRDT state if there is one, else (the first run
 * after the switch to live editing) adopt the old plain-text document as a local edit.
 */
export function loadDocument() {
  try {
    const state = localStorage.getItem('codrawer:ydoc')
    const saved = localStorage.getItem('codrawer:doc')
    if (state) collab.load(state)
    else if (saved) {
      editor.setText(saved)
      collab.commitLocal()
    }
  } catch {
    /* ignore */
  }
}

/** Keep the CRDT state (and a plain-text copy) in local storage and the Even bridge's storage. */
export function persistDoc() {
  const text = editor.text()
  const state = collab.state()
  try {
    localStorage.setItem('codrawer:doc', text)
    localStorage.setItem('codrawer:ydoc', state)
  } catch {
    /* ignore */
  }
  // the Even bridge's storage survives EHPK packaging where WebView localStorage may not
  if (glasses.bridge) {
    void glasses.bridge.setLocalStorage('doc', text).catch(() => {})
    void glasses.bridge.setLocalStorage('ydoc', state).catch(() => {})
  }
}

/** Save: commit, persist and share a plain-text copy. `reason` travels with it (save, ring, auto, …). */
export function saveDoc(reason: string) {
  collab.commitLocal()
  const text = editor.text()
  editor.dirty = false
  persistDoc()
  // Edits already travel live as doc_update; this plain-text copy is for the desktop router,
  // which writes it to .codrawer/doc.md for the terminal agent. crdt:true tells live-editing
  // clients to ignore it (they have the same text already).
  link.send({ t: 'doc', text, crdt: true, cursor: { line: editor.row + 1, col: editor.col + 1 }, reason, ts: Date.now() })
}

/** A local edit happened: send it live and start the autosave clock. */
export function editedLocally() {
  changedAt = performance.now()
  collab.commitLocal() // live: every keystroke reaches the other editors within ~40 ms
}

/** `/doc new`: an empty document, for everyone editing the session document. */
export function newDocument() {
  editor.setText('')
  editor.dirty = true
  collab.commitLocal() // clears it for everyone editing the session document
  changedAt = performance.now()
}

/** Called every render tick: save {@link AUTOSAVE_MS} after the last unsaved edit. */
export function autosaveIfDue() {
  if (editor.dirty && changedAt && performance.now() - changedAt > AUTOSAVE_MS) {
    changedAt = 0
    saveDoc('auto')
    dirty.text = true
  }
}

// ── Inbound ───────────────────────────────────────────────────────────────────────────────────

/** `doc_update`: Yjs updates from the others (or the router's replay of the log). */
export function onDocUpdate(m: Inbound['doc_update']) {
  collab.applyRemote(Array.isArray(m.us) ? m.us : typeof m.u === 'string' ? [m.u] : [])
}

/** `doc_compact`: the router wants our full state to compact its log. */
export function onDocCompact() {
  collab.answerCompact()
}

/**
 * `doc`: a plain-text document from a participant without live editing (e.g. an agent): fold it
 * in as an ordinary edit. Live-editing clients mark their copies crdt:true; those are ignored.
 */
export function onPlainDoc(m: Inbound['doc']) {
  if (typeof m.text === 'string' && !m.crdt) {
    collab.replaceWith(m.text)
    editor.setText(m.text)
    persistDoc()
    hud.notice = 'document updated'
    dirty.text = true
  }
}
