/**
 * Keep the phone's screen on while this page is visible (presenting, or drawing over the camera).
 *
 * The browser releases a screen wake lock whenever the page is hidden, so the lock is requested
 * again on every return to visible. Where the Wake Lock API is missing it simply does nothing.
 */

async function keepAwake() {
  try {
    const nav = navigator as Navigator & { wakeLock?: { request(type: 'screen'): Promise<unknown> } }
    if (!nav.wakeLock || document.visibilityState !== 'visible') return
    await nav.wakeLock.request('screen')
    console.log('[codrawer] screen wake lock held')
  } catch (e) {
    console.warn('[codrawer] screen wake lock unavailable', String(e))
  }
}

/** Take the wake lock now and after every return to the page. */
export function keepScreenAwake() {
  void keepAwake()
  document.addEventListener('visibilitychange', () => void keepAwake())
}
