# /// script
# requires-python = ">=3.10"
# ///
"""
rmflow: run a UI flow on the reMarkable through codrawer-layer's automation socket.

The extension (bridge/remarkable/xovi/codrawer-layer, "UI automation") drives xochitl from inside
the process: it reads state from xochitl's own objects, synthesizes taps and swipes into its
window, and copies its display buffer for screenshots, with hard guardrails of its own
(docs/investigations/ui-automation.md): destructive and security UI is never touched, edits only
happen in the notebook "codrawer: test", the user's pen pauses everything, a lock screen is never
bypassed. This script is only the client.

How it connects: the automation socket listens on the tablet's loopback (127.0.0.1:8579), and only
while /home/root/codrawer/AUTOMATION exists. The script opens an SSH tunnel to it (`ssh -L`), so
nothing is exposed to the network or the router, sends one JSON command per step, and checks
the step's expectations against the reply.

A flow is a JSON list of steps (scripts/dev/flows/*.json):

    {"name": "go to page 2", "cmd": "goto", "page": 2,
     "expect": {"ok": true}, "after": {"cmd": "wait_for", "cond": "page.index == 1", "timeout_ms": 3000},
     "shot": true}

- every key but name/expect/after/shot is sent as the command;
- `expect` maps dotted paths into the reply to values (`"state.doc.title": "codrawer: test"`);
- `after` is a command sent right after (typically a wait_for), whose `ok` must be true;
- `shot` grabs the screen after the step and copies the PNG to the output folder.

Usage:
    uv run scripts/dev/rmflow.py scripts/dev/flows/open-test-page2.json [--host root@192.168.50.156] [--out out/rmflow]

The report lists each step: ok or the reason, the time it took, and the screenshot. The exit
status is 0 only if every step passed.
"""

from __future__ import annotations

import argparse
import json
import socket
import subprocess
import sys
import time
from pathlib import Path

REMOTE_PORT = 8579


def dig(obj, path: str):
    for k in path.split("."):
        if not isinstance(obj, dict):
            return None
        obj = obj.get(k)
    return obj


class Tunnel:
    """`ssh -N -L local:127.0.0.1:8579 host`, closed on exit."""

    def __init__(self, host: str, local_port: int):
        self.proc = subprocess.Popen(
            ["ssh", "-o", "ExitOnForwardFailure=yes", "-o", "ConnectTimeout=6", "-o", "BatchMode=yes",
             "-N", "-L", f"{local_port}:127.0.0.1:{REMOTE_PORT}", host],
        )
        self.port = local_port
        deadline = time.time() + 15
        while time.time() < deadline:
            try:
                socket.create_connection(("127.0.0.1", local_port), timeout=1).close()
                return
            except OSError:
                if self.proc.poll() is not None:
                    raise SystemExit("ssh tunnel failed (is the tablet awake?)")
                time.sleep(0.3)
        raise SystemExit("ssh tunnel did not come up")

    def close(self):
        self.proc.terminate()


class Client:
    def __init__(self, port: int):
        self.sock = socket.create_connection(("127.0.0.1", port), timeout=70)
        self.buf = b""
        self.n = 0

    def call(self, cmd: dict) -> dict:
        self.n += 1
        req = {"id": str(self.n), **cmd}
        self.sock.sendall(json.dumps(req).encode() + b"\n")
        while b"\n" not in self.buf:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise SystemExit("the extension closed the connection (is AUTOMATION enabled?)")
            self.buf += chunk
        line, self.buf = self.buf.split(b"\n", 1)
        return json.loads(line)


def run(flow_path: Path, host: str, out: Path, local_port: int) -> bool:
    steps = json.loads(flow_path.read_text())
    out.mkdir(parents=True, exist_ok=True)
    tunnel = Tunnel(host, local_port)
    all_ok = True
    try:
        c = Client(tunnel.port)
        print(f"flow {flow_path.name}: {len(steps)} steps")
        for i, step in enumerate(steps, 1):
            name = step.get("name", step.get("cmd"))
            cmd = {k: v for k, v in step.items() if k not in ("name", "expect", "after", "shot")}
            t0 = time.time()
            reply = c.call(cmd)
            problems = []
            for path, want in step.get("expect", {"ok": True}).items():
                got = dig(reply, path)
                if got != want:
                    problems.append(f"{path} = {got!r}, want {want!r}")
            if not problems and "after" in step:
                after = c.call(step["after"])
                if not after.get("ok"):
                    problems.append(f"after {step['after'].get('cmd')}: {after}")
            shot = ""
            if step.get("shot"):
                g = c.call({"cmd": "grab"})
                if g.get("ok"):
                    local = out / f"{flow_path.stem}-{i:02d}.png"
                    subprocess.run(["scp", "-q", f"{host}:{g['png']}", str(local)], check=False)
                    shot = str(local)
            ok = not problems
            all_ok &= ok
            status = "ok  " if ok else "FAIL"
            print(f"  {status} {i:2d}. {name} ({(time.time() - t0) * 1000:.0f} ms){'  ' + shot if shot else ''}")
            for p in problems:
                print(f"         {p}")
            if not ok and reply.get("error"):
                print(f"         error: {reply['error']}")
            if not ok and step.get("stop_on_fail", True):
                break
    finally:
        tunnel.close()
    print("PASS" if all_ok else "FAIL")
    return all_ok


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("flow", type=Path)
    ap.add_argument("--host", default="root@192.168.50.156")
    ap.add_argument("--out", type=Path, default=Path("out/rmflow"))
    ap.add_argument("--local-port", type=int, default=18579)
    a = ap.parse_args()
    sys.exit(0 if run(a.flow, a.host, a.out, a.local_port) else 1)


if __name__ == "__main__":
    main()
