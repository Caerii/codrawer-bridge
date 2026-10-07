/**
 * hand: a biomechanical, biophysical handwriting simulator for codrawer's AI ink.
 *
 * `simulate(text, persona)` writes text the way a particular hand would: a sigma-lognormal motor
 * plan (Plamondon's Kinematic Theory) re-timed toward the two-thirds power law, tracked by a
 * damped shoulder–elbow–wrist–finger arm with physiological tremor, with pressure from the
 * movement and pauses, hesitations and self-corrections from a cognitive layer. `toProtocol`
 * turns the strokes into codrawer messages with real timestamps; `perform` plays them live and
 * yields while the user writes. Pure TypeScript with no DOM or Node dependency (the CLI aside).
 *
 * Reading order: lognormal → layout → compose → planner → arm (+ tremor) → pressure → simulate →
 * protocol → perform; stats for measurement; persona for who is writing.
 * The model and its sources: docs/investigations/hand-simulator.md.
 */

export { simulate, strokeMs, type HandResult, type Point, type Stroke, type Flight, type SimulateInput, type SimulateOptions, type StrokeProfile, type Trace } from './simulate'
export { PERSONAS, persona, definePersona, hurried, mirror, archivist, sketcher, elder, mathematician, calligrapher, teacher } from './persona'
export type { Persona, LetterParams, MotorParams, ArmParams, TremorParams, PressureParams, TimingParams, UserStats } from './persona'
export { toProtocol, strokeMessages, dueAt, toJsonl, PAPER_PRO_MM, type HandMessage, type ProtocolOptions } from './protocol'
export { perform, type PerformOptions, type Performance } from './perform'
export { powerLaw, spectrum, peakFrequency, userStats, bounded, type PowerLawFit } from './stats'
export { compose, type Phrase, type Gesture, type WordInfo } from './compose'
export { GEOMETRY, JOINT_HZ, type ArmFrame } from './arm'
export { lognormal, lognormalCdf, timing, velocity, displacement, type Impulse } from './lognormal'
export { Rng } from './rng'
export type { Pt } from './layout'
