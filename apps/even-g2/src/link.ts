/**
 * The link to the router: one WebSocket to the session, kept alive, and a typed dispatcher.
 *
 * Everything the app knows about the session arrives here as JSON messages (docs/protocol.md):
 * ink, the tablet's saved page, keys, the shared document, terminal output. The link does not
 * interpret them. It parses each one and hands it to the handlers registered for its tag with
 * {@link RouterLink.on}; main.ts holds the table of which module handles which message. Outbound,
 * {@link RouterLink.send} serializes a message if the socket is open and says whether it went.
 *
 * Three things make the connection more than `new WebSocket`:
 *
 * - Reconnects. Drops are routine on a phone; the timing policy (backoff, and a slow retry while a
 *   router refuses our pairing code) lives in reconnect.ts.
 * - Liveness. A phone that changed networks keeps a half-open socket and would show "live"
 *   forever. A router that sends app-level `ping`s (the tablet's Go router) must be heard from
 *   every {@link PING_DEAD_MS}, otherwise the socket is presumed dead and closed, which
 *   reconnects. Routers that never ping (the desktop Python router) are never timed out.
 * - Pairing. The URL carries `?token=<pairing code>` when we have one; the phone banner asks for
 *   it when the router refuses us and gives it back through {@link RouterLink.usePairingCode}.
 * - The address itself can be missing: a packaged app built without one, opened for the first
 *   time, has nowhere to connect. The link then waits; the phone banner asks for the tablet's
 *   address and hands it over through {@link RouterLink.useRouterAddress}, which also serves the
 *   menu's "Tablet address…" later.
 */
import { INITIAL_PAIRING_CODE, INITIAL_WS_URL, remember } from './config'
import type { Inbound, InboundType } from './protocol'
import { ReconnectPolicy } from './reconnect'

/** Silence from a pinging router longer than this (ms) means the socket is dead. */
export const PING_DEAD_MS = 25_000

type Handler<T extends InboundType> = (m: Inbound[T]) => void

export class RouterLink {
  /** True between the socket's open and close events. */
  connected = false
  /** Reconnect timing and the pairing-refusal streak (read by the stale-copy check). */
  readonly policy = new ReconnectPolicy()

  private socket: WebSocket | null = null
  private wsUrl = INITIAL_WS_URL
  private retryTimer: ReturnType<typeof setTimeout> | undefined
  private pairingCode = INITIAL_PAIRING_CODE
  private lastHeardAt = 0 // performance.now() of the last message, ms
  private routerPings = false // this router sends app-level pings (so silence means trouble)
  private handlers = new Map<string, ((m: never) => void)[]>()
  private openHandlers: (() => void)[] = []
  private closeHandlers: (() => void)[] = []

  /** The session URL in use, without the pairing code ('' until one is known). */
  get address(): string {
    return this.wsUrl
  }

  /** The pairing code in use ('' when none). */
  get code(): string {
    return this.pairingCode
  }

  /** Handle every inbound message tagged `t`, in registration order. */
  on<T extends InboundType>(t: T, handler: Handler<T>) {
    const list = this.handlers.get(t) ?? []
    list.push(handler as (m: never) => void)
    this.handlers.set(t, list)
  }

  /** Run on every successful (re)connect, before any message of that connection. */
  onOpen(fn: () => void) {
    this.openHandlers.push(fn)
  }

  /** Run when the current socket closes (a reconnect is already scheduled). */
  onClose(fn: () => void) {
    this.closeHandlers.push(fn)
  }

  /** The socket is open (messages can be sent now). */
  get open(): boolean {
    return !!this.socket && this.socket.readyState === WebSocket.OPEN
  }

  /** Send a message if the socket is open. Returns whether it was sent. */
  send(m: object): boolean {
    if (!this.open) return false
    this.socket!.send(JSON.stringify(m))
    return true
  }

  /** Close the socket; the close handler reconnects. */
  drop() {
    this.socket?.close()
  }

  /** Remember a pairing code typed on the phone and reconnect with it at once. */
  usePairingCode(code: string) {
    this.pairingCode = code
    remember('token', code)
    this.policy.retrySoon()
    this.socket?.close() // reconnects with the code
  }

  /**
   * Switch to a router session URL (already normalised, address.ts), remember it for the next
   * load, and connect to it at once: a live socket is closed and its reconnect uses the new
   * address; a pending retry is replaced by an immediate attempt.
   */
  useRouterAddress(url: string) {
    this.wsUrl = url
    remember('ws', url)
    this.policy.retrySoon()
    clearTimeout(this.retryTimer)
    const s = this.socket
    if (s && (s.readyState === WebSocket.OPEN || s.readyState === WebSocket.CONNECTING)) s.close() // onclose reconnects
    else this.connect()
  }

  /**
   * The liveness check, called from the render loop with performance.now() (ms): a router that
   * pings and has been silent past {@link PING_DEAD_MS} is dropped (and so reconnected).
   */
  checkLiveness(now: number) {
    if (this.connected && this.routerPings && now - this.lastHeardAt > PING_DEAD_MS) {
      console.warn('[codrawer] router silent for', Math.round(now - this.lastHeardAt), 'ms; reconnecting')
      this.routerPings = false
      this.socket?.close() // onclose reconnects
    }
  }

  /**
   * Open the socket (and keep reopening it whenever it closes). Without an address this does
   * nothing; {@link useRouterAddress} connects once there is one.
   */
  connect() {
    if (!this.wsUrl) return
    let ws: WebSocket
    try {
      ws = new WebSocket(this.url())
    } catch (e) {
      console.error('[codrawer] bad router URL', this.wsUrl, e)
      this.retryTimer = setTimeout(() => this.connect(), this.policy.delayAfterBadUrl())
      return
    }
    this.socket = ws
    ws.onopen = () => {
      this.connected = true
      this.policy.opened()
      this.lastHeardAt = performance.now()
      this.routerPings = false
      for (const fn of this.openHandlers) fn()
      console.log('[codrawer] connected', this.wsUrl)
    }
    ws.onclose = () => {
      if (this.socket !== ws) return
      const delay = this.policy.delayAfterClose()
      this.connected = false
      for (const fn of this.closeHandlers) fn()
      this.retryTimer = setTimeout(() => this.connect(), delay)
    }
    ws.onmessage = (ev) => this.receive(ev.data)
  }

  /** The session URL with the pairing code appended, when we have one. */
  private url(): string {
    if (!this.pairingCode) return this.wsUrl
    return `${this.wsUrl}${this.wsUrl.includes('?') ? '&' : '?'}token=${encodeURIComponent(this.pairingCode)}`
  }

  /** One inbound frame: note that the router is alive, parse, update link state, dispatch. */
  private receive(data: unknown) {
    this.lastHeardAt = performance.now()
    let m: { t?: string } & Record<string, unknown>
    try {
      m = JSON.parse(String(data))
    } catch {
      return
    }
    // The link's own reading of a few messages comes first; the modules' handlers follow.
    if (m.t === 'hello') this.policy.accepted()
    else if (m.t === 'error' && m.code === 'unauthorized') this.policy.refused(performance.now())
    else if (m.t === 'ping') this.routerPings = true
    for (const h of this.handlers.get(m.t as string) ?? []) (h as (m: unknown) => void)(m)
  }
}

/** The app's one router link. */
export const link = new RouterLink()
