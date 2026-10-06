/**
 * codrawer on the Even Realities G2: the table of contents.
 *
 * An Even Hub web app. It joins a codrawer-bridge session over WebSocket and shows the session's
 * page in two places at once:
 *
 *   on the glasses   two image containers and a text strip (glasses/): a small **loupe** that
 *                    follows the pen live and a **canvas** with the page, refreshed when the
 *                    writing pauses; the text shows status, the keyboard transcript, the
 *                    terminal, or a full-screen document editor (hud/, doc/)
 *   on the phone     the page at full resolution, live, on paper, dark or the camera (phone/), and
 *                    a participant's pen: strokes drawn there join the session; the user's
 *                    personal marks, learned and inspected here (marks/, phone/marks.ts); and
 *                    the Proof panel, the Primer's reading of a handwritten proof (primer/, ADR 010)
 *
 * The one fact that shapes the glasses side (ADR 006): an image update costs ~200 ms whatever its
 * size and only one can be on the wire, so live ink goes through the loupe alone, frames are
 * latest-wins and drawn just in time, and nothing else (text, the big canvas) is sent while the
 * pen is moving.
 *
 * How data flows:
 *
 *   router ──link.ts──▶ handlers (session.ts, hud/, doc/, phone/) ──▶ state.ts + dirty flags
 *   ring/menu ──glasses/input.ts──▶ actions.ts ──────────────────────▶ state.ts + dirty flags
 *   loop.ts (every 50 ms; keys flush the text at once) ──▶ glasses/display.ts ──▶ scheduler /
 *     text pacing ──▶ the glasses
 *   phone/stage.ts redraws itself on animation frames from the same stroke store
 *
 * This file only wires the modules together, in the order the page needs them. Outside the Even
 * app (a plain browser) everything but the glasses runs, and the phone's Glasses panel shows what
 * the glasses would.
 */
import { TextContainerUpgrade, waitForEvenAppBridge, type EvenAppBridge } from '@evenrealities/even_hub_sdk'
import { BENCH, HAS_LOUPE, RENDER_INTERVAL_MS } from './config'
import { collab, loadDocument, onDocCompact, onDocUpdate, onPlainDoc } from './doc/document'
import { runBench } from './glasses/bench'
import { drawCanvas, drawLoupe, keyTrace } from './glasses/display'
import { onGlassesEvent } from './glasses/input'
import { TEXT_ID } from './glasses/layout'
import { attachGlasses, releaseIfStale } from './glasses/page'
import { onKey } from './hud/keyboard'
import { onTerm } from './hud/terminal'
import { link } from './link'
import { setupMarks } from './marks/host'
import { flushText, tick } from './loop'
import { keepScreenAwake } from './phone/awake'
import { setupCamera } from './phone/camera'
import { installDevLog } from './phone/devlog'
import { forgetMyStrokes, setupDrawing } from './phone/draw'
import { setupMarksUi } from './phone/marks'
import { setupMenu } from './phone/menu'
import { askPairingCode, askRouterAddress, onHelloNotice } from './phone/notices'
import { showStatus } from './phone/panel'
import { stage } from './phone/screen'
import { setupToolbar, showConnection } from './phone/toolbar'
import { setupViews } from './phone/views'
import { mockActive, mockLine } from './primer/mock'
import { acceptReading, glanceFor, parseReading, primer } from './primer/model'
import { onReading, setupPrimerPanel } from './primer/panel'
import * as session from './session'
import { dirty, glasses, hud, view } from './state'
import { typerNoteText } from './typer'

// ── 1. The phone page ─────────────────────────────────────────────────────────────────────────
installDevLog() // first, so the console of everything below reaches the desktop in dev builds
stage.showAi = view.showAi !== false
setupToolbar()
setupViews()
setupDrawing()
setupCamera()
setupMenu()
setupMarksUi()
setupPrimerPanel()
keepScreenAwake()
loadDocument()

// ── 2. Router messages → the module that owns them (docs/protocol.md) ──────────────────────────
link.onOpen(() => {
  dirty.text = true
  collab.announce() // merge anything edited while offline; the router replays the rest
})
link.onClose(() => {
  showConnection(false)
  session.onDisconnect()
})
link.on('hello', () => showConnection(true))
link.on('hello', onHelloNotice)
link.on('hello', session.onHello)
link.on('hello', forgetMyStrokes) // a new connection owns no strokes yet (phone/draw.ts)
link.on('error', (m) => {
  if (m.code !== 'unauthorized') return
  askPairingCode()
  releaseIfStale()
})
link.on('cursor', session.onCursor)
link.on('stroke_begin', session.onStrokeBegin)
link.on('stroke_pts', session.onStrokePoints)
link.on('stroke_end', session.onStrokeEnd)
link.on('stroke_delete', session.onStrokeDelete)
link.on('ai_stroke_begin', session.onAiStrokeBegin)
link.on('ai_stroke_pts', session.onAiStrokePoints)
link.on('ai_stroke_end', session.onAiStrokeEnd)
link.on('ai_intent', session.onAiIntent)
link.on('page', session.onPage)
link.on('clear', session.onClear)
link.on('key', (m) => {
  keyTrace?.key(m.ts)
  onKey(m)
  flushText() // the key shows now, not on the next render tick
})
link.on('doc_update', onDocUpdate)
link.on('doc_compact', onDocCompact)
link.on('doc', onPlainDoc)
link.on('term', onTerm)
setupMarks() // personal marks: its own handlers for mark_*, dock_action and the ink it reads
link.on('primer', (m) => {
  // The panel shows every reading; the glasses get the move's one line (the HUD's intent line),
  // unless the Primer chose silence.
  const r = parseReading(m)
  if (!r) return
  const shown = acceptReading(r)
  onReading()
  // During a mock exam the glasses show only its quiet countdown (refreshed below), never a move.
  const line = mockActive(shown.mock) ? mockLine(shown.mock, Date.now()) : glanceFor(r.move)
  if (line) {
    hud.intent = line
    dirty.text = true
  }
  console.log('[codrawer] primer', shown.mode, shown.move?.kind ?? '-', shown.proof?.steps.length ?? 0, 'steps')
})

// The mock exam's countdown on the glasses: one text update a minute at most (ADR 006), and only
// while a mock runs or just after it ends.
setInterval(() => {
  const m = primer.latest?.mock ?? null
  if (!m || (!mockActive(m) && m.status !== 'awaiting_grading')) return
  const line = mockLine(m, Date.now())
  if (line && line !== hud.intent) {
    hud.intent = line
    dirty.text = true
  }
}, 15_000)

link.on('typer_note', (m) => {
  // what the tablet's typer could not type shows on the glasses' status strip
  const text = typerNoteText({ t: 'typer_note', ...m })
  if (text) onTerm({ kind: 'status', text })
})

// ── 3. Start: connect, draw, find the glasses ─────────────────────────────────────────────────

/** How long to wait for the Even bridge before running as a browser preview, ms. */
const BRIDGE_WAIT_MS = 3000

async function main() {
  link.connect()
  if (!link.address) askRouterAddress() // first run of a build with no router built in
  drawCanvas()
  if (HAS_LOUPE) drawLoupe()
  showStatus(`waiting for Even bridge… (${link.address || 'no tablet address yet'})`)
  const bridgeP = waitForEvenAppBridge()
  void bridgeP.then((sdk) => {
    glasses.sdk = sdk
  })
  const b = await Promise.race<EvenAppBridge | null>([bridgeP, new Promise<null>((resolve) => setTimeout(() => resolve(null), BRIDGE_WAIT_MS))])
  if (b && BENCH) {
    // ?bench=1: the on-device benchmark replaces the app for this load
    await runBench(b, (lines) => {
      showStatus(lines.join('\n'))
      void b.textContainerUpgrade(new TextContainerUpgrade({ containerID: TEXT_ID, containerName: 'status', content: lines.slice(0, 9).join('\n') })).catch(() => {})
    })
    return
  }
  dirty.text = true
  setInterval(tick, RENDER_INTERVAL_MS)
  if (b) {
    await attachGlasses(b, onGlassesEvent)
  } else {
    // A packaged (.ehpk) app can take longer than 3 s to get its bridge on a cold start; keep
    // the browser preview running and attach whenever it arrives instead of giving up.
    glasses.status = 'no Even bridge yet (still waiting)'
    console.log('[codrawer] no Even bridge yet; browser preview until it arrives')
    void bridgeP.then((sdk) => attachGlasses(sdk, onGlassesEvent))
  }
}

main().catch((e) => {
  console.error('[codrawer] fatal', e)
  showStatus(`fatal: ${String(e)}`)
})
