/**
 * The glasses page: which containers exist, where they sit, and the contextual menu.
 *
 * A G2 page is a fixed set of containers declared up front (SDK 0.0.16); changing the set means
 * rebuilding the page, one ~165 ms call that blanks every container (ADR 006). So the app has
 * three layouts and switches between them rarely, on purpose:
 *
 *     canvas   ┌────────────────────┐  ┌──────────────┐
 *              │ canvas  288×144    │  │ loupe 192×144│   live ink in the loupe, the page in
 *              └────────────────────┘  └──────────────┘   the canvas, a 4-row status strip
 *              status / transcript (4 rows)                underneath
 *     wide     ┌────────────────────┬────────────────────┐   the fit view across the full width:
 *              │ canvas, left half  │ canvas, right half │   two 288×144 tiles (the loupe's
 *              └────────────────────┴────────────────────┘   container carries the right one)
 *              status / transcript (4 rows)
 *     text     one full-screen text container (9 rows): the transcript
 *     edit     the same full-screen text container, showing the document editor
 *
 * The screen is 576×288 device px; image containers are at most 288×144. Exactly one container
 * carries `isEventCapture: 1` (the status text, so ring scrolls arrive as its text events), and
 * if any container sets `zOrderIndex`, all must. Containers must be built with the SDK classes;
 * plain object literals fail the host's type check.
 */
import { ImageContainerProperty, MenuContainerProperty, MenuItemProperty, TextContainerProperty } from '@evenrealities/even_hub_sdk'
import { HAS_LOUPE, IMG_H, IMG_W, LOUPE_H, LOUPE_W } from '../config'

/** The page layout (see the module comment). */
export type PageMode = 'canvas' | 'text' | 'edit'

/** The G2 display, device px. */
export const SCREEN_W = 576
export const SCREEN_H = 288

import { IMG_ID, TEXT_ID, LOUPE_ID, MENU } from './ids'
export { IMG_ID, TEXT_ID, LOUPE_ID, MENU } from './ids'

/**
 * The host refuses a page whose menu has more than 10 items (`TOO_MANY_MENU_ITEMS`: create and
 * rebuild both fail, so the glasses show nothing). Fold new entries into existing ones.
 */
export const MAX_MENU_ITEMS = 10

/** Width of each of the wide view's two tiles: the SDK's largest image container, half the screen. */
export const WIDE_TILE_W = SCREEN_W / 2

/** The contextual menu (long-press). Two entries name the layout they lead to. */
function menu(mode: PageMode): MenuContainerProperty {
  const menuItems = [
    new MenuItemProperty({ itemName: 'New drawing', itemID: MENU.newDrawing }),
    new MenuItemProperty({ itemName: 'Send drawing to agent', itemID: MENU.sendDrawing }),
    new MenuItemProperty({ itemName: mode === 'text' ? 'Canvas view' : 'Text view', itemID: MENU.textView }),
    new MenuItemProperty({ itemName: mode === 'edit' ? 'Leave editor' : 'Edit document', itemID: MENU.editDoc }),
    new MenuItemProperty({ itemName: 'Toggle AI ghost', itemID: MENU.toggleAi }),
    new MenuItemProperty({ itemName: 'View: follow / fit / wide', itemID: MENU.cycleView }),
    new MenuItemProperty({ itemName: 'Cycle emphasis', itemID: MENU.cycleHighlight }),
    new MenuItemProperty({ itemName: 'Zoom in', itemID: MENU.zoomIn }),
    new MenuItemProperty({ itemName: 'Zoom out', itemID: MENU.zoomOut }),
    new MenuItemProperty({ itemName: 'Clear AI ink', itemID: MENU.clearAi }),
  ]
  if (menuItems.length > MAX_MENU_ITEMS) throw new Error(`glasses menu has ${menuItems.length} items; the host allows ${MAX_MENU_ITEMS}`)
  return new MenuContainerProperty({ menuItems })
}

/**
 * The container set for a layout, ready for `createStartUpPageContainer` or
 * `rebuildPageContainer`. `text` supplies the full-screen text's first content (text and edit
 * layouts only; it is called only for them). `wide` lays the canvas layout out as the wide fit
 * view. The canvas layout's status strip starts as "codrawer: connecting…" until the render loop
 * sends the real line.
 */
export function buildPage(mode: PageMode, text: () => string, wide = false) {
  const menuObject = menu(mode)
  if (mode === 'text' || mode === 'edit') {
    const textObject = [
      new TextContainerProperty({
        xPosition: 8,
        yPosition: 4,
        width: SCREEN_W - 16,
        height: SCREEN_H - 8,
        containerID: TEXT_ID,
        containerName: 'status',
        content: text(),
        textColor: 4,
        isEventCapture: 1,
      }),
    ]
    return { containerTotalNum: 1, textObject, menuObject }
  }
  // canvas layout: canvas on the left, loupe flush right, both at the top; status text below
  const top = 4
  if (wide) return wideCanvasPage(top, menuObject)
  const imageObject = [
    new ImageContainerProperty({
      xPosition: 8,
      yPosition: top,
      width: IMG_W,
      height: IMG_H,
      containerID: IMG_ID,
      containerName: 'canvas',
      zOrderIndex: 1,
    }),
  ]
  if (HAS_LOUPE) {
    imageObject.push(
      new ImageContainerProperty({
        xPosition: SCREEN_W - 8 - LOUPE_W,
        yPosition: top,
        width: LOUPE_W,
        height: LOUPE_H,
        containerID: LOUPE_ID,
        containerName: 'loupe',
        zOrderIndex: 3,
      }),
    )
  }
  const textTop = top + Math.max(IMG_H, HAS_LOUPE ? LOUPE_H : 0) + 8
  const textObject = [
    new TextContainerProperty({
      xPosition: 8,
      yPosition: textTop,
      width: SCREEN_W - 16,
      height: Math.max(24, SCREEN_H - textTop - 4),
      containerID: TEXT_ID,
      containerName: 'status',
      content: 'codrawer: connecting…',
      textColor: 3,
      isEventCapture: 1,
      zOrderIndex: 2,
    }),
  ]
  return { containerTotalNum: imageObject.length + textObject.length, imageObject, textObject, menuObject }
}

/**
 * The wide fit layout: two tiles edge to edge across the screen (canvas container on the left,
 * the loupe's container on the right, so container ids stay fixed), the status strip below.
 */
function wideCanvasPage(top: number, menuObject: MenuContainerProperty) {
  const tile = (x: number, containerID: number, containerName: string, zOrderIndex: number) =>
    new ImageContainerProperty({ xPosition: x, yPosition: top, width: WIDE_TILE_W, height: IMG_H, containerID, containerName, zOrderIndex })
  const imageObject = [tile(0, IMG_ID, 'canvas', 1), tile(WIDE_TILE_W, LOUPE_ID, 'loupe', 3)]
  const textTop = top + IMG_H + 8
  const textObject = [
    new TextContainerProperty({
      xPosition: 8,
      yPosition: textTop,
      width: SCREEN_W - 16,
      height: Math.max(24, SCREEN_H - textTop - 4),
      containerID: TEXT_ID,
      containerName: 'status',
      content: 'codrawer: connecting…',
      textColor: 3,
      isEventCapture: 1,
      zOrderIndex: 2,
    }),
  ]
  return { containerTotalNum: imageObject.length + textObject.length, imageObject, textObject, menuObject }
}
