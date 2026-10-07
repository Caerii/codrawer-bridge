# The Ask experience: what would make it beautiful

Ask now works end to end on the Paper Pro (`docs/checkpoints/2026-10-07.md`). This note is about
the next level: making it feel right, not only work. It applies the vision on alifjakir.com/codrawer
(thoughtful computing, an agent that "does not talk over you while you are mid-thought") to
what the device taught us over two days of live use. Every proposal below is tied to something the
user said or that we measured.

## Principles

1. **The page is the interface; the agent is a guest in the margin.** Answers belong to what they
   answer: under it, aligned with it, at its scale. Nothing appears that the page could not have
   held. There are no windows, chips or bubbles; on the tablet, the only chrome is xochitl's own
   (the dock, the selection menu).
2. **One nib from thought to rest.** The doodle, the travel to the answer, the writing and the tick
   at the end are one continuous character, never a spinner that turns into text. Continuity is
   what made the user love the doodle ("I LOVED the thinking animation"), and every jump breaks
   it ("the agent spawns a little bit too much lower down", the doodle "jumping").
3. **The user's hand is sovereign.** The user's pen always wins, as both a safety rule and a
   design rule. The agent writes around the user, yields while they write, and can always be
   undone, struck out or forgotten. Every agent mark is on its own layer, in its own hand.
4. **Time is part of the medium.** Speed is beautiful when it reads as skill, not as a machine:
   hurried, slightly looser letters at 7–10 letters/s, pen-up flights compressed, not a video sped
   up (measured: past twice the hurry the letters break, so the rest of the speed comes from
   playback). Latency gets a presence (the doodle) within one frame of the tap.
5. **Calm, in e-ink terms.** Small refresh regions, no page flashes, no loops without an end:
   every ask ends visibly, with a hand-off, a tick or a short caption. Nothing animates when
   nothing is happening.
6. **Gestures over menus.** People already mark up paper: they strike things out, circle them,
   put a "?" in the margin, draw an arrow. Those marks should be the controls.
7. **Memory you can see and forget.** A page is a conversation. The thread is visible (on the
   phone, and as a dock row on the tablet), local, and forgettable with one tap.

## Placement and motion (in progress)

The doodle jumped because two systems each chose a spot. The tablet guessed at the tap, and agentd
computed its own a few seconds later from the ink bottom.

- **The tablet proposes, agentd confirms.** `ask_*` carries `spot` (and `ink` when the extension
  can read the selected ink's own bounds). agentd keeps the spot whenever the block fits there,
  so in the common case the doodle never moves.
- **When it must move, the move is a gesture.** The nib starts "considering" at the selection's
  bottom-left. If the answer needs to go elsewhere, it travels there once, in an arc at hand
  speed (300–500 ms, lognormal velocity), and keeps doodling. Corrections under 20 page units are
  ignored.
- **Off screen:** the nib waits at the nearest screen edge with a small directional cue and goes
  to the spot when the user scrolls there.

## Typography of answers

- **Rest on the paper's own grid.** On lined templates, baselines should sit on the ruling (the
  pitch is known per template); compact spacing becomes "one ruled line per line".
- **Margin notes.** A short answer (one line, or a correction) goes beside the selection, in the
  margin, at a smaller size, like an annotation.
- **Wrap around ink, not boxes.** Placement is rectangular today; a block could flow around
  existing ink the way text flows around a figure.
- **Math in the hand.** Fractions, exponents, sums and integrals written as a mathematician
  writes them (the hand already has a Mathematician persona). This is essential for the Primer
  and the Putnam (ADR 010).
- **Formats beyond prose:**
  - a short list;
  - a quick sketch or diagram;
  - teacher markup on the user's own ink (underline, circle, a caret where something is missing),
    on its own layer, in red (ADR 010's teacher markup).

## Gestures on answers

| mark | meaning |
|---|---|
| strike through an agent answer | dismiss it (removed from the agent layer; the strike stroke goes too) |
| circle part of an answer | ask a follow-up about that part |
| "?" in the margin next to the user's ink | ask about it, without the lasso |
| arrow from an answer to elsewhere | "move it there" |
| tick on an answer | "useful"; feeds the page thread and the learner model |

agentd already sees the user's live strokes and the page snapshot, so recognition belongs there,
next to the personal marks recogniser (`packages/marks`, ADR 013). Removing native strokes needs
an extension op that erases a set of the agent layer's strokes; it must be designed with the same
care as the commit chain.

## Presence and continuity

- **The nib at rest.** When an agent is attending (agentd connected), a tiny nib could rest in the
  page's top margin, like a pen laid on the desk. It would show presence without a status light;
  it is absent when nothing is listening. (This needs care: it must not be noise.)
- **History.** A dock row "Recent asks" lists this notebook's asks; tapping one takes you there
  ("take me there" already exists: `goto`).
- **Citations that travel.** When an answer refers to a book page or an earlier page, a small
  mark beside it opens that place on tap.
- **A voice per notebook.** A Socratic tutor in the Putnam notebook (hints, not solutions), a
  brainstorming partner in a sketchbook, a terse proofreader in a draft. This is chosen once per
  notebook from the dock, and the persona's hand matches its voice.
- **Glasses as a glance.** "Thinking…" and then the first line of the answer, for when the
  tablet is face down or across the desk.

## Reliability is part of beauty

A beautiful thing that sometimes does nothing feels broken. agentd should:

- start as a service with the PC;
- reconnect quietly;
- show a health row in the dock ("responder: online · Sonnet");
- end every ask visibly.

A nightly on-device regression (inktest, pentest, one Ask round trip on the test notebook)
catches breakage before the user does.

## Measures of success

- **Doodle:** within one frame of the tap, and zero visible jumps in the common case.
- **First stroke:** ≤ 3 s after the tap.
- **Writing speed:** 7–10 letters/s, with no broken letters.
- **Commits:**
  - no user stroke ever misfiled;
  - no pen ever blocked;
  - a commit window ≤ 50 ms.
- **Endings:** every ask ends visibly.
- **The learner:** her proofs get read correctly (SEEN), and her ticks outnumber her strikes.
