/**
 * Router addresses as people type them, turned into the session URL the link connects to.
 *
 * Someone setting the app up for their own tablet knows its IP address (their Wi-Fi router's client
 * list, or the address they SSH to), not our URL scheme. So the first-run prompt
 * (phone/notices.ts) accepts whatever they are likely to have in hand and fills in the rest from
 * what the tablet's router actually listens on (bridge/remarkable/boot/bridge.env.example):
 *
 *   192.168.1.20                     → ws://192.168.1.20:8577/ws/session1
 *   192.168.1.20:9000                → ws://192.168.1.20:9000/ws/session1
 *   remarkable.local                 → ws://remarkable.local:8577/ws/session1
 *   ws://192.168.1.20:8577/ws/demo   → unchanged (a full URL is taken as written)
 *   http://192.168.1.20:8577         → ws://192.168.1.20:8577/ws/session1 (http↔ws, https↔wss)
 *
 * A port is added only when none was written, and the session path only when there is none. Pure:
 * no config, DOM or storage, so it runs under the unit tests.
 */

/** The port the tablet's router listens on (`-serve :8577` in the bridge). */
export const ROUTER_PORT = 8577

/** The session a fresh address joins: the tablet bridge publishes its page there. */
export const DEFAULT_SESSION_PATH = '/ws/session1'

/** Schemes we accept, mapped to the WebSocket scheme they stand for. */
const SCHEMES: Record<string, string> = { 'ws:': 'ws:', 'wss:': 'wss:', 'http:': 'ws:', 'https:': 'wss:' }

/**
 * The router session URL for a typed address, or null when it cannot be one (empty, unparseable,
 * or a scheme other than ws/wss/http/https). The fragment is dropped; a query is kept.
 */
export function routerUrl(input: string): string | null {
  let s = input.trim()
  if (!s) return null
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `ws://${s}`
  // Whether a port was written, read before URL parsing: the parser hides a scheme's default port
  // (ws://h:80 parses with port ''), and "no port written" must not be confused with that.
  const authority = s.slice(s.indexOf('//') + 2).split(/[/?#]/)[0]
  const portWritten = /:\d+$/.test(authority)
  let u: URL
  try {
    u = new URL(s)
  } catch {
    return null
  }
  const scheme = SCHEMES[u.protocol]
  if (!scheme || !u.hostname || u.username || u.password) return null
  // Changing between special schemes is allowed by the URL standard, so rebuild rather than mutate.
  const port = portWritten ? u.port || (scheme === 'wss:' ? '443' : '80') : String(ROUTER_PORT)
  const path = u.pathname && u.pathname !== '/' ? u.pathname : DEFAULT_SESSION_PATH
  const out = new URL(`${scheme}//${u.hostname}:${port}${path}${u.search}`)
  return out.toString()
}
