/**
 * The slash commands, as the completion popup lists them.
 *
 * Typing `/` on the tablet's keyboard opens a popup of matching commands above the input line;
 * ArrowUp/Down highlight, Tab or ArrowRight completes (hud/keyboard.ts). This list is the popup's
 * source and the user-facing summary of each command; what the commands do is in
 * hud/commands.ts. Pure.
 */

export interface Command {
  name: string
  help: string
}

/** In popup order. */
export const COMMANDS: Command[] = [
  { name: '/term', help: 'send an instruction to the terminal (+ this turn\'s ink)' },
  { name: '/snap', help: 'send the whole page to the terminal' },
  { name: '/mode', help: 'ink | term: where plain lines go' },
  { name: '/hw', help: 'AI handwrites text on the canvas' },
  { name: '/draw', help: 'AI draws text' },
  { name: '/new', help: 'new drawing for every client' },
  { name: '/ai', help: 'toggle the AI ghost layer' },
  { name: '/text', help: 'toggle full-screen text view' },
  { name: '/clear', help: 'clear the transcript' },
  { name: '/edit', help: 'edit the document (Ctrl+K commands, Ctrl+S save, Ctrl+E leave)' },
  { name: '/doc', help: 'share the document with the session (/doc new clears it)' },
]

/** Commands matching `input` while it is still a bare `/word` (no space yet); else none. */
export function suggestions(input: string): Command[] {
  if (!input.startsWith('/') || input.includes(' ')) return []
  const prefix = input.toLowerCase()
  return COMMANDS.filter((c) => c.name.startsWith(prefix))
}
