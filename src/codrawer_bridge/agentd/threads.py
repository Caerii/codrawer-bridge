"""
The page thread: asks on one page follow on from each other, as a short text, never as images.

**Why text.** The user asked for asks on the same page to "follow the thread" (2026-10-06), with
memory as a toggle. Keeping the conversation alive in a model context is what made long
even-terminal sessions slow (every earlier image was carried again); the warm-pool design gives
every ask a fresh context instead. So the thread is kept here, as text: for each earlier ask on the
page, what the user had written there (the model's own one-line transcription, its ``SEEN:`` line,
prompt.py) and the answer given. A new ask carries the thread as page data, ahead of its image.

**Bounds.** The last :data:`MAX_EXCHANGES` exchanges, and at most :data:`MAX_CHARS` characters
(about 1.5k tokens), oldest dropped first.

**Privacy** (ADR 011's consent scopes: a page's context is that page). One file per page under
the state directory (``threads/<hash of doc/page>.json``, local, gitignored), never shared across
pages; "Forget this page's thread" (the dock) deletes it. With memory off nothing is read or
written, and each ask stands alone.

**The setting** (memory on or off) is kept in ``settings.json`` beside it, on by default.
"""

from __future__ import annotations

import hashlib
import json
import time
from dataclasses import asdict, dataclass
from pathlib import Path

#: The most exchanges a thread keeps, and its size limit in characters (~4 per token).
MAX_EXCHANGES = 6
MAX_CHARS = 6000


@dataclass
class Exchange:
    """One earlier ask on the page: what was written there, and what was answered (text)."""

    seen: str
    answer: str
    ts: float = 0.0


class ThreadStore:
    """Page threads and the memory setting, under ``root`` (module docstring)."""

    def __init__(self, root: Path) -> None:
        self.root = root
        self.dir = root / "threads"

    # ── the setting ────────────────────────────────────────────────────────────────────────

    @property
    def memory(self) -> bool:
        try:
            return bool(
                json.loads((self.root / "settings.json").read_text(encoding="utf-8")).get(
                    "memory", True
                )
            )
        except (OSError, ValueError):
            return True

    @memory.setter
    def memory(self, on: bool) -> None:
        path = self.root / "settings.json"
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            data = {}
        data["memory"] = bool(on)
        self.root.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(data), encoding="utf-8")

    # ── threads ────────────────────────────────────────────────────────────────────────────

    def _path(self, doc: str, page: str) -> Path:
        key = hashlib.sha256(f"{doc}/{page}".encode()).hexdigest()[:24]
        return self.dir / f"{key}.json"

    def get(self, doc: str, page: str) -> list[Exchange]:
        """The page's thread (oldest first); empty with memory off or for a new page."""
        if not self.memory or not page:
            return []
        try:
            data = json.loads(self._path(doc, page).read_text(encoding="utf-8"))
            return [Exchange(**e) for e in data.get("exchanges", [])]
        except (OSError, ValueError, TypeError):
            return []

    def add(self, doc: str, page: str, seen: str, answer: str) -> None:
        """Append one exchange, then trim to the bounds; nothing with memory off."""
        if not self.memory or not page or not (seen or answer):
            return
        ex = self.get(doc, page) + [Exchange(seen.strip()[:400], answer.strip()[:600], time.time())]
        ex = ex[-MAX_EXCHANGES:]
        while len(ex) > 1 and sum(len(e.seen) + len(e.answer) for e in ex) > MAX_CHARS:
            ex.pop(0)
        self.dir.mkdir(parents=True, exist_ok=True)
        self._path(doc, page).write_text(
            json.dumps({"exchanges": [asdict(e) for e in ex]}, ensure_ascii=False), encoding="utf-8"
        )

    def forget(self, doc: str, page: str) -> bool:
        """Delete the page's thread; True if there was one."""
        try:
            self._path(doc, page).unlink()
            return True
        except OSError:
            return False
