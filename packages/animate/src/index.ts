/**
 * animate: codrawer-animate's pure core, a Flipnote-style frame model for stroke-native
 * animation on the reMarkable Paper Pro, its phone, its glasses and its agents.
 *
 * The design and the evidence behind it: docs/investigations/codrawer-animate.md. In brief:
 * frames are pages (ADR 008); the tablet draws them natively, one notebook page per frame; the
 * onion skin is a QML overlay, never ink; the tablet previews at the few frames per second its
 * Animation waveform allows (`deviceSchedule`), while the phone, the glasses and the export play
 * at full rate from the same strokes. No DOM, no Node APIs: the module runs in the app, a router
 * and tests alike.
 *
 * Reading order: model (frames, holds, timing) → onion (ghosts, dither) → ease (spacing) →
 * inbetween (correspondence, interpolation) → motion (paths, bounce) → protocol (messages).
 */

export * from './model'
export * from './onion'
export * from './ease'
export * from './inbetween'
export * from './motion'
export * from './protocol'
