/**
 * "Record session" and "Export recording": the router link's traffic, kept for replay.
 *
 * The toggle starts a fresh recording (recording.ts keeps the messages, bounded) and shows a red
 * dot in the toolbar for as long as it is on; switching it off keeps what was recorded until the
 * next start. "Export recording" saves the messages as `.jsonl` in the replay tools' format (see
 * recording.ts for the format and the commands that replay it), shared or downloaded like the
 * page PNG (phone/share.ts).
 *
 * The tap. Every message crosses one of two points in the link (link.ts): `send`, which
 * serializes an outbound message, and the socket's message handler, which hands each inbound frame
 * to `receive` (it looks the method up on every frame, so replacing it on the instance takes
 * effect). The recorder wraps both on the app's one link instead of adding a hook to link.ts:
 *
 *   inbound   frame text → recording (when on) → the link's own receive → handlers
 *   outbound  message → the link's send → if it went: its JSON → recording (when on)
 *
 * The wrappers cost one boolean test per message while recording is off. Outbound messages are
 * serialized a second time while it is on (the link does not hand out its text); a phone sends
 * little, so that is cheap.
 */
import { link } from '../link'
import { recordingName, SessionRecording } from '../recording'
import { shareOrDownload } from './share'

/** The app's session recording. */
export const recording = new SessionRecording()

const dot = () => document.getElementById('recDot') as HTMLElement
const item = (act: string) => document.querySelector(`#menu [data-act="${act}"]`) as HTMLButtonElement

/** Wrap the link's send and receive so that, while recording, every message is kept. */
function tapLink() {
  const send = link.send.bind(link)
  link.send = (m: object) => {
    const sent = send(m)
    if (sent && recording.on) recording.add('out', JSON.stringify(m), Date.now())
    return sent
  }
  const tapped = link as unknown as { receive?: (data: unknown) => void }
  const receive = tapped.receive?.bind(link)
  if (!receive) {
    console.warn('[codrawer] recorder: the link has no receive() to tap; only outbound messages will be recorded')
    return
  }
  tapped.receive = (data: unknown) => {
    if (recording.on) recording.add('in', String(data), Date.now())
    receive(data)
  }
}

/** Sync the toggle, the export item, and the toolbar dot with the recording. */
export function refreshRecorder() {
  const rec = item('rec')
  rec.setAttribute('aria-checked', String(recording.on))
  const n = recording.size.toLocaleString('en-US')
  const dropped = recording.dropped ? ` (oldest ${recording.dropped.toLocaleString('en-US')} dropped)` : ''
  ;(rec.querySelector('span') as HTMLSpanElement).textContent = recording.on ? `Recording session · ${n}` : 'Record session'
  rec.title = recording.on ? `${n} messages kept${dropped}; tap to stop` : 'Keep every message to and from the router, for replay'
  const ex = item('rec-export')
  ex.setAttribute('aria-disabled', String(recording.size === 0))
  ;(ex.querySelector('.note') as HTMLSpanElement).textContent = recording.size ? n : ''
  ex.title = recording.size ? `${n} messages as JSONL${dropped}` : 'Nothing recorded yet'
  dot().hidden = !recording.on
  dot().title = `Recording session: ${n} messages${dropped}`
}

/** "Record session": start a fresh recording, or stop the one running. */
export function toggleRecording() {
  if (recording.on) recording.stop()
  else recording.start(Date.now())
  console.log('[codrawer] session recording', recording.on ? 'started' : `stopped: ${recording.size} messages, ${recording.dropped} dropped`)
  refreshRecorder()
}

/** "Export recording": the kept messages as `.jsonl` (recording continues if it is on). */
export async function exportRecording() {
  if (recording.size === 0) return
  const blob = new Blob(recording.jsonlParts(), { type: 'application/x-ndjson' })
  const name = recordingName(recording.startedAt)
  const how = await shareOrDownload(blob, name, 'codrawer session recording')
  console.log('[codrawer] session recording', name, recording.size, 'messages,', blob.size, 'bytes,', how)
}

/** Tap the link and keep the toolbar dot's count fresh while recording. */
export function setupRecorder() {
  tapLink()
  dot().onclick = () => (document.getElementById('menuBtn') as HTMLButtonElement).click()
  setInterval(() => {
    if (recording.on) refreshRecorder()
  }, 1000)
  refreshRecorder()
}
