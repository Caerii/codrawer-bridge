"""
One agentd per PC: a lock held by the running process, released by the OS when it dies.

**Why.** Two agentds on one tablet session both answer every Ask: two doodles' worth of
``agent_status``, two answers written over each other in ink, two warm pools. On 2026-10-07 the
live agentd ran as a background task of another agent's worktree, and a service started beside
it would have done exactly that. So every agentd that talks to a tablet (not ``--dry-run``)
takes this lock first and exits with :data:`EXIT_LOCKED` when another holds it.

**How.** An operating-system lock on one byte of ``~/.codrawer-agentd/agentd.lock``
(``msvcrt.locking`` on Windows, ``fcntl.flock`` elsewhere), taken without waiting. The OS drops
it when the process ends, however it ends (a crash, ``taskkill /F``, a reboot), so a stale lock
can never keep the service down: a pid file alone could. The file also holds the holder's pid,
start time and command line, so ``status`` and the second process can say who has it. Both
mechanisms lock per open file (per handle on Windows, per open file description for ``flock``),
so a second :func:`acquire` in the same process is refused too, which is what the tests use.
"""

from __future__ import annotations

import json
import os
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import IO

from .config import HOME

__all__ = ["EXIT_LOCKED", "LOCK_PATH", "AlreadyRunning", "Lock", "acquire", "holder"]

#: The lock file (``CODRAWER_AGENTD_LOCK`` overrides, e.g. for a deliberate second instance on
#: another tablet).
LOCK_PATH = Path(os.environ.get("CODRAWER_AGENTD_LOCK", HOME / "agentd.lock"))

#: agentd's exit status when another instance holds the lock (the launcher waits, not retries).
EXIT_LOCKED = 3

#: The holder's details start this far into the file, past the locked byte.
_INFO_AT = 1


class AlreadyRunning(RuntimeError):
    """Another process holds the lock; ``holder`` is what it wrote (may be empty)."""

    def __init__(self, path: Path, holder: dict) -> None:
        self.path, self.holder = path, holder
        who = f"pid {holder.get('pid')}" if holder.get("pid") else "another process"
        super().__init__(f"another agentd is running ({who}; lock {path})")


@dataclass
class Lock:
    """A held lock; :meth:`release` (or the process ending) lets the next agentd start."""

    path: Path
    _f: IO[bytes] | None

    def release(self) -> None:
        if self._f is None:
            return
        try:
            _unlock(self._f)
        finally:
            self._f.close()
            self._f = None

    def __enter__(self) -> Lock:
        return self

    def __exit__(self, *exc) -> None:
        self.release()


def _lock(f: IO[bytes]) -> None:
    """Lock byte 0 of ``f`` without waiting; OSError when it is held."""
    if sys.platform == "win32":
        import msvcrt

        f.seek(0)
        msvcrt.locking(f.fileno(), msvcrt.LK_NBLCK, 1)
    else:
        import fcntl

        fcntl.flock(f.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)


def _unlock(f: IO[bytes]) -> None:
    if sys.platform == "win32":
        import msvcrt

        f.seek(0)
        try:
            msvcrt.locking(f.fileno(), msvcrt.LK_UNLCK, 1)
        except OSError:
            pass
    else:
        import fcntl

        fcntl.flock(f.fileno(), fcntl.LOCK_UN)


def holder(path: Path = LOCK_PATH) -> dict:
    """What the current (or last) holder wrote: pid, started (Unix s), argv; {} if unreadable.
    On Windows the locked byte cannot be read while held, so the details sit after it."""
    try:
        with open(path, "rb") as f:
            f.seek(_INFO_AT)
            return json.loads(f.read().decode("utf-8") or "{}")
    except (OSError, ValueError):
        return {}


def acquire(path: Path = LOCK_PATH, argv: list[str] | None = None) -> Lock:
    """
    Take the lock or raise :class:`AlreadyRunning`. ``argv`` (redacted by the caller) is written
    for ``status``; the pid and start time always are.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    # not append mode: its writes ignore seek, and the details must start after byte 0
    f = os.fdopen(os.open(path, os.O_RDWR | os.O_CREAT | getattr(os, "O_BINARY", 0)), "r+b")
    try:
        _lock(f)
    except OSError:
        f.close()
        raise AlreadyRunning(path, holder(path)) from None
    info = {"pid": os.getpid(), "started": round(time.time(), 3), "argv": argv or []}
    f.seek(0)
    f.write(b"\n" + json.dumps(info).encode("utf-8"))
    f.truncate()
    f.flush()
    return Lock(path, f)
