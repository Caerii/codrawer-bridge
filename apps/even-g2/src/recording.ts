/**
 * Session recording: every protocol message in and out, timed, in the replay tools' JSONL.
 *
 * The phone menu's "Record session" keeps what crossed the router link from the moment it is
 * switched on; "Export recording" saves it as a `.jsonl` file that the repository's replay tools
 * play into any router later (a bug report, a demo, a test fixture):
 *
 *   uv run python -m codrawer_bridge.tools.stroke_sim.replay_jsonl --ws ws://<router>/ws/<session> \
 *     --in codrawer-session-….jsonl --only-t-prefix stroke_ --max-gap-ms 400
 *   python scripts/dev/replay_to.py ws://<router>/ws/<session> codrawer-session-….jsonl 60
 *
 * The format is the one `codrawer_bridge.tools.stroke_sim.record_jsonl` writes and both tools
 * read, one object per line: `{"ts": <Unix ms>, "msg": {...}}`. `ts` is when the message arrived
 * here (inbound) or was sent (outbound); the tools sleep the difference between lines. Each line
 * also says which way it went, `"dir": "in" | "out"`, which the tools ignore. There is no header
 * line: replay_jsonl would send it to the router as a message.
 *
 * What is kept, and what is not:
 *
 * - Every message with a string `t`, except liveness `ping` / `pong` (noise in a replay).
 * - The message exactly as it crossed the wire: the frame's text is stored, not re-serialized, so
 *   a line's `msg` is the bytes the router sent or received.
 * - Memory is bounded twice: at most {@link MAX_MESSAGES} messages and {@link MAX_CHARS} characters
 *   of message text (a tablet `page` is up to a few hundred KB). Past either, the oldest messages
 *   are dropped and counted in {@link SessionRecording.dropped}, which the menu shows.
 *
 * Pure (no DOM, no config): tested under tsx (test/recording.test.ts). phone/recorder.ts taps the
 * link and owns the menu item.
 */

/** Which way a message went: from the router (`in`) or to it (`out`). */
export type Direction = 'in' | 'out'

/** One recorded message: arrival or send time (Unix ms), direction, and the frame's JSON text. */
export interface Recorded {
  ts: number
  dir: Direction
  raw: string
}

/** Messages kept at most; then the oldest go. */
export const MAX_MESSAGES = 50_000
/** Characters of message text kept at most (~64 MB as JS strings); then the oldest go. */
export const MAX_CHARS = 32_000_000

/** Message types not worth keeping: liveness only, nothing to replay. */
const SKIP = new Set(['ping', 'pong'])

/**
 * The message type of a frame's text, or null when it is not a JSON object with a string `t`.
 * Cheap for the common case: it parses the frame once.
 */
export function messageType(raw: string): string | null {
  try {
    const m = JSON.parse(raw)
    return m && typeof m === 'object' && !Array.isArray(m) && typeof m.t === 'string' ? m.t : null
  } catch {
    return null
  }
}

/** One JSONL line (without its newline) in the replay tools' format, `raw` embedded verbatim. */
export function jsonlLine(r: Recorded): string {
  return `{"ts":${Math.round(r.ts)},"dir":"${r.dir}","msg":${r.raw}}`
}

/** A file name for a recording started at `startedAt` (Unix ms): codrawer-session-2026-10-05-14-03-12.jsonl */
export function recordingName(startedAt: number): string {
  return `codrawer-session-${new Date(startedAt).toISOString().slice(0, 19).replace(/[:T]/g, '-')}.jsonl`
}

/** A bounded, in-order log of the messages that crossed the link while recording was on. */
export class SessionRecording {
  /** Recording is on: {@link add} keeps messages. */
  on = false
  /** Unix ms when the current recording started (0: never). */
  startedAt = 0
  /** Messages dropped from the front to stay inside the bounds. */
  dropped = 0

  private items: Recorded[] = []
  private head = 0 // items before head are dropped
  private chars = 0

  constructor(
    readonly maxMessages = MAX_MESSAGES,
    readonly maxChars = MAX_CHARS,
  ) {}

  /** Start a fresh recording (what an earlier one kept is discarded). */
  start(now: number) {
    this.clear()
    this.on = true
    this.startedAt = now
  }

  /** Stop recording; what was kept stays for export. */
  stop() {
    this.on = false
  }

  /** Forget everything kept. */
  clear() {
    this.items = []
    this.head = 0
    this.chars = 0
    this.dropped = 0
  }

  /** Messages kept now. */
  get size(): number {
    return this.items.length - this.head
  }

  /**
   * Keep one frame's text if recording is on and it is a protocol message worth replaying.
   * Returns whether it was kept. Drops the oldest messages past either bound.
   */
  add(dir: Direction, raw: string, ts: number): boolean {
    if (!this.on) return false
    const t = messageType(raw)
    if (t === null || SKIP.has(t)) return false
    this.items.push({ ts, dir, raw })
    this.chars += raw.length
    while (this.size > 1 && (this.size > this.maxMessages || this.chars > this.maxChars)) {
      this.chars -= this.items[this.head].raw.length
      this.head++
      this.dropped++
    }
    // compact now and then, so dropping stays cheap and the dropped messages can be collected
    if (this.head > 4096 && this.head * 2 > this.items.length) {
      this.items = this.items.slice(this.head)
      this.head = 0
    }
    return true
  }

  /** The kept messages, oldest first. */
  messages(): Recorded[] {
    return this.items.slice(this.head)
  }

  /** The recording as JSONL text parts (one line each, newline included), ready for a Blob. */
  jsonlParts(): string[] {
    return this.messages().map((r) => jsonlLine(r) + '\n')
  }
}
