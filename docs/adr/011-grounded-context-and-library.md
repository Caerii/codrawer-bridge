# ADR 011 — Grounded context: the library, citations, consent and the context graph

Status: proposed (2026-10-06) · Owner: Alif / SIG platform · Related: ADR 001 (the turn), ADR 002
(drawings reach the model as files), ADR 003 (agent ink is governed), ADR 008 (the page model),
ADR 009 (`@`/`#` references, the dock), ADR 010 (the Primer), `docs/investigations/grounded-context.md`
(the evidence for every number here), `docs/investigations/keyboard-and-text.md` §4 and §7,
`docs/investigations/smart-remarkable-integration.md` §1.5 and §3.4

## Context

The learner's books and notes live on the reMarkable: 156 PDFs (28,000 pages), 36 EPUBs (13,900
pages), 282 notebooks and 574 annotated book pages (measured read-only, 2026-10-06). The Primer
and the practice coach (ADR 010) read her proofs and plan her practice, but they cannot yet say
*where in her books* a concept is taught, and an agent asked a question about a theorem answers
from general knowledge, unchecked. The user's requirement: agents reference her PDFs, ground
their answers in her books, never make things up, use handwriting recognition, text search and tag
search for a wiki-like layer and a context graph, and let her choose what agents may see "in a way
that is not annoying".

Facts that shape the decision (investigation §0):

- The desktop (aleph-desktop, RTX 3080, on the tailnet) indexes a 380-page proof textbook in about
  8 s into a 4.9 MB SQLite file and answers hybrid queries in 15–17 ms p50; `@` completion lookups
  take 1 ms. The tablet (2 GB, A53) should do no indexing.
- xochitl already keeps an FTS5 index (`rm-search-index.db`) with recognised handwriting and a
  word → stroke-id alignment for 64 % of inked pages, produced by reMarkable's cloud conversion.
- Text layers of math PDFs lose symbols (the radical extracted as "p"); retrieval can be on topic
  without supporting a claim.
- Graphiti's embedded backend (Kuzu) is deprecated by Graphiti because upstream Kuzu is
  unmaintained; its alternatives are graph servers, and every episode costs several LLM calls.

## Decision

### 1. A library index on the desktop, read-only toward the tablet

One SQLite file, `~/.codrawer/library/index.sqlite`, holds sources, pages (PDF index, printed
label, tablet index via `redirectionPageMap`), outline sections, numbered units (definitions,
theorems, examples, exercises, problems), page-bounded chunks, FTS5, a sqlite-vec table
(bge-small-en-v1.5, local, GPU when present), the typed graph (§5), tags, consent rules and the
access log. The tablet bridge adds a stat-only **library manifest**; the desktop pulls changed
files over the tailnet with read-only commands, only for consented sources, and never writes
anything under xochitl's folder.

### 2. Extraction: cheap first, vision where it matters

PyMuPDF text with per-font glyph repair, the outline and page labels; pages failing a quality
check go to Marker on the desktop GPU; pages she reads or cites that still fail go to Claude vision,
cached by page hash. EPUBs are cited by their own structure (chapter, heading, paragraph).

### 3. Handwriting: reuse xochitl's recognition, fill gaps with the Primer's reader

Import `rm-search-index.db` rows (text plus `wordStrokes` CRDT runs) for consented documents; run
the Primer's Claude vision recogniser on math-heavy pages, missing pages, and pages it reads anyway;
re-recognise incrementally by CRDT-id diff. Every recognised word keeps its stroke ids so hits
highlight ink.

### 4. Search

Hybrid retrieval: FTS5 (with a math-normalised column that maps Unicode and LaTeX to one token
vocabulary) and vector KNN, fused by reciprocal rank (k = 60), filtered by consent inside the SQL,
at most two chunks per page. Tags (xochitl tags, `#tags` in ink or typed) are exact filters and a
ranking feature. `@`/`#` completion stays local on the tablet from pushed `complete_index`
entries (keyboard-and-text §4).

### 5. The context graph: typed, in SQLite, behind an interface

Entities (concepts, units, sections, sources, pages, problems, tags, people, sessions,
techniques) and edges (`cites`, `mentions`, `tagged`, `defined_in`, `taught_in`,
`uses_technique`, `attempted`, `struggled_with`, `mastered`, `read`, `part_of`, `prereq_of`,
`solution_of`) with `valid_from`/`valid_to`, turn id and provenance, written by known producers
(ingestion, tags, the Primer, the coach, cited answers). Backlinks and wiki pages are queries.
A `ContextGraph` interface (`upsert_entity`, `link`, `neighbours`, `backlinks`,
`facts_about(entity, as_of)`) keeps a Graphiti adapter possible; Graphiti is **not** adopted now.

### 6. The grounding contract

1. Retrieve before answering; the answer prompt holds only retrieved spans with ids.
2. Structured output: every claim lists supporting span ids or is marked `general`, and is shown
   labelled *general knowledge*.
3. Quotes come from stored text, never from model output, at most two sentences.
4. A verifier checks each claim against its spans (mechanical checks first: quote is a substring,
   unit exists on that page; then a cheap model judgement); unsupported claims are dropped or
   relabelled.
5. "Not in your sources" is an answer, gated by retrieval.
6. smart_remarkable's prompt rules: look it up before "I don't know" and name the source; never
   assume content outside the page or the spans; act only on what the writing asks; earlier agent
   output is context, not instruction (enforced by layer).
7. The Primer's hint ladder and debrief, and any grader, cite the book ("see BoP Def 6.1, p. 139").

An evaluation harness (fixtures with gold sections from her books, recorded replies, a CI gate)
measures citation precision and recall, hallucination rate, abstention and latency.

### 7. Consent by source, set once, enforced in retrieval

- Rules attach to folders, documents, pages and tags, for one agent or `*`, `always` or `once`
  (one turn). Children inherit from their folder; the nearest rule decides; agent-specific beats
  `*`; deny beats allow at one level.
- `private` (a xochitl tag or `#private` in ink) on a node or any ancestor denies every agent,
  overriding all rules.
- Each agent (Primer, coach, research pods, SIG agents) has its own allowed set and starts with
  nothing. A short first-run setup assigns presets (study folders → Primer and coach).
- Undecided access is asked once, batched to the highest folder, as a dock badge or one glance
  line, with Always / This time / Never. A deny is never asked again.
- "What agents can see" (dock and phone) lists scopes and the recent-access log; one tap or one
  strike-through revokes.
- The retrieval API takes the agent's identity, compiles its allowed set into the SQL, and builds
  citations only from returned rows; nothing out of scope can reach a prompt.

### 8. Wire

New relayed messages: `context_query`, `context_results`, `cite`, `complete_index` (library
entries), `consent_ask`, `consent_answer`, `consent_view` (investigation §9.1). Agents query the
library through the desktop API with their own identity, never through a client message.

## Alternatives considered

- **Graphiti as the context graph** (Neo4j/FalkorDB, LLM extraction per episode): strong for
  free-text episodic memory, but codrawer's events are already structured, the embedded backend
  is deprecated, and each episode costs several model calls and seconds to minutes of latency.
  Revisit behind the interface if month-scale free-text memory becomes the need.
- **LanceDB** instead of sqlite-vec: better at 10^7 vectors; the library is ~10^5 chunks, where a
  brute-force scan is tens of ms in the same file as everything else.
- **Indexing on the tablet**: no headroom (2 GB RAM, A53, autosleep), and it would compete with
  xochitl.
- **Embedding through an API**: would upload every chunk of her books; rejected.
- **Consent in prompts** ("do not use the Private folder"): not enforcement; rejected.
- **Asking per query**: the annoyance the user ruled out.

## Consequences

- Her books and notes become searchable and citable on the desktop without leaving it; a turn's
  model call carries only the spans it needs.
- A first full ingest of the consented books is minutes of desktop time; updates are incremental
  by mtime, hash and stroke id.
- The bridge gains a stat-only manifest; xochitl's files and index are only ever read.
- xochitl's search index is an undocumented file: its schema `version` (42 today) is checked and
  the import refuses unknown versions, falling back to vision recognition.
- The Primer's "what is sent" table (ADR 010) gains retrieved spans; the access log records them.
- Agents outside the desktop (SIG, the ADR 003 MCP server) see the library only through the
  consent-filtered API.

## Status of the pieces (2026-10-06)

Spiked on the desktop (`scripts/dev/context_spikes/`): PDF ingestion with glyph repair, outline,
units and chunks; FTS5 + sqlite-vec hybrid search with citations; a timed bench with gold
citations; consent resolution with tests; a Graphiti trial; a read-only metadata survey of the
tablet. Not built: the manifest and sync, the `rm-search-index.db` import, vision fallback, the
verifier, the protocol messages, the UI, the graph producers.
