/**
 * Invite links: a URL that opens this page joined to the same session, on another phone or browser.
 *
 * The page takes its router from `?ws=` and a router's pairing code from `?token=` (config.ts), so
 * an invite is this page's address with exactly those two parameters. Nothing else is carried
 * over: the other parameters (`loupe`, `fmt`, `view`, …) tune one device's glasses and would be
 * remembered on the invitee's device too.
 *
 * Two limits are worth knowing. A packaged .ehpk runs from the Even app's own storage, not from an
 * address another device can open, so there is no invite to give (null). And the router address
 * is copied as this page uses it: if that is `localhost`, the link works only on this computer.
 * Pure.
 */

/**
 * The invite URL for a page at `pageUrl` joined to router `ws` with pairing code `token`
 * ('' for none), or null when the page is not served over http(s).
 */
export function inviteUrl(pageUrl: string, ws: string, token: string): string | null {
  let page: URL
  try {
    page = new URL(pageUrl)
  } catch {
    return null
  }
  if (page.protocol !== 'http:' && page.protocol !== 'https:') return null
  const q = new URLSearchParams({ ws })
  if (token) q.set('token', token)
  return `${page.origin}${page.pathname}?${q.toString()}`
}

/** Whether a router URL points at this machine only (the invite then works on this computer alone). */
export function isLoopback(ws: string): boolean {
  try {
    const h = new URL(ws).hostname
    return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1'
  } catch {
    return false
  }
}
