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


SESSIONS: dict[str, Session] = {}
LOCK = asyncio.Lock()


async def get_session(session_id: str) -> Session:
    async with LOCK:
        if session_id not in SESSIONS:
            SESSIONS[session_id] = Session()
        return SESSIONS[session_id]


async def broadcast(session: Session, msg: dict, exclude: WebSocket | None = None) -> None:
    dead: list[WebSocket] = []
    data = json.dumps(msg, separators=(",", ":"), ensure_ascii=False)
    for ws in list(session.clients):
        if exclude is ws:
            continue
        try:
            await ws.send_text(data)
        except Exception:
            dead.append(ws)
    for ws in dead:
        session.clients.discard(ws)


