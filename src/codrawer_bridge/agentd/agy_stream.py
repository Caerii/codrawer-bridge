"""
Antigravity CLI (``agy``) as warm, persistent processes for ``codrawer-agentd``.

Drives ``agy --input-format stream-json --output-format stream-json --model <m>
--dangerously-skip-permissions --disable-slash-commands`` using the same warm-pool lifecycle as
``claude_stream.py``: each ask takes a pre-warmed process, runs one turn, and retires it while
the pool starts a replacement in the background.

Because ``agy``'s ``stream-json`` stdin accepts ``text`` content only, the rendered page/selection
PNG is saved under ``--add-dir`` and referenced by path in the prompt so ``agy`` inspects it
with ``view_file``.
"""

from __future__ import annotations

import asyncio
import json
import os
import shutil
import time
from collections.abc import Callable
from pathlib import Path

from .aio import within
from .terminal import Reply


def agy_command(
    model: str,
    exe: str | None = None,
    add_dirs: tuple[Path, ...] = (),
) -> list[str]:
    """The ``agy`` stream-json command line."""
    cmd = [
        exe or shutil.which("agy") or "agy",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--model",
        model,
        "--dangerously-skip-permissions",
        "--disable-slash-commands",
    ]
    for d in add_dirs:
        cmd.extend(["--add-dir", str(d)])
    return cmd


def agy_user_message(text: str) -> bytes:
    """One NDJSON stdin line for ``agy --input-format stream-json``."""
    msg = {"event": "user", "message": {"content": text}}
    return (json.dumps(msg) + "\n").encode("utf-8")


class AgyProcess:
    """One ``agy`` stream-json process and its life cycle."""

    def __init__(self, cmd: list[str], cwd: Path, env: dict[str, str] | None = None) -> None:
        self.cmd = cmd
        self.cwd = cwd
        self.env = env
        self.state = "starting"
        self.proc: asyncio.subprocess.Process | None = None
        self.warm_s: float | None = None

    async def start(self, warm_timeout_s: float = 120.0) -> bool:
        """Spawn and wait for ``init`` (sidecar booted). True when ready; otherwise retired."""
        t0 = time.monotonic()
        try:
            self.proc = await asyncio.create_subprocess_exec(
                *self.cmd,
                cwd=self.cwd,
                env=self.env,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL,
                limit=2**26,
            )
            assert self.proc.stdout is not None
            while True:
                left = warm_timeout_s - (time.monotonic() - t0)
                if left <= 0:
                    await self.retire()
                    return False
                line = await within(self.proc.stdout.readline(), left)
                if not line:
                    await self.retire()
                    return False
                try:
                    ev = json.loads(line)
                except ValueError:
                    continue
                if ev.get("event") == "init":
                    self.state = "ready"
                    self.warm_s = round(time.monotonic() - t0, 2)
                    return True
        except (OSError, ValueError, TimeoutError):
            await self.retire()
            return False

    async def turn(
        self,
        text: str,
        png: bytes | None,
        timeout_s: float,
        on_text: Callable[[str], None] | None = None,
        stall_s: float = 45.0,
    ) -> Reply:
        """One turn: write ``user`` event, read ``step_update`` / ``result`` events."""
        del png  # images travel via --add-dir + file path in prompt
        out = Reply()
        p = self.proc
        if p is None or p.stdin is None or p.stdout is None or p.returncode is not None:
            out.error = "agy process not running"
            return out
        t0 = time.monotonic()
        try:
            p.stdin.write(agy_user_message(text))
            await p.stdin.drain()
        except (OSError, ConnectionError) as e:
            out.error = f"agy process: {e}"
            return out
        out.posted_s = round(time.monotonic() - t0, 3)
        acc = ""
        while True:
            now = time.monotonic() - t0
            left = timeout_s - now
            if left <= 0:
                out.error = f"timed out after {timeout_s:.0f} s"
                out.text = acc
                return out
            try:
                line = await within(p.stdout.readline(), min(left, stall_s))
            except TimeoutError:
                out.error = f"no output for {min(left, stall_s):.0f} s"
                out.text = acc
                return out
            if not line:
                out.error = "agy process exited"
                out.text = acc
                return out
            try:
                ev = json.loads(line)
            except ValueError:
                continue
            kind = ev.get("event")
            if kind == "step_update":
                su = ev.get("step_update") or {}
                if su.get("step_type") == "agent_response":
                    delta = su.get("text_delta") or ""
                    if delta:
                        if out.first_text_s is None:
                            out.first_text_s = out.first_answer_s = round(
                                time.monotonic() - t0, 3
                            )
                        acc += str(delta)
                        if on_text is not None:
                            on_text(acc)
            elif kind == "result":
                res = ev.get("result") or {}
                out.done_s = round(time.monotonic() - t0, 3)
                out.ok = res.get("status") == "SUCCESS"
                out.text = str(res.get("response") or acc).strip()
                u = res.get("usage") or {}
                out.tokens_in = int(u.get("input_tokens") or 0)
                if not out.ok:
                    err = res.get("error") or out.text
                    out.error = f"agy: {res.get('status')}: {str(err)[:160]}"
                return out

    async def retire(self) -> None:
        self.state = "retired"
        p = self.proc
        if p is not None and p.returncode is None:
            try:
                p.kill()
                await within(p.wait(), 5)
            except (TimeoutError, ProcessLookupError):
                pass


class AgyPool:
    """``size`` warm ``agy`` processes; each ask takes one and retires it."""

    def __init__(
        self,
        cwd: Path,
        size: int = 2,
        model: str = "gemini-4-neon-medium",
        cmd: list[str] | None = None,
        add_dirs: tuple[Path, ...] = (),
        warm_timeout_s: float = 120.0,
    ) -> None:
        self.cwd = cwd
        self.size = size
        self.cmd = cmd or agy_command(model, add_dirs=add_dirs)
        self.env = dict(os.environ)
        self.warm_timeout_s = warm_timeout_s
        self._ready: asyncio.Queue[AgyProcess] = asyncio.Queue()
        self._starting = 0
        self._busy = 0
        self._tasks: set[asyncio.Task] = set()
        self._closed = False
        self.started = 0

    def fill(self) -> None:
        """Start processes until ``size`` are alive (ready, starting or busy)."""
        while not self._closed and self._alive() < self.size:
            self._starting += 1
            self.started += 1
            t = asyncio.ensure_future(self._start_one())
            self._tasks.add(t)
            t.add_done_callback(self._tasks.discard)

    def _alive(self) -> int:
        return self._starting + self._ready.qsize() + self._busy

    def stats(self) -> dict[str, int]:
        """Current pool capacity for health reporting."""
        return {
            "ready": self._ready.qsize(),
            "starting": self._starting,
            "busy": self._busy,
            "size": self.size,
        }

    async def _start_one(self) -> None:
        p = AgyProcess(self.cmd, self.cwd, self.env)
        try:
            ok = await p.start(self.warm_timeout_s)
        finally:
            self._starting -= 1
        if ok and not self._closed:
            self._ready.put_nowait(p)
        else:
            await p.retire()
            if not self._closed:
                await asyncio.sleep(2.0)
                self.fill()

    async def ask(
        self,
        text: str,
        png: bytes | None,
        timeout_s: float = 90.0,
        on_text: Callable[[str], None] | None = None,
        stall_s: float = 45.0,
    ) -> Reply:
        """One ask on a warm ``agy`` process, which is then retired and replaced."""
        self.fill()
        t0 = time.monotonic()
        try:
            p = await within(self._ready.get(), timeout_s)
        except TimeoutError:
            return Reply(error=f"no agy process ready within {timeout_s:.0f} s")
        waited = time.monotonic() - t0
        self._busy += 1
        try:
            r = await p.turn(text, png, max(1.0, timeout_s - waited), on_text, stall_s)
        finally:
            self._busy -= 1
            await p.retire()
            self.fill()
        for k in ("posted_s", "first_text_s", "first_answer_s", "done_s"):
            v = getattr(r, k)
            if v is not None:
                setattr(r, k, round(v + waited, 3))
        r.session_id = "agy-stream"
        return r

    async def close(self) -> None:
        self._closed = True
        while not self._ready.empty():
            await self._ready.get_nowait().retire()
        for t in list(self._tasks):
            t.cancel()
