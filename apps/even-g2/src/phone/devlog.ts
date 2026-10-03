/**
 * Dev builds only: mirror the phone's console to the desktop.
 *
 * Inside the Even app there is no practical way to attach a debugger to the WebView, so in dev
 * builds every console.log/warn/error (and uncaught errors and rejections) is also POSTed to the
 * dev server's `/__log`, which appends it to `.codrawer/logs/phone.log` (vite.config.ts). The SDK's
 * own `[EvenAppBridge]` chatter is not forwarded. Lines are cut at 2000 characters; failures to
 * post are ignored. Production builds (.ehpk) never install this.
 */

/** Install the forwarding (a no-op outside dev builds). Call first, so nothing is missed. */
export function installDevLog() {
  if (!import.meta.env.DEV) return
  const post = (level: string, args: unknown[]) => {
    const text = args.map((a) => (typeof a === 'string' ? a : (() => { try { return JSON.stringify(a) } catch { return String(a) } })())).join(' ')
    void fetch('/__log', { method: 'POST', body: `${level} ${text}`.slice(0, 2000), keepalive: true }).catch(() => {})
  }
  for (const level of ['log', 'warn', 'error'] as const) {
    const orig = console[level].bind(console)
    console[level] = (...args: unknown[]) => {
      orig(...args)
      if (typeof args[0] === 'string' && args[0].startsWith('[EvenAppBridge]')) return // noisy
      post(level, args)
    }
  }
  window.addEventListener('error', (e) => post('error', ['window.onerror', e.message, `${e.filename}:${e.lineno}`]))
  window.addEventListener('unhandledrejection', (e) => post('error', ['unhandledrejection', String(e.reason)]))
  post('log', ['[codrawer] page loaded', navigator.userAgent, location.href])
}
