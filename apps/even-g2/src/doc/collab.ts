/**
 * Shared live editing of the session document (a Yjs CRDT).
 *
 * The Editor stays the view model (lines + cursor); this keeps a Y.Text in step with it.
 * Local edits are diffed into one Y.Text change per keystroke, batched, and sent as
 * `{"t":"doc_update","u":<base64>}`. Remote updates merge without conflicts; the cursor rides on
 * a Yjs relative position so other people's typing does not move it. Routers only store and
 * relay updates (and replay them to joiners), so they never need to understand the CRDT.
 * Yjs updates are idempotent: resending the whole state on reconnect is safe and is how edits
 * made offline reach the session.
 */
import * as Y from 'yjs'
import type { Editor } from './editor'

const REMOTE = 'remote'
const FLUSH_MS = 40

export function toB64(u: Uint8Array): string {
  let s = ''
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000))
  return btoa(s)
}

export function fromB64(s: string): Uint8Array {
  const bin = atob(s)
  const u = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i)
  return u
}

/** Offset of (row, col) in the editor's text. */
function offsetOf(editor: Editor): number {
  let off = 0
  for (let r = 0; r < editor.row; r++) off += editor.lines[r].length + 1
  return off + editor.col
}

function placeCursor(editor: Editor, offset: number) {
  let rest = Math.max(0, offset)
  for (let r = 0; r < editor.lines.length; r++) {
    if (rest <= editor.lines[r].length) {
      editor.row = r
      editor.col = rest
      return
    }
    rest -= editor.lines[r].length + 1
  }
  editor.row = editor.lines.length - 1
  editor.col = editor.lines[editor.row].length
}

export class CollabDoc {
  readonly ydoc = new Y.Doc()
  readonly ytext = this.ydoc.getText('doc')
  private pending: Uint8Array[] = []
  private timer: ReturnType<typeof setTimeout> | null = null
  /** Called when remote changes altered the text (redraw). */
  onRemoteChange: () => void = () => {}

  constructor(
    private editor: Editor,
    private send: (msg: object) => boolean,
  ) {
    this.ydoc.on('update', (u: Uint8Array, origin: unknown) => {
      if (origin === REMOTE) return
      this.pending.push(u)
      if (!this.timer) this.timer = setTimeout(() => this.flush(), FLUSH_MS)
    })
  }

  /** Restore a saved state (base64 of encodeStateAsUpdate) and show it. */
  load(state: string) {
    Y.applyUpdate(this.ydoc, fromB64(state), REMOTE)
    this.editor.setText(this.ytext.toString())
  }

  /** Full state, for local persistence and for resending on (re)connect. */
  state(): string {
    return toB64(Y.encodeStateAsUpdate(this.ydoc))
  }

  /** Push the editor's current text into the CRDT as one minimal change. */
  commitLocal() {
    this.replaceWith(this.editor.text())
  }

  /** Make the CRDT text equal `next` with a single prefix/suffix diff (a local edit). */
  replaceWith(next: string) {
    const prev = this.ytext.toString()
    if (prev === next) return
    let start = 0
    const max = Math.min(prev.length, next.length)
    while (start < max && prev.charCodeAt(start) === next.charCodeAt(start)) start++
    let endPrev = prev.length
    let endNext = next.length
    while (endPrev > start && endNext > start && prev.charCodeAt(endPrev - 1) === next.charCodeAt(endNext - 1)) {
      endPrev--
      endNext--
    }
    this.ydoc.transact(() => {
      if (endPrev > start) this.ytext.delete(start, endPrev - start)
      if (endNext > start) this.ytext.insert(start, next.slice(start, endNext))
    })
  }

  /** Apply updates from the session (one `u` or a replayed `us` batch). */
  applyRemote(updates: string[]) {
    if (!updates.length) return
    const before = this.ytext.toString()
    const cursor = Y.createRelativePositionFromTypeIndex(this.ytext, offsetOf(this.editor))
    this.ydoc.transact(() => {
      for (const u of updates) Y.applyUpdate(this.ydoc, fromB64(u), REMOTE)
    }, REMOTE)
    const after = this.ytext.toString()
    if (after === before) return
    const dirty = this.editor.dirty
    this.editor.setText(after)
    this.editor.dirty = dirty
    const abs = Y.createAbsolutePositionFromRelativePosition(cursor, this.ydoc)
    placeCursor(this.editor, abs ? abs.index : 0)
    this.onRemoteChange()
  }

  /** Send everything we know (on connect); merges anything edited while offline. */
  announce() {
    this.pending = []
    this.send({ t: 'doc_update', u: this.state() })
  }

  /** Router asked for a compacted snapshot of the update log. */
  answerCompact() {
    this.send({ t: 'doc_state', u: this.state() })
  }

  private flush() {
    this.timer = null
    if (!this.pending.length) return
    const merged = this.pending.length === 1 ? this.pending[0] : Y.mergeUpdates(this.pending)
    // Not connected: keep it; announce() on reconnect sends the full state anyway.
    if (this.send({ t: 'doc_update', u: toB64(merged) })) this.pending = []
  }
}
