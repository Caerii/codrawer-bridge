"""
Multi-scale notebook & page memory backed by SQLite + FTS5 (BM25 + half-life recency decay).

Organized across four scales so fresh warm-pool turns stay lean yet deeply aware:
1. **Micro** (`exchanges` on the active page): exact recent ``(seen, answer)`` turns (up to
   :data:`MAX_EXCHANGES` / :data:`MAX_CHARS`).
2. **Meso** (`pages.digest`): lossless compaction of exchanges evicted from the active page.
3. **Macro** (`notebook_context`): two-stage FTS5 BM25 + half-life recency + ``pinned`` recall
   across other pages of the same notebook.
4. **Meta** (`global_context`): durable ``pinned`` / high-BM25 insights across other notebooks.

Legacy ``threads/*.json`` files are migrated into ``threads.db`` automatically on first open.
"""

from __future__ import annotations

import json
import math
import re
import sqlite3
import time
from dataclasses import dataclass
from pathlib import Path

#: The most exchanges kept verbatim per page, and their character budget (~1.5k tokens).
MAX_EXCHANGES = 6
MAX_CHARS = 6000
MAX_DIGEST_CHARS = 1200
HALF_LIFE_DAYS = 30.0


@dataclass
class Exchange:
    """One earlier ask on the page: what was written there, and what was answered (text)."""

    seen: str
    answer: str
    ts: float = 0.0
    pinned: bool = False


def _sanitize_fts_query(query: str) -> str:
    """Turn arbitrary page text into a safe FTS5 ``OR`` query over up to 8 high-signal tokens."""
    tokens = [t for t in re.findall(r"[A-Za-z0-9_]+", query or "") if len(t) >= 2]
    seen_tok: set[str] = set()
    unique: list[str] = []
    for tok in tokens:
        low = tok.lower()
        if low in ("and", "or", "not", "near") or low in seen_tok:
            continue
        seen_tok.add(low)
        unique.append(tok)
    # Prefer longer, more specific terms for fast FTS5 postings-list lookup.
    unique.sort(key=len, reverse=True)
    return " OR ".join(unique[:8])


def _recency_score(ts: float, now: float, half_life_days: float = HALF_LIFE_DAYS) -> float:
    if ts <= 0:
        return 0.25
    age_days = max(0.0, (now - ts) / 86400.0)
    return math.pow(2.0, -age_days / max(0.5, half_life_days))


def _compact_line(seen: str, answer: str) -> str:
    s = seen.strip().replace("\n", " ")[:110]
    a = answer.strip().replace("\n", " ")[:150]
    return f"{s} -> {a}".strip(" ->")


class ThreadStore:
    """Multi-scale SQLite+FTS5 thread store and ``settings.json`` under ``root``."""

    def __init__(self, root: Path) -> None:
        self.root = root
        self.dir = root / "threads"
        self.db_path = root / "threads.db"
        self._conn: sqlite3.Connection | None = None
        self._page_cache: dict[tuple[str, str], list[Exchange]] = {}
        self._digest_cache: dict[tuple[str, str], str] = {}
        self._stats_cache: dict[str, tuple[int, int]] = {}
        self._settings_cache: dict[str, object] | None = None
        self._search_cache: dict[tuple[object, ...], list[tuple[str, str]]] = {}

    def _db(self) -> sqlite3.Connection:
        if self._conn is not None:
            return self._conn
        self.root.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        conn.executescript(
            """
            PRAGMA journal_mode=WAL;
            PRAGMA synchronous=NORMAL;
            PRAGMA temp_store=MEMORY;
            PRAGMA cache_size=-16384;
            PRAGMA mmap_size=67108864;
            CREATE TABLE IF NOT EXISTS exchanges (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                doc TEXT NOT NULL,
                page TEXT NOT NULL,
                seen TEXT NOT NULL,
                answer TEXT NOT NULL,
                ts REAL NOT NULL,
                pinned INTEGER NOT NULL DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS idx_ex_doc_page ON exchanges(doc, page, ts);
            CREATE INDEX IF NOT EXISTS idx_ex_doc_pin_ts ON exchanges(doc, pinned DESC, ts DESC);
            CREATE INDEX IF NOT EXISTS idx_ex_pinned_ts ON exchanges(ts DESC) WHERE pinned = 1;
            CREATE TABLE IF NOT EXISTS pages (
                doc TEXT NOT NULL,
                page TEXT NOT NULL,
                digest TEXT NOT NULL DEFAULT '',
                updated_ts REAL NOT NULL DEFAULT 0,
                PRIMARY KEY (doc, page)
            );
            CREATE VIRTUAL TABLE IF NOT EXISTS exchanges_fts USING fts5(
                doc,
                pinned,
                seen,
                answer,
                content='exchanges',
                content_rowid='id',
                tokenize='porter unicode61'
            );
            CREATE TRIGGER IF NOT EXISTS exchanges_ai AFTER INSERT ON exchanges BEGIN
                INSERT INTO exchanges_fts(rowid, doc, pinned, seen, answer)
                VALUES (new.id, new.doc, CAST(new.pinned AS TEXT), new.seen, new.answer);
            END;
            CREATE TRIGGER IF NOT EXISTS exchanges_ad AFTER DELETE ON exchanges BEGIN
                INSERT INTO exchanges_fts(exchanges_fts, rowid, doc, pinned, seen, answer)
                VALUES('delete', old.id, old.doc, CAST(old.pinned AS TEXT), old.seen, old.answer);
            END;
            CREATE TRIGGER IF NOT EXISTS exchanges_au AFTER UPDATE ON exchanges BEGIN
                INSERT INTO exchanges_fts(exchanges_fts, rowid, doc, pinned, seen, answer)
                VALUES('delete', old.id, old.doc, CAST(old.pinned AS TEXT), old.seen, old.answer);
                INSERT INTO exchanges_fts(rowid, doc, pinned, seen, answer)
                VALUES (new.id, new.doc, CAST(new.pinned AS TEXT), new.seen, new.answer);
            END;
            """
        )
        ver = int(conn.execute("PRAGMA user_version").fetchone()[0])
        if ver < 2:
            conn.executescript(
                """
                DROP TRIGGER IF EXISTS exchanges_ai;
                DROP TRIGGER IF EXISTS exchanges_ad;
                DROP TRIGGER IF EXISTS exchanges_au;
                DROP TABLE IF EXISTS exchanges_fts;
                CREATE VIRTUAL TABLE exchanges_fts USING fts5(
                    doc,
                    pinned,
                    seen,
                    answer,
                    content='exchanges',
                    content_rowid='id',
                    tokenize='porter unicode61'
                );
                CREATE TRIGGER exchanges_ai AFTER INSERT ON exchanges BEGIN
                    INSERT INTO exchanges_fts(rowid, doc, pinned, seen, answer)
                    VALUES (new.id, new.doc, CAST(new.pinned AS TEXT), new.seen, new.answer);
                END;
                CREATE TRIGGER exchanges_ad AFTER DELETE ON exchanges BEGIN
                    INSERT INTO exchanges_fts(exchanges_fts, rowid, doc, pinned, seen, answer)
                    VALUES(
                        'delete', old.id, old.doc, CAST(old.pinned AS TEXT), old.seen, old.answer
                    );
                END;
                CREATE TRIGGER exchanges_au AFTER UPDATE ON exchanges BEGIN
                    INSERT INTO exchanges_fts(exchanges_fts, rowid, doc, pinned, seen, answer)
                    VALUES(
                        'delete', old.id, old.doc, CAST(old.pinned AS TEXT), old.seen, old.answer
                    );
                    INSERT INTO exchanges_fts(rowid, doc, pinned, seen, answer)
                    VALUES (new.id, new.doc, CAST(new.pinned AS TEXT), new.seen, new.answer);
                END;
                INSERT INTO exchanges_fts(exchanges_fts) VALUES('rebuild');
                PRAGMA user_version = 2;
                """
            )
        self._conn = conn
        self._migrate_legacy_json(conn)
        return conn

    def close(self) -> None:
        """Close the SQLite connection cleanly."""
        if self._conn is not None:
            self._conn.close()
            self._conn = None

    def _migrate_legacy_json(self, conn: sqlite3.Connection) -> None:
        if not self.dir.exists():
            return
        files = list(self.dir.glob("*.json"))
        if not files:
            return
        with conn:
            for path in files:
                try:
                    data = json.loads(path.read_text(encoding="utf-8"))
                except (OSError, ValueError):
                    continue
                doc = str(data.get("doc") or "")
                page = str(data.get("page") or "")
                digest = str(data.get("digest") or "")
                if page and digest:
                    conn.execute(
                        "INSERT OR IGNORE INTO pages(doc, page, digest, updated_ts) "
                        "VALUES (?, ?, ?, ?)",
                        (doc, page, digest[:MAX_DIGEST_CHARS], time.time()),
                    )
                for raw in data.get("exchanges", []):
                    if not isinstance(raw, dict):
                        continue
                    conn.execute(
                        "INSERT INTO exchanges(doc, page, seen, answer, ts, pinned) "
                        "VALUES (?, ?, ?, ?, ?, ?)",
                        (
                            doc,
                            page or path.stem,
                            str(raw.get("seen") or "")[:400],
                            str(raw.get("answer") or "")[:600],
                            float(raw.get("ts") or 0.0),
                            1 if raw.get("pinned") else 0,
                        ),
                    )
                path.unlink(missing_ok=True)

    # ── the setting ────────────────────────────────────────────────────────────────────────

    def setting(self, key: str, default):
        """One value from ``settings.json`` (the user's choices from the dock), or ``default``."""
        if self._settings_cache is None:
            try:
                data = json.loads((self.root / "settings.json").read_text(encoding="utf-8"))
                self._settings_cache = data if isinstance(data, dict) else {}
            except (OSError, ValueError, AttributeError):
                self._settings_cache = {}
        return self._settings_cache.get(key, default)

    def set_setting(self, key: str, value) -> None:
        path = self.root / "settings.json"
        if self._settings_cache is None:
            self.setting(key, None)
        data = dict(self._settings_cache or {})
        data[key] = value
        self._settings_cache = data
        self.root.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(data), encoding="utf-8")

    @property
    def memory(self) -> bool:
        return bool(self.setting("memory", True))

    @memory.setter
    def memory(self, on: bool) -> None:
        self.set_setting("memory", bool(on))

    # ── micro & meso (per-page thread + lossless digest compaction) ────────────────────────

    def get(self, doc: str, page: str) -> list[Exchange]:
        """The page's active verbatim thread (oldest first); empty when memory is off."""
        if not self.memory or not page:
            return []
        key = (doc, page)
        if key in self._page_cache:
            return list(self._page_cache[key])
        rows = self._db().execute(
            "SELECT seen, answer, ts, pinned FROM exchanges "
            "WHERE doc = ? AND page = ? ORDER BY ts ASC, id ASC",
            (doc, page),
        ).fetchall()
        out = [Exchange(r["seen"], r["answer"], float(r["ts"]), bool(r["pinned"])) for r in rows]
        self._page_cache[key] = out
        return list(out)

    def page_digest(self, doc: str, page: str) -> str:
        """The compacted meso-level digest of exchanges previously evicted from ``page``."""
        if not self.memory or not page:
            return ""
        key = (doc, page)
        if key in self._digest_cache:
            return self._digest_cache[key]
        row = self._db().execute(
            "SELECT digest FROM pages WHERE doc = ? AND page = ?", (doc, page)
        ).fetchone()
        val = str(row["digest"]) if row else ""
        self._digest_cache[key] = val
        return val

    def _append_digest(self, conn: sqlite3.Connection, doc: str, page: str, line: str) -> None:
        if not line:
            return
        row = conn.execute(
            "SELECT digest FROM pages WHERE doc = ? AND page = ?", (doc, page)
        ).fetchone()
        prev = str(row["digest"]) if row else ""
        combined = f"{prev}; {line}".strip("; ")
        if len(combined) > MAX_DIGEST_CHARS:
            combined = combined[-MAX_DIGEST_CHARS:]
            semi = combined.find("; ")
            if semi > 0:
                combined = combined[semi + 2 :]
        conn.execute(
            "INSERT INTO pages(doc, page, digest, updated_ts) VALUES (?, ?, ?, ?) "
            "ON CONFLICT(doc, page) DO UPDATE SET digest = excluded.digest, "
            "updated_ts = excluded.updated_ts",
            (doc, page, combined, time.time()),
        )

    def add(self, doc: str, page: str, seen: str, answer: str) -> None:
        """Append one exchange; compact oldest unpinned exchanges into ``pages.digest``."""
        if not self.memory or not page or not (seen or answer):
            return
        conn = self._db()
        now = time.time()
        with conn:
            conn.execute(
                "INSERT INTO exchanges(doc, page, seen, answer, ts, pinned) "
                "VALUES (?, ?, ?, ?, ?, 0)",
                (doc, page, seen.strip()[:400], answer.strip()[:600], now),
            )
            rows = conn.execute(
                "SELECT id, seen, answer, pinned FROM exchanges "
                "WHERE doc = ? AND page = ? ORDER BY ts ASC, id ASC",
                (doc, page),
            ).fetchall()
            # Keep pinned items and evict oldest unpinned rows into the page digest.
            unpinned = [r for r in rows if not r["pinned"]]
            total_chars = sum(len(r["seen"]) + len(r["answer"]) for r in rows)
            while unpinned and (
                len(rows) > MAX_EXCHANGES or (len(rows) > 1 and total_chars > MAX_CHARS)
            ):
                victim = unpinned.pop(0)
                if not victim["pinned"]:
                    self._append_digest(
                        conn, doc, page, _compact_line(victim["seen"], victim["answer"])
                    )
                    conn.execute("DELETE FROM exchanges WHERE id = ?", (victim["id"],))
                    total_chars -= len(victim["seen"]) + len(victim["answer"])
                    rows = [r for r in rows if r["id"] != victim["id"]]
        self._page_cache.pop((doc, page), None)
        self._digest_cache.pop((doc, page), None)
        self._stats_cache.pop(doc, None)
        self._search_cache.clear()

    def pin_last(self, doc: str, page: str, note: str = "") -> bool:
        """Mark the latest exchange on ``(doc, page)`` (or add a pinned note) as durable."""
        if not self.memory or not page:
            return False
        conn = self._db()
        with conn:
            if note.strip():
                conn.execute(
                    "INSERT INTO exchanges(doc, page, seen, answer, ts, pinned) "
                    "VALUES (?, ?, 'pinned', ?, ?, 1)",
                    (doc, page, note.strip()[:600], time.time()),
                )
                self._page_cache.pop((doc, page), None)
                self._stats_cache.pop(doc, None)
                return True
            row = conn.execute(
                "SELECT id FROM exchanges WHERE doc = ? AND page = ? "
                "ORDER BY ts DESC, id DESC LIMIT 1",
                (doc, page),
            ).fetchone()
            if row is None:
                return False
            conn.execute("UPDATE exchanges SET pinned = 1 WHERE id = ?", (row["id"],))
            self._page_cache.pop((doc, page), None)
            self._stats_cache.pop(doc, None)
            return True

    def forget(self, doc: str, page: str) -> bool:
        """Delete the page's thread and digest; True if anything existed."""
        conn = self._db()
        with conn:
            c1 = conn.execute(
                "DELETE FROM exchanges WHERE doc = ? AND page = ?", (doc, page)
            ).rowcount
            c2 = conn.execute(
                "DELETE FROM pages WHERE doc = ? AND page = ?", (doc, page)
            ).rowcount
        self._page_cache.pop((doc, page), None)
        self._digest_cache.pop((doc, page), None)
        self._stats_cache.pop(doc, None)
        self._search_cache.clear()
        return bool(c1 or c2)

    # ── macro & meta (FTS5 BM25 + half-life recency + pin retrieval) ───────────────────────

    def _search_scope(
        self,
        *,
        doc_filter: str,
        exclude_doc: str = "",
        exclude_page: str = "",
        query: str = "",
        limit: int = 3,
        pinned_only: bool = False,
    ) -> list[tuple[str, str]]:
        cache_key = (doc_filter, exclude_doc, exclude_page, query, limit, pinned_only)
        if cache_key in self._search_cache:
            return list(self._search_cache[cache_key])
        conn = self._db()
        now = time.time()
        candidates: dict[int, tuple[float, Exchange]] = {}

        # Stage 1a: Pre-scoped FTS5 postings intersection without full-corpus bm25 sort
        fts_q = _sanitize_fts_query(query)
        if fts_q:
            match_expr = f"{{seen answer}} : ({fts_q})"
            if doc_filter:
                safe_doc = doc_filter.replace('"', "")
                match_expr = f'doc : "{safe_doc}" AND ({match_expr})'
            if pinned_only:
                match_expr = f"pinned : 1 AND ({match_expr})"
            sql = (
                "WITH hits AS ("
                "  SELECT rowid AS id FROM exchanges_fts WHERE exchanges_fts MATCH ? LIMIT 32"
                ") "
                "SELECT e.id, e.seen, e.answer, e.ts, e.pinned "
                "FROM hits JOIN exchanges e ON e.id = hits.id "
                "WHERE 1=1 "
            )
            params: list[object] = [match_expr]
            if exclude_doc:
                sql += "AND e.doc != ? "
                params.append(exclude_doc)
            if exclude_page:
                sql += "AND e.page != ? "
                params.append(exclude_page)
            try:
                rows = conn.execute(sql, params).fetchall()
                q_terms = {t.lower() for t in fts_q.split(" OR ") if t}
                for r in rows:
                    hay = f"{r['seen']} {r['answer']}".lower()
                    bm25_norm = min(1.0, sum(1 for t in q_terms if t in hay) / max(1, len(q_terms)))
                    rec = _recency_score(float(r["ts"]), now)
                    score = (10.0 if r["pinned"] else 0.0) + 0.65 * bm25_norm + 0.35 * rec
                    candidates[int(r["id"])] = (
                        score,
                        Exchange(r["seen"], r["answer"], float(r["ts"]), bool(r["pinned"])),
                    )
            except sqlite3.OperationalError:
                pass

        # Stage 1b: Fast indexed fallback only when FTS5 returned fewer than `limit` hits
        if len(candidates) < limit:
            sql2 = "SELECT id, seen, answer, ts, pinned FROM exchanges WHERE 1=1 "
            p2: list[object] = []
            if doc_filter:
                sql2 += "AND doc = ? "
                p2.append(doc_filter)
            if exclude_doc:
                sql2 += "AND doc != ? "
                p2.append(exclude_doc)
            if exclude_page:
                sql2 += "AND page != ? "
                p2.append(exclude_page)
            if pinned_only:
                sql2 += "AND pinned = 1 "
            sql2 += "ORDER BY pinned DESC, ts DESC LIMIT 12"
            for r in conn.execute(sql2, p2).fetchall():
                rid = int(r["id"])
                if rid in candidates:
                    continue
                rec = _recency_score(float(r["ts"]), now)
                score = (10.0 if r["pinned"] else 0.0) + 0.35 * rec
                candidates[rid] = (
                    score,
                    Exchange(r["seen"], r["answer"], float(r["ts"]), bool(r["pinned"])),
                )

        ranked = sorted(candidates.values(), key=lambda item: item[0], reverse=True)
        top = [ex for _, ex in ranked[:limit]]
        top.sort(key=lambda e: e.ts)
        res = [(e.seen, e.answer) for e in top]
        if len(self._search_cache) >= 128:
            self._search_cache.clear()
        self._search_cache[cache_key] = res
        return list(res)

    def notebook_context(
        self, doc: str, exclude_page: str, query: str = "", limit: int = 3
    ) -> list[tuple[str, str]]:
        """Macro-scale recall across other pages of ``doc``."""
        if not self.memory or not doc:
            return []
        return self._search_scope(
            doc_filter=doc, exclude_page=exclude_page, query=query, limit=limit
        )

    def global_context(
        self, exclude_doc: str, query: str = "", limit: int = 2
    ) -> list[tuple[str, str]]:
        """Meta-scale recall of durable pinned insights across other notebooks."""
        if not self.memory:
            return []
        return self._search_scope(
            doc_filter="",
            exclude_doc=exclude_doc,
            query=query,
            limit=limit,
            pinned_only=True,
        )

    def stats(self, doc: str) -> tuple[int, int]:
        """Return ``(page_count, pinned_count)`` for ``doc``."""
        if not self.memory or not doc:
            return 0, 0
        if doc in self._stats_cache:
            return self._stats_cache[doc]
        row = self._db().execute(
            "SELECT COUNT(DISTINCT page) AS pages, COALESCE(SUM(pinned), 0) AS pins "
            "FROM exchanges WHERE doc = ?",
            (doc,),
        ).fetchone()
        res = (int(row["pages"]), int(row["pins"])) if row else (0, 0)
        self._stats_cache[doc] = res
        return res
