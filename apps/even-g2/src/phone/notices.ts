/**
 * The banner under the phone toolbar: tablet notices, and the address and pairing-code prompts.
 *
 * Tablet notices come with the router's `hello` when the router runs on the tablet (boot.sh there
 * reports the OS version, the codrawer release, the previous OS after an update, and whether this
 * OS is one codrawer was tested on). A notice is shown until acknowledged with OK, and an
 * acknowledged notice (`codrawer:notice`) is not shown again.
 *
 * The pairing prompt appears when the router refuses us (`error: unauthorized`): a router on the
 * tablet requires the pairing code from its QR. The code typed here is remembered and the link
 * reconnects with it at once (link.ts).
 *
 * The address prompt appears when the app has no router to connect to at all: someone else's
 * build of the app, opened without a `?ws=` link, does not know where their tablet is. Like the
 * pairing code, the answer is remembered and used at once.
 */
import { routerUrl } from '../address'
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

/**
 * Show a one-field prompt in the banner. `submit` gets the trimmed text and says whether it was
 * taken; a value it refuses keeps the prompt up with `refused` as its label. Only one prompt is
 * shown at a time: a new one replaces another, and the same one (`id`) already up stays as it is.
 */
function bannerPrompt(opts: { id: string; label: string; placeholder: string; width: string; caps?: boolean; refused?: string; submit: (value: string) => boolean }) {
  if (document.getElementById(opts.id)) return // already asking
  const text = bannerText()
  const ok = bannerOk()
  text.innerHTML = ''
  const label = document.createElement('span')
  label.textContent = opts.label
  const input = document.createElement('input')
  input.id = opts.id
  input.placeholder = opts.placeholder
  input.autocapitalize = opts.caps ? 'characters' : 'off'
  input.autocomplete = 'off'
  input.spellcheck = false
  input.style.cssText = `font: inherit; width: ${opts.width}; padding: 4px 8px; border-radius: 8px; border: 1px solid var(--line); background: transparent; color: var(--fg); letter-spacing: 0.08em`
  text.append(label, input)
  banner.hidden = false
  ok.textContent = 'Connect'
  const submit = () => {
    const value = input.value.trim()
    if (!value) return
    if (!opts.submit(value)) {
      if (opts.refused) label.textContent = opts.refused
      input.focus()
      return
    }
    banner.hidden = true
    ok.textContent = 'OK'
    text.textContent = ''
  }
  ok.onclick = submit
  input.onkeydown = (e) => {
    if (e.key === 'Enter') submit()
  }
  input.focus()
}

/** `error: unauthorized`: ask for the pairing code (once; a prompt already showing stays). */
export function askPairingCode() {
  bannerPrompt({
    id: 'pairing',
    label: link.code ? 'That pairing code was not accepted. ' : 'This tablet needs its pairing code: ',
    placeholder: 'XXXX-XXXX',
    width: '9em',
    caps: false,
    submit: (code) => {
      link.usePairingCode(code)
      return true
    },
  })
  console.warn('[codrawer] router wants a pairing code')
}

/**
 * Ask for the tablet's address: at first run when the app has none (no `?ws=`, nothing remembered,
 * none built in), and from the menu's "Tablet address…". Takes an IP, `host:port` or a full ws://
 * URL (address.ts), remembers the result and connects to it at once.
 */
export function askRouterAddress() {
  bannerPrompt({
    id: 'routerAddress',
    label: link.address ? 'Tablet address: ' : "Your tablet's IP address: ",
    placeholder: link.address || '192.168.1.20',
    width: '12em',
    refused: 'Not an address. Try an IP like 192.168.1.20: ',
    submit: (typed) => {
      const url = routerUrl(typed)
      if (!url) return false
      link.useRouterAddress(url)
      console.log('[codrawer] router address set to', url)
      return true
    },
  })
}
