from __future__ import annotations

import asyncio
import json
import math
import random
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


def _dist2(a: list[float], b: list[float]) -> float:
    dx = a[0] - b[0]
    dy = a[1] - b[1]
    return dx * dx + dy * dy


def _heuristic_ai_strokes_from_user_stroke(
    stroke_points4: list,
    last_point3: list[float],
) -> list[list[list[float]]]:
    """
    Deterministic fallback that looks "purposeful" without any model:
    - Smooth echo of the user's last stroke (slight offset, lower pressure)
    - Small continuation flourish at the end (tapered curve)

    Input points are expected as [x,y,p,t] but we tolerate shorter.
    """
    pts3 = [
        [float(p[0]), float(p[1]), float(p[2]) if len(p) >= 3 else 0.6]
        for p in stroke_points4
        if isinstance(p, list) and len(p) >= 2
    ]
    if len(pts3) < 2:
        x, y, p = last_point3
        return [[[x, y, p], [x + 0.02, y, 0.4], [x + 0.04, y + 0.01, 0.2]]]

    # Downsample to reduce jitter.
    max_in = 160
    if len(pts3) > max_in:
        step = max(1, len(pts3) // max_in)
        pts3 = pts3[::step]
        if pts3[-1] != pts3[-1]:
            pts3.append(pts3[-1])

    # Simple smoothing: moving average on x/y.
    sm: list[list[float]] = []
    w = 3
    for i in range(len(pts3)):
        x = 0.0
        y = 0.0
        p = 0.0
        n = 0
        for j in range(max(0, i - w), min(len(pts3), i + w + 1)):
            x += pts3[j][0]
            y += pts3[j][1]
            p += pts3[j][2]
            n += 1
        sm.append([x / n, y / n, p / n])

    # Compute approximate direction at end.
    a = sm[-2]
    b = sm[-1]
    dx = b[0] - a[0]
    dy = b[1] - a[1]
    mag = math.hypot(dx, dy) or 1.0
    ux, uy = dx / mag, dy / mag
    # Perp for a subtle shadow offset.
    px, py = -uy, ux

    # Echo stroke (offset + reduced pressure).
    off = 0.006
    echo: list[list[float]] = []
    for (x, y, p) in sm:
        echo.append([_clamp01(x + px * off), _clamp01(y + py * off), _clamp01(0.55 * p)])

    # Decide if the stroke is "closed" (user drew a loop). If so, fit an ellipse-like cleanup.
    closed = _dist2(sm[0], sm[-1]) < (0.03 * 0.03)
    if closed:
        xs = [p[0] for p in sm]
        ys = [p[1] for p in sm]
        cx = (min(xs) + max(xs)) * 0.5
        cy = (min(ys) + max(ys)) * 0.5
        rx = max(0.01, (max(xs) - min(xs)) * 0.5)
        ry = max(0.01, (max(ys) - min(ys)) * 0.5)
        n = 72
        clean: list[list[float]] = []
        for i in range(n + 1):
            t = 2.0 * math.pi * (i / n)
            x = cx + rx * math.cos(t)
            y = cy + ry * math.sin(t)
            clean.append([_clamp01(x), _clamp01(y), 0.55])
        return [clean, echo]

    # Otherwise: add a small continuation flourish.
    # A short arc forward with a slight perpendicular bend.
    L = 0.06
    bend = 0.02
    n = 28
    flourish: list[list[float]] = []
    for i in range(1, n + 1):
        t = i / n
        x = b[0] + ux * (L * t) + px * (bend * (t * (1.0 - t)))
        y = b[1] + uy * (L * t) + py * (bend * (t * (1.0 - t)))
        p = 0.55 * (1.0 - 0.8 * t)
        flourish.append([_clamp01(x), _clamp01(y), _clamp01(p)])

    # Keep it minimal: 2 strokes max.
    return [echo, flourish]


def _clamp01(x: float) -> float:
    return 0.0 if x < 0.0 else 1.0 if x > 1.0 else x


def _q(x: float, nd: int = 3) -> float:
    """Quantize floats to reduce prompt size without changing semantics much."""
    return float(f"{x:.{nd}f}")


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


def _parse_ai_tool_args_obj(tool_args_json: str) -> dict:
    """Parse tool-call arguments as JSON object (for optional plan fields)."""
    obj = json.loads(tool_args_json)
    if not isinstance(obj, dict):
        raise ValueError("tool args must be an object")
    return obj


def _model_server_payload(
    *,
    settings,
    last_point3: list[float],
    stroke_points4: list,
    stroke_meta: dict,
    recent_user_strokes: list[dict[str, object]],
    recent_prompts: list[str],
    recent_ai_plans: list[str],
    context_image_png_b64: str | None,
    prompt_text: str | None,
    prompt_mode: str | None,
    prompt_anchor_xy: list[float] | None,
    model: str,
    temperature: float,
) -> dict:
    # Provide compact, model-friendly context (no huge arrays).
    # Compact / token-efficient context:
    # - quantize floats
    # - cap points per stroke (assume upstream already downsampled; enforce anyway)
    def _compact_strokes(strokes: list[dict[str, object]]) -> list[dict[str, object]]:
        out: list[dict[str, object]] = []
        for s in strokes[-8:]:
            pts = s.get("pts")
            if not isinstance(pts, list):
                continue
            pts2 = []
            for p in pts[:96]:
                if isinstance(p, list) and len(p) >= 3:
                    pts2.append([_q(float(p[0])), _q(float(p[1])), _q(float(p[2]))])
            out.append(
                {
                    "id": s.get("id"),
                    "brush": s.get("brush"),
                    "color": s.get("color"),
                    "pts": pts2,
                }
            )
        return out

    user_ctx = {
        "agent": {
            "name": settings.agent_persona,
            "personality": settings.agent_personality,
            "creativity": settings.agent_creativity,
            "chattiness": settings.agent_chattiness,
        },
        "last_point": {"x": _q(last_point3[0]), "y": _q(last_point3[1]), "p": _q(last_point3[2])},
        "recent_user_strokes": _compact_strokes(recent_user_strokes),
        "memory": {
            "recent_prompts": recent_prompts[-8:],
            "recent_ai_plans": recent_ai_plans[-8:],
        },
        "prompt": {
            "text": prompt_text,
            "mode": prompt_mode,
            "anchor_xy": prompt_anchor_xy,
        },
        "stroke": {
            "brush": stroke_meta.get("brush"),
            "color": stroke_meta.get("color"),
            "points": [
                [_q(float(p[0])), _q(float(p[1])), _q(float(p[2]))]
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
        "You are Codrawer: a co-creative drawing agent with a consistent personality.\n"
        "You generate AI 'ghost ink' vector strokes for a co-drawing app.\n"
        "Return ONLY by calling the tool emit_ai_strokes.\n"
        "\n"
        "Goal: add a small, intelligent, aesthetically pleasing continuation or enhancement\n"
        "that fits the user's recent strokes. Think: completing a shape, adding a clean\n"
        "contour, adding a small hatch/shadow,\n"
        "or a tasteful flourish. Avoid random doodles.\n"
        "\n"
        "Co-creative policy:\n"
        "- Do not just mirror the last stroke; consider the whole recent scene.\n"
        "- Sometimes augment; sometimes weave; sometimes add a small complementary doodle.\n"
        "- Be polite: if the user is actively drawing, set should_respond=false.\n"
        "- Keep your ink subtle; leave space; avoid covering the user's work.\n"
        "\n"
        "If prompt.mode == 'handwriting', you must handwrite the prompt.text in neat English\n"
        "handwriting as stroke paths (not printed fonts). Use 1-3 strokes per character where\n"
        "reasonable. Layout: left-to-right, baseline-aligned, consistent x-height.\n"
        "Place the text near prompt.anchor_xy if provided; otherwise near last_point.\n"
        "Keep it small and legible (roughly 0.06-0.10 normalized height per line).\n"
        "\n"
        "Hard rules:\n"
        "- Coordinates are normalized to [0,1].\n"
        "- Pressure p in [0,1].\n"
        "- Keep within bounds.\n"
        "- Output MUST be smooth: few strokes (1-4) with moderate points (20-120 per stroke).\n"
        "- Do NOT output giant circles unless the user is clearly drawing a circle.\n"
        "- Do NOT erase.\n"
        "- Prefer clean curves and simple geometry.\n"
    )

    tools = [
        {
            "type": "function",
            "function": {
                "name": "emit_ai_strokes",
                "description": (
                    "Emit AI layer strokes as arrays of points [x,y,p], plus optional plan text."
                ),
                "parameters": {
                    "type": "object",
                    "additionalProperties": False,
                    "properties": {
                        "plan": {
                            "type": "string",
                            "description": (
                                "One short sentence describing what you will draw and why."
                            ),
                        },
                        "say": {
                            "type": "string",
                            "description": (
                                "Optional short message to the user (friendly, concise)."
                            ),
                        },
                        "style_tags": {
                            "type": "array",
                            "items": {"type": "string"},
                            "description": (
                                "Optional tags like: hatch, outline, sparkle, arrow, label, mascot."
                            ),
                        },
                        "should_respond": {
                            "type": "boolean",
                            "description": (
                                "If false, emit no strokes (e.g., user is still drawing)."
                            ),
                        },
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
                    "required": ["strokes", "should_respond"],
                },
            },
        }
    ]

    user_content: object
    if context_image_png_b64:
        user_content = [
            {
                "type": "text",
                "text": json.dumps(user_ctx, separators=(",", ":"), ensure_ascii=False),
            },
            {
                "type": "image_url",
                "image_url": {
                    "url": f"data:image/png;base64,{context_image_png_b64}",
                    "detail": "low",
                },
            },
        ]
    else:
        user_content = json.dumps(user_ctx, separators=(",", ":"), ensure_ascii=False)

    return {
        "model": model,
        "messages": [
            {"role": "system", "content": system},
            {
                "role": "user",
                "content": user_content,
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
    recent_user_strokes: list[dict[str, object]],
    recent_prompts: list[str],
    recent_ai_plans: list[str],
    context_image_png_b64: str | None,
    prompt_text: str | None,
    prompt_mode: str | None,
    prompt_anchor_xy: list[float] | None,
) -> tuple[str | None, str | None, bool, list[list[list[float]]]]:
    """
    Call the external model-server (Node) to generate AI strokes via tool-calling.
    Falls back by raising on failure.
    """
    payload = _model_server_payload(
        settings=settings,
        last_point3=last_point3,
        stroke_points4=stroke_points4,
        stroke_meta=stroke_meta,
        recent_user_strokes=recent_user_strokes,
        recent_prompts=recent_prompts,
        recent_ai_plans=recent_ai_plans,
        context_image_png_b64=context_image_png_b64,
        prompt_text=prompt_text,
        prompt_mode=prompt_mode,
        prompt_anchor_xy=prompt_anchor_xy,
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
        if settings.debug_log_msgs and isinstance(resp, dict):
            usage = resp.get("usage")
            if isinstance(usage, dict):
                print(f"[ai:model-server] usage={usage}")
        choices = resp.get("choices") or []
        msg = choices[0]["message"]
        tool_calls = msg.get("tool_calls") or []
        args_json = tool_calls[0]["function"]["arguments"]
        obj = _parse_ai_tool_args_obj(args_json)
        plan = obj.get("plan")
        say = obj.get("say")
        should_respond = obj.get("should_respond")
        strokes_obj = obj.get("strokes")
        if should_respond is False:
            return (
                plan.strip() if isinstance(plan, str) else None,
                say.strip() if isinstance(say, str) else None,
                False,
                [],
            )
        if isinstance(strokes_obj, list):
            strokes_json = json.dumps({"strokes": strokes_obj})
            strokes = _parse_ai_tool_args(strokes_json)
        else:
            strokes = _parse_ai_tool_args(args_json)
        return (
            plan.strip() if isinstance(plan, str) else None,
            say.strip() if isinstance(say, str) else None,
            True,
            strokes,
        )
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
        recent_user_strokes: list[dict[str, object]] = []
        recent_prompts: list[str] = []
        recent_ai_plans: list[str] = []
        context_image_png_b64: str | None = None
        prompt_text: str | None = None
        prompt_mode: str | None = None
        prompt_anchor_xy: list[float] | None = None
        activity_seq: int | None = None
        job_type: str | None = None
        for e in reversed(pending):
            job_type = e.get("t") if isinstance(e.get("t"), str) else job_type
            lp = e.get("_last_point3")
            if isinstance(lp, list) and len(lp) == 3:
                last_point3 = [float(lp[0]), float(lp[1]), float(lp[2])]
            sp = e.get("_stroke_points4")
            if isinstance(sp, list) and sp:
                stroke_points4 = sp
            sm = e.get("_stroke_meta")
            if isinstance(sm, dict) and sm:
                stroke_meta = sm
            rs = e.get("_recent_user_strokes")
            if isinstance(rs, list) and rs:
                # Keep as-is (already compact).
                recent_user_strokes = rs  # type: ignore[assignment]
            rp = e.get("_recent_prompts")
            if isinstance(rp, list):
                recent_prompts = [str(x) for x in rp if isinstance(x, str)][-8:]
            rap = e.get("_recent_ai_plans")
            if isinstance(rap, list):
                recent_ai_plans = [str(x) for x in rap if isinstance(x, str)][-8:]
            ci = e.get("_context_image_png_b64")
            if isinstance(ci, str) and ci:
                context_image_png_b64 = ci
            seq = e.get("_activity_seq")
            if isinstance(seq, int):
                activity_seq = seq
            if e.get("t") == "prompt":
                pt = e.get("text")
                pm = e.get("mode")
                pa = e.get("_anchor_xy")
                if isinstance(pt, str) and pt.strip():
                    prompt_text = pt.strip()
                if isinstance(pm, str) and pm:
                    prompt_mode = pm
                if isinstance(pa, list) and len(pa) == 2:
                    prompt_anchor_xy = [float(pa[0]), float(pa[1])]
            if stroke_points4 or stroke_meta or lp or recent_user_strokes:
                break
        pending.clear()

        session.last_model_call_ts = _now()

        # If auto mode is enabled and this wasn't an explicit prompt, wait for a user pause.
        if (
            settings.ai_auto_enabled
            and (job_type != "prompt")
            and activity_seq is not None
            and settings.ai_auto_delay_s > 0
        ):
            await asyncio.sleep(settings.ai_auto_delay_s)
            if session.activity_seq != activity_seq:
                continue

        ai_strokes: list[list[list[float]]]
        if settings.model_server_url:
            try:
                plan, say, ok, strokes = await model_server_ai_strokes(
                    settings=settings,
                    last_point3=last_point3,
                    stroke_points4=stroke_points4,
                    stroke_meta=stroke_meta,
                    recent_user_strokes=recent_user_strokes,
                    recent_prompts=recent_prompts,
                    recent_ai_plans=recent_ai_plans,
                    context_image_png_b64=context_image_png_b64
                    if settings.model_server_use_context_image
                    else None,
                    prompt_text=prompt_text,
                    prompt_mode=prompt_mode,
                    prompt_anchor_xy=prompt_anchor_xy,
                )
                if plan:
                    # Remember a few recent plans for continuity.
                    session.recent_ai_plans.append(plan)
                    session.recent_ai_plans = session.recent_ai_plans[-8:]
                    await broadcast(
                        session,
                        {
                            "t": "ai_intent",
                            "plan": plan,
                            "mode": (prompt_mode or ("auto" if job_type != "prompt" else "draw")),
                            "prompt_text": prompt_text,
                            "anchor_xy": prompt_anchor_xy,
                        },
                    )
                if say and settings.agent_chattiness > 0:
                    # If the model provided a message, show it.
                    await broadcast(session, {"t": "ai_say", "text": say})
                if not ok or not strokes:
                    continue
                ai_strokes = strokes
            except Exception as e:
                if settings.debug_log_msgs:
                    print(f"[ai:{session_id}] model-server failed: {e}")
                ai_strokes = _heuristic_ai_strokes_from_user_stroke(stroke_points4, last_point3)
        else:
            ai_strokes = _heuristic_ai_strokes_from_user_stroke(stroke_points4, last_point3)

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


async def agentic_loop(session_id: str, session: Session) -> None:
    """
    Background "initiative" loop.

    When enabled, the agent occasionally creates its own co-creative prompt after the user
    has been idle for a short time. Strict cooldowns prevent spam.
    """
    settings = get_settings()
    # Initialize last_activity_ts on first run to avoid immediate trigger at t=0.
    if session.last_activity_ts <= 0:
        session.last_activity_ts = _now()

    while True:
        await asyncio.sleep(0.25)
        settings = get_settings()
        if not settings.agentic_enabled:
            continue
        if not session.clients:
            continue

        now = _now()
        idle = now - (session.last_activity_ts or now)
        if idle < settings.agentic_idle_s:
            continue
        if (now - session.last_agentic_ts) < settings.agentic_min_interval_s:
            continue

        p = max(0.0, min(1.0, settings.agentic_probability))
        if random.random() > p:
            continue

        # Choose an anchor: last cursor if present, else center.
        if session.last_cursor_xy and len(session.last_cursor_xy) == 2:
            cx, cy = float(session.last_cursor_xy[0]), float(session.last_cursor_xy[1])
        else:
            cx, cy = 0.5, 0.5

        # Enqueue an internal prompt job (acts like the user invited the agent).
        job = {
            "t": "prompt",
            "text": settings.agentic_prompt,
            "mode": "draw",
            "_anchor_xy": [cx, cy],
            "_recent_user_strokes": session.recent_user_strokes,
            "_recent_prompts": session.recent_prompts,
            "_recent_ai_plans": session.recent_ai_plans,
            "_activity_seq": session.activity_seq,
        }

        await session.ai_queue.put(job)
        session.last_agentic_ts = now

