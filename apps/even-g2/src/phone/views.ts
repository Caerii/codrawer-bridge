/**
 * The phone's view switch (Follow · Fit · Page) and the loupe box drawn over the page.
 *
 * Follow tracks the pen at the glasses' follow scale (the same slice of page width as the glasses
 * canvas), Fit frames the writing, Page shows the whole page. The view mirrors the glasses
 * (phone/mirror.ts): {@link followGlasses} is called after every ring action that changes the
 * glasses' framing or zoom; the segmented control sets the phone alone.
 *
 * In the Fit and Page views the stage also draws the glasses loupe's view as a dashed box; dragging
 * its corner sets the loupe's zoom (remembered), so you can choose on the phone how much of the
 * page the loupe shows on the glasses.
 */
import { STAGE_OVERRIDE } from '../config'
import { loupeRect, resizeLoupe } from '../glasses/display'
import { dirty, view } from '../state'
import { initialPhoneView, phoneViewFor } from './mirror'
import { stage } from './screen'
import type { View } from './stage'

const viewButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('.seg button[data-view]'))

/** Show view `v` on the phone (at the glasses' current follow window) and mark its button. */
function applyView(v: View) {
  stage.followWindow = view.window
  stage.setView(v)
  for (const b of viewButtons) b.setAttribute('aria-pressed', String(b.dataset.view === v))
}

/** Bring the phone back in step with the glasses (after a ring tap or zoom). */
export function followGlasses() {
  applyView(phoneViewFor(view.mode))
}

/** Wire the loupe box and the view buttons, and pick the starting view. */
export function setupViews() {
  stage.loupeRect = loupeRect
  stage.onLoupeResize = (w) => {
    resizeLoupe(w)
    dirty.loupe = true
  }
  applyView(initialPhoneView(STAGE_OVERRIDE, view.mode))
  for (const b of viewButtons) b.onclick = () => applyView(b.dataset.view as View)
}
