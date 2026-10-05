/**
 * Glasses input: the touchpad, the R1 ring and the contextual menu, turned into actions.
 *
 * The SDK delivers input in three shapes, and two of them are surprising (learned in the
 * simulator and on the device):
 *
 * - Menu picks arrive as `menuItemClickEvent` with the item id (glasses/layout.ts MENU).
 * - Click, double click and scroll as `sysEvent`; a click has **no** `eventType`, because the
 *   protobuf omits 0 (= CLICK_EVENT).
 * - Scroll up / down from the ring also arrive as a `textEvent` on the event-capture container
 *   (the status text), `eventType` 1 = up, 2 = down.
 *
 * On the canvas layout: click toggles follow / fit, double click cycles emphasis, scroll zooms
 * the follow window. The other layouts give the ring its own meanings: in the text view it
 * scrolls the transcript, in the editor it moves the cursor by line, and a click in the editor
 * saves and shares the document (the common action there).
 */
import { OsEventTypeList, type EvenHubEvent } from '@evenrealities/even_hub_sdk'
import { applyAction, type Action } from '../actions'
import { saveDoc } from '../doc/document'
import { commitLine } from '../hud/commands'
import { onKey } from '../hud/keyboard'
import { dirty, glasses, hud, view } from '../state'
import { MENU, TEXT_ID } from './layout'

const MENU_ACTION: Record<number, Action> = {
  [MENU.newDrawing]: 'new-drawing',
  [MENU.editDoc]: 'edit-doc',
  [MENU.sendDrawing]: 'send-drawing',
  [MENU.textView]: 'text-view',
  [MENU.clearAi]: 'clear-ai',
  [MENU.toggleAi]: 'toggle-ai',
  [MENU.toggleMode]: 'toggle-mode',
  [MENU.wideFit]: 'toggle-wide',
  [MENU.cycleHighlight]: 'cycle-highlight',
  [MENU.zoomIn]: 'zoom-in',
  [MENU.zoomOut]: 'zoom-out',
}

/** The action an event asks for, or '' when it asks for none. */
function actionFor(event: EvenHubEvent): Action | '' {
  const sys = event.sysEvent
  const text = event.textEvent
  const menu = event.menuItemClickEvent
  if (menu && menu.itemID !== undefined) return MENU_ACTION[menu.itemID] ?? ''
  if (sys && sys.eventSource !== undefined) {
    const type = sys.eventType ?? OsEventTypeList.CLICK_EVENT
    if (type === OsEventTypeList.CLICK_EVENT) return 'toggle-mode'
    if (type === OsEventTypeList.DOUBLE_CLICK_EVENT) return 'cycle-highlight'
    if (type === OsEventTypeList.SCROLL_TOP_EVENT) return 'zoom-in'
    if (type === OsEventTypeList.SCROLL_BOTTOM_EVENT) return 'zoom-out'
    return ''
  }
  if (text && text.containerID === TEXT_ID) {
    if (text.eventType === 1) return 'zoom-in'
    if (text.eventType === 2) return 'zoom-out'
  }
  return ''
}

/** Handle one glasses input event (subscribed by glasses/page.ts once the page is up). */
export function onGlassesEvent(event: EvenHubEvent) {
  const action = actionFor(event)
  if (!action) return
  // In text view the ring scrolls the transcript; in edit view it moves the cursor by line.
  if ((glasses.pageMode === 'text' || glasses.pageMode === 'edit') && (action === 'zoom-in' || action === 'zoom-out')) {
    onKey({ key: action === 'zoom-in' ? 'ArrowUp' : 'ArrowDown' })
    return
  }
  if (glasses.pageMode === 'edit' && action === 'toggle-mode') {
    // click in edit view = save + share, the common action
    saveDoc('ring')
    hud.notice = 'saved'
    dirty.text = true
    return
  }
  if (action === 'send-drawing') {
    // the menu's "Send drawing to agent" is the /snap command, shown in the transcript
    commitLine('/snap')
    hud.typingAt = performance.now()
    dirty.text = true
  } else applyAction(action)
  console.log('[codrawer] input', action, '→', view.mode, view.highlight, view.window.toFixed(2))
}
