/**
 * Configuration: every query parameter and remembered setting, in one typed place.
 *
 * The app runs in three hosts: the Even app's WebView on a phone (sideloaded from the dev server
 * or installed as a packaged .ehpk), the Even Hub simulator, and a plain browser. None of them
 * offers a settings screen we control, so configuration arrives once in the URL
 * (`?ws=…&loupe=128x64`) and is then remembered in localStorage under `codrawer:<key>`, which
 * survives the app being reopened from the Even Hub tab with a bare URL.
 *
 * Each tunable below carries its default and, where it is not obvious, the measurement that chose
 * it. The numbers that matter most come from ADR 006 (docs/adr/006-latency-budget-per-surface.md):
 * an image update to the glasses costs ~200 ms whatever its size and only one may be on the wire
 * at a time; a text update is a much cheaper host call; a page rebuild is ~165 ms flat.
 *
 * Everything here is read once, at load. Settings that change while the app runs (the AI toggle,
 * the loupe zoom, the theme, the page mode, the pairing code, the participant colour) are written
 * back with {@link remember} by the module that owns them, so the next load starts where this one
 * left off. (The shared document keeps its own storage: doc/document.ts.)
 */
import type { Highlight, ViewMode } from './strokes'
import { DEFAULT_ERASE_RADIUS } from './erase'
import type { PageMode } from './glasses/layout'

const params = new URLSearchParams(location.search)

/**
 * A setting: from `?key=` (and then remembered), else the remembered value, else `fallback`.
 * Storage can be unavailable in some WebViews; the setting then simply is not remembered.
 */
export function cfg(key: string, fallback: string): string {
  const fromQuery = params.get(key)
  if (fromQuery !== null) {
    try {
      localStorage.setItem(`codrawer:${key}`, fromQuery)
    } catch {
      /* storage may be unavailable in the webview */
    }
    return fromQuery
  }
  try {
    return localStorage.getItem(`codrawer:${key}`) ?? fallback
  } catch {
    return fallback
  }
}

/** A query parameter for this load only: never remembered (one-shot diagnostics, overrides). */
export function once(key: string): string | null {
  return params.get(key)
}

/** Remember a setting under `codrawer:<key>` for the next load. Best effort. */
export function remember(key: string, value: string) {
  try {
    localStorage.setItem(`codrawer:${key}`, value)
  } catch {
    /* ignore */
  }
}

/** A remembered setting, or null (also when storage is unavailable). */
export function recall(key: string): string | null {
  try {
    return localStorage.getItem(`codrawer:${key}`)
  } catch {
    return null
  }
}

/**
 * A `WxH` size in device pixels, clamped to `[20, max]` per side; `0` disables the container
 * ([0, 0]); anything unparseable falls back to `fallback` (clamped to the maximum only).
 */
function size(key: string, fallback: string, maxW: number, maxH: number): [number, number] {
  const v = cfg(key, fallback)
  if (v === '0') return [0, 0]
  const m = /^(\d+)x(\d+)$/.exec(v)
  const w = m ? Math.min(maxW, Math.max(20, Number(m[1]))) : Math.min(maxW, Number(fallback.split('x')[0]))
  const h = m ? Math.min(maxH, Math.max(20, Number(m[2]))) : Math.min(maxH, Number(fallback.split('x')[1]))
  return [w, h]
}

// ── The router ────────────────────────────────────────────────────────────────────────────────
// From the dev server (simulator, QR sideload) the router is assumed on the same host. A packaged
// .ehpk has no meaningful host: its default is whatever the build was given (CODRAWER_WS in
// vite.config.ts), which is nothing unless the person building it set one. With no address at all
// the phone asks for the tablet's (phone/notices.ts askRouterAddress) and remembers the answer.
const defaultWs = import.meta.env.DEV ? `ws://${location.hostname || 'localhost'}:8577/ws/session1` : __CODRAWER_WS__

/**
 * The session's WebSocket URL at load, without the pairing code (`?ws=`, else remembered, else the
 * default above); '' when there is none yet. The link owns it from then on (link.ts `address`).
 */
export const INITIAL_WS_URL = cfg('ws', defaultWs)

/**
 * The pairing code a router may require (the tablet's ROUTER_TOKEN): from `?token=` (the QR code
 * carries it) or remembered; when the router refuses us the phone banner asks for it.
 */
export const INITIAL_PAIRING_CODE = cfg('token', '')

// ── The glasses display ───────────────────────────────────────────────────────────────────────
// The G2 shows 576×288; an image container is at most 288×144 (SDK 0.0.16).

/** The canvas container in device px (`?img=`, max 288×144): the page, follow-crop or fit. */
export const [IMG_W, IMG_H] = size('img', '288x144', 288, 144)

/**
 * The loupe container in device px (`?loupe=`, `0` disables it): a window that follows the pen.
 * The phone converts every frame to an uncompressed 4-bpp bitmap for the glasses, so the cost
 * per send grows with the loupe's pixel area (~12 ms per KB of bitmap measured: 128x64 ≈ 4 KB ≈
 * 200 ms, 288x144 ≈ 20 KB ≈ 400 ms), not with our PNG size. Default 192x144: the full height of
 * the right column (~14 KB, ~290 ms, ~3.4 fps); ?loupe=128x64 is the fast small one, up to
 * 272x144 fits beside the canvas.
 */
export const [LOUPE_W, LOUPE_H] = size('loupe', '192x144', 272, 144)
export const HAS_LOUPE = LOUPE_W > 0

/** Floor between two loupe sends, ms (`?frame_ms=`). The measured round trip usually dominates. */
export const LOUPE_MIN_MS = Number(cfg('frame_ms', '60')) || 60
/** Floor between two canvas sends without a loupe, ms (`?canvas_ms=`). */
export const CANVAS_MIN_MS = Number(cfg('canvas_ms', '1200')) || 1200
/** With a loupe, the canvas is resent after this long without ink, ms (`?lull_ms=`). */
export const CANVAS_LULL_MS = Number(cfg('lull_ms', '600')) || 600
/**
 * Wide fit refresh floor (`?wide_ms=`). The wide view has no loupe, so its canvas is the live view:
 * it is resent as fast as the link takes it (one ~200 ms image send at a time, ADR 006), and only
 * the tile that changed goes (the scheduler skips a tile the lens already shows). Writing and
 * erasing then show within a few hundred ms instead of CANVAS_MIN_MS.
 */
export const WIDE_CANVAS_MIN_MS = Number(cfg('wide_ms', '150')) || 150

/**
 * Frame encoding (`?fmt=`). png: the browser's PNG (the documented encoded-image path; the host
 * converts to Gray4). gray8 / gray4: raw pixel bytes. png1 (1-bit PNG) is ~4x smaller than the
 * browser's PNG; measured on the device it does not lower the ~190 ms per-call floor but keeps the
 * canvas send short (2026-10-02).
 */
export const FMT: 'png' | 'png1' | 'gray8' | 'gray4' = ((v) => (v === 'gray8' || v === 'gray4' || v === 'png' ? v : 'png1'))(cfg('fmt', 'png1'))

/**
 * Image updates allowed on the wire at once (`?inflight=`, 1..4). Keep 1: the phone host answers
 * sendFailed to overlapping updates (measured with inflight=2, 2026-10-02).
 */
export const INFLIGHT = Math.max(1, Math.min(4, Number(cfg('inflight', '1')) || 1))

/** Snap pixels to black/white before encoding (`?binarize=0` keeps antialiased grey). */
export const BINARIZE = cfg('binarize', '1') !== '0'

/**
 * How imageData crosses the WebView bridge (`?enc=`). `b64` sends a base64 string: the simulator
 * accepts it but the phone host answered sendFailed (2026-09-26), so the SDK's number[]
 * marshaling stays the default; the bench compares both.
 */
export const ENC: 'b64' | 'array' = cfg('enc', 'array') === 'b64' ? 'b64' : 'array'

/** `?bench=1`: run the on-device benchmark (bench.ts) instead of the app; `?bench=0` returns. */
export const BENCH = cfg('bench', '0') === '1'

/** `?probe=1`: one-shot link probe after the page is up (probe.ts). Never remembered. */
export const PROBE = once('probe') === '1'

/** The loupe's writing-aware camera (`?loupe_cam=0`: plain re-centring on the pen every frame). */
export const LOUPE_CAM = cfg('loupe_cam', '1') !== '0'

/** Loupe zoom relative to the default, set by dragging the loupe box on the phone (remembered). */
export const INITIAL_LOUPE_ZOOM = Number(cfg('loupe_zoom', '1')) || 1

// ── The view ──────────────────────────────────────────────────────────────────────────────────

/** Page aspect, width / height: the Paper Pro's 1620 × 2160. */
export const PAGE_ASPECT = 1620 / 2160

/** Canvas framing (`?mode=follow|full`): crop around the pen, or the whole inked page. */
export const INITIAL_MODE: ViewMode = (cfg('mode', 'follow') as ViewMode) === 'full' ? 'full' : 'follow'

/**
 * Wide fit (`?wide=1`): in the fit view the glasses canvas spans the screen's full width as two
 * 288×144 image tiles side by side (288×144 is the SDK's largest image container, half the 576-px
 * screen), and the loupe gives way. Twice the width costs twice the sends (~200 ms each, ADR 006),
 * so it suits a page you look at more than one you write into. Remembered; toggled from the
 * glasses' menu and the phone's ⋯ menu.
 */
export const INITIAL_WIDE_FIT = cfg('wide', '0') === '1'
/** Emphasis (`?highlight=all|user|ai`). */
export const INITIAL_HIGHLIGHT: Highlight = (cfg('highlight', 'all') as Highlight) || 'all'
/** Follow window width as a fraction of the page width (`?window=`). */
export const INITIAL_WINDOW = Number(cfg('window', '0.22')) || 0.22
/**
 * The tablet eraser's radius in page px (`?eraser=`, 2..400): ink within it of the eraser's path
 * is cut as the eraser moves. 28.8 is the Marker's eraser end at the tablet's default zoom,
 * measured on a Paper Pro page (erase.ts, docs/investigations/native-erase.md). xochitl divides
 * the eraser by the zoom, so a page erased while zoomed in needs a smaller value.
 */
export const ERASE_RADIUS = ((v) => (v >= 2 && v <= 400 ? v : DEFAULT_ERASE_RADIUS))(Number(cfg('eraser', String(DEFAULT_ERASE_RADIUS))))

/**
 * Erase prediction (`?erase=0` turns it off): with it, the tablet's eraser cuts ink on every
 * client as it moves; without it, erased ink stays until the tablet saves the page.
 */
export const PREDICT_ERASE = cfg('erase', '1') !== '0'

/** Show the AI ghost layer (`?ai=1`; toggled from the menu and remembered). */
export const SHOW_AI = cfg('ai', '0') !== '0'

/** Glasses page layout at start (`?view=canvas|text|edit`; remembered on every switch). */
export const INITIAL_PAGE_MODE: PageMode = ((v) => (v === 'text' || v === 'edit' ? v : 'canvas'))(cfg('view', 'canvas'))

/** Phone theme (`?theme=paper|dark`; remembered on every toggle). */
export const INITIAL_THEME: 'paper' | 'dark' = cfg('theme', 'paper') === 'dark' ? 'dark' : 'paper'

/** Phone view for this load only (`?stage=page|focus|follow`); otherwise it mirrors the glasses. */
export const STAGE_OVERRIDE = once('stage')

/** The render loop's period, ms: dirty flags are turned into frames at most this often. */
export const RENDER_INTERVAL_MS = 50
