/**
 * The transcript: the lines typed on the tablet's keyboard and the terminal's answers.
 *
 * It lives in memory only (the last {@link TRANSCRIPT_MAX} lines) and is shown bottom-up in the
 * text container (hud/render.ts). The view can be scrolled back with ArrowUp/PageUp or, in the
 * text layout, the ring; any new line jumps back to the newest.
 */

/** Lines kept; older ones fall off the top. */
export const TRANSCRIPT_MAX = 80

export const transcript = {
  /** Oldest first. */
  lines: [] as string[],
  /** Lines hidden below the view (0 = the newest line is visible). */
  scrollBack: 0,
}

function trim() {
  while (transcript.lines.length > TRANSCRIPT_MAX) transcript.lines.shift()
  transcript.scrollBack = 0
}

/** A line the user committed (Enter), as typed. */
export function appendTyped(line: string) {
  transcript.lines.push(line)
  trim()
}

/** Output from elsewhere (the terminal): one transcript line per non-blank line, ≤ 200 chars each. */
export function appendOutput(text: string) {
  for (const l of text.split('\n')) {
    if (!l.trim()) continue
    transcript.lines.push(l.slice(0, 200))
  }
  trim()
}

/** `/clear`, Ctrl+L. */
export function clearTranscript() {
  transcript.lines.length = 0
}

/** Scroll the view by `n` lines (positive: back in time), kept within the transcript. */
export function scrollTranscript(n: number) {
  if (n > 0) transcript.scrollBack = Math.min(Math.max(0, transcript.lines.length - 1), transcript.scrollBack + n)
  else transcript.scrollBack = Math.max(0, transcript.scrollBack + n)
}
