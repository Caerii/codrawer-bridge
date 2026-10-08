/** Container ids, fixed across layouts so updates address the same id whatever the page. */
export const IMG_ID = 1
export const TEXT_ID = 2
export const LOUPE_ID = 3

/** Contextual-menu item ids (non-zero, unique); glasses/input.ts maps them to actions. */
export const MENU = { newDrawing: 1, toggleAi: 2, cycleView: 3, cycleHighlight: 4, zoomIn: 5, zoomOut: 6, clearAi: 7, textView: 8, sendDrawing: 9, editDoc: 10 } as const
