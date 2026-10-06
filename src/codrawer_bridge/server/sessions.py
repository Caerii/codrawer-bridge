from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass, field

from fastapi import WebSocket


@dataclass
class Session:
    clients: set[WebSocket] = field(default_factory=set)
    ai_queue: asyncio.Queue[dict] = field(default_factory=asyncio.Queue)
    last_model_call_ts: float = 0.0

    # Minimal rolling state so AI stubs can reference the user's last point.
    stroke_last_point4: dict[str, list[float]] = field(default_factory=dict)  # id -> [x,y,p,t]

    # Rolling per-stroke buffers for AI context (kept small; summarized before enqueue).
    # id -> [[x,y,p,t], ...]
    stroke_points4: dict[str, list[list[float]]] = field(default_factory=dict)
    # id -> {"brush":..., "color":...}
    stroke_meta: dict[str, dict[str, object]] = field(default_factory=dict)

    # Rolling session-level history of user strokes (already downsampled).
    # Each item: {"id": str, "brush": str|None, "color": str|None, "pts": [[x,y,p],...]}
    recent_user_strokes: list[dict[str, object]] = field(default_factory=list)

    # Rolling agent memory (tiny, token-friendly).
    recent_prompts: list[str] = field(default_factory=list)
    recent_ai_plans: list[str] = field(default_factory=list)

    # Page + turn ink (ADR 001/002): every finished user stroke on the page
    # (bounded) and the subset drawn since the last submitted line. Each item:
    # {"id", "brush", "color", "pts": [[x,y,p],...]} with pts sampled to <=256.
    page_strokes: list[dict[str, object]] = field(default_factory=list)
    turn_strokes: list[dict[str, object]] = field(default_factory=list)
    turn_seq: int = 0

    # Shared document (ADR 001): latest text shared by any participant.
    doc_text: str = ""
    # Shared live editing: Yjs updates (base64) relayed as `doc_update` and replayed to joiners.
    # Unlike the Go router this log is not compacted (the desktop is the AI/term path, not the
    # editing one); a long session just replays more small updates.
    doc_updates: list[str] = field(default_factory=list)

    # The tablet's latest saved page (`page` message from the bridge's page watcher), raw JSON,
    # replayed to joiners right after hello. This router keeps no live-stroke log to rebase.
    page_msg: str | None = None

    # The tablet bridge's latest `typer_config` acknowledgement (its reply typing speed), raw
    # JSON, replayed to joiners after the document so every client shows the current speed.
    typer_msg: str | None = None

    # Last known cursor (normalized), if clients send cursor updates.
    last_cursor_xy: list[float] | None = None

    # Monotonic activity counter used for "wait for user pause" behaviors.
    activity_seq: int = 0

    # Monotonic timestamp (perf_counter seconds) of the last observed activity.
    last_activity_ts: float = 0.0

    # Last time the agentic loop emitted a job (perf_counter seconds).
    last_agentic_ts: float = 0.0


SESSIONS: dict[str, Session] = {}
LOCK = asyncio.Lock()


async def get_session(session_id: str) -> Session:
    async with LOCK:
        if session_id not in SESSIONS:
            SESSIONS[session_id] = Session()
        return SESSIONS[session_id]


async def broadcast(session: Session, msg: dict, exclude: WebSocket | None = None) -> None:
    await broadcast_raw(session, json.dumps(msg, separators=(",", ":"), ensure_ascii=False), exclude)


async def broadcast_raw(session: Session, data: str, exclude: WebSocket | None = None) -> None:
    """Send an already encoded message (e.g. a large `page` snapshot, relayed as received)."""
    dead: list[WebSocket] = []
    for ws in list(session.clients):
        if exclude is ws:
            continue
        try:
            await ws.send_text(data)
        except Exception:
            dead.append(ws)
    for ws in dead:
        session.clients.discard(ws)


