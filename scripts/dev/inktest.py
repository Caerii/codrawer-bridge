# /// script
# requires-python = ">=3.10"
# dependencies = ["websockets>=12"]
# ///
"""
inktest: on-device regression test for native agent ink placement.

# What it checks

Agent ink reaches the reMarkable's page through three hops: an agent sends `ai`-layer strokes to
the router (normalised page coordinates, docs/protocol.md), the tablet bridge's agentink package
turns each finished stroke into a line on /run/codrawer/ink.sock in page coordinates, and the
codrawer-layer extension commits it with xochitl's own `addDrawingLine` on the layer
"codrawer: agent". The one fact that broke before is placement: `addDrawingLine` takes page
coordinates, unmapped, at any pan and zoom (docs/investigations/native-multiplayer-layer.md,
"Probe 1: results", item 4; an earlier build mapped them through the view transform and the
ink landed off by the scroll offset). This script is the test that found it, made repeatable:

  1. refuse unless native agent ink is on (the dock's choice in state/native_agent_ink, else
     NATIVE_AGENT_INK in bridge.env) and the visible notebook is "codrawer: test" (or the one
     named with --allow-doc): the test writes real ink into that notebook;
  2. read the extension's automation `state` (an SSH tunnel to 127.0.0.1:8579 on the tablet, as
     scripts/dev/rmflow.py does; needs /home/root/codrawer/AUTOMATION) for the visible page,
     zoom and scroll, and the page itself with the bridge's read-only `-page-dump`;
  3. pick a free target on the visible part of the page, away from existing ink;
  4. send an X in a circle (three strokes) as ai-layer strokes through the router
     (ws://<tablet>:8577/ws/<session>?token=<ROUTER_TOKEN from bridge.env>; the tablet's Wi-Fi
     can take tens of seconds to answer, hence the long open timeout);
  5. wait for the extension's `ink: ok` log lines, then for xochitl to save the page (a new
     `-page-dump` holding the new `ai` strokes; xochitl saves seconds to a minute after a pause);
  6. compare the saved strokes' bounds with the target's and print PASS or FAIL with the numbers.

Coordinates: page units are xochitl's (x centred, −810..810 on a 1620-wide page; y down from the
top); the protocol and the dump use x = (x_rm + w/2)/w, y = y_rm/h. The visible region comes
from the tile manager's sceneToViewTransform as `state` reports it: view = page · zoom + scroll.

Usage:
    uv run scripts/dev/inktest.py [--host root@192.168.50.156] [--allow-doc "Test"] [--radius 50]

Exit status 0 on PASS, 1 on FAIL, 2 when it refuses or cannot run. It writes one small mark into
the notebook; undo it on the tablet, or delete the "codrawer: agent" layer.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import math
import re
import shlex
import socket
import subprocess
import sys
import time

TEST_DOC = "codrawer: test"
AUTO_PORT = 8579
ROUTER_PORT = 8577
SCREEN_W, SCREEN_H = 1620, 2160  # view px
TOOLBAR_PX = 140  # the left toolbar covers this much of the view
EDGE_PX = 80  # stay this far from the other screen edges
CLEAR_PX = 60  # free space around the mark, page px
SSH_OPTS = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15"]


def die(msg: str) -> None:
    print(f"inktest: {msg}")
    sys.exit(2)


# ── the tablet over SSH ─────────────────────────────────────────────────────


def ssh(host: str, cmd: str, timeout: float = 60) -> str:
    r = subprocess.run(
        ["ssh", *SSH_OPTS, host, cmd], capture_output=True, text=True, timeout=timeout
    )
    if r.returncode != 0:
        raise RuntimeError(f"ssh {cmd!r}: exit {r.returncode}: {r.stderr.strip()}")
    return r.stdout


def bridge_settings(host: str) -> dict:
    """ROUTER_TOKEN, NATIVE_AGENT_INK from bridge.env and the dock's kept choice."""
    out = ssh(
        host,
        "cd /home/root/codrawer && (set -a; . ./bridge.env; set +a; "
        'printf \'token=%s\\nenv=%s\\n\' "$ROUTER_TOKEN" "$NATIVE_AGENT_INK"); '
        "printf 'state=%s\\n' \"$(cat state/native_agent_ink 2>/dev/null)\"",
    )
    kv = dict(line.split("=", 1) for line in out.splitlines() if "=" in line)
    return {k: v.strip() for k, v in kv.items()}


def agent_ink_on(s: dict) -> bool:
    # the bridge's rule (agent_ink.go initialAgentInk): the dock's kept choice, else the env flag
    if s.get("state"):
        return s["state"] == "1"
    return s.get("env", "").lower() in ("1", "true", "yes", "on")


def page_dump(host: str) -> dict:
    out = ssh(
        host,
        "cd /home/root/codrawer; set -a; . ./bridge.env; "
        "[ -f /run/codrawer/env ] && . /run/codrawer/env; set +a; "
        "current/codrawer_bridge_native -page-dump",
        timeout=90,
    )
    for line in out.splitlines():
        line = line.strip()
        if line.startswith("{") and '"t":"page"' in line.replace(" ", ""):
            return json.loads(line)
    raise RuntimeError("no page message in -page-dump output")


def log_lines(host: str) -> int:
    return int(ssh(host, "wc -l < /tmp/codrawer-layer/log").strip() or 0)


def log_since(host: str, n: int) -> list[str]:
    return ssh(host, f"tail -n +{n + 1} /tmp/codrawer-layer/log").splitlines()


# ── the automation state ────────────────────────────────────────────────────


def auto_state(host: str, local_port: int) -> dict:
    tunnel = subprocess.Popen(
        [
            "ssh",
            *SSH_OPTS,
            "-o",
            "ExitOnForwardFailure=yes",
            "-N",
            "-L",
            f"{local_port}:127.0.0.1:{AUTO_PORT}",
            host,
        ]
    )
    try:
        deadline = time.time() + 30
        sock = None
        while time.time() < deadline:
            try:
                sock = socket.create_connection(("127.0.0.1", local_port), timeout=1)
                break
            except OSError:
                if tunnel.poll() is not None:
                    raise RuntimeError("ssh tunnel failed (is the tablet awake?)") from None
                time.sleep(0.3)
        if sock is None:
            raise RuntimeError("ssh tunnel did not come up")
        sock.settimeout(30)
        sock.sendall(b'{"id":"1","cmd":"state"}\n')
        buf = b""
        while b"\n" not in buf:
            chunk = sock.recv(65536)
            if not chunk:
                raise RuntimeError(
                    "the extension closed the connection "
                    "(does /home/root/codrawer/AUTOMATION exist?)"
                )
            buf += chunk
        sock.close()
        reply = json.loads(buf.split(b"\n", 1)[0])
        if not reply.get("ok"):
            raise RuntimeError(f"state: {reply}")
        return reply["state"]
    finally:
        tunnel.terminate()


# ── choosing the target ─────────────────────────────────────────────────────


def to_norm(x_rm: float, y_rm: float, w: float, h: float) -> tuple[float, float]:
    return (x_rm + w / 2) / w, y_rm / h


def visible_page_rect(state: dict, w: float, h: float) -> tuple[float, float, float, float]:
    """The part of the page on screen, minus the toolbar and margins, in page units."""
    zoom = float(state.get("zoom") or 1.0)
    dx, dy = (state.get("scroll") or [w / 2, 0])[:2]
    x0 = (TOOLBAR_PX - dx) / zoom
    x1 = (SCREEN_W - EDGE_PX - dx) / zoom
    y0 = (EDGE_PX - dy) / zoom
    y1 = (SCREEN_H - EDGE_PX - dy) / zoom
    # and on the page itself (its first screen height: a longer page may not have grown yet)
    x0, x1 = max(x0, -w / 2 + EDGE_PX), min(x1, w / 2 - EDGE_PX)
    return x0, max(y0, EDGE_PX), x1, min(y1, h - EDGE_PX)


def existing_points(page: dict) -> list[tuple[float, float]]:
    w, h = page.get("w") or 1620, page.get("h") or 2160
    return [(p[0] * w - w / 2, p[1] * h) for s in page.get("strokes", []) for p in s.get("pts", [])]


def pick_target(page: dict, state: dict, r: float) -> tuple[float, float]:
    w, h = page.get("w") or 1620, page.get("h") or 2160
    x0, y0, x1, y1 = visible_page_rect(state, w, h)
    pts = existing_points(page)
    half = r + CLEAR_PX
    cx0, cy0 = (x0 + x1) / 2, (y0 + y1) / 2
    best = None
    step = 20.0
    y = y0 + half
    while y <= y1 - half:
        x = x0 + half
        while x <= x1 - half:
            if not any(abs(px - x) < half and abs(py - y) < half for px, py in pts):
                d = math.hypot(x - cx0, y - cy0)
                if best is None or d < best[0]:
                    best = (d, x, y)
            x += step
        y += step
    if best is None:
        die("no free spot on the visible part of the page; turn to an emptier page")
    return best[1], best[2]


def x_in_circle(cx: float, cy: float, r: float) -> list[list[tuple[float, float]]]:
    """Three strokes in page units: a circle and the two diagonals of the square inside it."""
    circle = [
        (cx + r * math.cos(2 * math.pi * i / 48), cy + r * math.sin(2 * math.pi * i / 48))
        for i in range(49)
    ]
    a = r * 0.6
    d1 = [(cx - a + 2 * a * i / 12, cy - a + 2 * a * i / 12) for i in range(13)]
    d2 = [(cx + a - 2 * a * i / 12, cy - a + 2 * a * i / 12) for i in range(13)]
    return [circle, d1, d2]


# ── sending through the router ──────────────────────────────────────────────


async def send_strokes(url: str, strokes_norm: list[list[tuple[float, float]]]) -> None:
    import websockets

    async with websockets.connect(url, open_timeout=60, max_size=2**24) as ws:
        tag = f"inktest_{int(time.time() * 1000)}"
        for i, pts in enumerate(strokes_norm):
            sid = f"{tag}_{i}"
            t0 = int(time.time() * 1000)
            await ws.send(
                json.dumps(
                    {"t": "stroke_begin", "id": sid, "layer": "ai", "brush": "pen", "ts": t0}
                )
            )
            out = [[round(x, 6), round(y, 6), 0.6, t0 + 8 * k] for k, (x, y) in enumerate(pts)]
            await ws.send(json.dumps({"t": "stroke_pts", "id": sid, "pts": out}))
            await ws.send(json.dumps({"t": "stroke_end", "id": sid, "ts": t0 + 8 * len(pts)}))
            await asyncio.sleep(0.3)
        await asyncio.sleep(1.0)  # let the router broadcast before closing


# ── main ────────────────────────────────────────────────────────────────────


def bounds(pts: list[tuple[float, float]]) -> tuple[float, float, float, float]:
    xs, ys = [p[0] for p in pts], [p[1] for p in pts]
    return min(xs), min(ys), max(xs), max(ys)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--host", default="root@192.168.50.156")
    ap.add_argument("--session", default="session1")
    ap.add_argument(
        "--allow-doc",
        default=TEST_DOC,
        help=f"the notebook that may be written to (default {TEST_DOC!r})",
    )
    ap.add_argument("--radius", type=float, default=50.0, help="the circle's radius, page px")
    ap.add_argument(
        "--tolerance", type=float, default=0.012, help="allowed offset of each bound, normalised"
    )
    ap.add_argument(
        "--save-timeout", type=float, default=180.0, help="seconds to wait for xochitl to save"
    )
    ap.add_argument("--local-port", type=int, default=18579)
    a = ap.parse_args()
    host_ip = a.host.split("@")[-1]

    # 1. the gates
    try:
        settings = bridge_settings(a.host)
    except Exception as e:  # noqa: BLE001
        die(f"cannot read bridge.env ({e}); is the tablet awake?")
    if not agent_ink_on(settings):
        die(
            f"native agent ink is off (state={settings.get('state')!r}, "
            f"NATIVE_AGENT_INK={settings.get('env')!r}); "
            "turn it on from the dock (Agent ink on/off)"
        )
    try:
        state = auto_state(a.host, a.local_port)
    except Exception as e:  # noqa: BLE001
        die(f"cannot read the automation state: {e}")
    title = ((state.get("doc") or {}).get("title")) or ""
    if not state.get("doc"):
        die("no notebook is open on the tablet")
    if title != a.allow_doc:
        die(
            f"the visible notebook is {title!r}, not {a.allow_doc!r}; "
            f"open it, or pass --allow-doc {shlex.quote(title)}"
        )
    if state.get("locked"):
        die("the tablet is locked")

    # 2. the page
    page = page_dump(a.host)
    page_id = (state.get("page") or {}).get("id")
    if page.get("page") != page_id:
        die(
            f"-page-dump shows page {page.get('page')} but the visible page is {page_id}; "
            "draw a dot and wait for a save, or turn the page and back"
        )
    w, h = page.get("w") or 1620, page.get("h") or 2160
    before_ai = {s["id"] for s in page.get("strokes", []) if s.get("layer") == "ai"}
    print(
        f"inktest: notebook {title!r}, page {page_id}, "
        f"zoom {state.get('zoom')}, scroll {state.get('scroll')}, "
        f"{len(page.get('strokes', []))} strokes ({len(before_ai)} ai)"
    )

    # 3. the target
    cx, cy = pick_target(page, state, a.radius)
    strokes_rm = x_in_circle(cx, cy, a.radius)
    strokes_norm = [[to_norm(x, y, w, h) for x, y in s] for s in strokes_rm]
    want = bounds([p for s in strokes_norm for p in s])
    tx, ty = to_norm(cx, cy, w, h)
    print(
        f"inktest: target ({tx:.4f}, {ty:.4f}) normalised = ({cx:.1f}, {cy:.1f}) page px, "
        f"radius {a.radius:g} px"
    )

    # 4. send
    n0 = log_lines(a.host)
    token = settings.get("token", "")
    url = f"ws://{host_ip}:{ROUTER_PORT}/ws/{a.session}" + (f"?token={token}" if token else "")
    asyncio.run(send_strokes(url, strokes_norm))
    print(f"inktest: sent {len(strokes_norm)} ai strokes")

    # 5a. the extension's verdicts
    committed, errors, deadline = 0, [], time.time() + 60
    while time.time() < deadline and committed < len(strokes_norm) and not errors:
        time.sleep(2)
        committed, errors = 0, []
        for line in log_since(a.host, n0):  # `ink: ok <n> (<n> stroke(s), layer "…", <ms> ms)`
            m = re.search(r"ink: ok (\d+) ", line)
            if m:
                committed += int(m.group(1))
            elif re.search(r"ink: (err|refused)", line):
                errors.append(line)
    if errors:
        print("inktest: FAIL: the extension refused:\n  " + "\n  ".join(errors))
        return 1
    if committed < len(strokes_norm):
        print(
            f"inktest: FAIL: {committed} of {len(strokes_norm)} strokes committed "
            "within 60 s (no `ink: ok` lines)"
        )
        return 1
    print(f"inktest: extension committed {committed} strokes (ink: ok)")

    # 5b. the save
    deadline = time.time() + a.save_timeout
    new = []
    while time.time() < deadline:
        time.sleep(5)
        try:
            after = page_dump(a.host)
        except Exception as e:  # noqa: BLE001
            print(f"inktest: (dump failed: {e}; retrying)")
            continue
        if after.get("page") != page_id:
            continue
        new = [
            s
            for s in after.get("strokes", [])
            if s.get("layer") == "ai" and s["id"] not in before_ai
        ]
        if len(new) >= len(strokes_norm):
            break
    if len(new) < len(strokes_norm):
        print(
            f"inktest: FAIL: the saved page holds {len(new)} new ai strokes "
            f"after {a.save_timeout:g} s (want {len(strokes_norm)})"
        )
        return 1

    # 6. compare
    got = bounds([(p[0], p[1]) for s in new for p in s.get("pts", [])])
    diffs = [g - w_ for g, w_ in zip(got, want, strict=True)]
    ok = all(abs(d) <= a.tolerance for d in diffs)
    names = ("x0", "y0", "x1", "y1")
    print("inktest: bounds (normalised)      want        got       diff")
    for n, w_, g, d in zip(names, want, got, diffs, strict=True):
        print(f"           {n}             {w_:9.4f}  {g:9.4f}  {d:+9.4f}")
    centre = ((got[0] + got[2]) / 2 - tx, (got[1] + got[3]) / 2 - ty)
    print(
        f"inktest: centre offset ({centre[0]:+.4f}, {centre[1]:+.4f}) "
        f"= ({centre[0] * w:+.1f}, {centre[1] * h:+.1f}) page px; "
        f"tolerance {a.tolerance} per bound"
    )
    print(f"inktest: {'PASS' if ok else 'FAIL'}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
