"""
Requests in order: one at a time per page, a few waiting at most.

A tap on "Ask about selection" while the previous answer is still being thought about or written
must not start a second answer on the same page: two hands would write at once and the second
placement would not see the first answer's ink. So requests are queued per page key
(``"<doc>/<page>"``) and run one after another. Different pages each have their own line (in
practice the terminal turn is the bottleneck, and service.py also serialises those).

A page's line holds at most ``max_waiting`` requests besides the running one; a request beyond
that is refused (``submit`` returns None) and the caller says so instead of queueing a backlog
the user has forgotten about. Each request runs to completion; an exception in one is reported
to ``on_error`` and does not stop the line.
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from typing import Any

Job = Callable[[], Awaitable[Any]]


class PageQueue:
    """Per-page FIFO of async jobs (module docstring)."""

    def __init__(
        self, max_waiting: int = 2, on_error: Callable[[BaseException], None] | None = None
    ) -> None:
        self.max_waiting = max_waiting
        self.on_error = on_error
        self._lines: dict[str, list[Job]] = {}
        self._workers: dict[str, asyncio.Task] = {}

    def pending(self, key: str) -> int:
        """Jobs for ``key`` not yet finished, the running one included."""
        running = 1 if key in self._workers and not self._workers[key].done() else 0
        return running + len(self._lines.get(key, []))

    def submit(self, key: str, job: Job) -> int | None:
        """Queue ``job``; returns how many run before it (0: it starts now), or None if refused."""
        if key in self._workers and not self._workers[key].done():
            line = self._lines.setdefault(key, [])
            if len(line) >= self.max_waiting:
                return None
            line.append(job)
            return len(line)  # the running job, and those waiting before this one
        self._workers[key] = asyncio.ensure_future(self._run(key, job))
        return 0

    async def _run(self, key: str, first: Job) -> None:
        job: Job | None = first
        while job is not None:
            try:
                await job()
            except asyncio.CancelledError:
                raise
            except Exception as e:  # noqa: BLE001 - one failed request must not stop the line
                if self.on_error:
                    self.on_error(e)
            line = self._lines.get(key)
            job = line.pop(0) if line else None
        self._lines.pop(key, None)

    async def drain(self) -> None:
        """Wait until every line is empty (tests, shutdown)."""
        while any(not t.done() for t in self._workers.values()):
            await asyncio.gather(*[t for t in self._workers.values() if not t.done()])
