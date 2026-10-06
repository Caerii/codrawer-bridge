/**
 * Getting a file out of the app: the share sheet on phones, a download everywhere else.
 *
 * The menu's exports (the page PNG, the timelapse video, the session recording) all end here.
 * On a touch device that can share files (iOS Safari and its WebView, Android Chrome) the share
 * sheet is the way to put a file in Photos, Messages or Files; a download from a WebView often
 * goes nowhere. On a desktop the download is what people expect.
 *
 * One rule shapes the callers: `navigator.share` needs a user gesture that is still fresh
 * (transient activation, ~5 s in Chrome, the same click in Safari). An export that took longer than
 * that (a timelapse records for its whole length) must ask for a second tap before sharing:
 * {@link canShareFile} says whether to offer one.
 */

/** Whether this device should share `file` through the share sheet (touch, and it can share files). */
export function canShareFile(file: File): boolean {
  const nav = navigator as Navigator & { canShare?: (d: { files: File[] }) => boolean }
  try {
    return matchMedia('(pointer: coarse)').matches && !!nav.canShare?.({ files: [file] })
  } catch {
    return false
  }
}

/** Save a blob as a download named `name` (an <a download> click on an object URL). */
export function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.append(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

/**
 * Share `blob` as a file named `name` where the share sheet is the way (see {@link canShareFile}),
 * else download it. Call it from a user gesture. Resolves how it went: `cancelled` when the user
 * closed the share sheet (nothing else is tried then).
 */
export async function shareOrDownload(blob: Blob, name: string, title: string): Promise<'shared' | 'downloaded' | 'cancelled'> {
  const file = new File([blob], name, { type: blob.type })
  if (canShareFile(file)) {
    try {
      await navigator.share({ files: [file], title })
      return 'shared'
    } catch (e) {
      if ((e as DOMException).name === 'AbortError') return 'cancelled'
      // NotAllowedError (the gesture went stale) or a share target that failed: download instead
    }
  }
  download(blob, name)
  return 'downloaded'
}

/** A file name stamped with the UTC time (as the PNG export always named it):`<prefix>-2026-10-05-14-03-12.<ext>`. */
export function stampedName(prefix: string, ext: string, at = Date.now()): string {
  return `${prefix}-${new Date(at).toISOString().slice(0, 19).replace(/[:T]/g, '-')}.${ext}`
}

/** "1.2 MB", "340 KB": a file size for a label. */
export function formatBytes(n: number): string {
  return n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`
}
