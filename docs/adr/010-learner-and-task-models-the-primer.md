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

- `primer_request` (`proof`, `hint`, `plan`, `forget`, `coach_on`, `coach_off`) from the
  phone's Proof panel; keyboard lines `/proof`, `/hint`, `/coach`; the tablet dock's
  `dock_action` `practice_coach`, `ask_page` and `ask_selection` (ADR 009 §4; the lasso's
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

## Alternatives considered

- **Local handwriting recognition** (InkML-trained math recognizers, image-to-LaTeX models): no
  structure (steps, reasons, references) and weaker on mixed prose and mathematics; a live model
  reading rendered strokes gives the structure in one call, and ADR 002 already renders strokes.
  Revisit for an on-device first pass.
- **Deep or IRT-style knowledge tracing**: better fits with a population of learners; with one
  learner and two months, BKT's four interpretable parameters per concept, with bounds, are
  easier to trust and to explain.
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
ladder, timed sessions, mocks, the queue and the plan, the coach (consent, reading positions,
attempts, weaknesses, problems in `packages/hand` ink), the desktop router integration, relays on
the Go and Rust routers, the Proof panel with step highlighting, and a demo against the Rust
router (`docs/media/primer-*.png`). Not yet run: a live model reading (no key on the build
machine). Not built: the bridge writing `dock.json` from `dock_entries`; the page watcher
reporting the open page's index and the document's kind (both engines, keeping their byte-for-byte
parity) so reading positions map to textbook sections; the guardian view; the mock-exam mode's
proctoring (the roadmap's first item, built on this ADR); handwritten replies in the loop.

## References

- Alamargot, Chesnet, Dansac & Ros (2006). Eye and pen: a new device for studying reading during
  writing. *Behavior Research Methods* 38(2).
- Baker, Corbett & Aleven (2008). More accurate student modeling through contextual estimation of
  slip and guess probabilities in Bayesian Knowledge Tracing. *ITS 2008*.
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
