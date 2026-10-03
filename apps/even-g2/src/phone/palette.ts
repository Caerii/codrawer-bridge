/**
 * Participant colours: the palette strokes drawn on a phone or browser are coloured from.
 *
 * Each participant draws in one colour so everyone can tell whose ink is whose (ADR 008). Until
 * someone picks one (the phone menu's "My colour", or `?color=`), the colour is chosen from the
 * participant's id, so the same device keeps the same colour across loads and different devices
 * usually differ. The palette leaves out black, the tablet's own ink. Pure.
 */

/** The palette, as CSS hex colours. */
export const PARTICIPANT_COLORS = ['#d6482a', '#2f80ed', '#9b51e0', '#219653', '#f2994a', '#eb5757']

/** Human names for the palette, for the colour buttons' labels. */
export const COLOR_NAMES: Record<string, string> = {
  '#d6482a': 'Vermilion',
  '#2f80ed': 'Blue',
  '#9b51e0': 'Purple',
  '#219653': 'Green',
  '#f2994a': 'Orange',
  '#eb5757': 'Coral',
}

/** The default colour for a participant id: a stable hash of the id into the palette. */
export function defaultColorFor(id: string): string {
  let h = 0
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return PARTICIPANT_COLORS[h % PARTICIPANT_COLORS.length]
}
