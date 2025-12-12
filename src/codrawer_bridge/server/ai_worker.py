from __future__ import annotations

import asyncio
import json
import math
import time
import urllib.error
import urllib.request
import uuid

from .config import get_settings
from .sessions import Session, broadcast


def _now() -> float:
    return time.perf_counter()


async def fake_ai_strokes_from_last_point(last_point3: list[float]) -> list[list[list[float]]]:
    """Return strokes -> points [x,y,p]."""
    cx, cy, _p = last_point3
    r = 0.04
    pts: list[list[float]] = []
    for i in range(42):
        a = 2 * math.pi * (i / 42)
        x = max(0.0, min(1.0, cx + r * math.cos(a)))
        y = max(0.0, min(1.0, cy + r * math.sin(a)))
        pts.append([x, y, 0.6])
    await asyncio.sleep(0.05)
    return [pts]


def _clamp01(x: float) -> float:
    return 0.0 if x < 0.0 else 1.0 if x > 1.0 else x


def _parse_ai_tool_args(tool_args_json: str) -> list[list[list[float]]]:
    """
    Parse tool-call arguments into strokes -> points [x,y,p].
    Tolerant to minor schema variance; clamps numeric values to [0,1].
    """
    obj = json.loads(tool_args_json)
    strokes = obj.get("strokes")
    if not isinstance(strokes, list):
        raise ValueError("tool args missing 'strokes' list")
    out: list[list[list[float]]] = []
    for stroke in strokes:
        if not isinstance(stroke, list):
            continue
        pts_out: list[list[float]] = []
        for pt in stroke:
            if not isinstance(pt, list) or len(pt) < 2:
                continue
            x = float(pt[0])
            y = float(pt[1])
            p = float(pt[2]) if len(pt) >= 3 else 0.6
            pts_out.append([_clamp01(x), _clamp01(y), _clamp01(p)])
        if pts_out:
            out.append(pts_out)
    if not out:
        raise ValueError("tool args contained no valid strokes")
    return out


def _model_server_payload(
    *,
    last_point3: list[float],
    stroke_points4: list,
    stroke_meta: dict,
    model: str,
    temperature: float,
) -> dict:
    # Provide compact, model-friendly context (no huge arrays).
    user_ctx = {
        "last_point": {"x": last_point3[0], "y": last_point3[1], "p": last_point3[2]},
        "stroke": {
            "brush": stroke_meta.get("brush"),
            "color": stroke_meta.get("color"),
            "points": [
                [p[0], p[1], p[2]]
                for p in stroke_points4
                if isinstance(p, list) and len(p) >= 3
            ],
        },
        "constraints": {
            "coords": "normalized [0,1]",
            "pressure": "normalized [0,1]",
            "max_strokes": 6,
            "max_points_per_stroke": 160,
            "prefer_smooth": True,
        },
    }

    system = (
        "You generate AI 'ghost ink' vector strokes for a drawing app.\n"
        "Return ONLY by calling the tool emit_ai_strokes.\n"
        "Rules:\n"
        "- Coordinates are normalized to [0,1].\n"
        "- Pressure p in [0,1].\n"
        "- Output should be visually pleasing: smooth curves, coherent shapes, no jitter.\n"
        "- Keep within [0,1] bounds.\n"
        "- Use few strokes and few points; do not output huge polylines.\n"
        "- Draw on a NEW AI layer; do not erase.\n"
    )

    tools = [
        {
            "type": "function",
            "function": {
                "name": "emit_ai_strokes",
                "description": "Emit AI layer strokes as arrays of points [x,y,p].",
                "parameters": {
                    "type": "object",
                    "additionalProperties": False,
                    "properties": {
                        "strokes": {
                            "type": "array",
                            "description": (
                                "List of strokes; each stroke is a list of [x,y,p] points."
                            ),
                            "items": {
                                "type": "array",
                                "items": {
                                    "type": "array",
                                    "minItems": 3,
                                    "maxItems": 3,
                                    "items": [
                                        {"type": "number"},
                                        {"type": "number"},
                                        {"type": "number"},
                                    ],
                                },
                            },
                        }
                    },
                    "required": ["strokes"],
                },
            },
        }
    ]

    return {
        "model": model,
        "messages": [
            {"role": "system", "content": system},
            {
                "role": "user",
                "content": json.dumps(user_ctx, separators=(",", ":"), ensure_ascii=False),
            },
        ],
        "tools": tools,
        "tool_choice": {"type": "function", "function": {"name": "emit_ai_strokes"}},
        "temperature": temperature,
        "max_tokens": 900,
        "stream": False,
    }


def _call_model_server_sync(*, base_url: str, timeout_s: float, payload: dict) -> dict:
    url = base_url.rstrip("/") + "/v1/chat/completions"
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout_s) as resp:
        raw = resp.read().decode("utf-8")
        return json.loads(raw)


async def model_server_ai_strokes(
    *,
    settings,
    last_point3: list[float],
    stroke_points4: list,
    stroke_meta: dict,
) -> list[list[list[float]]]:
    """
    Call the external model-server (Node) to generate AI strokes via tool-calling.
    Falls back by raising on failure.
    """
    payload = _model_server_payload(
        last_point3=last_point3,
        stroke_points4=stroke_points4,
        stroke_meta=stroke_meta,
        model=settings.model_server_model,
        temperature=settings.model_server_temperature,
    )

    try:
        resp = await asyncio.to_thread(
            _call_model_server_sync,
            base_url=settings.model_server_url,
            timeout_s=settings.model_server_timeout_s,
            payload=payload,
        )
    except (urllib.error.URLError, TimeoutError) as e:
        raise RuntimeError(f"model-server unreachable: {e}") from e

    try:
        choices = resp.get("choices") or []
        msg = choices[0]["message"]
        tool_calls = msg.get("tool_calls") or []
        args_json = tool_calls[0]["function"]["arguments"]
        return _parse_ai_tool_args(args_json)
    except Exception as e:
        raise RuntimeError(f"model-server bad response: {e}") from e


async def ai_loop(session_id: str, session: Session) -> None:
    settings = get_settings()
    pending: list[dict] = []
    last_flush = _now()

    while True:
        evt = await session.ai_queue.get()
        pending.append(evt)

        # debounce to batch multiple stroke_end events
        while (_now() - last_flush) < settings.ai_debounce_s:
            await asyncio.sleep(0.01)
        last_flush = _now()

        # enforce model interval
        dt = _now() - session.last_model_call_ts
        if dt < settings.ai_min_model_interval_s:
            await asyncio.sleep(settings.ai_min_model_interval_s - dt)

        # pick the best last_point if the enqueued event carried it, else fallback
        last_point3: list[float] = [0.5, 0.5, 0.6]
        stroke_points4: list = []
        stroke_meta: dict = {}
        for e in reversed(pending):
            lp = e.get("_last_point3")
            if isinstance(lp, list) and len(lp) == 3:
                last_point3 = [float(lp[0]), float(lp[1]), float(lp[2])]
            sp = e.get("_stroke_points4")
            if isinstance(sp, list) and sp:
                stroke_points4 = sp
            sm = e.get("_stroke_meta")
            if isinstance(sm, dict) and sm:
                stroke_meta = sm
            if stroke_points4 or stroke_meta or lp:
                break
        pending.clear()

        session.last_model_call_ts = _now()

        ai_strokes: list[list[list[float]]]
        if settings.model_server_url:
            try:
                ai_strokes = await model_server_ai_strokes(
                    settings=settings,
                    last_point3=last_point3,
                    stroke_points4=stroke_points4,
                    stroke_meta=stroke_meta,
                )
            except Exception as e:
                # Keep the system resilient; fall back to stub if the model-server is down.
                if settings.debug_log_msgs:
                    print(f"[ai:{session_id}] model-server failed: {e}")
                ai_strokes = await fake_ai_strokes_from_last_point(last_point3)
        else:
            ai_strokes = await fake_ai_strokes_from_last_point(last_point3)

        # stream out as AI stroke events
        for stroke_pts in ai_strokes:
            sid = f"ai_{uuid.uuid4().hex[:10]}"
            await broadcast(
                session,
                {"t": "ai_stroke_begin", "id": sid, "layer": "ai", "brush": "ghost"},
            )
            chunk: list[list[float]] = []
            for pt in stroke_pts:
                chunk.append(pt)
                if len(chunk) >= 12:
                    await broadcast(session, {"t": "ai_stroke_pts", "id": sid, "pts": chunk})
                    chunk = []
                    await asyncio.sleep(0)
            if chunk:
                await broadcast(session, {"t": "ai_stroke_pts", "id": sid, "pts": chunk})
            await broadcast(session, {"t": "ai_stroke_end", "id": sid})


