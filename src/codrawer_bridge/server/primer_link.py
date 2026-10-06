"""
The Primer inside the desktop router (opt-in: ``CODRAWER_PRIMER=1``; ADR 010).

The router hands every inbound message of a session to that session's Primer agent
(codrawer_bridge.primer.agent) through a queue, so the agent sees messages in order while the
socket loop never waits on a reading (a live reading is one model call, seconds long). The
agent's answers are broadcast to every client of the session, the asker included: a ``primer``
message is for all participants' panels, and agent ink (a problem written onto the page) is on
the ``ai`` layer like any agent ink (ADR 003).

Configuration (environment, read once per session):

- ``CODRAWER_PRIMER=1`` turns it on; ``CODRAWER_PRIMER_LEARNER`` the default learner name
  (requests may name another); ``CODRAWER_PRIMER_AUTO=1`` also reads the page at lulls;
  ``CODRAWER_PRIMER_MODE`` ``auto`` | ``live`` | ``offline``.
- ``CODRAWER_PRIMER_MODEL``, ``CODRAWER_PRIMER_EFFORT`` and ``ANTHROPIC_API_KEY`` are read by
  the recognizer (primer/recognize.py); ``CODRAWER_STATE_DIR`` by the learner store.

Joining clients get the Primer's toolbar dock entries (``dock_entries``) after ``hello``, so a
tablet bridge can publish them to its dock (ADR 010, "Entry points").
"""

from __future__ import annotations

import asyncio
import contextlib
import os
from collections.abc import Awaitable, Callable

from codrawer_bridge.primer.agent import PrimerAgent
from codrawer_bridge.primer.coach import dock_entries

#: Message types the Primer agent consumes; everything else is not queued.
CONSUMES = frozenset(
    {
        "stroke_begin",
        "stroke_pts",
        "stroke_end",
        "stroke_delete",
        "clear",
        "page",
        "key",
        "primer_request",
        "dock_action",
        "dock_query",
    }
)


def enabled() -> bool:
    return os.environ.get("CODRAWER_PRIMER", "").strip().lower() in ("1", "true", "yes", "on")


class PrimerLink:
    """One session's Primer: a queue, a worker task, and a ticker for lull-triggered readings."""

    def __init__(
        self,
        broadcast: Callable[[dict], Awaitable[None]],
        spawn: Callable[[Awaitable], asyncio.Task],
    ) -> None:
        self.broadcast = broadcast
        self.agent = PrimerAgent(
            broadcast,
            learner=os.environ.get("CODRAWER_PRIMER_LEARNER") or "learner",
            mode=os.environ.get("CODRAWER_PRIMER_MODE") or "auto",
            auto=os.environ.get("CODRAWER_PRIMER_AUTO", "") in ("1", "true", "yes", "on"),
        )
        self.queue: asyncio.Queue[dict] = asyncio.Queue()
        self.worker = spawn(self._work())
        self.ticker = spawn(self._tick())

    def offer(self, msg: dict) -> None:
        """Queue a message for the agent if it is one the agent reads."""
        if msg.get("t") in CONSUMES:
            self.queue.put_nowait(msg)

    def hello_extras(self) -> list[dict]:
        """Sent to each joining client after ``hello``."""
        lr = self.agent.store.load(self.agent.learner_name)
        return [
            {
                "t": "dock_entries",
                "owner": "primer",
                "entries": dock_entries(lr.consent and lr.watching),
            }
        ]

    async def _work(self) -> None:
        while True:
            msg = await self.queue.get()
            try:
                if msg.get("t") == "dock_query":
                    for m in self.hello_extras():
                        await self.broadcast(m)
                else:
                    await self.agent.handle(msg)
            except Exception as e:  # a failed reading must never take the router down
                with contextlib.suppress(Exception):
                    await self.broadcast(
                        {
                            "t": "term",
                            "kind": "status",
                            "text": f"primer: {type(e).__name__}: {e}"[:200],
                        }
                    )

    async def _tick(self) -> None:
        while True:
            await asyncio.sleep(1.0)
            with contextlib.suppress(Exception):
                await self.agent.tick()
