"""
One turn with Claude Code through even-terminal, start to answer.

**Why even-terminal.** It runs Claude Code on the user's own subscription behind a small HTTP
API, and the router's ``/term`` already uses it (server/term_bridge.py, whose overview lists the
API). agentd needs only a sliver of it, so this is a separate, smaller client:

    POST /api/prompt   {text, provider, cwd[, sessionId]}  → 202 {sessionId}  (no id: new one)
    GET  /api/messages?sessionId=&after=<id>               → {messages:[{id, type, …}], state}
    POST /api/permission-response {sessionId, decision:"deny"}
    POST /api/question-response   {sessionId, answer:"skip"}
    POST /api/interrupt           {sessionId}

``/api/messages`` is the session's ring buffer (500 entries) with increasing ids, so polling it
after the last id seen is the event stream without the race of subscribing to SSE after the
prompt was posted.

**One session, kept for a few turns.** agentd keeps a session of its own (its id and turn
count in a state file under the state directory) so later turns skip Claude Code's start-up
(measured 2026-10-06: a new session answered "pong" in 12 s, its first text 8 s after the
prompt). But every turn leaves its image in the session's context, and later turns slow down
with it (Haiku, 2026-10-06: 28 s, 30 s, then 67–74 s in one session), so after ``max_turns``
turns a new session starts. If the session is gone (even-terminal restarted without it), the
prompt is posted again without an id and the new session is kept. Each reply records its
phases (prompt accepted, Read started and ended, first answer text, done) for the log.

**When the answer is done.** The turn ends with a ``result`` event carrying the final text,
but that event can trail the text by seconds (5 s in the measurement above). The model Reads the
image first and then writes its answer, so once a text segment has ended after a Read finished,
and nothing new started for ``settle_s``, that segment is the answer. Otherwise the ``result``.

Before the next prompt, an earlier turn accepted that way must have delivered its ``result``,
so its trailing events are never read as the next turn's. A turn that ended with its
``result`` needs no wait: the session's ``idle`` status can trail it by many seconds and is
not waited for.

**Streaming.** Answer text (text after the Read) is handed to ``on_text`` delta by delta, so
stream.py can start writing a sentence the moment it is complete. Measured 2026-10-06 on the
same request: Opus thinks first and then sends its answer in a burst ~1.5 s before ``result``;
Haiku streams a little earlier.

**Nothing else may happen.** Every permission request is denied and every question skipped
(prompt.py: page content is data). A turn that runs past its timeout is interrupted, and so is
one whose request is cancelled because a newer ask replaced it (queue.py).
"""

from __future__ import annotations

import asyncio
import json
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import httpx

#: Fire-and-forget requests (an interrupt), kept referenced until done.
_background: set[asyncio.Task] = set()


@dataclass
class Reply:
    """A turn's outcome. Times are seconds after the prompt was posted."""

    text: str = ""
    ok: bool = False
    error: str = ""
    session_id: str = ""
    first_text_s: float | None = None
    first_answer_s: float | None = None  # first answer text after the Read
    posted_s: float | None = None  # the prompt was accepted (a new session takes longer)
    read_start_s: float | None = None  # the model asked to Read the image
    read_end_s: float | None = None  # the image was read; the answer is being thought out
    new_session: bool = False
    done_s: float | None = None
    cost_usd: float | None = None
    tools: list[str] = field(default_factory=list)
    denied: list[str] = field(default_factory=list)


class Terminal:
    """A client for one even-terminal session (module docstring)."""

    def __init__(
        self,
        url: str,
        token: str,
        cwd: str,
        state_path: Path,
        provider: str = "claude",
        poll_s: float = 0.25,
        settle_s: float = 1.5,
        max_turns: int = 4,
    ) -> None:
        self.url = url.rstrip("/")
        self.token = token
        self.cwd = cwd
        self.provider = provider
        self.state_path = state_path
        self.poll_s = poll_s
        self.settle_s = settle_s
        self.session_id = self._load()
        self._last_id = 0  # the last event id this client has read in its session
        self._open_turn = False  # the last turn was accepted before its `result` arrived
        self.max_turns = max_turns
        self._turns = self._load_turns()

    # ── state ──────────────────────────────────────────────────────────────────────────────

    def _load(self) -> str:
        try:
            return str(
                json.loads(self.state_path.read_text(encoding="utf-8")).get("session_id") or ""
            )
        except (OSError, ValueError):
            return ""

    def _load_turns(self) -> int:
        try:
            return int(json.loads(self.state_path.read_text(encoding="utf-8")).get("turns") or 0)
        except (OSError, ValueError, TypeError):
            return 0

    def _save(self) -> None:
        try:
            self.state_path.parent.mkdir(parents=True, exist_ok=True)
            self.state_path.write_text(
                json.dumps({"session_id": self.session_id, "turns": self._turns}),
                encoding="utf-8",
            )
        except OSError:
            pass

    # ── HTTP ───────────────────────────────────────────────────────────────────────────────

    def _headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.token}"}

    async def _post(self, c: httpx.AsyncClient, path: str, body: dict[str, Any]) -> tuple[int, Any]:
        r = await c.post(
            f"{self.url}{path}", json={**body, "provider": self.provider}, headers=self._headers()
        )
        try:
            return r.status_code, r.json()
        except ValueError:
            return r.status_code, r.text

    async def _messages(self, c: httpx.AsyncClient, after: int) -> tuple[list[dict[str, Any]], str]:
        r = await c.get(
            f"{self.url}/api/messages",
            params={"sessionId": self.session_id, "after": after, "provider": self.provider},
            headers=self._headers(),
        )
        data = r.json() if r.status_code == 200 else {}
        return list(data.get("messages") or []), str(data.get("state") or "")

    async def _interrupt(self) -> None:
        """Stop the session's running turn (best effort)."""
        try:
            async with httpx.AsyncClient(timeout=10) as c:
                await self._post(c, "/api/interrupt", {"sessionId": self.session_id})
        except (httpx.HTTPError, OSError):
            pass

    async def reachable(self) -> bool:
        try:
            async with httpx.AsyncClient(timeout=5) as c:
                r = await c.get(f"{self.url}/", headers=self._headers())
                return r.status_code < 500
        except httpx.HTTPError:
            return False

    # ── a turn ─────────────────────────────────────────────────────────────────────────────

    async def ask(
        self, text: str, timeout_s: float = 90.0, on_text: Callable[[str], None] | None = None
    ) -> Reply:
        """
        Post ``text`` and wait for the answer (module docstring); never raises on HTTP errors.
        ``on_text`` is called with the answer so far (the text segment after the Read) as it
        streams, so a caller can start writing before the turn ends.
        """
        out = Reply()
        t0 = time.monotonic()
        try:
            async with httpx.AsyncClient(timeout=30) as c:
                after = 0
                if self.session_id and self._turns >= self.max_turns and not self._open_turn:
                    # Every turn adds its image to the session's context, and each later turn
                    # carries them all: on 2026-10-06 Haiku's turns grew from 28 s to 74 s in
                    # one session. A fresh session costs a few seconds once instead.
                    self.session_id, self._turns = "", 0
                if self.session_id:
                    # A turn accepted before its `result` may still be finishing: wait for that
                    # result, so its trailing events are not read as this turn's. (Not for
                    # "idle": it can trail a finished turn by many seconds.)
                    msgs, _ = await self._messages(c, self._last_id)
                    deadline = time.monotonic() + 20
                    while self._open_turn and time.monotonic() < deadline:
                        if any(m.get("type") == "result" for m in msgs):
                            break
                        await asyncio.sleep(0.3)
                        msgs, _ = await self._messages(c, self._last_id)
                    after = max([self._last_id] + [int(m.get("id") or 0) for m in msgs])
                    code, data = await self._post(
                        c, "/api/prompt", {"text": text, "sessionId": self.session_id}
                    )
                    if code >= 300:  # the session is gone: start a new one
                        self.session_id, after = "", 0
                if not self.session_id:
                    code, data = await self._post(c, "/api/prompt", {"text": text, "cwd": self.cwd})
                    if code >= 300 or not isinstance(data, dict) or not data.get("sessionId"):
                        out.error = f"prompt failed ({code}): {str(data)[:120]}"
                        return out
                    self.session_id, self._turns = str(data["sessionId"]), 0
                    out.new_session = True
                out.posted_s = round(time.monotonic() - t0, 3)
                self._turns += 1
                self._save()
                out.session_id = self.session_id
                try:
                    return await self._follow(c, after, t0, timeout_s, out, on_text)
                except asyncio.CancelledError:
                    # replaced by a newer ask (queue.py): stop the model, and let the next turn
                    # wait for this one's (interrupted) result before reading its own events
                    self._open_turn = True
                    task = asyncio.ensure_future(self._interrupt())
                    _background.add(task)
                    task.add_done_callback(_background.discard)
                    raise
        except (httpx.HTTPError, OSError, ValueError) as e:
            out.error = f"{type(e).__name__}: {e}"[:200]
            return out

    async def _follow(
        self,
        c: httpx.AsyncClient,
        after: int,
        t0: float,
        timeout_s: float,
        out: Reply,
        on_text: Callable[[str], None] | None = None,
    ) -> Reply:
        segment: list[str] = []
        segments: list[str] = []
        read_done = False
        settled_at: float | None = None  # when the last text segment ended after a Read
        while True:
            now = time.monotonic() - t0
            if now > timeout_s:
                await self._post(c, "/api/interrupt", {"sessionId": self.session_id})
                out.error = f"timed out after {timeout_s:.0f} s"
                out.text = segments[-1] if segments else "".join(segment)
                self._last_id, self._open_turn = after, True
                return out
            msgs, _ = await self._messages(c, after)
            for m in msgs:
                after = max(after, int(m.get("id") or 0))
                t = m.get("type")
                if t == "text_delta" and isinstance(m.get("text"), str):
                    if out.first_text_s is None:
                        out.first_text_s = now
                    segment.append(m["text"])
                    settled_at = None
                    if read_done:
                        if out.first_answer_s is None:
                            out.first_answer_s = now
                        if on_text is not None:
                            on_text("".join(segment))
                elif t == "status" and m.get("state") == "text_start":
                    segment = []
                    settled_at = None
                elif t == "status" and m.get("state") == "text_end":
                    segments.append("".join(segment).strip())
                    segment = []
                    settled_at = now if read_done else None
                elif t == "tool_start" and m.get("name") == "Read" and out.read_start_s is None:
                    out.read_start_s = now
                    out.tools.append("Read")
                    settled_at = None
                elif t == "tool_start":
                    out.tools.append(str(m.get("name") or "?"))
                    settled_at = None
                elif t == "tool_end" and m.get("name") == "Read" and out.read_end_s is None:
                    out.read_end_s = now
                    read_done = True
                elif t == "tool_end":
                    read_done = read_done or str(m.get("name") or "") == "Read"
                elif t == "permission_request":
                    out.denied.append(str(m.get("toolName") or "?"))
                    await self._post(
                        c,
                        "/api/permission-response",
                        {"sessionId": self.session_id, "decision": "deny"},
                    )
                elif t == "user_question":
                    await self._post(
                        c,
                        "/api/question-response",
                        {"sessionId": self.session_id, "answer": "skip"},
                    )
                elif t == "result":
                    out.done_s = now
                    out.cost_usd = float(m.get("costUsd") or 0)
                    out.ok = bool(m.get("success"))
                    out.text = str(m.get("text") or "").strip() or (
                        segments[-1] if segments else ""
                    )
                    if not out.ok and not out.error:
                        out.error = out.text[:200] or "the turn failed"
                    self._last_id, self._open_turn = after, False
                    return out
                elif t == "error":
                    out.error = str(m.get("message") or "error")[:200]
            if (
                settled_at is not None
                and segments
                and segments[-1]
                and now - settled_at >= self.settle_s
            ):
                out.done_s = now
                out.ok = True
                out.text = segments[-1]
                self._last_id, self._open_turn = after, True
                return out
            await asyncio.sleep(self.poll_s)
