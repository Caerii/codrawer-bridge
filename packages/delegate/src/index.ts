/**
 * delegate: delegation on paper (docs/adr/012-delegation-on-paper.md).
 *
 * A user delegates ink on the page to a pod; the pod answers on a task card drawn in its own
 * hand on its own layer; the user answers the card with marks (circle, tick, strike, arrow,
 * initials). This package is the pure, testable core of that loop:
 *
 * - geometry: page millimetres, paths and containment;
 * - task: the task object, authority levels, actions and the action hash consent binds to;
 * - card: card layout, placement clear of the user's ink, and the status marks;
 * - marks: the semantic mark classifier, read against the cards' answer regions;
 * - consent: verifying initials as consent for one specific action.
 *
 * No DOM, no Node APIs: it runs in the router's TS tooling, the glasses app and the phone stage.
 */

export * from './geometry'
export * from './task'
export * from './card'
export * from './marks'
export * from './consent'
