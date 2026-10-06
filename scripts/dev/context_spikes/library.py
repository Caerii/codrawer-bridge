# /// script
# requires-python = ">=3.11"
# dependencies = ["pymupdf>=1.24", "sqlite-vec>=0.1.6", "fastembed>=0.4"]
# ///
"""
The library index, as a spike: one PDF in, an SQLite file out that answers hybrid queries with
citations a learner can check.

**The problem.** An agent that tutors from the learner's own books must answer *from* them: every
claim tied to a book, a section and a printed page, with the quoted span, and "not in your
sources" when retrieval finds nothing (docs/adr/011-grounded-context-and-library.md). This spike
measures whether the cheapest pipeline that could do that (PyMuPDF text, SQLite FTS5, a small
local embedding model in sqlite-vec, reciprocal-rank fusion) is fast and accurate enough on a real
math book, before any of it goes into `src/`.

**Facts it rests on.**

- PyMuPDF reads the outline (`get_toc`, 1-based page numbers) and the printed page labels
  (`Page.get_label`, from the PDF's /PageLabels), so a citation can say "p. 41" as the book prints
  it while the index keys on the 0-based page index, which is also the reMarkable page index for
  an unedited PDF (`.content` `redirectionPageMap` maps it when pages were inserted; §1.1 of the
  investigation).
- FTS5 ships in Python's sqlite3. `bm25()` is lower-is-better.
- sqlite-vec's `vec0` table does exact KNN over float32 vectors; at book scale (10^3 to 10^5
  chunks) brute force is milliseconds, so no ANN index is needed.
- `BAAI/bge-small-en-v1.5` (384 dimensions, ~130 MB ONNX, CPU via fastembed) wants the query
  prefix "Represent this sentence for searching relevant passages: ".
- Reciprocal-rank fusion (Cormack, Clarke & Büttcher 2009) needs no score calibration between the
  two retrievers: score = Σ 1/(k + rank), k = 60.

**Data flow.** `ingest(pdf)` → pages (text, label) → sections from the outline → "units"
(Definition 4.1, Theorem 6.2, Example 3.19, exercise blocks) by a line regex → chunks (text blocks
of one page merged to ~900 characters, never across a page, so a chunk cites exactly one page) →
FTS5 over the text plus a math-normalised copy → embeddings. `search(q)` → FTS top 30 and vector
top 30 → RRF → hits with source, section, unit, printed page, PDF page index and a short quote.

Run: `uv run scripts/dev/context_spikes/library.py ingest BOOK.pdf --db lib.sqlite`, then
`... search "pigeonhole principle" --db lib.sqlite`. The bench (bench.py) times all of it.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sqlite3
import struct
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path

EMBED_MODEL = "BAAI/bge-small-en-v1.5"
EMBED_DIM = 384
QUERY_PREFIX = "Represent this sentence for searching relevant passages: "
CHUNK_CHARS = 900
RRF_K = 60

# =============================================================================================
# Math normalisation
# =============================================================================================

#: Unicode mathematics as PDFs extract it, and the LaTeX a learner types, mapped to one token
#: vocabulary so "\subseteq", "⊆" and "subset" meet in the index. The same function runs on the
#: indexed text and on the query (both sides must agree, or nothing matches).
MATH_TOKENS: dict[str, str] = {
    "∈": "mathin", "\\in": "mathin", "∉": "mathnotin", "\\notin": "mathnotin",
    "⊆": "mathsubseteq", "\\subseteq": "mathsubseteq", "⊂": "mathsubset", "\\subset": "mathsubset",
    "∪": "mathcup", "\\cup": "mathcup", "∩": "mathcap", "\\cap": "mathcap",
    "∀": "mathforall", "\\forall": "mathforall", "∃": "mathexists", "\\exists": "mathexists",
    "⇒": "mathimplies", "\\implies": "mathimplies", "\\Rightarrow": "mathimplies",
    "⇔": "mathiff", "\\iff": "mathiff", "\\Leftrightarrow": "mathiff",
    "¬": "mathneg", "\\neg": "mathneg", "∧": "mathwedge", "\\wedge": "mathwedge",
    "∨": "mathvee", "\\vee": "mathvee", "≡": "mathequiv", "\\equiv": "mathequiv",
    "≤": "mathleq", "\\leq": "mathleq", "\\le": "mathleq", "≥": "mathgeq", "\\geq": "mathgeq",
    "\\ge": "mathgeq", "≠": "mathneq", "\\neq": "mathneq", "√": "mathsqrt", "\\sqrt": "mathsqrt",
    "∑": "mathsum", "\\sum": "mathsum", "∏": "mathprod", "\\prod": "mathprod",
    "∞": "mathinfty", "\\infty": "mathinfty", "∅": "mathemptyset", "\\emptyset": "mathemptyset",
    "×": "mathtimes", "\\times": "mathtimes", "◦": "mathcirc", "\\circ": "mathcirc",
    "|": "mathmid", "\\mid": "mathmid", "ℕ": "mathbbN", "\\mathbb{N}": "mathbbN",
    "ℤ": "mathbbZ", "\\mathbb{Z}": "mathbbZ", "ℚ": "mathbbQ", "\\mathbb{Q}": "mathbbQ",
    "ℝ": "mathbbR", "\\mathbb{R}": "mathbbR", "ℂ": "mathbbC", "\\mathbb{C}": "mathbbC",
    "P(": "mathpowerset (",
}
_MATH_RE = re.compile(
    "|".join(re.escape(k) for k in sorted(MATH_TOKENS, key=len, reverse=True))
)
#: TeX-built PDFs often encode big delimiters in font slots that extract as Latin-1 glyphs
#: (measured on Book of Proof: "©r,g,bª" for {r,g,b}, "¡22 20¢" for a binomial).
_DELIM_FIX = str.maketrans({"©": "{", "ª": "}", "¡": "(", "¢": ")", "ﬁ": "fi", "ﬂ": "fl"})


def clean(text: str) -> str:
    """Extraction repair: ligatures and the TeX big-delimiter glyphs back to ASCII."""
    return text.translate(_DELIM_FIX)


def math_normalise(text: str) -> str:
    """Text with mathematical symbols and LaTeX commands replaced by `math*` tokens."""
    return _MATH_RE.sub(lambda m: f" {MATH_TOKENS[m.group(0)]} ", text)


# =============================================================================================
# Schema
# =============================================================================================

SCHEMA = """
create table if not exists source(
  id integer primary key, kind text, title text, path text, sha256 text, pages int,
  ingested_ms int, extractor text);
create table if not exists page(
  source_id int, idx int, label text, chars int, primary key(source_id, idx));
create table if not exists section(
  id integer primary key, source_id int, level int, title text, start_idx int, end_idx int,
  parent_id int);
create table if not exists unit(
  id integer primary key, source_id int, kind text, number text, page_idx int, section_id int);
create table if not exists chunk(
  id integer primary key, source_id int, page_idx int, section_id int, unit_id int, ord int,
  text text, bbox text);
create virtual table if not exists chunk_fts using fts5(
  text, math, section, content='', tokenize='porter unicode61');
"""


def connect(db: str | Path) -> sqlite3.Connection:
    """Open the index with sqlite-vec loaded and the schema in place."""
    import sqlite_vec

    con = sqlite3.connect(db)
    con.enable_load_extension(True)
    sqlite_vec.load(con)
    con.enable_load_extension(False)
    con.executescript(SCHEMA)
    con.execute(
        f"create virtual table if not exists chunk_vec using vec0(embedding float[{EMBED_DIM}])"
    )
    return con


# =============================================================================================
# Ingestion
# =============================================================================================

UNIT_RE = re.compile(
    r"^(Definition|Theorem|Lemma|Corollary|Proposition|Example|Fact|Exercises? for (?:Chapter|Section))"
    r"\s+(\d+(?:\.\d+)*)",
    re.M,
)


@dataclass
class Timings:
    """Wall-clock seconds per stage; `counts` holds the sizes the stages produced."""

    stages: dict[str, float] = field(default_factory=dict)
    counts: dict[str, int] = field(default_factory=dict)

    def mark(self, name: str, t0: float) -> float:
        now = time.perf_counter()
        self.stages[name] = round(now - t0, 3)
        return now


def _embedder():
    from fastembed import TextEmbedding

    return TextEmbedding(EMBED_MODEL)


def _f32(vec) -> bytes:
    return struct.pack(f"{len(vec)}f", *vec)


def ingest(pdf: Path, db: str | Path, embed: bool = True) -> Timings:
    """
    Index one PDF. Idempotent by content hash: a PDF whose sha256 is already indexed is skipped,
    which is how incremental sync avoids re-ingesting a book whose file did not change.
    """
    import pymupdf

    tm = Timings()
    t = time.perf_counter()
    con = connect(db)
    data = pdf.read_bytes()
    sha = hashlib.sha256(data).hexdigest()
    if con.execute("select 1 from source where sha256=?", (sha,)).fetchone():
        tm.counts["skipped"] = 1
        return tm
    doc = pymupdf.open(stream=data, filetype="pdf")
    title = (doc.metadata or {}).get("title") or pdf.stem
    cur = con.execute(
        "insert into source(kind,title,path,sha256,pages,ingested_ms,extractor) values(?,?,?,?,?,?,?)",
        ("pdf", title, str(pdf), sha, doc.page_count, int(time.time() * 1000), "pymupdf"),
    )
    sid = cur.lastrowid
    t = tm.mark("open", t)

    # Sections from the outline. end_idx is the page before the next entry at the same or a
    # higher level (or the last page).
    toc = doc.get_toc()
    sections: list[tuple[int, int, str, int, int]] = []  # (id, level, title, start, end)
    stack: list[tuple[int, int]] = []  # (level, id)
    for i, (lvl, ttl, p1) in enumerate(toc):
        start = max(0, p1 - 1)
        end = doc.page_count - 1
        for lvl2, _, p2 in toc[i + 1 :]:
            if lvl2 <= lvl:
                end = max(start, p2 - 2)
                break
        while stack and stack[-1][0] >= lvl:
            stack.pop()
        parent = stack[-1][1] if stack else None
        sec = con.execute(
            "insert into section(source_id,level,title,start_idx,end_idx,parent_id) values(?,?,?,?,?,?)",
            (sid, lvl, ttl, start, end, parent),
        ).lastrowid
        stack.append((lvl, sec))
        sections.append((sec, lvl, ttl, start, end))

    def section_for(idx: int) -> tuple[int | None, str]:
        best = None
        for s in sections:  # deepest section containing the page
            if s[3] <= idx <= s[4] and (best is None or s[1] >= best[1]):
                best = s
        return (best[0], best[2]) if best else (None, "")

    # Pages, units and chunks.
    chunks: list[tuple[int, str]] = []
    n_units = 0
    for idx in range(doc.page_count):
        page = doc[idx]
        label = page.get_label() or str(idx + 1)
        blocks = [b for b in page.get_text("blocks") if b[6] == 0 and b[4].strip()]
        text = clean("".join(b[4] for b in blocks))
        con.execute("insert into page values(?,?,?,?)", (sid, idx, label, len(text)))
        sec_id, sec_title = section_for(idx)
        unit_id = None
        for m in UNIT_RE.finditer(text):
            unit_id = con.execute(
                "insert into unit(source_id,kind,number,page_idx,section_id) values(?,?,?,?,?)",
                (sid, m.group(1).split()[0].lower(), m.group(2), idx, sec_id),
            ).lastrowid
            n_units += 1
        buf, box, ord_ = "", None, 0

        def flush() -> None:
            nonlocal buf, box, ord_
            if buf.strip():
                cid = con.execute(
                    "insert into chunk(source_id,page_idx,section_id,unit_id,ord,text,bbox) values(?,?,?,?,?,?,?)",
                    (sid, idx, sec_id, unit_id, ord_, buf.strip(), json.dumps(box)),
                ).lastrowid
                con.execute(
                    "insert into chunk_fts(rowid,text,math,section) values(?,?,?,?)",
                    (cid, buf, math_normalise(buf), sec_title),
                )
                chunks.append((cid, f"{sec_title}\n{buf.strip()}"))
                ord_ += 1
            buf, box = "", None

        for b in blocks:
            bt = clean(b[4])
            if len(buf) + len(bt) > CHUNK_CHARS and buf:
                flush()
            buf += bt
            r = [round(v, 1) for v in b[:4]]
            box = r if box is None else [min(box[0], r[0]), min(box[1], r[1]), max(box[2], r[2]), max(box[3], r[3])]
        flush()
    con.commit()
    tm.counts.update(pages=doc.page_count, sections=len(sections), units=n_units, chunks=len(chunks))
    t = tm.mark("extract_fts", t)

    if embed:
        model = _embedder()
        t = tm.mark("embed_load", t)
        vecs = model.embed([c[1] for c in chunks], batch_size=64)
        for (cid, _), v in zip(chunks, vecs, strict=True):
            con.execute("insert into chunk_vec(rowid, embedding) values(?, ?)", (cid, _f32(v)))
        con.commit()
        tm.mark("embed", t)
    con.close()
    return tm


# =============================================================================================
# Search
# =============================================================================================


@dataclass
class Hit:
    """One cited passage. `page_idx` is 0-based (the reMarkable page index for an unedited PDF);
    `page_label` is what the book prints."""

    chunk_id: int
    source: str
    section: str
    unit: str
    page_idx: int
    page_label: str
    quote: str
    fts_rank: int | None
    vec_rank: int | None
    vec_dist: float | None
    score: float

    def cite(self) -> str:
        unit = f"{self.unit}, " if self.unit else ""
        return f"{self.source}, {self.section}, {unit}p. {self.page_label}"


_FTS_WORD = re.compile(r"[\w]+")


def fts_query(q: str) -> str:
    """A safe FTS5 MATCH string: the query's words (math-normalised) OR'd, each quoted."""
    words = [w for w in _FTS_WORD.findall(math_normalise(q)) if len(w) > 1]
    return " OR ".join(f'"{w}"' for w in words) or '""'


class Searcher:
    """Holds the connection and the embedding model warm, as the desktop service would."""

    def __init__(self, db: str | Path, embed: bool = True):
        self.con = connect(db)
        self.model = _embedder() if embed else None

    def fts(self, q: str, k: int = 30) -> list[int]:
        rows = self.con.execute(
            "select rowid from chunk_fts where chunk_fts match ? order by bm25(chunk_fts, 1.0, 1.0, 2.0) limit ?",
            (fts_query(q), k),
        ).fetchall()
        return [r[0] for r in rows]

    def vec(self, q: str, k: int = 30) -> list[tuple[int, float]]:
        if not self.model:
            return []
        v = next(iter(self.model.embed([QUERY_PREFIX + q])))
        rows = self.con.execute(
            "select rowid, distance from chunk_vec where embedding match ? and k = ? order by distance",
            (_f32(v), k),
        ).fetchall()
        return [(r[0], r[1]) for r in rows]

    def search(self, q: str, k: int = 5, mode: str = "hybrid") -> list[Hit]:
        f = self.fts(q) if mode in ("hybrid", "fts") else []
        v = self.vec(q) if mode in ("hybrid", "vec") else []
        score: dict[int, float] = {}
        frank = {cid: i for i, cid in enumerate(f)}
        vrank = {cid: i for i, (cid, _) in enumerate(v)}
        vdist = dict(v)
        for cid, r in frank.items():
            score[cid] = score.get(cid, 0) + 1 / (RRF_K + r + 1)
        for cid, r in vrank.items():
            score[cid] = score.get(cid, 0) + 1 / (RRF_K + r + 1)
        top = sorted(score, key=score.get, reverse=True)[:k]
        hits = []
        for cid in top:
            row = self.con.execute(
                """select s.title, coalesce(sec.title,''), coalesce(u.kind||' '||u.number,''),
                          c.page_idx, p.label, c.text
                   from chunk c join source s on s.id=c.source_id
                   left join section sec on sec.id=c.section_id
                   left join unit u on u.id=c.unit_id
                   join page p on p.source_id=c.source_id and p.idx=c.page_idx
                   where c.id=?""",
                (cid,),
            ).fetchone()
            hits.append(
                Hit(cid, row[0], row[1], row[2].title(), row[3], row[4], quote(row[5], q),
                    frank.get(cid), vrank.get(cid), vdist.get(cid), round(score[cid], 5))
            )
        return hits

    def complete(self, prefix: str, k: int = 8) -> list[tuple[str, str, int]]:
        """`@` completion over section titles and unit labels (prefix match, no model)."""
        p = prefix.lower()
        secs = self.con.execute(
            "select 'section', title, start_idx from section where lower(title) like ? limit ?",
            (f"%{p}%", k),
        ).fetchall()
        units = self.con.execute(
            "select 'unit', kind||' '||number, page_idx from unit where lower(kind||' '||number) like ? limit ?",
            (f"{p}%", k),
        ).fetchall()
        return (secs + units)[:k]


def quote(text: str, q: str, width: int = 240) -> str:
    """A short quote around the first query word found: short by design (copyright, §7)."""
    words = [w.lower() for w in _FTS_WORD.findall(q) if len(w) > 3]
    low = text.lower()
    pos = min((low.find(w) for w in words if low.find(w) >= 0), default=0)
    start = max(0, pos - width // 3)
    s = " ".join(text[start : start + width].split())
    return ("…" if start else "") + s + ("…" if start + width < len(text) else "")


# =============================================================================================
# CLI
# =============================================================================================


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    a1 = sub.add_parser("ingest")
    a1.add_argument("pdf", type=Path)
    a1.add_argument("--db", default="library.sqlite")
    a1.add_argument("--no-embed", action="store_true")
    a2 = sub.add_parser("search")
    a2.add_argument("query")
    a2.add_argument("--db", default="library.sqlite")
    a2.add_argument("--mode", default="hybrid", choices=["hybrid", "fts", "vec"])
    a = ap.parse_args()
    if a.cmd == "ingest":
        tm = ingest(a.pdf, a.db, embed=not a.no_embed)
        print(json.dumps({"stages_s": tm.stages, "counts": tm.counts}, indent=1))
    else:
        s = Searcher(a.db, embed=a.mode != "fts")
        t0 = time.perf_counter()
        hits = s.search(a.query, mode=a.mode)
        dt = (time.perf_counter() - t0) * 1000
        for h in hits:
            print(f"[{h.cite()}] (pdf page {h.page_idx}, fts#{h.fts_rank} vec#{h.vec_rank})\n  {h.quote}")
        print(f"{dt:.1f} ms")


if __name__ == "__main__":
    main()
