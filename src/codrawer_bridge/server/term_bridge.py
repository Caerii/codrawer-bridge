"""
Terminal bridge: even-terminal <-> codrawer session.

even-terminal (https://www.npmjs.com/package/@evenrealities/even-terminal) hosts
Claude Code / Codex sessions behind a small HTTP API:

    GET  /api/sessions?provider=claude                 -> [{id, ...}, ...]
    GET  /api/events?sessionId=<id>&needReplay=<bool>  -> SSE stream of typed events
    POST /api/prompt              {text, sessionId, provider}
    POST /api/permission-response {decision, sessionId, provider}   allow|allowAlways|deny
    POST /api/question-response   {answer, sessionId, provider}
    Authorization: Bearer <token>

This module lets any codrawer client (the G2 app, the web viewer, a tablet
keyboard) talk to that session without holding the token or a second
connection:

    client -> server   {"t":"term_prompt","text":"..."}     a new instruction
    client -> server   {"t":"term_answer","text":"..."}     reply to a pending permission/question
    server -> clients  {"t":"term","kind":"text","text":...}        streamed assistant text (coalesced)
                       {"t":"term","kind":"note","text":...}        tool start/end, progress, result, error
                       {"t":"term","kind":"permission","text":...}  waiting for y / a / n
                       {"t":"term","kind":"question","text":...}    waiting for an answer
                       {"t":"term","kind":"status","text":...}      bridge state (connected, session id, errors)

One even-terminal session is attached per codrawer session, lazily on the
first prompt. Text deltas are coalesced (~150 ms) so the glasses see a few
updates per second rather than one per token.
"""

from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable

import httpx

Broadcast = Callable[[dict[str, Any]], Awaitable[None]]


@dataclass
class TermSettings:
    url: str  # e.g. http://127.0.0.1:3456 ; empty = disabled
    token: str
    provider: str = "claude"
    session_id: str = ""  # optional pin; otherwise the most recent session, or a new one
    coalesce_s: float = 0.15


@dataclass
class TermLink:
    settings: TermSettings
    broadcast: Broadcast
    session_id: str | None = None
    pending: str | None = None  # 'permission' | 'question' | None
    reader: asyncio.Task | None = None
    _buf: list[str] = field(default_factory=list)
    _flush_task: asyncio.Task | None = None

    @property
    def enabled(self) -> bool:
        return bool(self.settings.url and self.settings.token)

    def _headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.settings.token}"}

    async def _status(self, text: str) -> None:
        await self.broadcast({"t": "term", "kind": "status", "text": text})

    async def ensure_session(self) -> str | None:
        if self.session_id:
            return self.session_id
        s = self.settings
        async with httpx.AsyncClient(timeout=10) as c:
            if s.session_id:
                self.session_id = s.session_id
            else:
                r = await c.get(f"{s.url}/api/sessions", params={"provider": s.provider}, headers=self._headers())
                if r.status_code != 200:
                    await self._status(f"terminal: /api/sessions {r.status_code}")
                    return None
                sessions = r.json()
                if isinstance(sessions, dict):
                    sessions = sessions.get("sessions") or sessions.get("items") or []
                if isinstance(sessions, list) and sessions:
                    first = sessions[0]
                    self.session_id = first.get("id") if isinstance(first, dict) else str(first)
        if self.session_id and (self.reader is None or self.reader.done()):
            self.reader = asyncio.create_task(self._follow_events())
        return self.session_id

    async def _post(self, path: str, body: dict[str, Any]) -> tuple[int, Any]:
        s = self.settings
        payload = {**body, "provider": s.provider}
        if self.session_id:
            payload["sessionId"] = self.session_id
        async with httpx.AsyncClient(timeout=20) as c:
            r = await c.post(f"{s.url}{path}", json=payload, headers=self._headers())
            try:
                data = r.json()
            except Exception:
                data = r.text
            return r.status_code, data

    async def prompt(self, text: str) -> None:
        if not self.enabled:
            await self._status("terminal: not configured (CODRAWER_TERM_URL / CODRAWER_TERM_TOKEN)")
            return
        text = text.strip()
        if not text:
            return
        await self.ensure_session()
        code, data = await self._post("/api/prompt", {"text": text})
        if code >= 300:
            await self._status(f"terminal: prompt failed ({code}) {str(data)[:80]}")
            return
        # A prompt without a session may create one; adopt it and start following.
        if not self.session_id and isinstance(data, dict):
            sid = data.get("sessionId") or data.get("id")
            if sid:
                self.session_id = str(sid)
                if self.reader is None or self.reader.done():
                    self.reader = asyncio.create_task(self._follow_events())
        await self.broadcast({"t": "term", "kind": "note", "text": f"> {text}"})

    async def answer(self, text: str) -> None:
        """Route a line to the pending permission/question, else treat it as a prompt."""
        if self.pending == "permission":
            s = text.strip().lower()
            decision = "allow" if s in ("y", "yes", "allow") else "allowAlways" if s in ("a", "always") else "deny"
            self.pending = None
            code, _ = await self._post("/api/permission-response", {"decision": decision})
            if code >= 300:
                await self._status(f"terminal: permission reply failed ({code})")
            return
        if self.pending == "question":
            self.pending = None
            code, _ = await self._post("/api/question-response", {"answer": text})
            if code >= 300:
                await self._status(f"terminal: answer failed ({code})")
            return
        await self.prompt(text)

    # ── SSE follow ─────────────────────────────────────────────────────────
    async def _follow_events(self) -> None:
        s = self.settings
        url = f"{s.url}/api/events"
        backoff = 1.0
        while True:
            try:
                async with httpx.AsyncClient(timeout=None) as c:
                    async with c.stream(
                        "GET", url, params={"sessionId": self.session_id, "needReplay": "false"}, headers=self._headers()
                    ) as r:
                        if r.status_code != 200:
                            await self._status(f"terminal: events {r.status_code}")
                            await asyncio.sleep(backoff)
                            backoff = min(10.0, backoff * 2)
                            continue
                        await self._status(f"terminal: attached {str(self.session_id)[:8]}")
                        backoff = 1.0
                        data_lines: list[str] = []
                        async for line in r.aiter_lines():
                            if line == "":
                                if data_lines:
                                    raw = "\n".join(data_lines)
                                    data_lines = []
                                    if not raw.startswith(":"):
                                        try:
                                            await self._on_event(json.loads(raw))
                                        except json.JSONDecodeError:
                                            pass
                                continue
                            if line.startswith("data:"):
                                data_lines.append(line[5:].lstrip())
            except (httpx.HTTPError, OSError) as e:
                await self._status(f"terminal: events dropped ({type(e).__name__}); retrying")
                await asyncio.sleep(backoff)
                backoff = min(10.0, backoff * 2)

    async def _on_event(self, ev: dict[str, Any]) -> None:
        t = ev.get("type")
        if t == "text_delta":
            txt = ev.get("text")
            if isinstance(txt, str) and txt:
                self._buf.append(txt)
                if self._flush_task is None or self._flush_task.done():
                    self._flush_task = asyncio.create_task(self._flush_later())
            return
        await self._flush_now()
        rendered = render_event(ev)
        if rendered is None:
            return
        kind = "note"
        if t == "permission_request":
            kind = "permission"
            self.pending = "permission"
        elif t == "user_question":
            kind = "question"
            self.pending = "question"
        elif t in ("permission_result", "question_answer"):
            self.pending = None
        await self.broadcast({"t": "term", "kind": kind, "text": rendered})

    async def _flush_later(self) -> None:
        await asyncio.sleep(self.settings.coalesce_s)
        await self._flush_now()

    async def _flush_now(self) -> None:
        if not self._buf:
            return
        text = "".join(self._buf)
        self._buf = []
        await self.broadcast({"t": "term", "kind": "text", "text": text})


def render_event(ev: dict[str, Any]) -> str | None:
    """Mirror of packages/glasses-pager/scripts/even-bridge.mjs renderEvent, HUD-sized."""
    t = ev.get("type")
    if t == "tool_start":
        return f"⚙ {ev.get('name', '')}…"
    if t == "tool_end":
        summary = ev.get("summary")
        return f"✓ {ev.get('name', '')}" + (f" — {summary}" if summary else "")
    if t == "task_progress":
        return f"[{ev.get('completed', '?')}/{ev.get('total', '?')}] {ev.get('current') or ''}"
    if t == "notification":
        return f"🔔 {ev.get('title', '')}: {ev.get('message', '')}"
    if t == "permission_request":
        detail = ev.get("detail")
        return f"⚠ {ev.get('toolName', '')} — {ev.get('description', '')}" + (f" ({detail})" if detail else "") + "  y / a / n ?"
    if t == "permission_result":
        return f"→ {ev.get('toolName', '')}: {ev.get('decision', '')}"
    if t == "user_question":
        lines = []
        for q in ev.get("questions") or []:
            head = f"[{q.get('header')}] " if q.get("header") else ""
            lines.append(f"❓ {head}{q.get('question', '')}")
            for i, o in enumerate(q.get("options") or []):
                lines.append(f"  {i + 1}) {o.get('label', '')}")
        lines.append("type an option or text")
        return "\n".join(lines)
    if t == "result":
        cost = float(ev.get("costUsd") or 0)
        return f"— done ({ev.get('turns', 0)} turns, ${cost:.4f}) —"
    if t == "error":
        return f"‼ {ev.get('message', '')}"
    return None


_links: dict[str, TermLink] = {}


def get_link(session_key: str, settings: TermSettings, broadcast: Broadcast) -> TermLink:
    link = _links.get(session_key)
    if link is None:
        link = TermLink(settings=settings, broadcast=broadcast)
        _links[session_key] = link
    return link

