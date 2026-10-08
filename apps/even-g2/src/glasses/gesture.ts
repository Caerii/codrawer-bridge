/** Pure ring/menu decoding, including omitted protobuf defaults. */
import { OsEventTypeList, type EvenHubEvent } from '@evenrealities/even_hub_sdk'
import type { Action } from '../actions'
import { MENU, TEXT_ID } from './ids'

const MENU_ACTION: Record<number, Action> = {
  [MENU.newDrawing]: 'new-drawing',
  [MENU.editDoc]: 'edit-doc',
  [MENU.sendDrawing]: 'send-drawing',
  [MENU.textView]: 'text-view',
  [MENU.clearAi]: 'clear-ai',
  [MENU.toggleAi]: 'toggle-ai',
  [MENU.cycleView]: 'cycle-view',
  [MENU.cycleHighlight]: 'cycle-highlight',
  [MENU.zoomIn]: 'zoom-in',
  [MENU.zoomOut]: 'zoom-out',
}

/** The action an event asks for, or '' when it asks for none. */
export function actionFor(event: EvenHubEvent): Action | '' {
  const sys = event.sysEvent
  const text = event.textEvent
  const menu = event.menuItemClickEvent
  if (menu && menu.itemID !== undefined) return MENU_ACTION[menu.itemID] ?? ''
  if (text && text.containerID === TEXT_ID) {
    if (text.eventType === 1) return 'zoom-in'
    if (text.eventType === 2) return 'zoom-out'
  }
  if (sys) {
    const type = sys.eventType ?? OsEventTypeList.CLICK_EVENT
    if (type === OsEventTypeList.CLICK_EVENT) return 'toggle-mode'
    if (type === OsEventTypeList.DOUBLE_CLICK_EVENT) return 'cycle-highlight'
    if (type === OsEventTypeList.SCROLL_TOP_EVENT) return 'zoom-in'
    if (type === OsEventTypeList.SCROLL_BOTTOM_EVENT) return 'zoom-out'
    return ''
  }
  return ''
}
