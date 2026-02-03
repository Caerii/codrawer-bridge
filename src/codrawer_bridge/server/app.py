from __future__ import annotations

import asyncio

# ruff: noqa: E501
import base64
import io
import json
import time

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse
from PIL import Image, ImageDraw

from codrawer_bridge.protocol.constants import (
    T_CURSOR,
    T_HELLO,
    T_PROMPT,
    T_STROKE_BEGIN,
    T_STROKE_END,
    T_STROKE_PTS,
)

from .ai_worker import agentic_loop, ai_loop
from .config import get_settings
from .rendering import render_context_patch_png_b64
from .sessions import broadcast, get_session
from .viewer_page import render_viewer_html

app = FastAPI()


@app.get("/healthz")
def healthz():
    return {"ok": True}

@app.get("/viewer/{session_id}", response_class=HTMLResponse)
def viewer(session_id: str):
    return HTMLResponse(render_viewer_html(session_id))
    # Minimal debug viewer: renders user + AI strokes with separate styling.
    # NOTE: This is a developer tool; real clients will be separate apps.
    html = """
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>codrawer-bridge viewer: {session_id}</title>
    <style>
      html, body {{ height: 100%; margin: 0; background: #0b0f14; color: #e6edf3; font-family: ui-sans-serif, system-ui, -apple-system; }}
      #bar {{ position: fixed; top: 0; left: 0; right: 0; padding: 10px 12px; background: rgba(11,15,20,0.85); backdrop-filter: blur(8px); border-bottom: 1px solid rgba(255,255,255,0.08); }}
      #bar code {{ color: #9cdcfe; }}
      #wrap {{ position: absolute; inset: 0; }}
      canvas {{ position: absolute; inset: 0; }}
      #status {{ font-size: 12px; opacity: 0.9; }}
    </style>
  </head>
  <body>
    <div id="bar">
      <div><strong>Session</strong>: <code>{session_id}</code></div>
      <div id="status">connecting…</div>
      <div style="font-size:12px; opacity:0.85; margin-top:6px;">
        User: <span style="color:#7ee787">green</span> · AI: <span style="color:#ff7b72">red</span> · Eraser: clears user layer
      </div>
      <div style="font-size:12px; opacity:0.7; margin-top:6px;">
        Aspect: set `?w=1620&h=2160` (or your device dims) to avoid stretching.
      </div>
      <div style="display:flex; gap:8px; align-items:center; margin-top:10px;">
        <input id="prompt" placeholder="Ask AI to draw or handwrite… (e.g. 'handwriting: hello')" style="flex:1; padding:8px 10px; border-radius:8px; border:1px solid rgba(255,255,255,0.12); background: rgba(255,255,255,0.06); color:#e6edf3; outline:none;" />
        <select id="mode" style="padding:8px 10px; border-radius:8px; border:1px solid rgba(255,255,255,0.12); background: rgba(255,255,255,0.06); color:#e6edf3;">
          <option value="draw">draw</option>
          <option value="handwriting">handwriting</option>
        </select>
        <button id="send" style="padding:8px 12px; border-radius:8px; border:1px solid rgba(255,255,255,0.16); background: rgba(255,255,255,0.10); color:#e6edf3; cursor:pointer;">Send</button>
      </div>
    </div>
    <div id="wrap">
      <canvas id="user"></canvas>
      <canvas id="ai"></canvas>
      <canvas id="hud"></canvas>
    </div>
    <script>
      const sessionId = {json.dumps(session_id)};
      const statusEl = document.getElementById("status");
      const userCanvas = document.getElementById("user");
      const aiCanvas = document.getElementById("ai");
      const hudCanvas = document.getElementById("hud");
      const userCtx = userCanvas.getContext("2d");
      const aiCtx = aiCanvas.getContext("2d");
      const hudCtx = hudCanvas.getContext("2d");

      function resize() {{
        const dpr = window.devicePixelRatio || 1;
        const w = window.innerWidth;
        const h = window.innerHeight;
        for (const c of [userCanvas, aiCanvas, hudCanvas]) {{
          c.width = Math.floor(w * dpr);
          c.height = Math.floor(h * dpr);
          c.style.width = w + "px";
          c.style.height = h + "px";
        }}
        userCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
        aiCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
        hudCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
        // clear backgrounds on resize
        userCtx.clearRect(0, 0, w, h);
        aiCtx.clearRect(0, 0, w, h);
        hudCtx.clearRect(0, 0, w, h);
      }}
      window.addEventListener("resize", resize);
      resize();

      // Coordinate mapping: keep aspect ratio (no stretching).
      // Use URL params (?w=1620&h=2160) to set the "source" aspect.
      const qs = new URLSearchParams(location.search);
      const srcW = Number(qs.get("w") || 1620);
      const srcH = Number(qs.get("h") || 2160);
      const srcAspect = (srcW > 0 && srcH > 0) ? (srcW / srcH) : (3/4);

      function drawRect() {{
        const w = window.innerWidth;
        const h = window.innerHeight;
        const winAspect = w / h;
        let dw, dh, ox, oy;
        if (winAspect > srcAspect) {{
          // window wider: pillarbox
          dh = h;
          dw = dh * srcAspect;
          ox = (w - dw) / 2;
          oy = 0;
        }} else {{
          // window taller: letterbox
          dw = w;
          dh = dw / srcAspect;
          ox = 0;
          oy = (h - dh) / 2;
        }}
        return {{ dw, dh, ox, oy }};
      }}

      function toXY(pt) {{
        const r = drawRect();
        const x = r.ox + pt[0] * r.dw;
        const y = r.oy + pt[1] * r.dh;
        return [x, y];
      }}

      function drawSegment(ctx, a, b, color, width) {{
        ctx.strokeStyle = color;
        ctx.lineWidth = width;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.miterLimit = 2;
        ctx.beginPath();
        ctx.moveTo(a[0], a[1]);
        ctx.lineTo(b[0], b[1]);
        ctx.stroke();
      }}

      // Stroke state (streaming smoothing).
      // We render incrementally using a quadratic mid-point technique:
      // given points A,B,C we draw a quadratic from mid(A,B) -> mid(B,C) with control=B.
      const strokeState = new Map(); // id -> {{ p0, p1, p2, lastMid, lastW }}
      const strokeBrush = new Map(); // id -> brush string
      const strokeColor = new Map(); // id -> color hint

      // HUD: show where the AI pen currently is (smoothly interpolated).
      let aiTip = null; // [x,y] pixels
      let aiPrevTip = null;
      const aiTipQueue = []; // list of [x,y] pixels to move through
      let lastHudTs = null;
      function drawHud() {{
        const w = window.innerWidth;
        const h = window.innerHeight;
        hudCtx.clearRect(0, 0, w, h);
        if (!aiTip) return;
        const x = aiTip[0], y = aiTip[1];
        const dx = aiPrevTip ? (x - aiPrevTip[0]) : 0;
        const dy = aiPrevTip ? (y - aiPrevTip[1]) : 0;
        const mag = Math.hypot(dx, dy) || 1;
        const ux = dx / mag, uy = dy / mag;

        // soft glow
        hudCtx.save();
        hudCtx.globalAlpha = 0.75;
        hudCtx.fillStyle = "rgba(255, 123, 114, 0.85)";
        hudCtx.beginPath();
        hudCtx.arc(x, y, 5, 0, Math.PI * 2);
        hudCtx.fill();

        hudCtx.globalAlpha = 0.35;
        hudCtx.fillStyle = "rgba(255, 123, 114, 0.35)";
        hudCtx.beginPath();
        hudCtx.arc(x, y, 14, 0, Math.PI * 2);
        hudCtx.fill();

        // heading line
        hudCtx.globalAlpha = 0.7;
        hudCtx.strokeStyle = "rgba(255, 123, 114, 0.8)";
        hudCtx.lineWidth = 2;
        hudCtx.lineCap = "round";
        hudCtx.beginPath();
        hudCtx.moveTo(x, y);
        hudCtx.lineTo(x + ux * 26, y + uy * 26);
        hudCtx.stroke();
        hudCtx.restore();
      }}

      function hudLoop(ts) {{
        if (lastHudTs == null) lastHudTs = ts;
        const dt = Math.max(0.001, (ts - lastHudTs) / 1000);
        lastHudTs = ts;

        // Move the AI tip towards queued target points at a constant speed.
        const speed = 900; // px/sec (tweak for "dragged" feel)
        if (aiTipQueue.length > 0) {{
          const target = aiTipQueue[0];
          if (!aiTip) {{
            aiTip = [target[0], target[1]];
            aiPrevTip = [target[0], target[1]];
          }} else {{
            const dx = target[0] - aiTip[0];
            const dy = target[1] - aiTip[1];
            const dist = Math.hypot(dx, dy);
            const step = speed * dt;
            aiPrevTip = [aiTip[0], aiTip[1]];
            if (dist <= step) {{
              aiTip = [target[0], target[1]];
              aiTipQueue.shift();
            }} else {{
              aiTip = [aiTip[0] + (dx / dist) * step, aiTip[1] + (dy / dist) * step];
            }}
          }}
        }}

        drawHud();
        requestAnimationFrame(hudLoop);
      }}
      requestAnimationFrame(hudLoop);
      const ctxByLayer = {{
        user: {{ ctx: userCtx, color: "#7ee787" }},
        ai:   {{ ctx: aiCtx,   color: "#ff7b72" }},
      }};

      const q = new URLSearchParams(location.search);
      const gamma = Number(q.get("gamma") || 0.65); // <1 boosts low pressure
      const minW = Number(q.get("minw") || 1.4);
      const maxW = Number(q.get("maxw") || 4.2);
      const eraserMinW = Number(q.get("eraser_minw") || 18);
      const eraserMaxW = Number(q.get("eraser_maxw") || 48);

      function clamp01(x) {{
        return Math.max(0, Math.min(1, x));
      }}

      function widthFromPressure(p, isEraser) {{
        const pn = clamp01(p);
        // smooth non-linear curve
        const curved = Math.pow(pn, gamma);
        if (isEraser) {{
          return eraserMinW + (eraserMaxW - eraserMinW) * curved;
        }}
        return minW + (maxW - minW) * curved;
      }}

      function drawQuadraticSegment(ctx, start, ctrl, end, color, width, compositeOp) {{
        ctx.save();
        if (compositeOp) ctx.globalCompositeOperation = compositeOp;
        ctx.strokeStyle = color;
        ctx.lineWidth = width;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.miterLimit = 2;
        ctx.beginPath();
        ctx.moveTo(start[0], start[1]);
        ctx.quadraticCurveTo(ctrl[0], ctrl[1], end[0], end[1]);
        ctx.stroke();
        ctx.restore();
      }}

      function mid(a, b) {{
        return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      }}

      function handlePts(id, pts, layer) {{
        const info = ctxByLayer[layer] || ctxByLayer.user;
        const ctx = info.ctx;
        const fallbackColor = info.color;
        const brush = strokeBrush.get(id) || "pen";
        const colorHint = strokeColor.get(id) || fallbackColor;
        const isEraser = (layer === "user" && brush === "eraser");
        const compositeOp = isEraser ? "destination-out" : null;
        const drawColor = isEraser ? "rgba(0,0,0,1)" : colorHint;

        let st = strokeState.get(id);
        if (!st) {{
          st = {{ p0: null, p1: null, p2: null, lastMid: null, lastW: null }};
          strokeState.set(id, st);
        }}

        for (const pt of pts) {{
          const xy = toXY(pt);
          const p = (pt.length >= 3) ? pt[2] : 0.7;
          const w = widthFromPressure(p, isEraser);

          // shift points
          st.p0 = st.p1;
          st.p1 = st.p2;
          st.p2 = xy;

          // Not enough points yet: just seed and draw a small dot/segment.
          if (!st.p1) {{
            // first point only: nothing to draw yet
            continue;
          }}
          if (!st.p0) {{
            // second point: draw a simple segment
            drawSegment(ctx, st.p1, st.p2, drawColor, w);
            st.lastW = w;
            continue;
          }}

          // 3+ points: draw smooth quadratic from previous midpoint to new midpoint.
          const m1 = mid(st.p0, st.p1);
          const m2 = mid(st.p1, st.p2);
          // Smooth width a bit to avoid jitter
          const w2 = (st.lastW == null) ? w : (0.7 * st.lastW + 0.3 * w);
          drawQuadraticSegment(ctx, m1, st.p1, m2, isEraser ? "rgba(0,0,0,1)" : colorHint, w2, compositeOp);
          st.lastW = w2;
          st.lastMid = m2;

          // HUD tracking: follow the AI tip.
          if (layer === "ai") {{
            aiTipQueue.push(m2);
          }}
        }}
      }}

      function handleEnd(id) {{
        // If we have a dangling last segment, draw it as a straight line to the last point.
        const st = strokeState.get(id);
        if (st && st.p1 && st.p2) {{
          // draw final segment
          const brush = strokeBrush.get(id) || "pen";
          const isEraser = (brush === "eraser");
          const info = ctxByLayer.user;
          const ctx = info.ctx;
          const color = isEraser ? "rgba(0,0,0,1)" : info.color;
          const compositeOp = isEraser ? "destination-out" : null;
          const w = (st.lastW == null) ? minW : st.lastW;
          if (compositeOp) {{
            ctx.save();
            ctx.globalCompositeOperation = compositeOp;
            drawSegment(ctx, st.p1, st.p2, color, w);
            ctx.restore();
          }} else {{
            drawSegment(ctx, st.p1, st.p2, color, w);
          }}
        }}
        strokeState.delete(id);
        strokeBrush.delete(id);
        strokeColor.delete(id);

        // If the finished stroke was AI, leave the tip visible (no change).
      }}

      function wsUrl() {{
        const proto = (location.protocol === "https:") ? "wss" : "ws";
        return `${{proto}}://${{location.host}}/ws/${{sessionId}}`;
      }}

      let ws;
      function connect() {{
        statusEl.textContent = `connecting… ${{wsUrl()}}`;
        ws = new WebSocket(wsUrl());
        ws.onopen = () => {{
          statusEl.textContent = "connected";
        }};
        ws.onclose = () => {{
          statusEl.textContent = "disconnected; retrying…";
          setTimeout(connect, 500);
        }};
        ws.onerror = () => {{
          // onclose will handle reconnect
        }};
        ws.onmessage = (ev) => {{
          let msg;
          try {{ msg = JSON.parse(ev.data); }} catch {{ return; }}
          const t = msg.t;
          if (t === "stroke_begin") {{
            strokeState.delete(msg.id);
            strokeBrush.set(msg.id, msg.brush || "pen");
            strokeColor.set(msg.id, msg.color || "");
          }} else if (t === "stroke_pts") {{
            handlePts(msg.id, msg.pts || [], "user");
          }} else if (t === "stroke_end") {{
            handleEnd(msg.id);
          }} else if (t === "ai_stroke_begin") {{
            strokeState.delete(msg.id);
            strokeBrush.set(msg.id, msg.brush || "ghost");
            strokeColor.set(msg.id, msg.color || "");
          }} else if (t === "ai_stroke_pts") {{
            handlePts(msg.id, msg.pts || [], "ai");
          }} else if (t === "ai_stroke_end") {{
            handleEnd(msg.id);
          }} else if (t === "ai_intent") {{
            // Display what the AI "intends" to do.
            if (msg.plan) {{
              statusEl.textContent = `AI: ${msg.plan}`;
            }}
          }}
        }};
      }}

      const promptEl = document.getElementById("prompt");
      const modeEl = document.getElementById("mode");
      const sendEl = document.getElementById("send");

      function sendPrompt() {{
        if (!ws || ws.readyState !== 1) return;
        const text = (promptEl.value || "").trim();
        if (!text) return;
        const mode = modeEl.value || "draw";
        ws.send(JSON.stringify({{ t: "prompt", text, mode, ts: Date.now() }}));
        promptEl.value = "";
      }}

      sendEl.addEventListener("click", sendPrompt);
      promptEl.addEventListener("keydown", (e) => {{
        if (e.key === "Enter") sendPrompt();
      }});

      connect();
    </script>
  </body>
</html>
"""
    return HTMLResponse(html)


def _render_context_patch_png_b64(
    *,
    strokes: list[dict[str, object]],
    center_xy: tuple[float, float],
    window: float,
    px: int,
) -> str:
    """
    Render a simple context patch as a PNG (base64, no data-url prefix).

    - **strokes**: [{"pts": [[x,y,p],...], ...}, ...] in normalized [0,1]
    - **center_xy**: patch center in normalized coords
    - **window**: normalized width/height of the region to render (square)
    - **px**: output image size (px x px)
    """
    cx, cy = center_xy
    half = max(1e-6, window * 0.5)
    x0, x1 = cx - half, cx + half
    y0, y1 = cy - half, cy + half

    img = Image.new("L", (px, px), 0)  # black bg
    draw = ImageDraw.Draw(img)

    def to_px(x: float, y: float) -> tuple[float, float]:
        u = (x - x0) / (x1 - x0)
        v = (y - y0) / (y1 - y0)
        return (u * (px - 1), v * (px - 1))

    # Older strokes dimmer; newest brighter.
    take = strokes[-8:]
    n = max(1, len(take))
    for i, s in enumerate(take):
        pts = s.get("pts")
        if not isinstance(pts, list) or len(pts) < 2:
            continue
        alpha = 0.35 + 0.65 * ((i + 1) / n)
        col = int(255 * alpha)
        prev = None
        for p in pts:
            if not isinstance(p, list) or len(p) < 2:
                continue
            x = float(p[0])
            y = float(p[1])
            pr = float(p[2]) if len(p) >= 3 else 0.6
            if x < x0 or x > x1 or y < y0 or y > y1:
                prev = None
                continue
            cur = to_px(x, y)
            w = max(1, int(1 + 5 * pr))
            if prev is not None:
                draw.line([prev, cur], fill=col, width=w)
            prev = cur

    bio = io.BytesIO()
    img.save(bio, format="PNG", optimize=True)
    return base64.b64encode(bio.getvalue()).decode("ascii")


@app.websocket("/ws/{session_id}")
async def ws(session_id: str, ws: WebSocket):
    await ws.accept()
    session = await get_session(session_id)
    session.clients.add(ws)

    # start AI loop once per session
    if not getattr(session, "_ai_started", False):
        session._ai_started = True
        asyncio.create_task(ai_loop(session_id, session))
        asyncio.create_task(agentic_loop(session_id, session))

    await ws.send_text(json.dumps({"t": T_HELLO, "session": session_id}, separators=(",", ":")))

    try:
        while True:
            raw = await ws.receive_text()
            msg = json.loads(raw)
            t = msg.get("t")
            if get_settings().debug_log_msgs:
                print(f"[ws:{session_id}] in t={t} from={getattr(ws.client,'host',None)}")

            # Track "activity" for auto AI behaviors (wait for user pause).
            if t in (T_STROKE_BEGIN, T_STROKE_PTS, T_STROKE_END, T_CURSOR, T_PROMPT):
                session.activity_seq += 1
                session.last_activity_ts = time.perf_counter()

            if t == T_CURSOR:
                x = msg.get("x")
                y = msg.get("y")
                if isinstance(x, (int, float)) and isinstance(y, (int, float)):
                    session.last_cursor_xy = [float(x), float(y)]

            def _sample_points4(pts: list, max_points: int = 256) -> list[list[float]]:
                """Downsample a list of [x,y,p,t] points to a bounded size (keep endpoints)."""
                if not pts:
                    return []
                if len(pts) <= max_points:
                    return [p for p in pts if isinstance(p, list) and len(p) >= 4]
                keep: list[list[float]] = []
                n = len(pts)
                step = max(1, n // (max_points - 1))
                for i in range(0, n, step):
                    p = pts[i]
                    if isinstance(p, list) and len(p) >= 4:
                        keep.append(p)
                    if len(keep) >= (max_points - 1):
                        break
                last = pts[-1]
                if isinstance(last, list) and len(last) >= 4:
                    keep.append(last)
                return keep

            def _sample_points3(pts: list, max_points: int = 96) -> list[list[float]]:
                """Downsample a list of [x,y,p] points to a bounded size (keep endpoints)."""
                if not pts:
                    return []
                if len(pts) <= max_points:
                    return [p for p in pts if isinstance(p, list) and len(p) >= 3]
                keep: list[list[float]] = []
                n = len(pts)
                step = max(1, n // (max_points - 1))
                for i in range(0, n, step):
                    p = pts[i]
                    if isinstance(p, list) and len(p) >= 3:
                        keep.append(p)
                    if len(keep) >= (max_points - 1):
                        break
                last = pts[-1]
                if isinstance(last, list) and len(last) >= 3:
                    keep.append(last)
                return keep

            if t == T_STROKE_BEGIN:
                sid = msg.get("id")
                if isinstance(sid, str):
                    session.stroke_points4[sid] = []
                    session.stroke_meta[sid] = {
                        "brush": msg.get("brush"),
                        "color": msg.get("color"),
                    }

            if t == T_STROKE_PTS:
                # Track last point for each stroke id so AI stub can anchor output.
                sid = msg.get("id")
                pts = msg.get("pts")
                if isinstance(sid, str) and isinstance(pts, list) and pts:
                    buf = session.stroke_points4.setdefault(sid, [])
                    # Keep this bounded in memory; we only need limited context.
                    for p in pts:
                        if isinstance(p, list) and len(p) >= 4:
                            buf.append(p)
                    if len(buf) > 4096:
                        session.stroke_points4[sid] = buf[-4096:]

                    last = pts[-1]
                    if isinstance(last, list) and len(last) >= 4:
                        session.stroke_last_point4[sid] = last

            # Broadcast all stroke_* and cursor events to other clients
            if t in (T_STROKE_BEGIN, T_STROKE_PTS, T_STROKE_END, T_CURSOR):
                await broadcast(session, msg, exclude=ws)

            # Trigger AI only on stroke_end (debounced + rate-limited in worker)
            if t == T_STROKE_END:
                sid = msg.get("id")
                if isinstance(sid, str) and sid in session.stroke_last_point4:
                    lp = session.stroke_last_point4[sid]  # [x,y,p,t]
                    msg = dict(msg)
                    msg["_last_point3"] = [lp[0], lp[1], lp[2]]
                    pts4 = session.stroke_points4.get(sid) or []
                    msg["_stroke_points4"] = _sample_points4(pts4, max_points=256)
                    msg["_stroke_meta"] = session.stroke_meta.get(sid) or {}

                    # Update session rolling history with a compact [x,y,p] version.
                    pts3 = [
                        [p[0], p[1], p[2]]
                        for p in msg["_stroke_points4"]
                        if isinstance(p, list) and len(p) >= 3
                    ]
                    pts3 = _sample_points3(pts3, max_points=96)
                    session.recent_user_strokes.append(
                        {
                            "id": sid,
                            "brush": (msg["_stroke_meta"] or {}).get("brush"),
                            "color": (msg["_stroke_meta"] or {}).get("color"),
                            "pts": pts3,
                        }
                    )
                    # Keep bounded.
                    session.recent_user_strokes = session.recent_user_strokes[-12:]
                    msg["_recent_user_strokes"] = session.recent_user_strokes
                    msg["_activity_seq"] = session.activity_seq

                    # Optional: attach a local rendered patch image for multimodal models.
                    settings = get_settings()
                    if settings.model_server_use_context_image:
                        try:
                            b64 = render_context_patch_png_b64(
                                strokes=session.recent_user_strokes,
                                center_xy=(float(lp[0]), float(lp[1])),
                                window=float(settings.model_server_context_image_window),
                                px=int(settings.model_server_context_image_px),
                            )
                            msg["_context_image_png_b64"] = b64
                        except Exception as e:
                            if settings.debug_log_msgs:
                                print(f"[ws:{session_id}] context patch render failed: {e}")

                    session.stroke_points4.pop(sid, None)
                    session.stroke_meta.pop(sid, None)
                await session.ai_queue.put(msg)

            if t == T_PROMPT:
                # Client-driven AI request (e.g., handwriting).
                # This is NOT broadcast; it only triggers AI output on the AI layer.
                text = msg.get("text")
                mode = msg.get("mode", "draw")
                x = msg.get("x")
                y = msg.get("y")
                if not isinstance(text, str) or not text.strip():
                    continue
                if mode not in ("draw", "handwriting"):
                    mode = "draw"

                cx = float(x) if isinstance(x, (int, float)) else None
                cy = float(y) if isinstance(y, (int, float)) else None
                if cx is None or cy is None:
                    if session.last_cursor_xy:
                        cx, cy = session.last_cursor_xy[0], session.last_cursor_xy[1]
                    else:
                        cx, cy = 0.5, 0.5

                # Update small agent memory (token friendly).
                session.recent_prompts.append(text.strip())
                session.recent_prompts = session.recent_prompts[-8:]

                job = {
                    "t": T_PROMPT,
                    "text": text.strip(),
                    "mode": mode,
                    "_anchor_xy": [cx, cy],
                    "_recent_user_strokes": session.recent_user_strokes,
                    "_recent_prompts": session.recent_prompts,
                    "_recent_ai_plans": session.recent_ai_plans,
                    "_activity_seq": session.activity_seq,
                }

                settings = get_settings()
                if settings.model_server_use_context_image:
                    try:
                        job["_context_image_png_b64"] = render_context_patch_png_b64(
                            strokes=session.recent_user_strokes,
                            center_xy=(cx, cy),
                            window=float(settings.model_server_context_image_window),
                            px=int(settings.model_server_context_image_px),
                        )
                    except Exception as e:
                        if settings.debug_log_msgs:
                            print(f"[ws:{session_id}] context patch render failed (prompt): {e}")

                await session.ai_queue.put(job)

    except WebSocketDisconnect:
        session.clients.discard(ws)
    except Exception:
        session.clients.discard(ws)


