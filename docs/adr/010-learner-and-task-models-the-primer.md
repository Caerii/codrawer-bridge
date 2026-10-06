# ADR 010 — Learner and task models: the Primer

Status: proposed (2026-10-06) · Owner: Alif / SIG platform · Related: ADR 001 (the turn), ADR 002
(drawings reach the model as images), ADR 003 (agent ink is governed), ADR 006 (latency per
surface), ADR 008 (the page model), ADR 009 (call and response, the dock), `docs/protocol.md`
(`primer`, `primer_request`, `dock_entries`), `docs/roadmap.md` (Putnam mock-exam mode)

## Context

In Neal Stephenson's *The Diamond Age*, Nell's *Young Lady's Illustrated Primer* is a book that
watches its reader, knows what she knows, and answers her in its own pages. codrawer already has
most of what such a thing needs: pen strokes with millisecond timestamps from the tablet, the
tablet's saved page with exact tools, a phone stage and glasses that render the same session, a
desktop router that can call models, agent ink on its own layer that can now be committed onto
the reMarkable page itself (ADR 009), a biomechanical handwriting simulator for that ink
(`packages/hand`), and a toolbar dock on the tablet that sends `dock_action`.

What it lacks is a model of the *task* (what the learner is trying to do, broken into steps and
ideas) and of the *learner* (what she knows, what she gets wrong, what is fading), and a policy
that turns both into a response that helps without taking over. The vision
(alifjakir.com/codrawer) sets the tone: thoughtful computing, an AI co-thinker that "does not talk
over you while you are mid-thought", stroke timing and pauses as signal, AI ink on its own layer.

**The first learner** is preparing for the 87th William Lowell Putnam Mathematical Competition on
Saturday 5 December 2026, two months away, and wants to learn proofs deeply and quickly. From
this exam on, the Putnam is **four 90-minute sessions of three problems**, twelve problems scored
0–10 each (120 points), held synchronously across time zones (Eastern 11:00–12:30, 12:45–14:15,
16:00–17:30, 17:45–19:15) with designated breaks and no leaving mid-session; it was two
three-hour sessions of six. MAA made the change for exam security against AI (maa.org/putnam;
local announcements such as math.gatech.edu/putnam-competition). She uses the household's Even
account and tablet, so a device does not identify a learner.

The first domain is formal mathematical proof: onboarding with the classics (√2 is irrational;
1 + 3 + ⋯ + (2n−1) = n² by induction), building toward Putnam-level problem solving.

## Decision

### 1. One vocabulary for both models (`primer/concepts.py`)

The task model and the learner model share a fixed vocabulary, written down in code so tests can
check it and every turn's evidence lands on the same entries:

- **A concept graph** of about seventy concepts with prerequisites (a DAG, checked by
  `check_graph`): logic and proof (implication versus equivalence, converse and inverse,
  quantifiers and their order, negation, direct proof, contrapositive, contradiction, cases,
  counterexamples, WLOG), techniques (induction, strong and structural induction, well-ordering
  and descent, pigeonhole, invariants and monovariants, the extremal principle, parity and
  colouring), number theory (divisibility, primes, gcd and Bézout, Euclid's lemma, rationals in
  lowest terms, modular arithmetic, Fermat/Euler, orders, CRT, Diophantine equations),
  inequalities (AM-GM, Cauchy-Schwarz, Jensen, rearrangement, equality cases), polynomials
  (roots, Vieta, irreducibility, interpolation), combinatorics (bijections, double counting,
  inclusion-exclusion, recurrences, generating functions, graphs), linear algebra (determinants,
  rank, eigenvalues, determinants mod p), analysis (ε-δ limits, continuity and IVT, MVT,
  integrals, sequences, series), probability (linearity of expectation, geometric probability),
  functional equations (Cauchy's equation) and complex numbers (roots of unity, geometry).
- **A misconception catalog** of first-class entries in three kinds, because Putnam graders
  punish all three: `misconception` (a wrong belief: assumes the conclusion, converse confusion,
  quantifier swap, examples as proof, a wrong negation, an inequality multiplied by a quantity of
  unknown sign), `missing_rigor` (a true claim used without its proof or a hypothesis never
  stated: lowest terms never assumed in the √2 proof, "p² even ⇒ p even" asserted, an induction
  step that does not use the hypothesis, a missing base case, pigeonhole without named boxes,
  non-exhaustive cases, theorem hypotheses unchecked, a limit moved inside a sum, termination
  without a monovariant, a bijection not shown to be one, a functional-equation candidate never
  checked) and `exposition` (undefined variables, no stated conclusion, unjustified steps). Each
  entry carries the concepts it is evidence against, a severity as a grader would see it
  (fatal / major / minor), a Socratic probe and a hint ladder.
- **A proof as data** (`primer/proofdoc.py`, the ProofDoc): title, goal in LaTeX, main technique,
  and steps (LaTeX, plain reading, the learner's justification, references to earlier steps,
  concept ids, recognition confidence, the handwriting lines it came from and so its stroke ids
  and bounds), then findings, a grade estimate and a formal check. A fixture file, a model's
  structured output and the wire message are the same document.

### 2. The learner model, local-first (`primer/learner.py`)

**Mastery is Bayesian Knowledge Tracing** (Corbett & Anderson 1995) per concept, with parameters
chosen and bounded as the literature advises:

| Parameter | Value | Why |
| --- | --- | --- |
| P(L₀) prior | 0.35 / 0.20 / 0.12 / 0.08 by concept level 1–4 | fitted priors usually sit in 0.1–0.4; a Putnam candidate knows first-proof material; per-student priors (Pardos & Heffernan 2010) once there is data |
| P(T) learning | 0.12 | inside the 0.05–0.3 band fitted values fall in |
| P(G) guess | 0.12 | a sound proof step is hard to produce by luck; Corbett & Anderson bounded guess at 0.3 |
| P(S) slip | 0.10 | their bound; Baker, Corbett & Aleven (2008) show unbounded fits degenerate |

A proof step is not right-or-wrong, so evidence is soft: credit 1 (`ok`), 0.5 (`gap`), 0
(`error`) mixes the correct and incorrect posteriors (in the spirit of partial-credit BKT, Wang &
Heffernan 2013), the learning transition follows, and the recognizer's confidence weights the
update so an illegible step barely moves the model. Each hint rung used costs a quarter of the
credit; a hesitant line (§3) scales credit by 1 − 0.3·hesitation. Those two discounts are
hand-set and are the first parameters to fit from her data.

**Misconceptions** are counted per learner with the turn last seen and a clean streak: two
proofs in a row that exercise the entry's concepts without it mark it "not recurring".

**Evidence events** are logged per turn (concept, raw and effective credit, weight, mastery
before and after, step, problem, hints, hesitation, finding), so the learner or a parent can see
why the model believes what it believes.

**Spaced review** is a half-life model (Settles & Meeder 2016): predicted recall 2^(−Δ/h); a
success doubles the half-life, a failure halves it; a concept is due when recall falls under 0.5,
or under 0.7 while mastery is still shaky. The spacing effect is among the most robust results in
learning science (Cepeda et al. 2006).

**Ink signals** (`primer/ink_signals.py`) come from the strokes the tablet already sends: the
pause before each handwriting line relative to the writer's ordinary line break and in absolute
terms, stalls inside a line, writing speed against her median, erasures (the eraser's path over
the line's band), removed strokes, rewrites after an erasure, and crossings-out (long straight
strokes over ink, a heuristic that underlines can trip). They combine into a 0..1 hesitation per
line. Writing research reads pauses as planning and difficulty (Alamargot et al. 2006; Wengelin
2006) and pen interfaces as a window on cognitive load (Oviatt 2006); the weights here are
starting values, not results from that literature, and say so in the code.

**Identity and privacy.** A learner is a person with a chosen name, not a device: the app's
Learner tab sets it and every request carries it. Her model is one JSON file,
`~/.codrawer/primer/learners/<name>.json` (or under `$CODRAWER_STATE_DIR`), on the desktop,
outside any repository. It is hers: readable, copyable, deletable from the panel ("Delete my
learner file…", `primer_request` `forget`) or the CLI (`learner NAME --forget`). Nothing reads it
but the Primer on that desktop, and nothing in it is sent anywhere. What one live reading sends
to the model:

| Sent | Not sent |
| --- | --- |
| a PNG of the user ink on this page (or the lasso's part), rendered from strokes, cropped, with line labels | the learner's name or file, mastery, misconceptions, attempt log |
| the number of labelled lines | earlier turns, other pages, reading history |
| the problem statement when the coach assigned a known bank problem | the document's title, the agent layer, other participants' ink |
| the fixed catalogs of concept and misconception ids | timestamps or ink signals |

### 3. Recognition: handwriting → structured proof → LaTeX (`primer/recognize.py`)

- **Render, then read.** The page's user ink is rendered from the stroke store (ADR 002's rule:
  never a screenshot), cropped to the ink, at most 1568 px on the long side, with each
  handwriting line labelled `L1`, `L2`… in a margin. A Claude model reads it through the Anthropic
  Python SDK with structured outputs (a JSON schema whose concept and misconception fields are
  enums of the catalog ids) and returns the ProofDoc: steps with LaTeX, the reasons given,
  references, technique, per-step confidence and the lines each step came from (so the panel can
  highlight its strokes), plus findings, a grade estimate and, for short elementary proofs, a
  Lean 4 formalization of *her* steps. The instruction is to transcribe faithfully and never fix
  the proof. The model is `CODRAWER_PRIMER_MODEL` (default `claude-opus-5-5`; a cheaper model is
  a one-variable change) at effort `CODRAWER_PRIMER_EFFORT` (default `high`), with the
  server-side refusal fallback on; the key comes from `ANTHROPIC_API_KEY` through the SDK and is
  never logged.
- **Offline mode.** With no key the pipeline runs on fixture transcriptions: ink whose stroke ids
  match a fixture recording (Jaccard ≥ 0.6) gets that fixture's hand-written ProofDoc; other ink
  gets an honest "cannot read new handwriting offline" (`move.kind` `notice`), never a guess.
  Every message says `mode: live | offline`, and the panel shows it.
- **The formal check** (`primer/check.py`) runs a formalization through a local prover when one is
  installed (`lean`, or `rocq`/`coqc`; nothing is installed for the user). `checked` only after a
  prover run succeeded on a file without `sorry`/`admit`/`axiom`; `failed` with the first error
  mapped to the learner's step (formalizations mark steps with `-- step N`); `not_checked`
  otherwise. It checks the formalization, and says where that came from (fixture or model); the
  fidelity of a model's formalization to her steps is a separate question the panel does not
  paper over. The iPad's Rocq pane is an editor without a prover process, so checks run on the
  desktop.
- **LaTeX** (`primer/latex.py`): her steps, in her order, with her reasons, typeset as an
  `article` (claim, then a numbered proof), and the Primer's notes in a separate section labelled
  as such. Plain text is escaped and the Unicode a transcription contains becomes math macros, so
  it compiles under pdfLaTeX, XeLaTeX or Tectonic; compiled when one is installed, else the
  panel's KaTeX rendering is the rendering.

### 4. Assessment like a Putnam grader, labelled as an estimate (`primer/assess.py`)

Each Putnam problem is scored out of 10, and graders are widely reported to award mostly 0, 1,
2, 8, 9 or 10: a complete, rigorous solution earns 10, a complete one with a minor flaw 8–9,
substantial progress without a complete argument 1–2, and middle scores are rare. The Primer
follows that spirit: a fatal finding caps a write-up at partial credit (1–2 by how much of the
argument stands); one major gap gives 8; two or more fall to partial credit; minor gaps cost a
point each down to 8. Feedback separates **rigor** (what a grader would mark) from **exposition**
(whether a grader could follow it). Every grade carries `estimate: true`, and every surface says
"estimate": neither a rule set nor a model call is a Putnam grader. Live readings take the
model's findings (validated against the catalog) and grade; offline, a small rule set covers the
onboarding proofs and the generic exposition checks, and marks its findings "offline rule".

### 5. The Primer's policy (`primer/policy.py`)

The Primer chooses one move per reading:

1. **Silence** while she is mid-thought. A lull detector adapts to the writer (three times the
   90th percentile of her recent gaps between strokes, clamped to 4–15 s); while the pen is down
   or she paused only briefly, an automatic reading sends nothing. Asking (the panel, `/proof`,
   `/hint`, the dock) always gets an answer.
2. **A Socratic question** about the most serious finding (fatal before major before minor;
   wrong beliefs before missing rigor before exposition), asked at the step where the gap bites:
   for the flawed √2 proof, "You end with p and q both even. Why is that a contradiction? What
   did you assume about p and q at the start?" Questions that make the learner find the gap
   protect the productive struggle that drives learning (Kapur 2008).
3. **A hint ladder** only when she asks, one rung at a time, each more specific (contingent
   tutoring: Wood, Bruner & Ross 1976; Wood & Middleton 1975). The one exception: a misconception
   seen three or more times with mastery under 0.3 starts at the first rung, since novices learn
   more from guidance (the expertise-reversal effect, Kalyuga et al. 2003).
4. **A worked example** after the last rung, if she asks again, on a *different* problem (the
   lowest-terms move shown on √3). **The Primer never hands over her solution unprompted.**
5. **Affirm or debrief** a sound proof: the technique, the key idea, why it worked, a line about
   a step she hesitated over but got right, and an entry in her technique notebook.

Every move has a one-line `glance` (≤ 48 characters) that the glasses show. A narrative persona
is optional and later: the Primer's voice and, when it writes by hand, a `packages/hand` persona,
or characters from the showcase. A **teacher or parent view** is the same data seen read-only:
today the Learner and Coach tabs and the learner file itself; next, a guardian page that lists
attempts, findings and the reasons behind every suggestion, with the learner's consent.

### 6. The practice loop for the 2026 format (`primer/practice.py`)

- **Timed sessions** of 90 minutes and three problems; a **full mock** is four sessions with the
  real breaks (15 min, about 1 h 45, 15 min). Full mocks fall on fixed Saturdays two weeks apart
  ending a week before the exam: 24 October, 7 November, 21 November 2026; the last week tapers.
- **Triage is trained.** With 30 minutes per problem on average the Primer nudges, only at
  lulls: read all three in the first minutes and start with the most tractable; around the half
  hour, decide whether the current problem is converging or whether to write up partial progress
  and switch; keep the last ten minutes for writing up, because rigorous partial work scores.
- **The queue** (each pick with its reason): problems tied to the section she was just reading;
  spaced review of fading concepts; weak spots (the concepts behind recurring misconceptions,
  on a fresh problem with the same idea); then stretch problems whose predicted success is about
  0.35–0.75, at the edge of her ability (cf. Wilson et al. 2019 on moderate error rates).
- **Problem sources.** The bank is classic folklore problems in our own words, with no
  competition solution text bundled. Past Putnam problems are stored by reference only
  (`Putnam 1995 B1`) with a pointer to Kiran Kedlaya's archive (kskedlaya.org/putnam-archive);
  their concepts are tagged from her own debriefs. Their A1–A6/B1–B6 labels place them on the
  *old* two-session ladder. How difficulty will be spread within a new three-problem session is
  not known from past data, so practice sessions mix difficulties in shuffled order and assume no
  ladder.
- **The technique notebook** grows from her solved problems: technique, key idea, why it worked.
- **The plan** runs week by week from today to the exam: focus areas (logic and techniques, number
  theory, inequalities and polynomials, combinatorics, linear algebra and complex numbers,
  analysis, probability and functional equations, then her weakest areas), twelve problems a week
  (four timed sessions), review of earlier areas whose evidenced mastery is low, the mocks, and a
  light final week. It is rebuilt from the learner model on every reading and shown in the
  panel's Plan tab.

### 7. The practice coach: deliberate practice that happens to you (`primer/coach.py`)

Most people doing problems are not practising deliberately: they choose problems they can already
do, skip the debrief, and repeat errors without noticing. Deliberate practice needs work at the
edge of ability, immediate feedback, attention to specific weaknesses and spaced repetition
(Ericsson, Krampe & Tesch-Römer 1993). The coach is a background agent that supplies that
structure in short nudges, never lectures:

- **Consent first.** It observes nothing until the learner turns it on (panel: Coach tab,
  "Start watching"; `primer_request` `coach_on`); it can be paused at any time. While it watches,
  its dock entry reads "Practice coach · watching" and the panel's Coach tab shows a dot.
- **Reading position.** The bridge's `page` messages carry the open document's id, page id and
  title (PDFs and EPUBs on the reMarkable are documents too); the coach records when she was on
  which page of which book, and ties problems to what she was just reading (by the title's words
  today; by section once the page watcher reports page indices, below).
- **The attempt log**: problem, minutes the pen was on it, hints, the steps that went wrong, the
  score estimate, misconceptions, the reading position she came from. Re-reading a problem within
  30 minutes updates the same attempt. She can annotate or delete entries.
- **Weaknesses across attempts**: low mastery with repeated evidence, and recurring
  misconceptions, each with its evidence count.
- **Suggestions with a "why"** on every one (the queue above), and one nudge after an attempt:
  a recurring error named; ten minutes alone before the first hint; go harder after a quick 8+;
  write up partial progress after a long attempt.
- **Problems on the page.** From the dock's "Practice coach", the next problem is written onto
  the page as agent ink on the `ai` layer by a `packages/hand` persona (the mathematician),
  falling back to the Hershey font, else text on the phone and glasses. With native agent ink on
  (ADR 009) it lands in her notebook on codrawer's own layer, undoable like her own ink.
- **SIG learns over time.** The coach's memory is the learner file plus the attempt log; its
  suggestions improve as evidence accumulates, and it can always show its reasons.

### 8. Entry points and the wire (`docs/protocol.md`)

- `primer_request` from the phone's Proof panel (`proof` with an optional confidence, `hint`,
  `grade`, `plan`, `forget`, the coach, mock, review, goals, consent, dispute and report requests:
  `docs/protocol.md`); keyboard lines `/proof`, `/hint`, `/grade`, `/coach`, `/review`, `/sure N`,
  `/mock start`, `/p N`; the tablet dock's `dock_action` `practice_coach`, `ask_page`,
  `ask_selection`, `grade_page`, `grade_selection` and `my_progress` (ADR 009 §4; the lasso's
  `bbox` arrives in xochitl's scene units and is normalized).
- The Primer answers with one `primer` message per reading: the proof (steps with stroke ids and
  bounds, the `.tex`, the check), findings, the grade estimate, the move, the learner summary, the
  plan and the coach view. It announces its dock entries with `dock_entries` (and on
  `dock_query`); the tablet bridge writing them into `/run/codrawer/dock.json` is the native
  side's next step, and until then the extension's built-in list carries the same ids.
- **Where it runs.** Inside the desktop router (`CODRAWER_PRIMER=1`, fed through a queue so the
  socket loop never waits on a model call), or joined to any router as a client
  (`python -m codrawer_bridge.primer live --ws …`). The Go and Rust routers relay `primer`,
  `primer_request` and the dock messages as they are.

### 9. Output in the medium

- **The Proof panel** on the phone stage (⋯ → Proof panel, or `?panel=proof`): her proof typeset
  with KaTeX (lazy-loaded), each step's status and the Primer's note; tapping a step highlights its
  strokes on the page; findings, the score estimate, the check's honest status, the move; tabs for
  the plan, the coach and the learner.
- **The glasses** show the move's one line.
- **The `.tex` document** downloads from the panel and is written by the CLI (`--out`, `--pdf`).
- **Handwritten replies** are ADR 009's call and response: the move's text written by a
  `packages/hand` persona onto the page, on the agent layer. Agent ink never touches her layer.

### 10. The teacher's markup (`primer/markup.py`)

The first learner asked for feedback that looks like a teacher marking up her page. So grading
can end in red pen on her own ink, as another layer:

- **Vocabulary.** From the assessed proof: a **caret** where a missing assumption belongs (the
  gap opens there), a **circle** with a **"?"** around the claim where it bites (on a long line the
  circle hugs its last words, as a teacher circles a word, not a paragraph), a **strike-through**
  across a step that rests on a wrong belief, an **underline** under a minor gap, **ticks** on the
  key steps that stand (the ones later steps cite most), a short **comment** in free margin space
  with an **arrow** when it is not beside its step, the **score** circled in the top corner with
  "est.", and a one-line **summary** under the proof ("Good idea; why is 'both even' a
  contradiction?"). Unreadable steps get "can't read: rewrite?", never a guess.
- **Pedagogy.** Comments are at most eight words and point ("lowest terms?", "why? justify p² even
  ⇒ p even"), never write the fix: the hint ladder's first rung (§5). The fix comes only if she
  asks.
- **Placement.** Every comment, "?", tick and the score lands on free paper: the page's user stroke
  boxes (and marks already placed) are occupied; candidates are beside the step, the left margin,
  the gap just above or below its line nearest the anchor, then the nearest free spot on the page.
  Tested on the fixtures: no text mark over her ink or another text mark.
- **Looks.** Red (#d03030), fineliner, written by a new **Teacher** persona in `packages/hand`
  (quick, confident, slightly slanted print; its parameters live in the persona data). Letters go
  through the simulated hand (one batch run, `scripts/dev/hand_batch.ts`); circles, strikes and
  ticks are timed by the Primer as a quick pen (the simulated arm smooths a line-sized loop into a
  blob). The strokes carry real timestamps and are performed at that pace, pausing while her pen is
  down.
- **Layer.** Agent ink on the `ai` layer with `author: "primer:teacher"` and `ink_layer: "codrawer:
  teacher"`: the named native layer a tablet with native agent ink commits them to (ADR 009), so
  they hide and undo as one layer there; on the phone the panel's "Hide marks" hides them by
  author, "Remove marks" takes them back for everyone (`stroke_delete`), and the stage draws them
  even with the AI layer off (they are feedback she asked for).
- **Triggers.** The dock's "Grade this page" and "Grade selection" (`grade_page`,
  `grade_selection`), `/grade`, the panel's "Mark it up", and a mock's write-ups: graded the next
  morning, their marks are put on when each write-up's page is on screen.
- **Phone parity.** The `markup` block lists every mark with its short text, the long explanation
  and the step's LaTeX; tapping a mark (on the page or in the list) picks out its strokes and opens
  the long version. The tablet carries the short version; the phone the long one.

### 11. Putnam mock-exam mode (`primer/mock.py`; the roadmap's first item)

- Four 90-minute sessions of three problems with the exam's breaks (15 min, 1 h 45, 15 min) on the
  wall clock, persisted so a restarted router resumes. Problems are drawn per session (one she
  should finish, one at her edge, one beyond, shuffled) or given.
- At each session's start the problems go out as text (panel and glasses) and, with
  `CODRAWER_PRIMER_INK=1` (set when the tablet runs native agent ink), as `packages/hand` ink once
  she is on a fresh page (the Primer asks her to turn the page if the current one has ink).
- Ink during a session is collected per problem (`/p 2` or the panel picks the problem being
  written) and per page; ink during breaks is not. The Primer does not tutor while a mock runs.
- The glasses show a quiet countdown ("Mock S2/4 · 47 min · P1"), updated at most once a minute
  (ADR 006); the app counts down from the phase's end time, so the Primer sends only phase changes.
- Write-ups are graded at 06:00 the next day (or on request): 0–10 each, labelled as estimates,
  rigour and exposition, out of 120, fed to the learner model, the attempt log and the teacher's
  markup. Mocks sit on the plan's fixed Saturdays (24 Oct, 7 Nov, 21 Nov), and a problem of the day
  (the same all day, from the top of her queue) fills the days between; the dock's "Practice
  coach" writes it onto the page.
- LaTeX goes to the phone panel, never typed into a tablet text box: xochitl's text boxes drop
  `[ ] { } ^ \ ~` when typed (the keyboard study, `docs/investigations/`), so the tablet carries
  ink and the phone carries typeset mathematics, unless the native `text_insert` path is used.

### 12. Two layers of memory: mastery (BKT) and items (FSRS) (`primer/fsrs.py`)

BKT (§2) estimates whether she *knows* a concept. It does not say whether she will *recall* it on
the day. Memory is item by item, so a second layer schedules **items**: techniques ("when to use
the extremal principle"), key lemmas, her own past mistakes (the error journal), and problems to
re-attempt. Each item has the FSRS memory state (Ye, Su & Cao 2022; Su et al. 2023; the
open-spaced-repetition project): retrievability R = (1 + 19/81 · t/S)^−0.5, stability S in days,
difficulty D in 1..10, updated from a rating 1 Again … 4 Easy with the 17 FSRS-4.5 default weights
until her own review log is long enough to fit them. FSRS replaces the half-life model for any
concept that has items.

How the layers interact:

- **Up:** a review is BKT evidence on the item's concepts at half weight (recall is not a proof):
  Good/Easy credit 1, Hard 0.5, Again 0.
- **Down:** BKT gates FSRS: an item is scheduled for recall only once its concepts' mastery is at
  least 0.3; below that the policy teaches (worked examples, hints) instead of testing recall.
- **Ratings come from the medium:** a re-attempt read by the Primer (error → Again; a gap, hints
  or marked hesitation → Hard; fluent and quick → Easy; else Good), or her own rating of a quick
  recall on the phone or glasses.
- **Items are created by her work:** a finding creates a mistake item (seen again: a lapse; a clean
  proof on its concepts: a success), a graded problem a re-attempt item, a complete proof a "when
  would you reach for this?" technique item.
- **Reviews happen in the medium:** the prompt or the problem written onto a fresh page as agent
  ink, or a quick recall line on the glasses, rated with one tap.

### 13. Metacognition (`primer/metacog.py`)

Knowing what you know decides where exam minutes go; monitoring one's understanding improves
learning (Flavell 1979; Schraw & Dennison 1994), and people are systematically miscalibrated, the
least skilled most (Lichtenstein, Fischhoff & Phillips 1982; Kruger & Dunning 1999).

- **Calibration.** Before a check she may rate how sure she is (a slider, or `/sure 70`). After
  the grade the pair is kept; the Learner tab shows her calibration curve, the mean gap and the
  Brier score, and per technique flags over- or under-confidence (|gap| ≥ 0.2 over ≥ 3 proofs)
  with one kind, specific nudge.
- **Self-explanation.** After a complete proof the debrief asks for the key idea in her words
  (Chi et al. 1989, 1994), which goes into the technique notebook.
- **Planning and monitoring.** Triage under time (§6, §11) is coached at lulls in timed sessions.
- **The error journal** is the set of mistake items: hers to read, annotate and review; the
  patterns are hers, not the Primer's verdicts.
- **Productive struggle versus floundering.** The ink signals tell them apart: pauses followed by
  new lines are thinking (silence); long stalls with repeated erasures and rewrites and no new
  progress over several minutes are floundering, where a first-rung hint may be offered (only if
  her nudging setting allows it, and never during a mock). Productive failure (Kapur 2008) is
  protected; floundering is not left alone.
- **Reflection** at the end of a session and on the report's last page: what went well, where she
  got stuck and what got her unstuck, what she will do differently.

### 14. Goals she agrees to, and consent per feature

- **Goals are a conversation**, never a setting the Primer imposes (Locke & Latham 2002 on
  specific goals; Deci & Ryan 2000 on autonomy): her target (score or percentile, in her words),
  topics, weekly hours, how much nudging she wants, and which features may watch her. Every change
  is recorded with its date and who proposed it; only her edits mark them agreed; a weekly revisit
  is offered, not forced, and they change any time.
- **Consent per feature**, each off until she turns it on: reading position, attempt log, ink
  signals, reviews, nudges, activity review (`metacog.FEATURES`).
- **She sees and edits everything the model believes**: mastery, calibration, goals, insights.
  "That's wrong" on a mastery estimate is evidence at weight 0.3 (her word counts without
  overruling her proofs); "not right" on an insight dismisses it and teaches the model.

### 15. Inspiration, grounded

Practice for two months needs reasons beyond the deadline: occasional curiosity hooks (a beautiful
problem, the story behind a technique, a connection to something she loved), noticing streaks and
breakthroughs without shallow gamification (no points or badges; a sentence when something
genuinely changed, such as a misconception not seen for two weeks), and now and then a delight
problem chosen for beauty rather than weakness. Every story and attribution must be cited or
skipped: no fabricated anecdotes. The citations come from the grounded context and library system
designed on the branch `research/grounded-context`; until it lands, the Primer offers problems
from its own bank and says nothing it cannot cite.

### 16. The reflective layer (`primer/reflect.py`, `primer/report.py`)

A background reader of her own record, opt-in (`activity_review`), kind and specific: her mirror,
not surveillance.

- **Activity review:** problems attempted with outcomes; weaknesses (concepts, techniques,
  recurring mistakes) with evidence; an **approach profile** from her own work, each line with its
  basis ("reaches for contradiction first: 5 of 10 attempts"; "little sign of testing small cases";
  "most marks are for missing justification rather than wrong ideas"); topics with time spent and
  the trend of mastery.
- **Blind spots:** patterns invisible from inside: the same mistake across topics, over- or
  under-confidence on a technique, time sinks (long attempts ending at 2/10 or less), stalling at
  the same kind of step across problems, a topic gone untouched for two weeks, a technique the hard
  problems needed that never appears in her work. Each has evidence (attempts with links to replay
  the page at that moment, `apps/even-g2` thinking replay, and thumbnails of her ink), a
  confidence, and one suggestion; she confirms or dismisses each, and dismissed ones stay gone.
- **Reports:** weekly and on demand (the dock's "My progress"), typeset with the proofs' LaTeX
  pipeline (Tectonic or pdfLaTeX; an HTML-and-KaTeX rendering is the fallback design where no TeX
  engine exists): goals against progress, mastery and calibration charts, weaknesses with trends,
  the approach profile, blind spots with ink thumbnails, the error journal, the next problems with
  their reasons, and a page of reflective prompts to answer by hand. They accumulate into a
  portfolio under `<state>/primer/reports/<learner>/`, served by the desktop router to her phone.
  Putting a report on the tablet as a document is a write in xochitl's documented format (the PDF
  with a `.metadata` and `.content` beside it under `xochitl/`, then the sync or a restart): left
  for the extension and automation work, and only with her OK.
- The ink signals here use the same units and thresholds as the app's thinking replay
  (`apps/even-g2/src/replay/moments.ts`: speeds in page widths per second with y × 4/3, the 4 s
  absolute pause, the 70 % slowdown), so a "hesitation" means the same thing on both sides.

### 17. Evaluation, and the prompt rules (`primer/scoring.py`)

- **Prompt rules** adopted from the smart_remarkable study (`docs/investigations/
  smart-remarkable-integration.md`; their prompts are MIT): the lasso's selection is image 1 and
  the whole page image 2; never assume content off the page; agent ink is never rendered, so earlier
  replies cannot pass for her instructions; act only on what the writing explicitly asks (read and
  assess, never complete); and return the literal `received_text` and a `kind` before the
  structure, so a reading can be audited against what was seen.
- **A scored evaluation**, because their harness was a gallery: recognition is scored against the
  fixtures' gold transcriptions (step count, LaTeX token F1, concept and line-assignment Jaccard),
  grading against expected findings, score, band and move on the fixtures and on transcript-only
  cases (`tests/fixtures/eval/grading/`). Offline runs gate at exact; live runs record replies with
  latency and tokens (`--record`), and replaying the recordings gates a model's measured quality in
  CI without a network.

### 18. The data model (one learner file, `<state>/primer/learners/<name>.json`)

| Field | What it holds | Who writes it |
| --- | --- | --- |
| `concepts` | per concept: BKT P(known), opportunities, half-life, last evidence | readings, reviews, her corrections |
| `misconceptions` | per catalog entry: count, last turn, clean streak | readings |
| `evidence` | every observation: concept, credit, weight, hesitation, mastery before and after | the Primer |
| `items` | FSRS items: kind, prompt, concepts, S, D, due, reps, lapses, review log | readings, her review ratings |
| `judgments` | confidence before a check, and the outcome | her, then the grade |
| `goals` | target, topics, weekly hours, nudging, revisit days, agreed date, change history | her (the Primer may propose) |
| `features` | consent per kind of watching | her |
| `attempts` | the attempt log: problem, minutes, hints, wrong steps, score, mistakes, reading position, thumbnail, her note | the coach (with consent); she may edit |
| `reading` | document, title, page and when | the coach (with consent) |
| `notebook` | techniques from solved problems, key idea, her own explanation | the debrief, her |
| `corrections`, `insight_verdicts` | her "that's wrong" and her verdicts on insights | her |
| `sessions` | timed sessions and mocks with scores | mock mode |

Beside it, per learner: `mocks/` (each mock's write-ups and report), `thumbs/` (ink thumbnails for
evidence) and `reports/` (the portfolio). All local to the desktop, all deleted with `forget` (the
learner file) or by removing the folder; nothing is sent anywhere but the minimum a live reading
needs (§2).

## Alternatives considered

- **Local handwriting recognition** (InkML-trained math recognizers, image-to-LaTeX models): no
  structure (steps, reasons, references) and weaker on mixed prose and mathematics; a live model
  reading rendered strokes gives the structure in one call, and ADR 002 already renders strokes.
  Revisit for an on-device first pass.
- **Deep or IRT-style knowledge tracing**: better fits with a population of learners; with one
  learner and two months, BKT's four interpretable parameters per concept, with bounds, are
  easier to trust and to explain.
- **SM-2 (or the half-life model alone) for review**: SM-2's ease factor has no model of
  retrievability; FSRS predicts recall and fits its weights to a review log, and its three numbers
  are explainable to her ("you'd recall this with 72 % chance today").
- **Marks drawn entirely by the simulated hand**: the arm model turns a loop the size of a line of
  writing into a blob; letters by the hand, shapes timed by the Primer, look like a teacher's pen.
- **Grading with a model only**: kept for live readings, but always alongside the catalog, the
  rubric's bands and an "estimate" label, with the prover as the only thing allowed to say
  "checked".

## Consequences

- The learner file becomes the one place her progress lives; its schema is versioned and ids are
  never reused, so it survives catalog growth.
- Live readings cost one model call each (an image and a structured answer); automatic readings
  happen at most every 30 s and only at lulls after new ink.
- The fixtures double as a regression suite: three handwritten proofs as real stroke messages
  (`scripts/dev/primer_fixtures.py`), hand-written transcriptions and expectations, and Lean files
  that check (√2 with lowest terms, the induction) or fail at the learner's broken step (√2
  without lowest terms fails at step 6).
- Clients must treat `primer` messages as ephemeral: routers do not replay them, so a panel that
  joins late asks with `plan` or `proof`.

## Status of the pieces (2026-10-06)

Built and tested offline: the concept graph and catalog, BKT and the learner file, ink signals and
the lull detector, offline recognition, assessment and grading, the Lean check (Lean 4.30 here:
the fixtures check or fail as expected), LaTeX (compiled with Tectonic here), the policy and hint
ladder, timed sessions, the queue and the plan, the coach (consent, reading positions, attempts,
weaknesses, problems in `packages/hand` ink), the teacher's markup (selection, placement, the
Teacher persona, performance, the phone's list and tap-to-explain), mock-exam mode (sessions,
breaks, collection, next-morning grading, the glasses' countdown, the Mock tab), FSRS items,
calibration, goals and per-feature consent with her corrections as evidence, the activity review,
blind spots and the progress report (`docs/media/primer-report-sample.pdf`, from fixture data),
the scored evaluation, the desktop router integration and report route, relays on the Go and Rust
routers, and demos against the Rust router (`docs/media/primer-*.png`). Not yet run: a live model
reading (no key on the build machine). Not built: the bridge writing `dock.json` from
`dock_entries`, and committing `ink_layer` strokes to a named native layer; the page watcher
reporting the open page's index and the document's kind (both engines, keeping their byte-for-byte
parity) so reading positions map to textbook sections; the floundering detector's hint offer;
grounded inspiration (waiting for the grounded-context library); the guardian view; the report's
HTML fallback and tablet import; handwritten replies in the loop.

## References

- Alamargot, Chesnet, Dansac & Ros (2006). Eye and pen: a new device for studying reading during
  writing. *Behavior Research Methods* 38(2).
- Baker, Corbett & Aleven (2008). More accurate student modeling through contextual estimation of
  slip and guess probabilities in Bayesian Knowledge Tracing. *ITS 2008*.
- Chi, Bassok, Lewis, Reimann & Glaser (1989). Self-explanations: how students study and use
  examples in learning to solve problems. *Cognitive Science* 13(2); Chi, de Leeuw, Chiu &
  LaVancher (1994). Eliciting self-explanations improves understanding. *Cognitive Science* 18(3).
- Deci & Ryan (2000). The "what" and "why" of goal pursuits: human needs and the
  self-determination of behavior. *Psychological Inquiry* 11(4).
- Flavell (1979). Metacognition and cognitive monitoring. *American Psychologist* 34(10).
- Kruger & Dunning (1999). Unskilled and unaware of it. *Journal of Personality and Social
  Psychology* 77(6).
- Lichtenstein, Fischhoff & Phillips (1982). Calibration of probabilities: the state of the art to
  1980. In *Judgment under Uncertainty* (Kahneman, Slovic & Tversky, eds.).
- Locke & Latham (2002). Building a practically useful theory of goal setting and task
  motivation. *American Psychologist* 57(9).
- Schraw & Dennison (1994). Assessing metacognitive awareness. *Contemporary Educational
  Psychology* 19(4).
- Su, Ye, Cao et al. (2023). Optimizing spaced repetition schedule by capturing the dynamics of
  memory. *IEEE TKDE*; Ye, Su & Cao (2022). A stochastic shortest path algorithm for optimizing
  spaced repetition scheduling. *KDD 2022*; the FSRS algorithm and weights:
  github.com/open-spaced-repetition.
- Cepeda, Pashler, Vul, Wixted & Rohrer (2006). Distributed practice in verbal recall tasks.
  *Psychological Bulletin* 132(3).
- Corbett & Anderson (1995). Knowledge tracing: modeling the acquisition of procedural knowledge.
  *User Modeling and User-Adapted Interaction* 4.
- Ericsson, Krampe & Tesch-Römer (1993). The role of deliberate practice in the acquisition of
  expert performance. *Psychological Review* 100(3).
- Kalyuga, Ayres, Chandler & Sweller (2003). The expertise reversal effect. *Educational
  Psychologist* 38(1).
- Kapur (2008). Productive failure. *Cognition and Instruction* 26(3).
- Kedlaya, Poonen & Vakil (2002). *The William Lowell Putnam Mathematical Competition 1985–2000*.
  MAA. Archive: kskedlaya.org/putnam-archive.
- MAA, the Putnam competition: maa.org/putnam (the 2026 four-session format); Georgia Tech School
  of Mathematics, math.gatech.edu/putnam-competition.
- Oviatt (2006). Human-centered design meets cognitive load theory. *ACM Multimedia*.
- Pardos & Heffernan (2010). Modeling individualization in a Bayesian networks implementation of
  knowledge tracing. *UMAP 2010*.
- Selden & Selden (1987). Errors and misconceptions in college level theorem proving.
- Settles & Meeder (2016). A trainable spaced repetition model for language learning. *ACL 2016*.
- Stephenson (1995). *The Diamond Age: Or, A Young Lady's Illustrated Primer*.
- Wang & Heffernan (2013). Extending knowledge tracing to allow partial credit. *AIED 2013*.
- Weber (2001). Student difficulty in constructing proofs. *Educational Studies in Mathematics* 48.
- Wengelin (2006). Examining pauses in writing. In *Computer Key-Stroke Logging and Writing*.
- Wilson, Shenhav, Straccia & Cohen (2019). The eighty five percent rule for optimal learning.
  *Nature Communications* 10.
- Wood, Bruner & Ross (1976). The role of tutoring in problem solving. *Journal of Child
  Psychology and Psychiatry* 17; Wood & Middleton (1975). A study of assisted problem-solving.
  *British Journal of Psychology* 66.
- Zeitz, *The Art and Craft of Problem Solving*; Engel, *Problem-Solving Strategies*.
