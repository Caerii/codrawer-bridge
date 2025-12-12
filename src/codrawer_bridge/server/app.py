from __future__ import annotations

# ruff: noqa: E501
import asyncio
import json

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse

from codrawer_bridge.protocol.constants import (
    T_CURSOR,
    T_HELLO,
    T_STROKE_BEGIN,
    T_STROKE_END,
    T_STROKE_PTS,
)

from .ai_worker import ai_loop
from .config import get_settings
from .sessions import broadcast, get_session

app = FastAPI()


@app.get("/healthz")
def healthz():
    return {"ok": True}

@app.get("/viewer/{session_id}", response_class=HTMLResponse)
def viewer(session_id: str):
    # Minimal debug viewer: renders user + AI strokes with separate styling.
    # NOTE: This is a developer tool; real clients will be separate apps.
    html = f"""
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
    </div>
    <div id="wrap">
      <canvas id="user"></canvas>
      <canvas id="ai"></canvas>
    </div>
    <script>
      const sessionId = {json.dumps(session_id)};
      const statusEl = document.getElementById("status");
      const userCanvas = document.getElementById("user");
      const aiCanvas = document.getElementById("ai");
      const userCtx = userCanvas.getContext("2d");
      const aiCtx = aiCanvas.getContext("2d");

      function resize() {{
        const dpr = window.devicePixelRatio || 1;
        const w = window.innerWidth;
        const h = window.innerHeight;
        for (const c of [userCanvas, aiCanvas]) {{
          c.width = Math.floor(w * dpr);
          c.height = Math.floor(h * dpr);
          c.style.width = w + "px";
          c.style.height = h + "px";
        }}
        userCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
        aiCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
        // clear backgrounds on resize
        userCtx.clearRect(0, 0, w, h);
        aiCtx.clearRect(0, 0, w, h);
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
          }}
        }};
      }}
      connect();
    </script>
  </body>
</html>
"""
    return HTMLResponse(html)


@app.websocket("/ws/{session_id}")
async def ws(session_id: str, ws: WebSocket):
    await ws.accept()
    session = await get_session(session_id)
    session.clients.add(ws)

    # start AI loop once per session
    if not getattr(session, "_ai_started", False):
        session._ai_started = True
        asyncio.create_task(ai_loop(session_id, session))

    await ws.send_text(json.dumps({"t": T_HELLO, "session": session_id}, separators=(",", ":")))

    try:
        while True:
            raw = await ws.receive_text()
            msg = json.loads(raw)
            t = msg.get("t")
            if get_settings().debug_log_msgs:
                print(f"[ws:{session_id}] in t={t} from={getattr(ws.client,'host',None)}")

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
                    session.stroke_points4.pop(sid, None)
                    session.stroke_meta.pop(sid, None)
                await session.ai_queue.put(msg)

    except WebSocketDisconnect:
        session.clients.discard(ws)
    except Exception:
        session.clients.discard(ws)


