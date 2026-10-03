/**
 * The phone screen's stage: the page at full resolution, live, on paper or dark.
 *
 * This is what you look at on the phone (or project); the Stage class (stage.ts) does the drawing.
 * It reads the shared stroke store directly and redraws on animation frames when told something
 * changed: `touch()` for new points, `invalidate()` when strokes were removed or restyled.
 * Everything that changes the page calls one or the other.
 */
import { PAGE_ASPECT } from '../config'
import { store } from '../state'
import { Stage } from './stage'

/** The phone's stage, drawing into the page's <canvas id="stage">. */
export const stage = new Stage(document.getElementById('stage') as HTMLCanvasElement, store, PAGE_ASPECT)
