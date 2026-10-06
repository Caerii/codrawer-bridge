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

### After the top three: delegation (ADR 012, proposed)

- **Delegation on paper.**
  - Lasso some ink and write `@research`. The pod's task card appears beside it, in the pod's
    hand, and shows discrete states: queued, working, needs you, done, failed.
  - The pod comes back with a summary, sources and its decisions drawn as choices.
  - You answer with the pen: circle to choose, strike to reject, an arrow between cards to chain.

  Details: `docs/investigations/delegation-on-paper.md` and `packages/delegate`.
- **Consent by pen.**
  - The broker hashes a consequential action and draws its code beside a consent box.
  - Your initials there authorise that action and nothing else. They count only from your own
    pen, and only after the question was drawn.
  - Initials are the intent, not the lock. When the stakes or the doubt are high, a ring or
    phone tap confirms the same code.
- **Attention budget.** Pods push to the glasses only when they need you, and only at a pause in
  your writing, at most a few times an hour. Everything else waits until you look.
- **Ink provenance.** Every answer, approval and read is audited with the stroke ids of the marks
  that made it. "Who approved this?" is answered by your own ink on the page.

## Later

- **Each agent has a hand.** Every pod and agent writes in its own persona (packages/hand), on
  its own layer. You can tell at a glance who wrote what on a page, as you would with colleagues.
- **Your paper as SIG's memory.** Within your scopes (ADR 011), notebooks become retrievable
  context for SIG's pods. Answers cite back to the page and stroke, and nothing is read beyond
  what you allowed.
- **Morning and evening pages.**
  - Each morning, a page is written in: what is waiting, what pods finished overnight, and the
    day's decisions as choices.
  - Each evening, another: what you delegated and what is still open.
  - You answer both with the pen.
- **Sketch an agent workflow.** Draw boxes for pods and arrows between them on paper. The drawing
  becomes a chained delegation (ADR 012's arrows, generalised) that runs and reports on the same
  page.
- **Sketch as program:** drawn graphs get real axes and fits; state machines run; circuits
  simulate; free-body diagrams animate. Answers come back as agent ink.
- **Search everything you have written:** a local handwriting index across notebooks, queried from
  the glasses or keyboard.
- **An ambient co-thinker on the glasses:** a small glyph when the agent has something, never an
  interruption.
- **The agent's own notebook:** reflections and open questions in its handwriting persona.
- **The codrawer MCP server** (ADR 003): any agent gets governed page read, agent ink and dock
  actions.
- **The hardware film** (`docs/demos/hardware-film-plan.md`).
