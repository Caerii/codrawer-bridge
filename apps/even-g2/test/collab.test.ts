// Run: pnpm test  (node:test via tsx). Two editors converge through an ordered relay.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Editor } from '../src/editor'
import { CollabDoc } from '../src/collab'

/** A tiny in-memory router: ordered log, relay to others, replay to joiners. */
function hub() {
  const log: string[] = []
  const peers: { doc: CollabDoc; online: boolean }[] = []
  return {
    join(editor: Editor) {
      const peer = { doc: null as unknown as CollabDoc, online: true }
      peer.doc = new CollabDoc(editor, (msg: any) => {
        if (!peer.online) return false
        log.push(msg.u)
        for (const p of peers) if (p !== peer && p.online) p.doc.applyRemote([msg.u])
        return true
      })
      peers.push(peer)
      peer.doc.applyRemote([...log])
      return peer
    },
    reconnect(peer: { doc: CollabDoc; online: boolean }) {
      peer.online = true
      peer.doc.applyRemote([...log])
      peer.doc.announce()
    },
  }
}
const tick = () => new Promise((r) => setTimeout(r, 60)) // > FLUSH_MS
function type(e: Editor, d: CollabDoc, s: string) {
  for (const ch of s) {
    if (ch === '\n') e.newline()
    else e.insert(ch)
    d.commitLocal()
  }
}

test('concurrent typing converges and keeps each cursor', async () => {
  const h = hub()
  const ea = new Editor()
  const a = h.join(ea)
  type(ea, a.doc, 'hello world')
  await tick()
  const eb = new Editor()
  const b = h.join(eb)
  assert.equal(eb.text(), 'hello world')

  ea.row = 0; ea.col = 5 // after "hello"
  eb.row = 0; eb.col = 11 // end
  type(ea, a.doc, ' there')
  type(eb, b.doc, '!')
  await tick()
  assert.equal(ea.text(), eb.text())
  assert.equal(ea.text(), 'hello there world!')
  assert.equal(eb.col, 'hello there world!'.length, "b's cursor moved with its text")
  assert.equal(ea.col, 'hello there'.length, "a's cursor stayed after its own insert")
})

test('edits made offline merge on reconnect', async () => {
  const h = hub()
  const ea = new Editor()
  const a = h.join(ea)
  type(ea, a.doc, 'line one')
  await tick()
  const eb = new Editor()
  const b = h.join(eb)

  b.online = false
  eb.row = 0; eb.col = eb.lines[0].length
  type(eb, b.doc, '\nfrom b offline')
  ea.row = 0; ea.col = 0
  type(ea, a.doc, '# ')
  await tick()
  h.reconnect(b)
  await tick()
  assert.equal(ea.text(), eb.text())
  assert.equal(ea.text(), '# line one\nfrom b offline')
})

test('a plain-text doc from an agent folds in as an edit', async () => {
  const h = hub()
  const ea = new Editor()
  const a = h.join(ea)
  const eb = new Editor()
  const b = h.join(eb)
  type(ea, a.doc, 'draft')
  await tick()
  b.doc.replaceWith('draft v2')
  eb.setText('draft v2')
  await tick()
  assert.equal(ea.text(), 'draft v2')
})
