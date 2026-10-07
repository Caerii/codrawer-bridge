"""
A timeout that never swallows a cancellation.

Python 3.11's ``asyncio.wait_for`` loses a cancellation that arrives just as the awaited thing
completes: it returns the result instead (fixed in 3.12). agentd cancels an ask when the same
selection is asked again (queue.py), and on 2026-10-07 a cancelled ask that was taking a warm
Claude process from the pool's queue carried on and answered, so the user got two answers.
``asyncio.timeout`` (3.11+) has no such race; :func:`within` wraps it in ``wait_for``'s shape.
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable
from typing import TypeVar

T = TypeVar("T")


async def within(aw: Awaitable[T], seconds: float) -> T:
    """``await aw`` with a timeout of ``seconds``; raises ``TimeoutError`` like ``wait_for``."""
    async with asyncio.timeout(seconds):
        return await aw
