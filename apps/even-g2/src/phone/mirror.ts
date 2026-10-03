/**
 * How the phone's view follows the glasses.
 *
 * The phone has three views (Follow · Fit · Page); the glasses canvas has two framings (follow the
 * pen, or fit the whole inked page). The phone mirrors the glasses: a ring tap or ring zoom puts
 * the phone in Follow when the glasses follow and in Fit when they show the page. The phone's own
 * control overrides that until the next ring action. Pure.
 */
import type { ViewMode } from '../strokes'
import type { View } from './stage'

/** The phone view that matches the glasses' framing. */
export function phoneViewFor(mode: ViewMode): View {
  return mode === 'follow' ? 'follow' : 'focus'
}

/** The phone view at load: `?stage=` when it names a view, else in step with the glasses. */
export function initialPhoneView(override: string | null, mode: ViewMode): View {
  return override === 'page' || override === 'focus' || override === 'follow' ? override : phoneViewFor(mode)
}
