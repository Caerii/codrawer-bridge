/**
 * The phone toolbar's simple controls: connection chip, theme, Glasses panel, and hiding the bar.
 *
 * The toolbar (index.html #bar) also holds the view switch (phone/views.ts), the draw button
 * (phone/draw.ts), the camera buttons (phone/camera.ts) and the "⋯" menu (phone/menu.ts); each
 * of those modules wires its own. The menu repeats the theme and Glasses-panel toggles, so both
 * are exported here.
 *
 * Tapping the page hides the bar for a clean projection and tapping again brings it back, unless
 * the tap ended a drag of the loupe box.
 */
import { INITIAL_THEME, remember } from '../config'
import { stage } from './screen'
import type { Theme } from './stage'

const connEl = document.getElementById('conn') as HTMLSpanElement
const themeBtn = document.getElementById('themeBtn') as HTMLButtonElement

/** The connection chip: green "live" once the router said hello, "reconnecting" otherwise. */
export function showConnection(live: boolean) {
  connEl.classList.toggle('live', live)
  ;(connEl.querySelector('span') ?? connEl).textContent = live ? 'live' : 'reconnecting'
}

/** Apply and remember a theme. The button's icon shows where a tap goes: a moon on paper, a sun in the dark. */
function applyTheme(t: Theme) {
  stage.setTheme(t)
  document.documentElement.dataset.theme = t
  themeBtn.innerHTML = t === 'paper' ? '<svg viewBox="0 0 24 24"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/></svg>' : '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>'
  themeBtn.title = t === 'paper' ? 'Dark theme' : 'Paper theme'
  remember('theme', t)
}

/** Switch between paper and dark (the theme button, and the menu's "Dark theme"). */
export function toggleTheme() {
  applyTheme(stage.theme === 'paper' ? 'dark' : 'paper')
}

/** Show or hide the Glasses panel (the glasses button, and the menu's "Glasses diagnostics"). */
export function toggleDiagnostics() {
  const on = document.body.classList.toggle('debug')
  ;(document.getElementById('debugBtn') as HTMLButtonElement).setAttribute('aria-pressed', String(on))
}

/** Whether the Glasses panel is showing. */
export function diagnosticsShown(): boolean {
  return document.body.classList.contains('debug')
}

/** Wire the toolbar's theme and Glasses-panel buttons and the tap-to-hide on the page. */
export function setupToolbar() {
  applyTheme(INITIAL_THEME)
  themeBtn.onclick = toggleTheme
  ;(document.getElementById('debugBtn') as HTMLButtonElement).onclick = toggleDiagnostics
  // tap the page to hide the bar (clean projection); tap again to bring it back
  ;(document.getElementById('stage') as HTMLCanvasElement).onclick = () => {
    if (stage.consumeDrag()) return // that was a resize of the loupe box
    document.body.classList.toggle('chromeless')
  }
}
