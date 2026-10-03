/**
 * The banner under the phone toolbar: tablet notices, and the pairing-code prompt.
 *
 * Tablet notices come with the router's `hello` when the router runs on the tablet (boot.sh there
 * reports the OS version, the codrawer release, the previous OS after an update, and whether this
 * OS is one codrawer was tested on). A notice is shown until acknowledged with OK, and an
 * acknowledged notice (`codrawer:notice`) is not shown again.
 *
 * The pairing prompt appears when the router refuses us (`error: unauthorized`): a router on the
 * tablet requires the pairing code from its QR. The code typed here is remembered and the link
 * reconnects with it at once (link.ts).
 */
import { recall, remember } from '../config'
import { link } from '../link'
import type { Inbound } from '../protocol'

const banner = document.getElementById('banner') as HTMLDivElement
const bannerText = () => document.getElementById('bannerText') as HTMLSpanElement
const bannerOk = () => document.getElementById('bannerOk') as HTMLButtonElement

/**
 * The notice for a tablet report, and the key it is acknowledged under; empty text when there is
 * nothing to say. An OS update and an untested OS can both apply (joined with " · ").
 */
function tabletNoticeText(t: Record<string, string>): { text: string; key: string } {
  let text = ''
  let key = ''
  if (t.osChangedFrom && t.os) {
    text = `Tablet updated ${t.osChangedFrom} → ${t.os} · codrawer restored`
    key = `os:${t.osChangedFrom}>${t.os}`
  }
  if (t.osTested === '0' && t.os) {
    text = `${text ? text + ' · ' : ''}codrawer is not yet tested on OS ${t.os}; experimental features stay off`
    key ||= `untested:${t.os}`
  }
  return { text, key }
}

/** `hello`: show the tablet's notice, if it carries one not yet acknowledged. */
export function onHelloNotice(m: Inbound['hello']) {
  if (!m.tablet || typeof m.tablet !== 'object') return
  const t = m.tablet as Record<string, string>
  const { text, key } = tabletNoticeText(t)
  if (!text) return
  if (recall('notice') === key) return // already acknowledged
  bannerText().textContent = text
  banner.hidden = false
  bannerOk().onclick = () => {
    banner.hidden = true
    remember('notice', key)
  }
  console.log('[codrawer] tablet notice:', text, t)
}

/** `error: unauthorized`: ask for the pairing code (once; a prompt already showing stays). */
export function askPairingCode() {
  if (document.getElementById('pairing')) return // already asking
  const text = bannerText()
  const ok = bannerOk()
  text.innerHTML = ''
  const label = document.createElement('span')
  label.textContent = link.code ? 'That pairing code was not accepted. ' : 'This tablet needs its pairing code: '
  const input = document.createElement('input')
  input.id = 'pairing'
  input.placeholder = 'XXXX-XXXX'
  input.autocapitalize = 'characters'
  input.autocomplete = 'off'
  input.style.cssText = 'font: inherit; width: 9em; padding: 4px 8px; border-radius: 8px; border: 1px solid var(--line); background: transparent; color: var(--fg); letter-spacing: 0.08em'
  text.append(label, input)
  banner.hidden = false
  ok.textContent = 'Connect'
  const submit = () => {
    const code = input.value.trim().toUpperCase()
    if (!code) return
    banner.hidden = true
    ok.textContent = 'OK'
    text.textContent = ''
    link.usePairingCode(code)
  }
  ok.onclick = submit
  input.onkeydown = (e) => {
    if (e.key === 'Enter') submit()
  }
  input.focus()
  console.warn('[codrawer] router wants a pairing code')
}
