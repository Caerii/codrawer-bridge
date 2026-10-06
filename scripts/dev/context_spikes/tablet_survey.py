# /// script
# requires-python = ">=3.11"
# ///
"""
Size the library on the tablet from its metadata alone, read-only, and print aggregates.

**The problem.** Before designing ingestion we need the shape of the learner's library: how many
PDFs, EPUBs and notebooks, how many pages, how much annotation ink, which tags exist, and whether
xochitl already keeps text we could reuse. The rule for this spike (grounded-context research,
2026-10-06): read metadata only, never copy a PDF, EPUB or notebook page off the device, write
nothing on it, and print only counts and sizes (no titles).

**What it reads.** Over `ssh root@<tablet>`:

1. `ls -l` of the xochitl folder (file sizes per extension), and a count of `.rm` page files per
   document folder.
2. A tar stream of `*.metadata` and `*.content` (JSON, ~14 MB together), unpacked in memory and
   never written to disk. From them: document type (`.content` `fileType`: pdf, epub, notebook),
   folders, trash, page counts (`cPages.pages`, or `pageCount`), PDF original page counts,
   document `tags` and `pageTags`, and `lastOpened` recency.
3. xochitl's own search index, `rm-search-index.db` (an SQLite FTS5 table; schema found on
   2026-10-06, see docs/investigations/grounded-context.md §1.4). It is streamed into an
   in-memory SQLite (`Connection.deserialize`), and only **counts** are printed: rows by `type`,
   how many rows carry handwritten or digital text, the total characters, and the JSON *shape* of
   one `wordStrokes` value with every string replaced by its length. No text is printed or stored.

Tag names are printed, since "tags present" is part of the sizing; pass `--no-tag-names` to
print counts only.

Usage: `uv run scripts/dev/context_spikes/tablet_survey.py [--host root@192.168.50.156]`
"""

from __future__ import annotations

import argparse
import collections
import io
import json
import sqlite3
import statistics
import subprocess
import tarfile
import time

XOCHITL = "/home/root/.local/share/remarkable/xochitl"


def ssh(host: str, cmd: str) -> bytes:
    """Run one read-only command on the tablet and return its stdout."""
    return subprocess.run(
        ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", host, cmd],
        check=True,
        capture_output=True,
        timeout=300,
    ).stdout


def shape(v, depth=0):
    """The JSON shape of a value with strings replaced by their length (no content leaks)."""
    if isinstance(v, dict):
        return {k: shape(x, depth + 1) for k, x in list(v.items())[:12]}
    if isinstance(v, list):
        return [shape(v[0], depth + 1), f"... x{len(v)}"] if v else []
    if isinstance(v, str):
        return f"<str len {len(v)}>"
    return type(v).__name__


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="root@192.168.50.156")
    ap.add_argument("--no-tag-names", action="store_true")
    a = ap.parse_args()

    t0 = time.perf_counter()
    # 1. sizes by extension, and .rm counts per document folder
    listing = ssh(a.host, f"cd {XOCHITL} && ls -l | awk '{{print $5, $9}}'").decode()
    size_by_ext: dict[str, list[int]] = collections.defaultdict(list)
    for line in listing.splitlines():
        parts = line.split(" ", 1)
        if len(parts) != 2 or not parts[0].isdigit():
            continue
        name = parts[1]
        ext = name.split(".", 1)[1] if "." in name else "(dir)"
        size_by_ext[ext].append(int(parts[0]))
    rm_counts_raw = ssh(
        a.host, f"cd {XOCHITL} && find . -name '*.rm' | cut -d/ -f2 | sort | uniq -c"
    ).decode()
    rm_per_doc = {
        ln.split()[1]: int(ln.split()[0]) for ln in rm_counts_raw.splitlines() if ln.strip()
    }

    # 2. metadata and content, in memory
    blob = ssh(a.host, f"cd {XOCHITL} && tar cf - *.metadata *.content 2>/dev/null")
    meta: dict[str, dict] = {}
    content: dict[str, dict] = {}
    with tarfile.open(fileobj=io.BytesIO(blob)) as tf:
        for m in tf.getmembers():
            raw = tf.extractfile(m)
            if raw is None:
                continue
            uid, ext = m.name.rsplit(".", 1)
            try:
                obj = json.loads(raw.read().decode("utf-8", "replace") or "{}")
            except json.JSONDecodeError:
                continue
            (meta if ext == "metadata" else content)[uid] = obj

    kinds = collections.Counter()
    pages_by_kind: dict[str, list[int]] = collections.defaultdict(list)
    annotated = collections.Counter()
    ink_pages_by_kind = collections.Counter()
    doc_tags = collections.Counter()
    page_tags = collections.Counter()
    docs_with_tags = docs_with_pagetags = 0
    trashed = folders = 0
    recency = collections.Counter()
    now_ms = time.time() * 1000
    for uid, md in meta.items():
        if md.get("type") == "CollectionType":
            folders += 1
            continue
        if md.get("parent") == "trash" or md.get("deleted"):
            trashed += 1
            continue
        c = content.get(uid, {})
        kind = c.get("fileType") or "notebook"
        kind = kind or "notebook"
        kinds[kind] += 1
        pages = c.get("cPages", {}).get("pages")
        n = len([p for p in pages if not p.get("deleted")]) if pages else c.get("pageCount") or 0
        pages_by_kind[kind].append(int(n))
        r = rm_per_doc.get(uid, 0)
        ink_pages_by_kind[kind] += r
        if r and kind in ("pdf", "epub"):
            annotated[kind] += 1
        tags = c.get("tags") or []
        if tags:
            docs_with_tags += 1
            for t in tags:
                doc_tags[t.get("name", "?") if isinstance(t, dict) else str(t)] += 1
        ptags = c.get("pageTags") or []
        if ptags:
            docs_with_pagetags += 1
            for t in ptags:
                page_tags[t.get("name", "?") if isinstance(t, dict) else str(t)] += 1
        lo = md.get("lastOpened")
        try:
            days = (now_ms - int(lo)) / 86_400_000 if lo else None
        except ValueError:
            days = None
        bucket = (
            "never" if days is None else "<7d" if days < 7 else "<30d" if days < 30
            else "<180d" if days < 180 else "older"
        )
        recency[bucket] += 1

    print(f"metadata files: {len(meta)}; content files: {len(content)}")
    print(f"folders: {folders}; trashed/deleted docs: {trashed}")
    print("documents by kind:", dict(kinds))
    for k, v in pages_by_kind.items():
        if v:
            print(
                f"  {k}: pages total {sum(v)}, median {statistics.median(v)}, max {max(v)};"
                f" .rm ink pages {ink_pages_by_kind[k]}; annotated docs {annotated.get(k, 0)}"
            )
    for ext in ("pdf", "epub", "content", "metadata"):
        s = size_by_ext.get(ext, [])
        if s:
            print(f"  .{ext}: n={len(s)}, total {sum(s)/1e6:.1f} MB, median {statistics.median(s)/1e6:.2f} MB, max {max(s)/1e6:.1f} MB")
    print("lastOpened recency (live docs):", dict(recency))
    print(f"docs with document tags: {docs_with_tags}; with page tags: {docs_with_pagetags}")
    if a.no_tag_names:
        print(f"distinct doc tags {len(doc_tags)}, page tags {len(page_tags)}")
    else:
        print("doc tags:", dict(doc_tags.most_common(30)))
        print("page tags:", dict(page_tags.most_common(30)))
    sample_keys = collections.Counter(k for c in content.values() for k in c)
    print("content keys (count of files having each):", dict(sample_keys.most_common(40)))

    # 3. xochitl's own FTS5 index: counts only
    db_bytes = ssh(a.host, f"cat {XOCHITL}/rm-search-index.db")
    con = sqlite3.connect(":memory:")
    con.deserialize(db_bytes)
    print(f"rm-search-index.db: {len(db_bytes)/1e6:.1f} MB")
    try:
        rows = con.execute(
            "select type, count(*), sum(length(handwrittenText)>0), sum(length(digitalText)>0),"
            " sum(length(handwrittenText)), sum(length(digitalText)), sum(length(tags)>0),"
            " count(distinct entryId) from search group by type"
        ).fetchall()
        for r in rows:
            print(
                f"  type={r[0]!s:>10}: rows {r[1]}, with handwriting {r[2]}, with digital text {r[3]},"
                f" handwriting chars {r[4]}, digital chars {r[5]}, rows with tags {r[6]}, docs {r[7]}"
            )
        ws = con.execute(
            "select wordStrokes from search where length(wordStrokes)>2 limit 1"
        ).fetchone()
        if ws:
            try:
                print("  wordStrokes shape:", json.dumps(shape(json.loads(ws[0])))[:600])
            except (json.JSONDecodeError, TypeError):
                print(f"  wordStrokes: non-JSON, {len(ws[0])} bytes")
        am = con.execute("select authorMap from search where length(authorMap)>2 limit 1").fetchone()
        if am:
            try:
                print("  authorMap shape:", json.dumps(shape(json.loads(am[0])))[:300])
            except (json.JSONDecodeError, TypeError):
                print(f"  authorMap: non-JSON, {len(am[0])} bytes")
        for k, v in con.execute("select * from version union all select * from generation"):
            print(f"  version/generation row: {k} {v}")
    except sqlite3.Error as e:
        print("  index read failed:", e)
    con.close()
    print(f"survey took {time.perf_counter()-t0:.1f} s")


if __name__ == "__main__":
    main()
