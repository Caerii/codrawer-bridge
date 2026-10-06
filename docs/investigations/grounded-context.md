# Grounded context: the library, search, the link layer and the context graph

Status: investigation (2026-10-06), with spikes in `scripts/dev/context_spikes/`. Decision drafted
as ADR 011 (`docs/adr/011-grounded-context-and-library.md`, proposed). Related: ADR 001 (the turn),
ADR 002 (drawings reach the model as files), ADR 003 (agent ink is governed), ADR 008 (the page
model), ADR 009 (`@`/`#`, the dock), ADR 010 (the Primer, on the Primer branch), and the
investigations `keyboard-and-text.md` (§4 completion, §7 reading text),
`smart-remarkable-integration.md` (§1.5, §3.4, §3.7 prompt rules and evaluation),
`xochitl-pen-data.md` (the `.rm` format) and `latex-on-tablet.md`.

The user's ask: "we should be able to reference pdfs, the agent should not give you nonsense, you
can ground context in the books information… use the handwriting recognition and text search and
tag search for the wiki-like things for context graph and maybe even graphiti… properly designed
and efficient." And later: the user chooses what agents may see, "but in a way that is not
annoying".

## Recommendation

1. **One library index on the desktop, in SQLite**: documents, pages, outline sections, numbered
   units (Definition 4.1, Theorem 6.2, Exercise 3.4), page-bounded chunks, FTS5 and a sqlite-vec
   table, plus a small typed graph (entities and edges) in the same file. One file, one process,
   no server, backed up by copying it. The spike indexes a 380-page proof textbook in about
   **8 s** (1.2 s text and FTS, 2.3–2.9 s GPU embedding, 3–4 s model load) into **4.9 MB**, and
   answers a hybrid query in **15–17 ms p50** and an `@` completion in **1 ms**.
2. **Read the tablet, never write it.** Sync is a read-only pull over the tailnet: `.metadata` and
   `.content` always (14 MB for the whole library), the `.pdf`/`.epub` only for documents the
   consent scopes cover, and `.rm` pages when they change (the page watcher already knows). The
   tablet does no indexing work (2 GB RAM, A53).
3. **Handwriting: reuse what the tablet already has first.** xochitl keeps its own FTS5 index,
   `rm-search-index.db`, with recognised `handwrittenText` and a **word → stroke-id alignment**
   (`wordStrokes`, runs of CRDT ids) for 671 pages (64 % of the 1,052 inked pages; found
   2026-10-06, §1.4). Its text comes from reMarkable's cloud conversion (MyScript JIIX; the
   recogniser is an HTTP client in xochitl). Read it, credit it, and fill the gaps (unconverted
   pages, mathematics) with the Primer's Claude vision reading, keyed by the same stroke ids.
4. **Grounding is enforced by structure, not by asking nicely**: retrieval first; answers are
   built from cited spans the index returned; every claim carries a citation (book, section,
   unit, printed page) or is labelled "general knowledge"; a verifier re-reads each cited span and
   drops claims it does not support; and "not in your sources" is a first-class answer, gated by
   retrieval (the spike separates 6/6 out-of-corpus questions from 19/20 in-corpus ones by vector
   distance alone, fitted on that fixture).
5. **The context graph is a typed graph in the same SQLite file now, with Graphiti as a possible
   later backend behind an interface, not a dependency.** Graphiti's value (LLM-extracted
   entities and temporal facts from free-text episodes) is real for unstructured conversation,
   but codrawer's events are already structured (the Primer emits concept ids, misconceptions,
   attempts, reading positions), so the extraction calls buy little; its local-first embedded
   backend, Kuzu, is deprecated by Graphiti itself because upstream Kuzu is no longer maintained
   (warning printed by graphiti-core 0.30.2 in the spike), leaving Neo4j or FalkorDB servers; and
   every episode costs several LLM calls (§5.2 for the measured numbers).
6. **Consent by source, set once** (§7): scopes on folders, books, notebooks and tags, inherited
   down the tree; `#private` (in ink or as a xochitl tag) always wins; each agent has its own
   allowed set and starts with nothing; one batched ask, only for genuinely new access, where the
   user already is; a quiet "What agents can see" entry with the access log. Enforced in the
   retrieval layer: a query is compiled with the agent's allowed source ids in its `WHERE`
   clause, so out-of-scope text never reaches a prompt.

Phases (§10): **1** PDF/EPUB text, FTS, citations and the grounding contract for the Primer (about
2 weeks, aimed at the 24 October mock); **2** handwriting (xochitl's index plus vision), hybrid
search, tags, `@`/`#` completion (about 2–3 weeks); **3** the typed graph, the wiki and backlinks,
the coach's "from the section you were reading" (about 2 weeks), with a Graphiti adapter only if
phase 3 shows a need that the typed graph cannot meet.

---

## 0. Facts this rests on

### 0.1 The library on the tablet (measured 2026-10-06, read-only, metadata only)

`scripts/dev/context_spikes/tablet_survey.py` over `ssh root@192.168.50.156` (Codex image
20260924063239). It reads `ls -l`, a count of `.rm` files per document, and a tar stream of
`*.metadata` and `*.content` unpacked in memory; it prints counts, never titles. Nothing was
copied to disk and nothing was written on the tablet.

| | count | pages | ink pages (`.rm`) | size |
| --- | --- | --- | --- | --- |
| PDF documents (live) | 156 (214 `.pdf` files incl. trash) | 27,993 (median 29, max 4,592) | 408 in 25 annotated PDFs | 1,789 MB (median 2.1 MB, max 141 MB) |
| EPUB documents | 36 (40 files) | 13,902 (median 358) | 166 in 9 annotated EPUBs | 182 MB |
| notebooks | 282 | 478 (median 1) | 478 | `.rm` total 323 MB |
| folders | 176 | | | |
| trashed or deleted | 33 | | | |

- **Recency**: of the live documents, 11 opened in the last week, 25 in the last month, 70 in the
  last six months, 368 older. The working set is small even though the library is large.
- **Tags are almost unused**: no document has a document tag and one page carries a page tag
  (`Important`). Every `.content` has the `tags` and `pageTags` keys, so the mechanism is there;
  codrawer's `#tags` in ink will be the main source of tags.
- **`.content` keys present** (count of files): `tags` 598, `fileType`/`pageCount`/
  `documentMetadata`/`extraMetadata`/`formatVersion` 507, `cPages` 323, `originalPageCount` 184,
  `redirectionPageMap` 179, `dummyDocument` 130. `redirectionPageMap` is how a PDF with pages
  inserted on the tablet maps its page indices back to the original PDF pages.
- Two documents carry `.textconversion` and three `.highlights` folders (empty in the one we
  listed); two `.epubindex` files exist.

### 0.2 xochitl's own search index (found 2026-10-06)

`/home/root/.local/share/remarkable/xochitl/rm-search-index.db` (4.2 MB, written 06:23 that
morning) is an SQLite database whose schema is, read from the file's first pages:

```sql
CREATE VIRTUAL TABLE search USING fts5(entryId, pageId, handwrittenText,
  authorMap UNINDEXED, wordStrokes UNINDEXED, digitalText, title, tags, type,
  tokenize="unicode61 categories 'L* M* N* Cf Co P* S*' separators '-'")
```

Aggregates (computed on an in-memory copy, no text printed or kept): 671 rows, one per page, all
`type = 1`, over 306 documents; 668 rows carry `handwrittenText` (684,183 characters in all),
22 carry `digitalText` (typed text, 17,784 characters), none carry tags. `wordStrokes` is text of
the form `a:c;n,a:c;n,|a:c;n,|…`: words separated by `|`, each a list of CRDT-id runs
(`author:counter;count`) of the strokes that make up the word, the same ids `rmlines` returns.
That is an exact word → ink alignment for free.

Where the text comes from: xochitl's binary contains `handwritingconversion/src/recognitionjob.cpp`,
`recognitiontask.cpp` (whose `start` takes an `http::Reply`), `jiixparser.cpp` (JIIX is MyScript's
output format), the string `myscript`, `:/misc/hwr/license.txt` and "Could not load handwriting
conversion license". So recognition is MyScript's, run through reMarkable's cloud, with the result
stored locally and indexed. It covers 64 % of the inked pages; unconverted pages, mathematics
(MyScript Text, not Math) and pages written offline are the gaps.

### 0.3 The spikes (desktop, 2026-10-06)

The test book is Richard Hammack's *Book of Proof*, 3rd edition (CC BY-NC-ND 4.0, free PDF from
the author; downloaded locally, not committed): 380 pages, 107 outline entries, roman and arabic
page labels, typeset in TeX with Fourier math fonts. It is the kind of book the learner has: a
proofs textbook with definitions, theorems, examples and exercises.

| Stage | Result |
| --- | --- |
| open + text + outline + units + chunks + FTS5 | 1.2 s (6.7 s with the per-glyph math repair, on a loaded CPU) |
| units found by regex | 301 (Definitions, Theorems, Examples, Facts, Exercises) |
| chunks (≤ 900 chars, never across a page) | 1,243 |
| embedding, bge-small-en-v1.5, RTX 3080 (onnxruntime-gpu) | 2.3–2.9 s (1.8 ms/chunk); model load 3–4 s |
| embedding, same model, CPU (16 threads, machine at 100 % load from other jobs) | 211 s (~200 ms/chunk; unreliable, contended) |
| index on disk | 4.9 MB (≈ 13 KB per page) |
| query p50 / p95, warm (130 queries) | FTS 4.5–5.0 / 6.7–7.9 ms; vector 12.7–14.8 / 15–22 ms (query embedding 4.5 ms on GPU); hybrid 15–17 / 18–25 ms; cross-encoder rerank 214 / 266 ms |
| `@` completion (titles and unit labels, prefix/LIKE) | 1.0 / 1.5 ms |

Citation quality on 20 in-corpus questions with gold outline sections and 6 out-of-corpus
questions (`gold_bookofproof.json`; a citation counts when its page is inside a gold section):

| Retriever | hit@1 | hit@5 | precision@5 | MRR |
| --- | --- | --- | --- | --- |
| FTS5 (porter, math-normalised column) | 0.65 | 0.85 | 0.59 | 0.75 |
| vector (bge-small) | 0.80 | 0.95 | 0.72 | 0.87 |
| hybrid (RRF, k = 60) | 0.65 | 1.00 | 0.72 | 0.80 |
| hybrid + bge-reranker-base | 0.75 | 0.90 | 0.57 | 0.81 |

- Hybrid has the best recall (every gold section in the top 5) and vector the best top-1; the
  reranker costs 200 ms and did not help here. Twenty questions are too few to rank the last two
  digits; the harness is the point (§6.5), and phase 1 grows the fixture from her own books.
- **The classic failure is mathematics in the text layer.** In this book the radical sign is a
  glyph in the math font's `p` slot and the empty set in its `;` slot, so PyMuPDF extracted "√2"
  as "p 2" (213 radicals) and big braces and binomials as "©…ª" and "¡…¢". A per-font glyph
  repair fixes those (`library.MATH_FONT_GLYPHS`). Even then "Show that √2 is irrational" ranked
  pages that *use* the fact (p. 143, 154) above the page that *proves* it (p. 139): a citation can
  be on topic and still not support the claim, which is why the verifier in §6.3 exists.
- Abstention by the best vector distance alone: in-corpus 0.47–0.71, out-of-corpus 0.71–0.83; a
  threshold at 0.70 answers 19/20 and abstains on 6/6 (fitted on this fixture, so optimistic).

---

## 1. Sources and ingestion

### 1.1 How xochitl stores documents

Everything is flat in `/home/root/.local/share/remarkable/xochitl/` (`xochitl-pen-data.md` §1):

- `<uuid>.metadata` (JSON): `visibleName`, `type` (`DocumentType` or `CollectionType` for a
  folder), `parent` (a folder uuid, `""` for the root, `"trash"`), `lastOpened` (ms),
  `lastOpenedPage`, `deleted`. The folder tree is the `parent` chain.
- `<uuid>.content` (JSON): `fileType` (`pdf`, `epub`, `notebook`), `pageCount`,
  `originalPageCount`, `cPages.pages[]` (page ids in order, with `deleted` tombstones),
  `cPages.lastOpened`, `redirectionPageMap` (reMarkable page index → original PDF page, for PDFs
  with inserted pages), `tags` (document tags: `{name, timestamp}`), `pageTags`
  (`{name, pageId, timestamp}`), `documentMetadata` (authors, title when the file carried them).
- `<uuid>.pdf` / `<uuid>.epub`: the source file, unchanged. For an EPUB xochitl also lays out
  pages; its page indices depend on the reading settings (`fontName`, `textScale`, `margins`), so
  EPUB citations use the EPUB's own structure (spine item, heading, paragraph) and treat the
  tablet page index as a view (§1.5).
- `<uuid>/<page-id>.rm`: annotations and notebook pages (the `.rm` v6 format, `rmlines`), one
  file per page that has ink. On a PDF the strokes sit in page coordinates over the PDF page.
- `<uuid>.thumbnails/`, `<uuid>.pagedata`, `<uuid>.local`, `.highlights/`, `.textconversion/`,
  and the global `rm-search-index.db` (§0.2).

### 1.2 Incremental, read-only sync to the desktop

The desktop keeps a mirror of only what the index needs, in `~/.codrawer/library/` (never in the
repository):

1. **Change detection.** The bridge's page watcher (`pagewatch`) already polls stat on the open
   document and sends `page` on every save. A sibling, the **library watcher**, runs at a slower
   cadence (every 60 s when awake, and at wake) and sends a manifest: for every document, the
   `.metadata`/`.content` mtimes and sizes, the `.pdf`/`.epub` size and mtime, and per page the
   `.rm` mtime and size. That is a few hundred stat calls; no hashing on the tablet.
2. **Pull on the desktop.** The desktop diffs the manifest against its mirror and pulls changed
   files over the tailnet (`ssh`/`sftp`, read-only commands; or the bridge's own HTTP on
   `-serve :8577` adding a read-only `GET /lib/<uuid>.<ext>` behind the session token). A file is
   re-indexed only when its content hash changed (the spike's `ingest` is idempotent by sha256),
   so a touched-but-unchanged PDF costs one hash.
3. **What is pulled**: `.metadata` and `.content` always (14 MB in all, a few KB per change); the
   PDF/EPUB **only when a consent scope covers it** (§7); `.rm` pages of covered documents when
   their mtime changes; `rm-search-index.db` when its mtime changes and handwriting search is on
   (4 MB, a read-only copy; SQLite's file can be copied safely after xochitl's write settles,
   checked with `PRAGMA integrity_check` on the copy).
4. **Sleep and Wi-Fi.** The tablet sleeps within minutes and drops Wi-Fi. The desktop catches up
   at wake (the bridge reconnects and sends a fresh manifest); nothing is lost because xochitl's
   files are the source of truth.
5. **Never write.** No file under xochitl's folder is ever opened for writing by sync; tags set by
   codrawer live in the desktop index, not in `.content` (writing `.content` while xochitl runs
   races its own saves; ADR 008 §4 rule 3).

Cost of a first full sync of the measured library: 1.97 GB of PDF/EPUB over Wi-Fi at a realistic
5–10 MB/s is 3–7 minutes, but by consent it is the scoped subset (the Putnam folder is likely
under 200 MB).

### 1.3 Text extraction from PDFs, and mathematics

| Option | Text quality on born-digital math | Scanned books | Speed / cost | Notes |
| --- | --- | --- | --- | --- |
| **PyMuPDF** (`get_text("rawdict")`, outline, page labels) | good prose; math symbols as Unicode; **TeX font-slot glyphs need repair** (§0.3) | none (no OCR built in; Tesseract hook available) | 3 ms/page | AGPL (or commercial); used locally, not distributed |
| pdfplumber / pdfminer.six | similar text, better table geometry | none | ~10× slower | MIT |
| Tesseract OCR (via PyMuPDF `get_textpage_ocr`) | n/a | prose fine; mathematics poor | ~1–2 s/page CPU | the floor for scanned prose |
| **Marker** (Surya OCR + layout, optional LLM pass) | markdown with LaTeX for equations; reading order; headers | yes | ~0.1–0.5 s/page on GPU | GPL-3.0 code, model weights under a restrictive licence for commercial use; fine for personal use |
| **Nougat** (Meta, academic PDFs → Mathpix-style markdown) | strong on arXiv-like layout, LaTeX math | yes | ~1–2 s/page GPU | hallucination loops on unusual layouts; trained on papers, weaker on textbooks |
| **Claude vision** per page (render at ≤ 1568 px, ask for markdown + LaTeX) | best on mixed prose, math, diagrams and handwriting margins | yes | 5–15 s/page; see cost below | sends the page image to the API: needs consent |

Recommended pipeline per page: PyMuPDF text with the glyph repair → a quality check (the share of
characters from math fonts that remain unmapped, replacement characters, very short text on a page
with ink coverage, or no text layer at all) → pages that fail go to Marker on the desktop GPU, and
pages the learner actually reads or cites that still fail (dense display mathematics, scanned
problem books) go to Claude vision, cached forever by page hash. This keeps the expensive path to
the pages that matter.

**Vision cost** (list prices from the claude-api skill, cached 2026-09-25; image tokens ≈ width ×
height / 750): a page rendered at 1568 × 1210 is ~2,500 image tokens; with a 300-token instruction
and ~1,000 output tokens of markdown and LaTeX:

| Model | per page | 300-page book | with the Batch API (−50 %) |
| --- | --- | --- | --- |
| Claude Opus 5.5 ($4 / $20 per MTok) | ≈ $0.031 | ≈ $9.40 | ≈ $4.70 |
| Claude Sonnet 5.5 ($2 / $10) | ≈ $0.016 | ≈ $4.70 | ≈ $2.35 |
| Claude Haiku 4.5 ($1 / $5) | ≈ $0.008 | ≈ $2.40 | ≈ $1.20 |

Thinking tokens come on top on Opus 5.5 (thinking cannot be disabled there; run it at `low`
effort for transcription). Transcribing the whole 42,000-page library this way would be $300–
$1,300, which is why vision is per page on demand, not a bulk step. The scanned fraction of her
PDFs is unknown (measuring it needs the files, which this research did not copy): the first sync
reports it (pages with no text layer) before anything is sent anywhere.

### 1.4 Structure: chapters, sections, units, exercises

- **Outline first**: the PDF outline gives chapters and sections with page numbers (107 entries in
  the test book). Sections get `start_idx`/`end_idx` page ranges and a parent.
- **No outline**: fall back to font-size and boldness runs (headings are larger or bold), which
  Marker also produces.
- **Units** (Definition 4.1, Theorem 6.2, Lemma, Corollary, Proposition, Example, Fact,
  "Exercises for Section 3.4", problem numbers in problem books): a line regex over the repaired
  text found 301 in the test book; each unit starts a new chunk, so a citation can name the
  unit. A unit's extent is approximate (until the next heading or the section's end); the
  verifier, not the extent, decides support.
- **Exercises and solutions**: exercise lists are units of kind `exercise` with their numbers;
  "Solutions" sections are tagged so that the coach can withhold solutions until after an attempt
  (ADR 010's rule that the Primer never hands over a solution unprompted applies to the book's own
  solutions too).
- **Problem books** (Putnam and Beyond, the Kedlaya–Poonen–Vakil volume, Engel, Zeitz): problems
  as units with their number and source year (`Putnam 1995 B1`), linked to the Primer's
  `putnam_ref` ids.

### 1.5 Page numbers ↔ reMarkable page indices

Three numbers per page, all stored: the **PDF page index** (0-based), the **printed label**
(`Page.get_label()`, from the PDF's /PageLabels; `xiv`, `139`), and the **tablet page index**. For
an unedited PDF the tablet index is the PDF index. When the user inserted pages on the tablet,
`.content` `redirectionPageMap[i]` gives the original PDF page for tablet page `i` (with a
negative value for an inserted blank page); the `page` message's page id resolves through
`cPages.pages`. Citations show the printed label ("p. 139"); "open it" jumps by the tablet index.
For EPUBs, citations use the EPUB's chapter and heading and a paragraph id; the tablet page index
is computed only for "you are here", from the reading position the page watcher reports.

---

## 2. Handwriting recognition for notebooks and annotations

### 2.1 Options

| Option | Accuracy | Math | Privacy | Cost | Stroke alignment |
| --- | --- | --- | --- | --- | --- |
| **xochitl's own conversion** (MyScript via reMarkable's cloud), read from `rm-search-index.db` | high on prose (MyScript is the commercial benchmark) | text only; formulas come out as letters | already sent to reMarkable by the user's sync settings; codrawer sends nothing more | free | **yes**: `wordStrokes` → CRDT ids |
| reMarkable's "convert to text" on demand | same engine | same | same | free | via the index after conversion |
| Local models (TrOCR, Microsoft's handwritten checkpoints; PaddleOCR; kraken) on rendered lines | moderate on neat print, poor on cursive and math | weak (TrOCR is line text) | local | GPU minutes | from the line crops |
| Online-ink recognisers (stroke sequences: MyScript iink SDK, Google's Digital Ink ML Kit on Android) | high | MyScript Math is strong | iink SDK is local but licensed; ML Kit is Android-only | licence | native |
| Image-to-LaTeX (pix2tex, Texify, the math part of Marker/Surya) | good for isolated formulas | yes | local | GPU seconds | per crop |
| **Claude vision** (the Primer's recogniser: render from strokes, label lines, structured output) | highest on mixed prose and mathematics in our experience of the Primer fixtures; the scored evaluation (`primer score`) measures it | yes, with structure (steps, reasons) | sends the rendered page: consented per scope | ~$0.01–0.03 per page (§1.3) | by line labels → stroke ids (ADR 010 §3) |

### 2.2 Recommendation

- **Tier 0, free**: import xochitl's index rows for consented documents: page text plus
  word → stroke runs. This alone makes 64 % of inked pages searchable with ink highlighting,
  without any model call.
- **Tier 1, on demand**: the Primer's recogniser for pages that are math-heavy (heuristics: many
  short strokes, digits and operators in the MyScript text, or a `#math` tag), for pages the
  index lacks, and for any page the learner asks about or the Primer reads anyway (its reading
  is reused; nothing is recognised twice).
- **Tier 2, later**: a local first pass (Texify or a fine-tuned TrOCR) only if the cost or the
  offline requirement demands it; ADR 010's "Alternatives" already keeps this open.

### 2.3 Incremental recognition

A page's recognition is keyed by the set of live stroke ids it covered. On a new `page` snapshot:
strokes added or tombstoned since the last recognition are diffed by CRDT id (`rmlines` returns
ids and tombstones); words whose stroke runs lost a stroke are invalidated; new strokes are
grouped into lines (`ink_signals.segment_lines`) and only the changed lines' bounding box is
re-recognised, with the unchanged neighbours as context. xochitl's own index is re-read when its
`generation` row changes.

### 2.4 Stroke ↔ text alignment

Every recognised word or step stores the stroke ids it came from (xochitl's runs, or the Primer's
line labels mapped to strokes), so a search hit carries `strokes: [ids]` and its bounding box.
Clients highlight those strokes on the phone stage and glasses; on the tablet the extension can
draw a transient highlight box (no write to the page).

---

## 3. Search

### 3.1 Full text: SQLite FTS5

- One FTS5 table over chunks with three columns: the text (porter + unicode61), a
  math-normalised copy (§3.4) and the section title (weighted ×2 in `bm25`).
- Handwritten text is indexed in the same table with `kind = 'ink'` so a query spans books and
  notebooks; typed text from `.rm` RootText (keyboard-and-text §7) joins it when decoded.
- Measured: 4.5–5 ms p50 for OR-of-terms queries over 1,243 chunks. FTS5 scales linearly in
  postings; at the library's full size (~140,000 chunks if everything were indexed) expect
  tens of ms, still inside the budget.

### 3.2 Semantic: embeddings

| Choice | Dim | Size | Speed (measured / expected) | Notes |
| --- | --- | --- | --- | --- |
| **bge-small-en-v1.5** (fastembed, ONNX) | 384 | 130 MB | 1.8 ms/chunk GPU, 4.5 ms per query | used in the spike; English |
| nomic-embed-text v1.5 (Ollama or ONNX) | 768 (Matryoshka to 256) | 270 MB | ~2× bge-small | 8k context; good on long chunks |
| bge-m3 | 1024 | 2.2 GB | ~5× | multilingual, also sparse vectors |
| An API (Voyage, OpenAI) | 1024–3072 | — | network-bound | sends every chunk out: rejected for privacy (§8) |

- **sqlite-vec** (`vec0`, brute force) is enough: 140,000 × 384 floats is 215 MB and a scan is
  tens of ms; with int8 quantisation 54 MB. LanceDB is the alternative if the corpus grows by an
  order of magnitude (IVF-PQ, a separate directory, Arrow); not needed now.
- The desktop has an RTX 3080: embedding the whole measured library (≈ 140,000 chunks) is about
  4 minutes on the GPU, about 8 hours on a busy CPU.

### 3.3 Hybrid ranking

Reciprocal-rank fusion of FTS top 30 and vector top 30, then **filtered by the consent scope**
(§7) inside the SQL, then grouped so at most two chunks per page are shown. The cross-encoder is
off by default (200 ms, no gain on the fixture); a reranker or the verifier (§6.3) is the place to
spend latency, and only for answers, never for completion.

### 3.4 Math-aware search

- The math-normalised column maps Unicode mathematics and LaTeX commands to one token vocabulary
  (`⊆`, `\subseteq` → `mathsubseteq`; `√`, `\sqrt`, "square root" → `mathsqrt`), applied to
  documents and queries alike (`library.MATH_TOKENS`). This lets a typed `\equiv \pmod{n}` find
  "≡" in the book (the congruence question hit at rank 1).
- Later: formula-level search (normalised LaTeX trees, as in Approach0 or Tangent-L) for "find
  where the book uses \sum_{k=1}^n k^2". Not phase 1.

### 3.5 Tags

Sources of tags, all stored as entity links (§4): xochitl `tags` and `pageTags` from `.content`;
codrawer `#tags` written in ink (recognised from the handwriting text as `#word` tokens; the
Primer's recogniser is told to keep them literal) or typed in a text box; tags the user applies
from the phone. Tag search is an exact join (`tag:pigeonhole` filters), and tags are a ranking
feature (a page tagged `#pigeonhole` outranks one that only mentions it).

### 3.6 Latency targets and where they are met

| Interaction | Budget | Where it runs | Measured |
| --- | --- | --- | --- |
| `@`/`#` completion per keystroke | < 50 ms, ideally local | the tablet extension filters a pushed `complete.json` (keyboard-and-text §4); the desktop pushes updated entries | desktop lookup 1 ms; the tablet filter is local |
| "Search my library" results | < 300 ms to first results | desktop hybrid query, results pushed to the tablet/phone | 15–25 ms query + network |
| A grounded answer | seconds, dominated by the model call | desktop: retrieve (20 ms), answer (model), verify (model or cheap check) | retrieval 20 ms |

---

## 4. The wiki and link layer

### 4.1 Semantics

- `@x` **addresses or attaches**: an agent (`@primer`), a participant, or a source (`@book-of-proof`,
  `@putnam-week3`, `@thm-6.2`). Attaching a source puts it in the turn's context bundle (as files
  the agent Reads, ADR 002) and scopes retrieval to it.
- `#x` **names a topic** that pages are about: a Primer concept id (`#pigeonhole`), a codrawer tag
  (`#contradiction`, `#todo`), a Putnam reference (`#putnam-1995-B1`), or a wiki page. Writing
  `#pigeonhole` on a page links that page to the concept.
- Every `@`/`#` occurrence (typed or recognised in ink) becomes an **edge** from the page (and the
  strokes) to the entity, with the turn id. Backlinks are the reverse query: "every page that
  mentions `#pigeonhole`", across notebooks, book annotations and the Primer's attempts.

### 4.2 Pages of the wiki

A wiki page is a view, not a stored document: for an entity it lists its definition where the
books give one (the unit and page), its backlinks (her pages, newest first), the problems that use
it (bank and Putnam references), her mastery and last evidence (from the learner file, when the
viewer is the learner), and related entities (prerequisites from the concept graph). The user
can add a note to an entity; notes are stored in the index and are hers.

### 4.3 How a reference renders

- **Phone / web**: a citation chip, `Book of Proof · §6.1 · Def 6.1 · p. 139`, which expands to the
  quoted span (≤ 2 sentences) and "open on tablet" (jumps the tablet when the extension supports
  it; otherwise shows the page image rendered on the desktop).
- **Glasses**: the chip's first line, `BoP p.139 Def 6.1`, ≤ 48 characters (ADR 010 glance rule).
- **Tablet, as agent ink**: a short handwritten citation in the margin next to the answer,
  `(BoP 6.1, p.139)`, by the `packages/hand` persona, on the agent layer. Never the quote itself
  in ink: ink is for short marks.
- **Inline in a text box** (keyboard route A): `[BoP p.139]`, styled.

---

## 5. The context graph

### 5.1 What the graph is for

- The Primer's learner model links mastery to **where a concept is taught**: concept
  `proof_by_contradiction` → `defined_in` Book of Proof §6.1 p. 139, so a weak spot comes with
  "re-read pp. 138–141".
- The practice coach's "the section you were on last": reading positions (`page` messages:
  document, page) → section → concepts taught there → exercises in that section and bank
  problems with those concepts (ADR 010 §6 "problems tied to the section she was just reading").
- Grounded answers: "where have I used pigeonhole before?" is a backlink query, not a search.

### 5.2 Graphiti, evaluated

Graphiti (getzep/graphiti, Apache-2.0) builds a temporal knowledge graph from *episodes* (text or
JSON): an LLM extracts entities and facts, deduplicates them against existing nodes (embedding
search plus an LLM judgement), resolves contradictions by invalidating older edges with
`valid_at`/`invalid_at`, and searches with hybrid (BM25 + embedding + graph distance) retrieval.

Tried 2026-10-06 (`graphiti_spike.py`): graphiti-core 0.30.2 with the Kuzu embedded driver,
`qwen3:4b` and `nomic-embed-text` through Ollama on the desktop GPU, four synthetic codrawer
episodes (a reading position, a Primer reading, an attempt, a note).

- **Install**: `graphiti-core[kuzu]` resolves (kuzu 0.11.3, neo4j driver and openai pulled in
  regardless); it imports `httpx` without declaring it.
- **Kuzu is deprecated by Graphiti**: constructing `KuzuDriver` prints "The Kuzu backend is
  deprecated and will be removed in a future release — the upstream Kuzu project is no longer
  maintained. Migrate to Neo4j or FalkorDB." Local-first then means running a Neo4j (JVM, ~1 GB
  RAM) or FalkorDB (Redis module, Docker on Windows) server beside the router.
- **Per-episode cost and latency**: GRAPHITI_RESULTS.

| | Graphiti | Typed graph in SQLite |
| --- | --- | --- |
| Infrastructure | a graph server (Neo4j/FalkorDB) or a deprecated embedded DB | the index file that already exists |
| Ingest cost | several LLM calls per episode (extract nodes, dedupe, extract edges, resolve, summarise) | zero for structured events; one model call only for free text that needs extraction |
| Determinism and audit | LLM-extracted facts can be wrong or duplicated; needs review | edges come from known producers (Primer ids, outline, tags) with provenance |
| Temporal facts | first-class (`valid_at`/`invalid_at`) | columns `valid_from`/`valid_to` on edges; enough for "was struggling, now mastered" |
| Free-text memory ("she said she hates geometry") | strong | weak without extraction |
| Fit with codrawer's data | most events are already structured | direct |

**Verdict**: not now. Use the typed SQLite graph, behind a small `ContextGraph` interface
(`upsert_entity`, `link`, `neighbours`, `backlinks`, `facts_about(entity, as_of)`), and revisit
Graphiti (with FalkorDB) if free-text episodic memory across months becomes the bottleneck, for
example the agent's own notebook (roadmap "Later").

### 5.3 The typed graph

```sql
entity(id text primary key,      -- 'concept:pigeonhole', 'src:<uuid>', 'sec:<uuid>/6.1',
                                  -- 'unit:<uuid>/thm-6.2', 'page:<doc>/<page>', 'problem:putnam-1995-B1',
                                  -- 'tag:contradiction', 'person:<name>', 'session:<id>', 'technique:...'
       kind text, label text, attrs json, created_ms int)
edge(src text, rel text, dst text, -- rel in: cites, mentions, tagged, defined_in, taught_in,
                                    -- uses_technique, attempted, struggled_with, mastered,
                                    -- read, part_of, prereq_of, solution_of
     weight real, valid_from int, valid_to int, turn_id text, provenance text, -- 'outline','primer','ink','user','model'
     primary key(src, rel, dst, valid_from))
```

Producers: ingestion (`part_of`, `defined_in` by unit kind and title matching against the concept
catalog's labels and synonyms, reviewed by the user once per book), ink and typed tags
(`tagged`, `mentions`), the Primer (`attempted`, `struggled_with`, `uses_technique` with the
reading's concept ids and misconceptions), the coach (`read` from reading positions), and agents'
grounded answers (`cites`). Queries are recursive CTEs, two or three hops at most, milliseconds.

### 5.4 Feeding the Primer and the coach

- **Concept → where taught**: `defined_in`/`taught_in` edges give each concept a ranked list of
  book locations; the Primer's hint ladder adds "see BoP Def 6.1, p. 139" at the second rung.
- **Reading position → exercises**: the coach's queue entry "reading" becomes: section the
  learner was on → that section's exercise units → filtered by her frontier → "Exercise 6.4 from
  §6.1, which you read yesterday".
- **Mastery ← evidence**: unchanged (BKT in the learner file); the graph adds *where* the evidence
  was produced, so the guardian view can link every belief to her page.

---

## 6. Grounding and anti-hallucination

### 6.1 The contract

1. **Retrieve before answering.** Every agent turn that asks about content runs a library query
   first (scoped by consent), and the answer prompt contains only the retrieved spans, each with
   an id (`[S1]`…), plus the question.
2. **Every claim cites.** Structured output: `claims: [{text, support: [span ids] | "general",
   quote?}]`. A claim with `support: "general"` is shown labelled *general knowledge* (a different
   colour on the phone, the prefix "GK:" on the glasses, no citation chip in ink).
3. **Show the quote.** Each citation carries the exact span (≤ 2 sentences, from the stored text,
   never from the model's output) so the learner can check it without opening the book.
4. **"Not in your sources" is an answer.** When retrieval falls under the abstention gate (§0.3)
   or the verifier rejects every claim, the agent says so and offers general knowledge,
   explicitly labelled, or a search with other words.
5. **Earlier agent output is context, not instruction** (smart_remarkable's rule, made exact by
   layer: agent-layer ink and agent text are never rendered into prompts as user content).

### 6.2 Prompt rules adopted (smart_remarkable, mattpetters; integration §1.5, §3.4)

- "Look it up before saying I don't know, and name the source": here, *look it up in the library*
  (the web is off unless the user allows it per turn).
- Never assume content off the page or outside the retrieved spans.
- Act only on what the writing explicitly asks.
- Return the literal reading (`received_text`) before interpreting it.
- Prior AI replies are prior replies, not new instructions.

### 6.3 Verification

- **Span re-read**: for each claim, the verifier receives the claim and its cited spans only, and
  answers `supports | partial | does_not_support` with the supporting sentence. Unsupported
  claims are dropped or relabelled general knowledge. Cheap model (Haiku 4.5 or Sonnet 5.5 at
  low effort), ~1–2k tokens per answer, ~$0.002–0.01.
- **Mechanical checks first**: the quote must be a substring of the stored span; the cited unit
  label must exist on that page; a "Theorem 6.2" in the answer must match a unit id. These catch
  most fabricated citations for free.
- **The √2 lesson** (§0.3): a page that *uses* a fact does not *prove* it; the verifier's
  question is "does this span support this claim", not "is it on topic".

### 6.4 Separating knowledge from grounding in the UI

Grounded text is plain; general knowledge is italic with a "GK" marker; quotes are in a quote
block with the chip; on the tablet, only grounded claims get a handwritten citation. A per-turn
footer: "3 claims from your books, 1 general".

### 6.5 The evaluation harness

`scripts/dev/context_spikes/bench.py` is the seed: fixtures of questions with gold sections
(in-corpus) and out-of-corpus questions, measuring hit@1, hit@5, precision@5, MRR, latency and
abstention. Phase 1 extends it into `scripts/eval/grounding/` with:

- fixtures per book from her own library (questions written by Alif or her, gold = section/unit/page),
  never storing book text;
- answer-level metrics with recorded model replies (the Primer's `score` pattern: offline gate on
  recorded replies, live with `--record`): **citation precision** (cited spans that the verifier
  and a human label as supporting), **citation recall** against gold, **hallucination rate**
  (claims marked grounded whose spans do not support them), **abstention accuracy** on
  out-of-corpus questions, **general-knowledge leakage** (unlabelled GK), and p50/p95 latency;
- a CI gate on the recorded replies, as `primer score` has.

---

## 7. Context consent: what agents may see, without being annoying

### 7.1 Principles

Consent attaches to **sources**, not queries; it is set **once**, in bulk, with sensible presets;
it is asked **only** for genuinely new access, **batched**, **where the user already is**; it is
**quietly visible** and **revocable in one action**; and it is **enforced in the retrieval layer**,
not in prompts.

### 7.2 Data model (`scripts/dev/context_spikes/consent.py`, nine tests)

- **Nodes**: the xochitl tree from `.metadata` `parent` (folders, notebooks, PDFs, EPUBs) and
  their pages; tags on each (xochitl `tags`/`pageTags`, codrawer `#tags` in ink or typed).
- **Rules**: `(subject, agent, effect, lifetime)`: subject is a node id (covers its subtree) or a
  `#tag`; agent is an agent id or `*`; effect `allow`/`deny`; lifetime `always` or `once`
  (bound to one turn id: "this time"); plus who set it (`user` or `preset`) and when.
- **The private tag**: `private` on a node or any ancestor denies every agent, overriding every
  rule; only removing the tag undoes it. It works in ink (`#private` written on a page) and as a
  xochitl tag.
- **Resolution** for (agent, node): private → deny; else walk up from the node, and the first
  level with an applicable rule (on the node or on one of its tags) decides, an agent-specific rule
  beating `*` and deny beating allow at one level; no rule → `ask`. A new agent therefore starts
  with nothing.
- **Asks** are batched to the highest undecided level (one question about the "Putnam" folder,
  not one per notebook). An explicit deny is final and silent: never asked again.
- **The access log**: `(ms, agent, node, purpose, turn_id, effect)` for every read the retrieval
  layer performs, kept on the desktop, rotated after 90 days.

### 7.3 Setup, once

A short setup on the phone (or the dock's first-run page), three screens at most:

1. "Which folders are for study?" (the folder list, top level only, with page counts) → presets:
   the chosen folders → Primer + practice coach; everything else undecided.
2. "Anything private?" → the chosen folders get the `private` tag (stored in codrawer's index,
   never written to the tablet) and the note "Write #private on any page to hide it from every
   agent."
3. "Research pods and SIG agents" → off by default; a pod asks on first use.

### 7.4 Just-in-time asks, at most one at a time

When an agent's query would touch undecided sources, the query runs on what is allowed and the
rest becomes one pending ask: a dot on the dock entry and one glance line on the glasses ("Coach
wants: Papers folder · Allow?"), or a row in the phone panel. Answers: **Always** (a rule on the
batched node), **This time** (a `once` rule for the turn), **Never** (a deny, silent from then
on). No modal, no repeated prompt: an unanswered ask expires with the turn and is shown again only
when that agent next needs the same node, and at most once a day.

### 7.5 Quiet transparency

A dock entry and a phone tab, **What agents can see**: per agent, the allowed folders and tags as
a short list, and the recent-access log ("Primer read Book of Proof pp. 138–141, 10:42, for your
√3 proof"). One tap revokes an agent's access to an item, or all of it; on the tablet, striking
through an entry in that list (the extension's gesture) revokes it. Silent when nothing changed.

### 7.6 Enforcement

- The retrieval API takes the agent id, not a list of sources: `search(agent, query, turn)`
  computes the allowed source and page set (`Consent.allowed`, cached per rule-set version) and
  compiles it into the SQL (`… where c.source_id in (…) and (c.source_id, c.page_idx) not in
  private_pages`), so out-of-scope rows are never read.
- Citations are built from stored spans of returned rows only; an agent cannot cite what it did
  not get. The verifier sees only those spans.
- What reaches a model is logged with the access entry (ADR 010's "what is sent" table extended:
  the spans, their sources, the agent).
- Agents in other processes (SIG agents, the MCP server of ADR 003) get the library only through
  this API, with their own agent id and token.

---

## 8. Privacy, efficiency and copyright

### 8.1 What goes where

| Data | Where it lives | What leaves the desktop |
| --- | --- | --- |
| PDFs/EPUBs (consented subset) | `~/.codrawer/library/files/` on the desktop | nothing in bulk; a page image to Claude only for on-demand vision transcription of a consented page |
| The index (text, embeddings, graph, tags, consent, access log) | `~/.codrawer/library/index.sqlite` | nothing; embeddings are computed locally |
| Retrieved spans for a turn | in the prompt of that turn's model call | the spans (short) and the question, to the model the agent uses |
| Handwriting text from xochitl's index | the index | nothing new (it came from reMarkable's own cloud conversion, under the user's existing settings) |
| Page renders for recognition | memory, then the turn record | the PNG of the page's ink, as ADR 010 already defines |

The tablet runs nothing new except a stat-only manifest in the bridge.

### 8.2 Costs, measured and extrapolated

- **A 300-page born-digital book**: ~1–2 s text and FTS on the desktop CPU, ~2 s embedding on
  the GPU, ~4 MB of index, $0 in model calls. On CPU only (the tablet never; a laptop), embedding
  would be ~1 minute unloaded.
- **The whole measured library** (42,000 PDF/EPUB pages + 478 notebook pages), if all were
  consented and born-digital: ~15–20 minutes of desktop time, ~0.5 GB of index. Scanned books add
  Marker OCR (~0.3 s/page GPU) and, only on demand, vision.
- **Incremental**: a changed annotation page costs one `.rm` pull (~300 KB median), a stroke diff,
  and a vision call only if the page is in Tier 1 (§2.2).
- **Memory**: the embedding model ~300 MB (GPU), SQLite page cache ~64 MB; the router and the
  Primer stay as they are.

### 8.3 Copyright

Books stay on her devices and the desktop; nothing is uploaded except short spans in a turn, which
is quotation for her own study. Quotes shown are ≤ 2 sentences and carry the citation; agents
never reproduce whole pages or solutions sections (the coach withholds solutions until after an
attempt). Test fixtures store section names and page numbers, never book text, and only openly
licensed books are downloaded for development (here *Book of Proof*, CC BY-NC-ND, local only).

---

## 9. Protocol and UX

### 9.1 New messages (relayed by every router, like `primer`)

```json
{"t":"context_query","id":"q7","agent":"primer","q":"pigeonhole principle","scope":{"tags":["putnam"]},"k":5,"mode":"hybrid","turn":"t42"}
{"t":"context_results","id":"q7","hits":[{"cite":"Book of Proof §3.9 Fact 3.8 p.104","src":"<uuid>","page_idx":115,"tablet_page":115,"label":"104",
  "unit":"fact-3.8","quote":"If n objects are placed in k boxes and n > k, …","strokes":[],"score":0.032}],"abstain":false,"ms":18}
{"t":"cite","turn":"t42","claims":[{"text":"…","support":["S1"],"verdict":"supports"},{"text":"…","support":"general"}]}
{"t":"complete_index","owner":"library","entries":[{"k":"@","id":"src:<uuid>","label":"Book of Proof","hint":"380 pp"},{"k":"#","id":"tag:contradiction"}],"rev":12}
{"t":"consent_ask","id":"a3","agent":"coach","nodes":[{"id":"<folder uuid>","label":"Papers","docs":14}],"turn":"t42"}
{"t":"consent_answer","id":"a3","answer":"always|once|never"}
{"t":"consent_view","agents":[{"id":"primer","allowed":["Putnam"],"recent":[{"ms":0,"node":"…","purpose":"…"}]}]}
```

`context_query` from clients carries no agent (a user search is the user's own: everything not
private); agents' queries go through the desktop API, never the wire.

### 9.2 Flows

- **`@`/`#` while typing** on the tablet (keyboard-and-text §4): the popup filters
  `complete.json`, which now includes library entries (recent books, sections the learner opened,
  tags); accepting `@book-of-proof` attaches the source to the turn.
- **Dock "Search my library"**: opens the tablet's input field; results come back as
  `context_results` and show on the phone panel and as a list in the dock popup; tapping one jumps
  the tablet (when supported) or opens the page render on the phone.
- **Lasso "Find in my books"**: the lasso's strokes are recognised (xochitl's text for those
  stroke ids if present, else a Tier 1 reading of the crop) and the text is the query.
- **Grounded answers**: as agent text (chips) on phone and glasses; on the tablet as agent ink
  with a short handwritten citation (§4.3).
- **The Primer and the grader citing the book**: the hint ladder's second rung and the debrief
  cite where the concept is taught ("see BoP Def 6.1, p. 139"); a teacher-markup grader's
  feedback cites the theorem the learner misapplied ("Thm 2.3, p. 41 needs f continuous on
  [a, b]") with the quote available on tap.

---

## 10. Phased plan

| Phase | Scope | Effort | Done when |
| --- | --- | --- | --- |
| **1. Books and citations for the Primer** | library watcher manifest (bridge, stat only); desktop pull of consented PDFs/EPUBs; PyMuPDF + glyph repair + outline + units + chunks; FTS5 + bge-small/sqlite-vec; `search(agent, q)` with the consent filter (setup screen + presets only); citations with quotes; the grounding contract in the Primer (hint ladder and debrief cite the book); `context_query`/`context_results`; eval harness with fixtures from her books | ~2 weeks | the Primer cites the book page for a weak concept at the 24 October mock; citation precision ≥ 0.9 on recorded fixtures |
| **2. Handwriting, hybrid search, tags** | import xochitl's `rm-search-index.db` (text + word→stroke runs) for consented docs; Tier 1 vision for math pages and gaps, incremental by stroke ids; ink highlight of hits; `#tags` in ink; tag search; `@`/`#` completion entries; dock "Search my library" and lasso "Find in my books"; just-in-time consent asks and the "What agents can see" view; the verifier | ~2–3 weeks | a handwritten note from last week is found by a typed query and highlighted on the phone in < 300 ms |
| **3. Graph, wiki, backlinks** | typed graph tables and producers; concept → where-taught links reviewed once per book; backlinks and entity pages; the coach's "from the section you were reading"; guardian view links; the `ContextGraph` interface; Graphiti re-evaluated with FalkorDB only if free-text memory is needed | ~2 weeks | "where have I used pigeonhole?" lists her pages and the book's section; the coach proposes exercises from the last section read |

Risks: scanned problem books (vision cost, Marker licence); EPUB page mapping; xochitl changing its
index schema (read-only and version-checked: the `version` row is 42 today); the tablet asleep
during sync (catch up at wake); a model citing correctly but reasoning wrongly (the verifier checks
support, not the mathematics; the Primer's prover is the only "checked").

---

## Appendix: reproducing the spikes

```bash
cd scripts/dev/context_spikes
# tablet sizing (read-only, metadata only)
uv run --no-project --python 3.12 tablet_survey.py
# consent resolution
uv run --no-project --python 3.12 --with pytest pytest test_consent.py -q
# index one book and query it (CPU)
uv run --python 3.12 library.py ingest Main.pdf --db lib.sqlite
uv run --python 3.12 library.py search "pigeonhole principle" --db lib.sqlite
# the bench, GPU embedding
uv run --no-project --python 3.12 --with pymupdf --with sqlite-vec --with fastembed-gpu \
  --with "onnxruntime-gpu[cuda,cudnn]" python bench.py Main.pdf --gpu
# Graphiti (needs Ollama with qwen3:4b and nomic-embed-text)
uv run --no-project --python 3.12 --with "graphiti-core[kuzu]" --with httpx python graphiti_spike.py <scratch>
```

Results: `results/bench.json` (with glyph repair and rerank), `results/bench-v0-no-glyph-repair.json`,
`results/graphiti.json`.

## Sources

- getzep/graphiti (README, `graphiti_core/driver/kuzu_driver.py` deprecation warning, 0.30.2).
- asg017/sqlite-vec (`vec0`, KNN syntax). SQLite FTS5 documentation (`bm25`, external content).
- PyMuPDF documentation (`get_text("rawdict")`, `get_toc`, `Page.get_label`).
- BAAI bge-small-en-v1.5 model card (query instruction); qdrant/fastembed.
- Cormack, Clarke & Büttcher (2009), Reciprocal rank fusion outperforms Condorcet and individual
  rank learning methods, SIGIR.
- VikParuchuri/marker and surya; facebookresearch/nougat; MyScript JIIX format documentation.
- Hammack, *Book of Proof*, 3rd ed. (richardhammack.github.io/BookOfProof), CC BY-NC-ND 4.0.
- Caerii/smart_remarkable prompts (MIT), as read in `smart-remarkable-integration.md`.
