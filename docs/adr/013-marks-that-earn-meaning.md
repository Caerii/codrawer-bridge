# ADR 013: Marks that earn their meaning

Status: proposed (2026-10-06) · Owner: Alif · Related:

- ADR 003 (agent ink as a governed action), 008 (page model), 012 (delegation on paper: the
  built-in pen grammar, task cards, consent by pen);
- roadmap item 3; the vision page ("A mark does not arrive with a meaning. It earns one.",
  alifjakir.com/codrawer);
- `packages/marks`, `packages/delegate`, `packages/hand`, `apps/even-g2` (My marks),
  `docs/media/marks-*`.

## Context

People annotate paper with marks of their own: a star for "important", a bolt for "make this a
card", a little flag for "ask someone". ADR 012 gave codrawer a fixed grammar (circle, tick,
strike, arrow, initials) read against task cards. The roadmap asks for the other half: a
vocabulary the user invents, which the agent learns from them, and which can always be inspected,
refined or retracted.

Four things make this hard:

- **Few examples.** A user will draw a new glyph once, maybe three times, before expecting it to
  work.
- **Open set.** Most ink on a page is writing. A recogniser that maps every gesture to its nearest
  known mark fires on every letter.
- **Two vocabularies on one page.** A personal mark must never be confused with a built-in mark,
  and a circle must keep meaning what it meant yesterday.
- **Trust.** A mark that acts must be seen to have earned the right, and every action must be one
  the user could have taken another way, under the same governance.

## Decision

### 1. One recognition system, two vocabularies

Gestures are grouped by packages/delegate (`gestures`), and each one is routed (`marks/grammar.ts`):

1. **Built-ins first, and cards are theirs.** delegate's `interpret` reads the gesture against the
   task cards on the page; an answer is an answer (ADR 012). Ink *on* a card that answers nothing
   is not a personal mark either: cards are the broker's contract.
2. **Reserved shapes.** Off the cards, a round loop, a straight line and a cross are ordinary
   drawing; they, and the tick, can never be taught.
3. **Personal marks second.** Everything else goes to the personal recogniser.

A personal mark that the grammar would read as a built-in shape (a star is a "loop" to
delegate's rule; an arrow; a scribble) is *shadowed* on cards: the built-in wins there, and the
gallery says so.

Why a new package (`packages/marks`) and not a module of `packages/delegate`: delegate is the
broker's card-and-consent core, and its grammar is fixed by ADR 012. Marks add a learned,
per-person vocabulary with its own state (a registry, a teach flow, feedback). marks depends on
delegate for its gestures, geometry, shape classifier, card layout and DTW, so there is still one
recognition system; delegate does not depend on marks.

### 2. Few-shot, open-set recognition (`recognizer.ts`, `cloud.ts`, `context.ts`)

- **Shape: the $P point-cloud recogniser** (R.-D. Vatavu, L. Anthony, J. O. Wobbrock, ICMI
  2012), with **$Q**'s early abandoning (Vatavu, Anthony, Wobbrock, MobileHCI 2018). It works
  from one example and ignores stroke order and direction, which people do change when they redraw
  their own symbols. Clouds are resampled to 32 points, scaled uniformly and centred; rotation is
  searched within ±25° by golden section ($1: Wobbrock, Wilson, Li, UIST 2007), or the whole
  circle for an orientation-free mark.
- **Path: a second opinion.** DTW (delegate's) between the gesture's path and the winner's
  examples, at the rotation $P found, over every order and direction of its strokes. A word can
  scatter its points like a star while its path wanders quite differently.
- **Gates**: stroke count (one extra allowed, none fewer), size within ×1.6 of the examples
  (size is a gate, not a distance), aspect within ×1.9, and not *inline* (between the words of a
  line), unless the mark was taught inline.
- **Open-set thresholds per mark** in both representations: τ from one example, or 1.5× the
  largest leave-one-out distance among the examples, clamped. Two marks within threshold and
  within 15% of each other are *ambiguous*, never a guess.
- **Context**: zone (margins, body), relation to nearby ink (inline, adjoining, beside, over,
  near, alone), the side of the line in the writing direction, and the **target**, the ink the
  mark refers to (its line, or the nearest block), which is what the action acts on. Each mark
  keeps counts of the relations it was taught and accepted in, as a soft prior.
- **Negatives.** An invocation the user rejects or undoes keeps its ink as a negative of the mark;
  a gesture nearer a negative than every example is not the mark. Accepted uses add examples, up
  to five.

### 3. The teach flow (`teach.ts`, `engine.ts`)

- **Candidates** are unknown gestures that look deliberate (compact, 3–20 mm, ≤ 4 strokes, not
  inline) and either sit beside content, come back a second time, or were lasso-selected
  ("Teach a mark" on the dock or the phone).
- **Asked at most once, batched, in the medium.** At a lull (3 s of pen rest), at most one ask
  every 5 minutes (a lasso skips the wait), at most three glyphs per ask. On paper the ask is a
  delegate card ("this mark → ?") with the action vocabulary and "not a mark" as choices, so a
  pen answer is read by the built-in grammar. A declined, unanswered (15 min) or answered shape is
  remembered and never asked about again.
- **Earning silence** (`modeFor`): `confirm` (the action waits for an accept and lapses after
  2 minutes) for the first three accepted uses, after any change of meaning, for an unsure reading,
  and always for a consequential action; then `notify` (the action runs, with an undo for a
  minute; no answer counts as an accept); then `silent` once it has five accepts, a confidence of
  0.85 (the Beta(1,1) posterior of accept/reject) and at most one rejection among the last ten.
- **Refusals at teach time**: a built-in shape, or a look-alike of one of the owner's existing
  marks (with the way out: add it as an example, or retract the other).

### 4. The registry with lineage (`registry.ts`)

One JSON document (localStorage on the phone; any file elsewhere), versioned:

- each mark's examples (strokes resampled, at most 48 points each), negatives, meaning (action +
  parameters), rotation tolerance, owner, sharing, created and changed times;
- **lineage**: an append-only list of create, refine (meaning before and after), rename,
  add/remove example, add negative, retract, restore, share, unshare, adopt, each with who and
  when;
- every **invocation**: the meaning at the time, mode, confidence, shape distance, relation,
  strokes, the ink, and the verdict (accept, reject, undo, expired) with how it was given.

From these it computes **confidence**, **drift** (recent accepted uses farther from the examples
than early ones, by 1.4×; it suggests the occurrence to add) and **conflicts** (two visible marks
that look alike but mean different things: between collaborators, or one person's own).
JSON rather than SQLite because the registry runs on the phone and in Node alike; the desktop
broker can mirror it into ADR 012's `tasks.sqlite` when it lands.

**Ownership.** A mark recognises only its owner's ink. Sharing makes it visible; another
participant adopts a copy of their own, and the two then evolve separately. A collaborator's
meanings never change under you.

### 5. Actions are existing primitives (`actions.ts`)

| action | becomes |
| --- | --- |
| delegate to a pod | `task_create`, `trigger:"mark"` (ADR 012) |
| send to someone | `task_create` to the drafts pod at `act_with_consent`: the send still needs initials on its card |
| make a flashcard | `primer_request` `what:"flashcard"` (the Primer, feat/primer, schedules it; its learner model is a half-life regression, not FSRS, so the item carries no schedule of its own) |
| ask the agent | `term_prompt` `attach:"page"` with the target region |
| render LaTeX | `latex_recognize` (latex-on-tablet §5) |
| tag | the invocation is the record |
| replay from here | a client opens Thinking replay at the target's first stroke |

A mark never raises authority: it is a shortcut to a door that already exists, under that door's
rules. Protocol: `mark_seen`, `mark_ask`, `mark_define`, `mark_invoke`, `mark_feedback`,
`mark_query`, `marks` (docs/protocol.md, "Personal marks"); all three routers relay them.

### 6. Surfaces

- **Phone** (`apps/even-g2`): ⋯ → *My marks*: the gallery (examples, meaning, confidence, how it
  acts now, badges for shared, shadowed, drifting, conflict), a mark's page (examples, meaning
  editor, rename, share, retract or restore, the history of lineage and uses with accept/undo), and
  *Teach a mark…* on a 24 mm drawing pad (not the shared page, so teaching leaves no ink). The ask
  card and the quiet confirmations appear over the stage. The phone is the first recogniser host
  ("Watch my ink for marks", opt-in, so two phones never both act).
- **Paper**: the ask card in the agent's hand beside the mark (`askCard`), answered by pen.
- **Tablet dock** (once the XOVI extension's dock reads it): an entry
  `{"id":"mark_teach","label":"Teach a mark","kind":"selection"}` in `/run/codrawer/dock.json`.
- **Glasses**: the ask and the confirmations as glance lines (not built yet).

## Measured, on synthetic ink only

`pnpm --filter marks eval` (test/evaluate.ts): six invented glyphs (bolt, lemniscate, spiral,
star, asterisk, flag), each varied as a redrawn symbol (size, tilt, shear, jitter, stroke order
and direction) and written by five of packages/hand's personas; 240 positives per row, drawn
beside the end of a line of notes. Negatives: every word of five lines of the same persona's
writing, read in context (125); short words, letters and digits written alone beside a line,
exactly where a mark goes (180); and a held-out set of 36 more words written 1.3× larger (180),
added after the constants were set.

| examples | precision (with held-out) | recall | ambiguous | false accepts: words in a line | words beside a line | held-out words |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 99.6% (93.4%) | 93.8% | 1 | 0/125 | 0/180 | 15/180 (8.3%) |
| 3 | 100.0% (95.1%) | 97.5% | 1 | 0/125 | 0/180 | 12/180 (6.7%) |
| 5 | 100.0% (95.9%) | 97.9% | 0 | 0/125 | 0/180 | 10/180 (5.6%) |

After rejecting each held-out false accept once (3 examples), the same words written again: 4/180
(2.2%) false accepts, recall unchanged (97.5%).

What this does and does not show:

- The held-out words are the honest number. They are mostly cursive pairs ("on", "as", "ex")
  read as the lemniscate, and "b" and "F" read as the spiral and the flag. Those are close to the
  glyphs in both shape and path; no threshold separates them without losing the glyph. Negatives
  learned from one rejection remove most of them. A mark that looks like the user's own
  handwriting is a poor mark; the gallery should eventually warn at teach time by comparing a new
  glyph with the user's recent words (not built).
- The misses we inspected are mostly a glyph the simulated hand drew at about half size (the size
  gate refuses it). A mark taught once is at the mercy of that one example; accepted uses grow it
  to five.
- Everything is synthetic: the variation model is ours and the letters are Hershey's single-line
  fonts through a simulated arm. **Real-ink tuning is pending**: about twenty examples of a few
  invented marks per user on the Paper Pro, with a day of ordinary notes as negatives, recorded
  with the bridge and replayed through the engine.

The teach flow, lineage, ownership, built-ins-first routing, pen answers on the ask card, the
policy (confirm → notify → silent), retracting, consequential actions and negatives are tested in
`packages/marks/test` (teach, registry, recognizer).

## Consequences

- The user's own vocabulary becomes part of the notebook, with a visible history, and every
  action it takes is one the user could take another way.
- Built-in marks keep their meaning everywhere; a few natural glyphs (a plain circle, a tick, an
  underline, a cross) can never be personal marks.
- The phone carries recognition until the desktop broker exists; a phone that is not watching
  still teaches, edits and answers.
- A new message family on every router (relay only).
- **Open**: real-ink tuning; the glasses' glance lines; the teach-time look-alike warning against
  the user's handwriting; registry sync between a user's devices (today each device keeps its
  own, and `marks` snapshots carry shared marks); the broker-side host and the dock entry; how a
  `primer_request` flashcard is acknowledged by the Primer.
