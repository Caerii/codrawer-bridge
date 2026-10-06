"""
The Primer: a tutor for handwritten mathematical proof, with a learner model and a task model.

Named for Nell's *Young Lady's Illustrated Primer* in Neal Stephenson's *The Diamond Age*: a book
that watches the child, knows what she knows, and answers in its own pages. Here the pages are a
reMarkable tablet's: the learner writes a proof by hand, and the Primer reads it, re-renders it as
LaTeX, understands its structure, tracks what she knows and misunderstands, and responds in the
page's own medium, without talking over her while she is mid-thought. ADR 010
(``docs/adr/010-learner-and-task-models-the-primer.md``) records the design and its reasons.

Reading order:

- ``concepts``: the task model's vocabulary: the concept graph and the misconception catalog.
- ``proofdoc``: a proof as typed data, the shape every stage shares.
- ``ink_signals``: the stroke log, line segmentation, hesitation features, the lull detector.
- ``recognize``: ink to ProofDoc (render + Claude; offline fixtures without a key).
- ``assess``: findings, step statuses, a Putnam-style grade estimate.
- ``check``: the optional Lean/Rocq run.
- ``learner``: Bayesian Knowledge Tracing, misconceptions, evidence, spaced review, the file.
- ``practice``: the problem bank, timed sessions, the queue, the plan.
- ``policy``: the next move: silence, a Socratic question, a hint, a worked example, a debrief.
- ``coach``: the background practice coach: attempts, weaknesses, suggestions, dock entries.
- ``latex``: the proof as a ``.tex`` document.
- ``agent``: one session's Primer, from protocol messages in to ``primer`` messages out.
- ``__main__``: the command line (a recording, or ``live`` against a router).
"""
