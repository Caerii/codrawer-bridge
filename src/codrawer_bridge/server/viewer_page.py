from __future__ import annotations

# ruff: noqa: E501
import json


def render_viewer_html(session_id: str) -> str:
    """
    Developer viewer HTML (single page app).

    Kept in a separate module so `app.py` stays focused on transport/session logic.
    """
    # NOTE: This is intentionally a big string; we keep logic in JS functions below.
    return f"""
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
        <input id="prompt" placeholder="Ask AI to draw or handwrite…" style="flex:1; padding:8px 10px; border-radius:8px; border:1px solid rgba(255,255,255,0.12); background: rgba(255,255,255,0.06); color:#e6edf3; outline:none;" />
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
        userCtx.clearRect(0, 0, w, h);
        aiCtx.clearRect(0, 0, w, h);
        hudCtx.clearRect(0, 0, w, h);
      }}
      window.addEventListener("resize", resize);
      resize();

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
          dh = h; dw = dh * srcAspect; ox = (w - dw) / 2; oy = 0;
        }} else {{
          dw = w; dh = dw / srcAspect; ox = 0; oy = (h - dh) / 2;
        }}
        return {{ dw, dh, ox, oy }};
      }}

      function toXY(pt) {{
        const r = drawRect();
        return [r.ox + pt[0] * r.dw, r.oy + pt[1] * r.dh];
      }}

      const strokeState = new Map();
      const strokeBrush = new Map();
      const strokeColor = new Map();
      const ctxByLayer = {{
        user: {{ ctx: userCtx, color: "#7ee787" }},
        ai:   {{ ctx: aiCtx,   color: "#ff7b72" }},
      }};

      // --- AI playback controls (human-feel) ---
      // We buffer AI points on receipt and render them later at a controlled rate.
      // Tune via URL params:
      // - ailag: delay in ms before AI points become drawable (default 260)
      // - aipps: AI points per second (default 180)
      // - aimax: max AI points drawn per animation frame (default 30)
      const aiLagMs = Number(qs.get("ailag") || 260);
      const aiPps = Number(qs.get("aipps") || 180);
      const aiMaxPerFrame = Number(qs.get("aimax") || 30);
      const aiPending = new Map(); // id -> buffered AI points (received timestamped, played back later)
      const aiEnded = new Set(); // ids that received ai_stroke_end
      let aiBudget = 0;
      let lastAiFrameTs = null;

      function widthFromPressure(p, isEraser) {{
        const gamma = Number(qs.get("gamma") || 1.8);
        const minW = Number(qs.get("minw") || (isEraser ? 14 : 1.6));
        const maxW = Number(qs.get("maxw") || (isEraser ? 40 : 6.5));
        const pp = Math.max(0.0, Math.min(1.0, p));
        const w = minW + (maxW - minW) * Math.pow(pp, gamma);
        return w;
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

      function mid(a, b) {{ return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]; }}

      // HUD AI cursor (smoothly interpolated)
      let aiTip = null;
      let aiPrevTip = null;
      const aiTipQueue = [];
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
        const speed = 900;
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
          st.p0 = st.p1; st.p1 = st.p2; st.p2 = xy;
          if (!st.p1) continue;
          if (!st.p0) {{
            drawSegment(ctx, st.p1, st.p2, drawColor, w);
            st.lastW = w;
            continue;
          }}
          const m1 = mid(st.p0, st.p1);
          const m2 = mid(st.p1, st.p2);
          const w2 = (st.lastW == null) ? w : (0.7 * st.lastW + 0.3 * w);
          drawQuadraticSegment(ctx, m1, st.p1, m2, drawColor, w2, compositeOp);
          st.lastW = w2;
          st.lastMid = m2;
          if (layer === "ai") aiTipQueue.push(m2);
        }}
      }}

      function handleEnd(id) {{
        strokeState.delete(id);
        strokeBrush.delete(id);
        strokeColor.delete(id);
      }}

      function aiPlaybackLoop(ts) {{
        if (lastAiFrameTs == null) lastAiFrameTs = ts;
        const dt = Math.max(0.0, (ts - lastAiFrameTs) / 1000);
        lastAiFrameTs = ts;
        aiBudget += aiPps * dt;

        const now = performance.now();
        const dueBefore = now - aiLagMs;
        let canDraw = Math.min(Math.floor(aiBudget), aiMaxPerFrame);
        if (canDraw <= 0) {{
          requestAnimationFrame(aiPlaybackLoop);
          return;
        }}

        // Draw due points per stroke, in small batches.
        for (const [id, q] of aiPending) {{
          if (canDraw <= 0) break;
          if (!q || q.length === 0) {{
            // If ended and empty, finalize stroke.
            if (aiEnded.has(id)) {{
              aiEnded.delete(id);
              aiPending.delete(id);
              handleEnd(id);
            }}
            continue;
          }}
          // Grab a batch of due points.
          const batch = [];
          while (q.length > 0 && canDraw > 0) {{
            const item = q[0];
            if (item.tRecv > dueBefore) break;
            batch.push(item.p);
            q.shift();
            canDraw -= 1;
          }}
          if (batch.length > 0) {{
            handlePts(id, batch, "ai");
          }}
          // If ended and empty after drawing, finalize.
          if (q.length === 0 && aiEnded.has(id)) {{
            aiEnded.delete(id);
            aiPending.delete(id);
            handleEnd(id);
          }}
        }}

        aiBudget = Math.max(0, aiBudget - Math.min(aiMaxPerFrame, Math.floor(aiBudget)));
        requestAnimationFrame(aiPlaybackLoop);
      }}
      requestAnimationFrame(aiPlaybackLoop);

      function wsUrl() {{
        const proto = (location.protocol === "https:") ? "wss" : "ws";
        return `${{proto}}://${{location.host}}/ws/${{sessionId}}`;
      }}

      let ws;
      function connect() {{
        statusEl.textContent = `connecting… ${{wsUrl()}}`;
        ws = new WebSocket(wsUrl());
        ws.onopen = () => {{ statusEl.textContent = "connected"; }};
        ws.onclose = () => {{ statusEl.textContent = "disconnected; retrying…"; setTimeout(connect, 500); }};
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
            aiEnded.delete(msg.id);
            aiPending.set(msg.id, []);
          }} else if (t === "ai_stroke_pts") {{
            // Buffer for later playback (human-feel)
            const q = aiPending.get(msg.id) || [];
            const pts = msg.pts || [];
            const tRecv = performance.now();
            for (const p of pts) {{
              if (Array.isArray(p) && p.length >= 2) {{
                const pr = (p.length >= 3) ? p[2] : 0.7;
                q.push({{ p: [p[0], p[1], pr], tRecv }});
              }}
            }}
            aiPending.set(msg.id, q);
          }} else if (t === "ai_stroke_end") {{
            aiEnded.add(msg.id);
          }} else if (t === "ai_intent") {{
            if (msg.plan) statusEl.textContent = `AI: ${{msg.plan}}`;
          }} else if (t === "ai_say") {{
            if (msg.text) statusEl.textContent = `AI: ${{msg.text}}`;
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
      promptEl.addEventListener("keydown", (e) => {{ if (e.key === "Enter") sendPrompt(); }});

      connect();
    </script>
  </body>
</html>
"""


