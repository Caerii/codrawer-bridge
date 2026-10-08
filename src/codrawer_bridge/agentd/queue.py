"""
Requests in order: one at a time per page, a few waiting at most, and one answer per question.

A tap on "Ask about selection" while the previous answer is still being thought about or written
must not start a second answer on the same page: two hands would write at once and the second
placement would not see the first answer's ink. So requests are queued per page key
(``"<doc>/<page>"``) and run one after another. Different pages each have their own line (in
practice the terminal turn is the bottleneck, and service.py also serialises those).

**One answer per question: the newer ask replaces the older.** Each request may carry a
signature (service.py: the dock entry and the lasso's box, rounded). A request whose signature
matches one already on that page is the same question asked again (a double tap on the first
live day gave two answers). It replaces the older one: a waiting one is swapped for it in
place; a running one is cancelled (the caller's job sees ``CancelledError``, and service.py and
terminal.py interrupt its model turn) and the new one runs next. ``submit`` returns
:data:`REPLACED` then. Only the job is cancelled, never the page's line.

A page's line holds at most ``max_waiting`` requests besides the running one; a request beyond
that is refused (``submit`` returns None) and the caller says so instead of queueing a backlog
the user has forgotten about. Each request otherwise runs to completion; an exception in one is
reported to ``on_error`` and does not stop the line.
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable, Hashable
from typing import Any

Job = Callable[[], Awaitable[Any]]

#: What :meth:`PageQueue.submit` returns when the request replaced an older one with its signature.
REPLACED = -1


class PageQueue:
    """Per-page FIFO of async jobs (module docstring)."""

    def __init__(
        self, max_waiting: int = 2, on_error: Callable[[BaseException], None] | None = None
    ) -> None:
        self.max_waiting = max_waiting
        self.on_error = on_error
        self._lines: dict[str, list[tuple[Hashable, Job]]] = {}
        self._running: dict[str, tuple[Hashable, asyncio.Task]] = {}
        self._workers: dict[str, asyncio.Task] = {}
        self._replaced: set[asyncio.Task] = set()  # jobs cancelled because a newer ask came

    def pending(self, key: str) -> int:
        """Jobs for ``key`` not yet finished, the running one included."""
        running = 1 if key in self._workers and not self._workers[key].done() else 0
        return running + len(self._lines.get(key, []))

    def submit(self, key: str, job: Job, sig: Hashable = None) -> int | None:
        """
        Queue ``job``; returns how many run before it (0: it starts now), :data:`REPLACED` when it
        replaced a request with the same ``sig`` on ``key``, or None if refused.
        """
        busy = key in self._workers and not self._workers[key].done()
        line = self._lines.setdefault(key, [])
        if sig is not None and busy:
            for i, (s, _) in enumerate(line):
                if s == sig:
                    line[i] = (sig, job)
                    return REPLACED
            running = self._running.get(key)
            if running is not None and running[0] == sig and not running[1].done():
                line.insert(0, (sig, job))
                self._replaced.add(running[1])
                running[1].cancel()
                return REPLACED
        if busy:
            if len(line) >= self.max_waiting:
                return None
            line.append((sig, job))
            return len(line)  # the running job, and those waiting before this one
        self._workers[key] = asyncio.ensure_future(self._run(key, sig, job))
        return 0

    async def _run(self, key: str, sig: Hashable, first: Job) -> None:
        item: tuple[Hashable, Job] | None = (sig, first)
        while item is not None:
            task = asyncio.ensure_future(item[1]())
            self._running[key] = (item[0], task)
            try:
                await task
            except asyncio.CancelledError:
                if task not in self._replaced:
                    raise  # the line itself is being cancelled, not just this job
                self._replaced.discard(task)
            except Exception as e:  # noqa: BLE001 - one failed request must not stop the line
                if self.on_error:
                    self.on_error(e)
            line = self._lines.get(key)
            item = line.pop(0) if line else None
        self._running.pop(key, None)
        self._lines.pop(key, None)

    async def drain(self) -> None:
        """Wait until every line is empty (tests, shutdown)."""
        while any(not t.done() for t in self._workers.values()):
            await asyncio.gather(*[t for t in self._workers.values() if not t.done()])

    def cancel_page(self, doc: str, page: str) -> None:
        """Deleting the native answer layer cancels pending answers on that page."""
        prefix = f"{doc}/{page}|"
        for key, worker in list(self._workers.items()):
            if key.startswith(prefix):
                self._lines.pop(key, None)
                if not worker.done():
                    worker.cancel()
