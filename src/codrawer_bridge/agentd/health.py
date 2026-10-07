"""
The responder's health, as one row in the tablet's dock and one file on the PC.

**Why.** "A beautiful thing that sometimes does nothing feels broken" (docs/design/
ask-experience.md, "Reliability is part of beauty"). Before this, the only way to know whether
an Ask would be answered was to tap and wait. Now agentd keeps a row in the dock,

    Responder: online · Sonnet            badge ok
    Responder: degraded · claude not ready   badge degraded

and the row is simply absent while agentd is not connected: the tablet's routers withdraw an
owner's rows when the client that announced them leaves (docs/protocol.md, ``dock_entries``).
The same state goes to ``health.json`` in agentd's state directory, which scripts/dev/nightly.py
and ``agentd-service.ps1 status`` read (and ``update`` uses to restart only between asks).

**The state machine** (:class:`HealthState`, pure, clocked by the caller)::

        ok ──(a non-benign failed ask)──────────────▶ degraded: <why>
        ok ──(no warm process, none busy, > 30 s)──▶ degraded: claude not ready
    degraded ──(an ask answered after the failure, or 10 min without one)──▶ ok
    degraded ──(a warm process again)──▶ ok   (for "claude not ready")

"Benign" failures are the user's or the page's, not the responder's: an empty selection or page,
and an ask replaced by the same ask tapped again (service.py). A pool with no warm process but
an ask in it is busy, not cold: each ask retires its process and the pool starts the replacement
at once (claude_stream.py), which takes ~3 s, hence the grace. "Not ready" wins over failed asks:
it says what the next ask will meet.

**Publishing** (:class:`HealthMonitor`). The row goes as ``dock_entries`` under its own owner,
``agentd-health``, so it changes without resending agentd's settings rows; the dock lists owners
in name order, so it sits right after them. It is sent whenever agentd announces its entries
(join, ``dock_query``, a setting or model change: service.py calls :meth:`HealthMonitor.publish`
from ``_dock_entries``) and whenever the row's text changes, checked every ``interval_s``. The
hint holds clock times, not ages, so an unchanged state never re-sends.

The extension could show "Responder: offline" when no ``agentd-health`` row is present; that is
the extension's to build (docs/protocol.md, ``dock_entries``, "agentd-health").
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from collections import deque
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

log = logging.getLogger("agentd")

#: The dock row's owner and id (docs/protocol.md).
OWNER = "agentd-health"
ENTRY_ID = "agentd_health"

#: Failed asks count for this long (s); a pool may be cold this long before it is "not ready".
ERROR_WINDOW_S = 600.0
WARM_GRACE_S = 30.0

#: Failures that are not the responder's (prefixes of Record.error in service.py).
BENIGN = ("empty selection", "empty page", "replaced by a newer ask")


@dataclass(frozen=True)
class PoolStats:
    """The warm pool's processes by state (claude_stream.ClaudePool.stats)."""

    ready: int
    starting: int
    busy: int
    size: int


@dataclass(frozen=True)
class Health:
    """What the dock row says: ``status`` ok|degraded, and the row's label, badge and hint."""

    status: str
    reason: str
    label: str
    badge: str
    hint: str

    def entry(self) -> dict[str, str]:
        return {"id": ENTRY_ID, "label": self.label, "badge": self.badge, "hint": self.hint}


def benign(error: str) -> bool:
    return any(error.startswith(b) for b in BENIGN)


def short_reason(error: str) -> str:
    """A failed ask's error as the few words a dock row has room for."""
    e = error.lower()
    if "no claude process ready" in e or "exited" in e or "not found" in e:
        return "claude not ready"
    if "timeout" in e or "timed out" in e:
        return "answers timing out"
    if "said nothing" in e or "stall" in e or "silent" in e:
        return "claude stalled"
    if "empty answer" in e:
        return "empty answers"
    return "asks failing"


def model_name(model: str) -> str:
    """``claude-sonnet-5-5`` → ``Sonnet`` (as service.py's Model row names it)."""
    parts = model.split("-")
    return parts[1].capitalize() if len(parts) > 1 else model


def clock(t: float) -> str:
    return time.strftime("%H:%M", time.localtime(t))


class HealthState:
    """The state machine of the module docstring; every method takes the time (Unix s)."""

    def __init__(self, window_s: float = ERROR_WINDOW_S, grace_s: float = WARM_GRACE_S) -> None:
        self.window_s, self.grace_s = window_s, grace_s
        self.errors: deque[tuple[float, str]] = deque()
        self.last_ok: float | None = None
        self.last_error: tuple[float, str] | None = None
        self.pool: PoolStats | None = None
        self.cold_since: float | None = None

    def ask_finished(self, error: str, answered: bool, at: float) -> None:
        """An ask ended: answered, or failed with ``error`` (Record.error)."""
        if answered and not error:
            self.last_ok = at
        elif error and not benign(error):
            self.errors.append((at, error))
            self.last_error = (at, error)

    def observe_pool(self, stats: PoolStats | None, at: float) -> None:
        """The pool now (None: a backend without one, even-terminal)."""
        self.pool = stats
        cold = stats is not None and stats.ready == 0 and stats.busy == 0
        if not cold:
            self.cold_since = None
        elif self.cold_since is None:
            self.cold_since = at

    def recent_errors(self, now: float) -> list[tuple[float, str]]:
        while self.errors and now - self.errors[0][0] > self.window_s:
            self.errors.popleft()
        if self.last_ok is not None:  # recovered: an answer came after them
            return [e for e in self.errors if e[0] > self.last_ok]
        return list(self.errors)

    def evaluate(self, model: str, now: float) -> Health:
        name = model_name(model)
        cold = self.cold_since is not None and now - self.cold_since >= self.grace_s
        errors = self.recent_errors(now)
        if cold:
            reason, since = "claude not ready", self.cold_since
        elif errors:
            reason, since = short_reason(errors[-1][1]), errors[0][0]
        else:
            parts = []
            if self.pool is not None:
                parts.append(f"{self.pool.ready} warm")
            if self.last_ok is not None:
                parts.append(f"last answer {clock(self.last_ok)}")
            hint = " · ".join(parts) or "ready for an Ask"
            return Health("ok", "", f"Responder: online · {name}", "ok", hint)
        fails = f" · {len(errors)} failed in 10 min" if errors else ""
        hint = f"{name} · since {clock(since or now)}{fails}"
        return Health("degraded", reason, f"Responder: degraded · {reason}", "degraded", hint)


# ── publishing ───────────────────────────────────────────────────────────────────────────────


class HealthMonitor:
    """
    Feeds :class:`HealthState` from a running service and publishes it (module docstring).

    ``agent`` is the service (service.Agentd); what is read from it: ``claude`` (a ClaudePool
    or None), ``model_id``, ``queue.busy()``, ``connected``, ``send()`` and ``state`` (the state
    directory, for ``health.json``).
    """

    def __init__(self, agent: Any, interval_s: float = 10.0, clock=time.time) -> None:
        self.agent = agent
        self.interval_s = interval_s
        self.clock = clock
        self.state = HealthState()
        self.started = clock()
        self._sent: Health | None = None
        self._lock = asyncio.Lock()

    def observe(self, rec: Any) -> None:
        """A finished request (service.Record): its outcome counts."""
        self.state.ask_finished(rec.error or "", bool(rec.answer), self.clock())

    def current(self) -> Health:
        now = self.clock()
        pool = getattr(self.agent, "claude", None)
        self.state.observe_pool(PoolStats(**pool.stats()) if pool is not None else None, now)
        return self.state.evaluate(self.agent.model_id, now)

    async def publish(self, force: bool = False) -> Health:
        """Send the row if it changed (or ``force``), and write ``health.json``."""
        async with self._lock:
            h = self.current()
            if not self.agent.connected:
                self._sent = None  # the routers withdrew the row; the join re-sends it
            elif force or h != self._sent:
                ok = await self.agent.send(
                    {"t": "dock_entries", "owner": OWNER, "entries": [h.entry()]}
                )
                if ok and self.agent.connected:
                    if h.status != (self._sent.status if self._sent else "ok"):
                        log.info("health: %s", h.label)
                    self._sent = h
            self.write(h)
            return h

    def snapshot(self, h: Health) -> dict[str, Any]:
        """``health.json``: what nightly.py and agentd-service.ps1 read."""
        s = self.state
        pool = s.pool
        busy = getattr(getattr(self.agent, "queue", None), "busy", lambda: 0)()
        return {
            "updated": round(self.clock(), 3),
            "pid": os.getpid(),
            "started": round(self.started, 3),
            "connected": bool(self.agent.connected),
            "model": self.agent.model_id,
            **{k: v for k, v in asdict(h).items()},
            "pool": asdict(pool) if pool else None,
            "in_flight": busy,
            "last_ok": s.last_ok,
            "last_error": list(s.last_error) if s.last_error else None,
            "errors_10min": len(s.recent_errors(self.clock())),
        }

    def write(self, h: Health) -> None:
        path = Path(self.agent.state) / "health.json"
        tmp = path.with_suffix(".json.tmp")
        try:
            tmp.write_text(json.dumps(self.snapshot(h)), encoding="utf-8")
            os.replace(tmp, path)
        except OSError as e:  # a reader holding it open on Windows: next tick
            log.debug("health.json not written (%s)", e)

    async def run(self, until: asyncio.Event | None = None) -> None:
        """Re-evaluate every ``interval_s``; publish when the row changes."""
        while until is None or not until.is_set():
            try:
                await self.publish()
            except Exception:  # noqa: BLE001 - health must never take the service down
                log.exception("health tick failed")
            await asyncio.sleep(self.interval_s)


def read(state_dir: Path) -> dict[str, Any] | None:
    """``health.json`` from a state directory, or None."""
    try:
        return json.loads((Path(state_dir) / "health.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
