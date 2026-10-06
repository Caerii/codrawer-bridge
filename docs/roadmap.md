# Roadmap

What codrawer is building next, and why. Decisions live in `docs/adr/`; device research in
`docs/investigations/`. The guiding idea is the one on alifjakir.com/codrawer: thoughtful
computing, where the agent is a co-thinker that works in the page's own medium and "does not talk
over you while you are mid-thought".

## Now

These are in progress or landing (October 2026):

- **Native agent ink on the tablet.** Strokes commit as real reMarkable ink on their own layer
  (Probe 1 passed: render, save, undo). Next: placement through the view transform, bridge
  forwarding of ai-layer strokes, call and response (`docs/investigations/native-multiplayer-layer.md`).
- **The tablet dock and lasso action.** A toolbar button injected at runtime by the XOVI extension
  opens a dock of agents; the lasso menu gets "Ask agent".
- **Direct text insertion.** Replies go into the focused text box through the extension, not key
  by key (fixes the characters xochitl drops when typed: `^ [ ] { } \` ~`).
- **The Primer** (ADR 010): handwritten proofs recognised and re-rendered as LaTeX, a learner model
  and a practice coach, for a learner preparing for the Putnam (December 5, 2026; four 90-minute
  sessions of three problems).
- **Handwriting personas** (`packages/hand`): agent ink written by a biomechanical hand.
- **Portable sessions** over Tailscale (the tablet is on the tailnet; ADR 009).
- **Research:** LaTeX on the tablet, keyboard and text design, smart_remarkable integration.

## Next: the top three

Chosen 2026-10-06.

### 1. Putnam mock-exam mode

A proctored rehearsal of the real format, built on the Primer:

- Four 90-minute sessions of three problems with the real break pattern (15 min, about 1 h 45, 15 min).
- A quiet session timer on the glasses.
- Problems handwritten onto fresh pages at each session's start (agent ink, a chosen persona).
- Write-ups collected and graded the next morning: 0–10 per problem, labelled as an estimate,
  with feedback on rigour and exposition.
- A "problem of the day" written in each morning between mocks.
- Mocks on fixed Saturdays before December 5; the learner model plans the weeks between.

Why first: a real learner with a real deadline, and every piece (Primer, native ink, hand, dock)
already exists or is landing.

### 2. Thinking replay

Every stroke carries a timestamp, so any page can be scrubbed like a video: "show me how I got
here".

- A scrubber on the phone stage and, later, on the tablet (dock entry).
- Pauses, erasures and rewrites are marked on the timeline (the Primer's ink signals).
- For practice, replay an attempt at a problem to see where the learner hesitated or changed
  direction, which is better feedback than the final write-up alone.
- Builds on the timelapse export and session recordings, which already exist.

### 3. Marks that earn their meaning

A personal mark vocabulary, as described on the vision page ("A mark does not arrive with a
meaning. It earns one.").

- The user draws a personal glyph. The first time, the agent asks what it means; after that it
  acts on it, and the meaning can be inspected, refined or retracted.
- Marks are recognised from stroke shape and context. Each meaning has a lineage (its edit history)
  so drift and conflicts between collaborators can be seen.
- Actions come from the dock's vocabulary (send to someone, make a flashcard, ask the agent,
  render LaTeX, …).

## Later

- **Sketch as program:** drawn graphs get real axes and fits; state machines run; circuits
  simulate; free-body diagrams animate. Answers come back as agent ink.
- **Search everything you have written:** a local handwriting index across notebooks, queried from
  the glasses or keyboard. Designed with the book library, citations, consent and the context graph in ADR 011
  (proposed) and `docs/investigations/grounded-context.md`.
- **An ambient co-thinker on the glasses:** a small glyph when the agent has something, never an
  interruption.
- **The agent's own notebook:** reflections and open questions in its handwriting persona.
- **The codrawer MCP server** (ADR 003): any agent gets governed page read, agent ink and dock
  actions.
- **The hardware film** (`docs/demos/hardware-film-plan.md`).
