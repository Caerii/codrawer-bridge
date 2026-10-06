/**
 * marks: marks that earn their meaning (docs/adr/013-marks-that-earn-meaning.md).
 *
 * "A mark does not arrive with a meaning. It earns one." The user draws a glyph of their own; the
 * first time, the agent asks (once, batched, in the page's medium) what it means; after that the
 * mark acts, quietly confirmed at first and silently once it has earned trust, and its meaning can
 * always be inspected, refined or retracted. This package is the pure, testable core:
 *
 * - cloud: $P point clouds (Vatavu, Anthony, Wobbrock 2012) with $Q's early abandoning (2018) and
 *   bounded rotation search;
 * - context: where a gesture sits (zone, relation to the ink around it, side, target);
 * - recognizer: few-shot, open-set recognition with gates, per-mark thresholds, a DTW second
 *   opinion and a context prior;
 * - grammar: packages/delegate's built-in marks first, personal marks second, never confused;
 * - actions: the vocabulary, mapped onto existing primitives (task_create, primer_request,
 *   term_prompt, latex_recognize, tags, replay);
 * - registry: marks, examples, meanings, invocations, feedback, confidence and lineage;
 * - teach: candidates, the batched ask, and the confirm → notify → silent policy;
 * - engine: ink in, protocol messages out;
 * - protocol: the `mark_*` messages.
 *
 * No DOM, no Node APIs: it runs on the phone (apps/even-g2) and in the desktop tooling.
 */

export * from './cloud'
export * from './context'
export * from './recognizer'
export * from './grammar'
export * from './actions'
export * from './registry'
export * from './teach'
export * from './engine'
export * from './protocol'
