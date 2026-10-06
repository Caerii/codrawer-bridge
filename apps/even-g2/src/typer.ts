/**
 * The tablet's reply typing speed, as this app knows it (docs/protocol.md, `typer_config`).
 *
 * The tablet bridge types terminal replies into xochitl's focused text field through a virtual
 * keyboard, at one of three speeds: `careful` (a key at a time, the pace verified on hardware),
 * `fast` (a word per write) and `instant` (bursts of keys; not yet calibrated against xochitl).
 * The bridge owns the setting. A client asks for a change with `{"t":"typer_config","speed":…}`,
 * and only the bridge's acknowledgement (`"ok":true`, relayed by the router and replayed to
 * joiners) says what is in force, so the phone menu shows the acknowledged value, never the one
 * it asked for. A request with no fields asks the bridge to announce its setting.
 *
 * Pure: no DOM and no link, so the tests import it directly (test/menu.test.ts). phone/menu.ts
 * wires it to the router link and the "Reply typing speed" items.
 */

/** The speeds the bridge knows, in menu order. */
export const TYPER_SPEEDS = ['careful', 'fast', 'instant'] as const
export type TyperSpeed = (typeof TYPER_SPEEDS)[number]

/** What the menu says under each speed. */
export const TYPER_SPEED_NOTES: Record<TyperSpeed, string> = {
  careful: 'a key at a time',
  fast: 'a word at a time',
  instant: 'bursts; uncalibrated',
}

/**
 * The acknowledged setting: the speed, its pause after each write (ms), instant's burst size,
 * and the tablet keyboard table with the ASCII it cannot type.
 */
export interface TyperSetting {
  speed: TyperSpeed
  charMs: number
  burst: number
  keymap: string
  untypeable: string
}

/** The setting an acknowledgement reports, or null for anything else (a request, a refusal). */
export function readTyperAck(m: unknown): TyperSetting | null {
  if (!m || typeof m !== 'object') return null
  const r = m as Record<string, unknown>
  if (r.t !== 'typer_config' || r.ok !== true) return null
  if (!TYPER_SPEEDS.includes(r.speed as TyperSpeed)) return null
  return {
    speed: r.speed as TyperSpeed,
    charMs: typeof r.char_ms === 'number' ? r.char_ms : 0,
    burst: typeof r.burst === 'number' ? r.burst : 0,
    keymap: typeof r.keymap === 'string' ? r.keymap : '',
    untypeable: typeof r.untypeable === 'string' ? r.untypeable : '',
  }
}

/**
 * The status line for a `typer_note`: what a reply typed into the tablet lost, because the
 * tablet's keyboard language has no key for it (xochitl's US table cannot type `[ ] { } ^ ` ~`).
 * Null for anything else.
 */
export function typerNoteText(m: unknown): string | null {
  if (!m || typeof m !== 'object') return null
  const r = m as Record<string, unknown>
  if (r.t !== 'typer_note' || typeof r.dropped !== 'string' || !r.dropped) return null
  const shown = Array.from(new Set(Array.from(r.dropped))).join(' ')
  const n = typeof r.count === 'number' ? r.count : Array.from(r.dropped).length
  return `tablet could not type ${n} char${n === 1 ? '' : 's'}: ${shown}`
}

/** The request for a speed (the bridge resets the pause to that speed's own), or a query. */
export function typerRequest(speed?: TyperSpeed): { t: 'typer_config'; speed?: TyperSpeed } {
  return speed ? { t: 'typer_config', speed } : { t: 'typer_config' }
}
