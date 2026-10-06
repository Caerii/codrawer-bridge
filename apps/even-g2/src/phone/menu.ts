/**
 * The phone toolbar's "⋯" menu: the session actions that do not deserve a button of their own.
 *
 *   New drawing…            clears the page for everyone (the glasses menu's "New drawing": a
 *                           local clear plus `clear` to the session), after an inline confirm
 *   Undo my last stroke     takes back the newest stroke drawn here, for everyone (`stroke_delete`)
 *   Clear my strokes        takes back every stroke drawn here; both count only strokes drawn
 *                           on this connection, the ones the router lets us delete (phone/draw.ts)
 *   My colour               the colour of the strokes this device draws from now on (remembered)
 *   Download page as PNG    the whole page at its own resolution (1620 px wide), as the phone
 *                           draws it on the current theme
 *   Copy invite link        this page joined to the same session (phone/invite.ts)
 *   Tablet address…         change the router this page connects to (phone/notices.ts)
 *   Export timelapse…       the page redrawn stroke by stroke into a 10/20/40 s video, after an
 *                           inline row of options (phone/timelapse.ts)
 *   Record session          keep every message to and from the router; a red dot in the toolbar
 *                           while on (phone/recorder.ts)
 *   Export recording        what was recorded, as JSONL the replay tools play into any router
 *   Diagnostics             off by default: the Glasses panel here and the metrics line on the
 *                           glasses' status strip (also the toolbar's glasses button)
 *   Glasses: wide fit view  the fit view across the glasses' full width (config.ts INITIAL_WIDE_FIT)
 *   Dark theme              paper or dark (also the toolbar's moon/sun button)
 *
 * Undo and Clear rest on `stroke_delete`, which the routers relay and drop from their page replay,
 * so a stroke taken back stays gone for late joiners and after a reconnect. With nothing of ours
 * on the page they show disabled, with the reason as their tooltip.
 *
 * It behaves like a menu on every input: it opens under its button, focus moves into it, the
 * arrow keys (and Home/End) move between items, Escape or a tap anywhere outside closes it and
 * hands focus back to the button. That outside tap only closes the menu: it does not also hide
 * the toolbar or start a stroke on the page under it.
 */
import { applyAction } from '../actions'
import { link } from '../link'
import { glasses } from '../state'
import { clearMyStrokes, myColor, myStrokes, setMyColor, undoMyLastStroke } from './draw'
import { inviteUrl, isLoopback } from './invite'
import { askRouterAddress } from './notices'
import { COLOR_NAMES, PARTICIPANT_COLORS } from './palette'
import { exportRecording, refreshRecorder, setupRecorder, toggleRecording } from './recorder'
import { stage } from './screen'
import { shareOrDownload, stampedName } from './share'
import { refreshTimelapse, timelapseAction, timelapseEscape, timelapseMenuClosed } from './timelapse'
import { diagnosticsShown, toggleDiagnostics, toggleTheme } from './toolbar'

const button = document.getElementById('menuBtn') as HTMLButtonElement
const menu = document.getElementById('menu') as HTMLDivElement
const confirmNew = document.getElementById('confirmNew') as HTMLDivElement
const swatches = menu.querySelector('.swatches') as HTMLDivElement

const item = (act: string) => menu.querySelector(`[data-act="${act}"]`) as HTMLButtonElement

// ── Opening and closing ───────────────────────────────────────────────────────────────────────

function isOpen(): boolean {
  return !menu.hidden
}

/** Open the menu with its toggles and colour showing the current state; focus the first item. */
function open() {
  refresh()
  menu.hidden = false
  button.setAttribute('aria-expanded', 'true')
  focusables()[0]?.focus()
}

/**
 * Close the menu (and any confirm or options row in it; a timelapse being recorded carries on and
 * shows its progress when the menu opens again); `refocus` hands focus back to the menu button.
 */
function close(refocus = false) {
  if (!isOpen()) return
  menu.hidden = true
  confirmNew.hidden = true
  timelapseMenuClosed()
  button.setAttribute('aria-expanded', 'false')
  if (refocus) button.focus()
}

/** The menu's items that can take focus now, in order. */
function focusables(): HTMLButtonElement[] {
  return Array.from(menu.querySelectorAll<HTMLButtonElement>('button')).filter((b) => b.offsetParent !== null)
}

/** Sync the toggles and the colour swatches with the app's state. */
function refresh() {
  item('diag').setAttribute('aria-checked', String(diagnosticsShown()))
  item('wide').setAttribute('aria-checked', String(glasses.wideFit))
  item('dark').setAttribute('aria-checked', String(stage.theme === 'dark'))
  for (const s of Array.from(swatches.querySelectorAll<HTMLButtonElement>('.swatch'))) s.setAttribute('aria-checked', String(s.dataset.color === myColor()))
  const invite = link.address ? inviteUrl(location.href, link.address, link.code) : null
  const inviteItem = item('invite')
  inviteItem.setAttribute('aria-disabled', String(invite === null))
  inviteItem.title = !link.address ? 'No tablet address yet' : invite === null ? 'Only from a page served over http(s), not the installed app' : isLoopback(link.address) ? 'The router is on localhost: the link works on this computer only' : invite
  item('address').title = link.address || 'Not set'
  const n = myStrokes().length
  const none = 'Nothing drawn here since connecting (turn on the pen button to draw)'
  for (const act of ['undo', 'clear-mine']) {
    item(act).setAttribute('aria-disabled', String(n === 0))
    item(act).title = n === 0 ? none : ''
  }
  ;(item('clear-mine').querySelector('.note') as HTMLSpanElement).textContent = n ? String(n) : ''
  refreshTimelapse()
  refreshRecorder()
}

// ── The actions ───────────────────────────────────────────────────────────────────────────────

/** "New drawing…": the first press asks, inline; Clear does it, Cancel or Escape backs out. */
function askNewDrawing() {
  confirmNew.hidden = false
  ;(confirmNew.querySelector('[data-act="new-no"]') as HTMLButtonElement).focus()
}

function newDrawing() {
  applyAction('new-drawing')
  close(true)
}

/** Download (or, on a touch device that can share files, share) the page as a PNG. */
async function downloadPng() {
  close(true)
  const blob = await stage.pagePng()
  if (!blob) {
    console.warn('[codrawer] page PNG: the browser could not encode it')
    return
  }
  const name = stampedName('codrawer-page', 'png')
  const how = await shareOrDownload(blob, name, 'codrawer page')
  console.log('[codrawer] page PNG', name, blob.size, 'bytes,', how)
}

/** Copy text to the clipboard: the async API where allowed, else the old selection copy. */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.cssText = 'position: fixed; opacity: 0'
    document.body.append(ta)
    ta.select()
    const ok = document.execCommand('copy')
    ta.remove()
    return ok
  }
}

/** "Copy invite link": copy it and say so in the item itself for a moment. */
async function copyInvite() {
  const url = link.address ? inviteUrl(location.href, link.address, link.code) : null
  if (!url) return
  const label = item('invite').querySelector('span') as HTMLSpanElement
  const ok = await copyText(url)
  label.textContent = ok ? 'Invite link copied' : 'Could not copy; long-press to copy the link'
  if (!ok) item('invite').title = url
  setTimeout(() => (label.textContent = 'Copy invite link'), 1800)
  console.log('[codrawer] invite link', ok ? 'copied' : 'not copied', url)
}

// ── Wiring ────────────────────────────────────────────────────────────────────────────────────

/** Build the colour swatches and wire the menu's button, items and keyboard. */
export function setupMenu() {
  for (const color of PARTICIPANT_COLORS) {
    const s = document.createElement('button')
    s.type = 'button'
    s.className = 'swatch'
    s.setAttribute('role', 'menuitemradio')
    s.dataset.color = color
    s.style.background = color
    s.setAttribute('aria-label', COLOR_NAMES[color] ?? color)
    s.title = COLOR_NAMES[color] ?? color
    s.onclick = () => {
      setMyColor(color)
      refresh()
    }
    swatches.append(s)
  }
  setupRecorder()

  button.onclick = () => (isOpen() ? close(true) : open())
  menu.addEventListener('click', (e) => {
    const target = e.target as HTMLElement
    const act = target.closest<HTMLElement>('[data-act]')?.dataset.act
    if (act?.startsWith('tl') || target.closest('#tlBox')) timelapseAction(act ?? '', target)
    else if (act === 'rec') toggleRecording()
    else if (act === 'rec-export') void exportRecording()
    else if (act === 'undo') {
      undoMyLastStroke()
      refresh() // stays open: undo again, or see that nothing is left
    } else if (act === 'clear-mine') {
      if (clearMyStrokes()) close(true)
    } else if (act === 'new') askNewDrawing()
    else if (act === 'new-yes') newDrawing()
    else if (act === 'new-no') {
      confirmNew.hidden = true
      item('new').focus()
    } else if (act === 'png') void downloadPng()
    else if (act === 'invite') void copyInvite()
    else if (act === 'address') {
      close()
      askRouterAddress()
    }
    else if (act === 'diag') {
      toggleDiagnostics()
      refresh()
    } else if (act === 'wide') {
      applyAction('toggle-wide')
      refresh()
    } else if (act === 'dark') {
      toggleTheme()
      refresh()
    }
  })

  menu.addEventListener('keydown', (e) => {
    const items = focusables()
    const i = items.indexOf(document.activeElement as HTMLButtonElement)
    if (e.key === 'Escape') {
      if (!confirmNew.hidden) {
        confirmNew.hidden = true
        item('new').focus()
      } else if (!timelapseEscape()) close(true)
    } else if (e.key === 'ArrowDown') items[(i + 1) % items.length]?.focus()
    else if (e.key === 'ArrowUp') items[(i - 1 + items.length) % items.length]?.focus()
    else if (e.key === 'Home') items[0]?.focus()
    else if (e.key === 'End') items[items.length - 1]?.focus()
    else return
    e.preventDefault()
  })

  // A press outside closes the menu and goes no further (no stroke, no toolbar hiding), so the
  // click that follows it (within a moment) is swallowed too.
  let swallowUntil = 0
  document.addEventListener(
    'pointerdown',
    (e) => {
      if (!isOpen() || menu.contains(e.target as Node) || button.contains(e.target as Node)) return
      close()
      swallowUntil = performance.now() + 800
      e.stopPropagation()
      e.preventDefault()
    },
    true,
  )
  document.addEventListener(
    'click',
    (e) => {
      if (performance.now() > swallowUntil) return
      swallowUntil = 0
      e.stopPropagation()
      e.preventDefault()
    },
    true,
  )
  // Tabbing out of the menu closes it, like any other way of leaving.
  menu.addEventListener('focusout', (e) => {
    const to = e.relatedTarget as Node | null
    if (to && !menu.contains(to) && to !== button) close()
  })
}
