/**
 * The phone's Glasses panel status line (toggled by the toolbar's glasses button).
 *
 * The panel shows the two glasses surfaces (glasses/display.ts sizes them) and, under them, this
 * line: the glasses' state followed by the text the glasses are showing, or the bench and probe
 * results while those run. It is the only diagnostics view on a phone without a debugger.
 */
const statusEl = document.getElementById('status') as HTMLDivElement

/** Replace the panel's status text. */
export function showStatus(text: string) {
  statusEl.textContent = text
}
