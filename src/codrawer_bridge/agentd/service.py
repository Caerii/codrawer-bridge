"""
The service: a session participant that answers ``ask_page`` and ``ask_selection`` in ink.

**The connection.** One WebSocket to the tablet's router (``?token=`` the pairing code). The
tablet's Wi-Fi can take tens of seconds to answer, so the open timeout is long (60 s by default)
and keepalive pings are sent every 20 s; on any drop the service reconnects with a backoff of up
to 30 s, and the router replays the page on every join, so the model of the page is rebuilt.
Messages sent while the link is down wait for it up to ``send_wait_s`` and are then dropped.

**A request**, in order (:meth:`Agentd.answer`); every step's time goes into the log:

1. *Acknowledge.* The glasses get "thinking…" at once. With agent ink on, a reply spot is
   reserved near the selection (placement.py, for a typical three-line answer), and an
   ``agent_status`` ``thinking`` names it (docs/protocol.md): the tablet can animate an unsaved
   overlay there while the model thinks; ``writing`` and ``done`` follow. Until that overlay
   exists (``--thinking dots``, the default), three small dots are written at the spot instead:
   a static pending mark. They stay (native ink cannot be taken back by the router); the answer
   starts right after them, so they read as its lead-in.
2. *The page.* If the request names a page other than the snapshot's, wait up to 5 s for the
   page watcher's snapshot of it.
3. *The picture.* ``ask_selection``: the lasso's box with a margin (render.py), the selected
   strokes black. ``ask_page``: the whole page. The PNG goes to the state directory, which lies
   under the terminal's working directory so Claude Code can Read it (ADR 002).
4. *The turn* (prompt.py, terminal.py), with a timeout (90 s by default).
5. *The answer in ink.* hand.py lays the text out at three widths; placement.py picks a width,
   a scale and a free spot (near the dots when there are any); the strokes are sent at the hand's
   pace, pausing while the user's pen is down or moving (the bridge also refuses to commit while
   the user touches the page, ADR 009 §2).
6. *The glasses.* The answer as a ``primer`` message with a ``notice`` move (the tablet's router
   relays ``primer``; its ``glance`` is the glasses' line, its ``text`` the phone panel's) and as
   ``ai_intent`` (for the desktop router, which relays it).
7. *The record.* One JSON line in ``requests.jsonl``.

With agent ink off (``--ink off``, or ``auto`` reading the tablet's setting over SSH), or when no
free space fits the answer, or when ``packages/hand`` cannot run, step 5 is skipped and the
answer is text only. A timeout or failure writes a short note instead of an answer: "couldn't
answer" in ink after the dots (if there are dots), and on the glasses.

**What is ignored.** Other ``dock_action`` ids (the Primer, the marks host and the bridge handle
those), and our own strokes (ids starting ``agentd_``; the router does not echo them anyway).
``agent_ink`` taps refresh the ``auto`` ink setting.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import subprocess
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

from . import hand as handmod
from . import placement, prompt, render
from .page import Box, PageModel
from .queue import PageQueue
from .terminal import Reply, Terminal

log = logging.getLogger("agentd")

ASK_IDS = ("ask_page", "ask_selection")


@dataclass
class Config:
    ws: str
    token: str = ""
    term_url: str = "http://127.0.0.1:3456"
    term_token: str = "sig-glasses"
    term_cwd: str = ""
    state_dir: str = ""
    persona: str = "archivist"
    color: str = "#3a6ea5"
    speed: float = 1.5
    ink: str = "auto"  # on | off | auto (auto reads the tablet over ssh, else on)
    ssh: str = ""  # root@<tablet> for --ink auto
    thinking: str = "dots"  # dots | overlay | none: the pending mark (agent_status is always sent)
    timeout_s: float = 90.0
    open_timeout_s: float = 60.0
    send_wait_s: float = 30.0
    include_ai: bool = False
    dry_run: bool = False
    widths: tuple[float, ...] = (70.0, 110.0, 150.0)
    scales: tuple[float, ...] = (1.0, 0.8, 0.65)


@dataclass
class Record:
    """One request, as logged (times in seconds after the dock_action arrived)."""

    n: int
    kind: str
    received: float  # Unix s, desktop clock
    dock_ts: float | None = None  # the tablet's ms clock
    doc: str = ""
    page: str = ""
    bbox: list[float] | None = None
    region: list[float] | None = None
    n_strokes: int = 0
    image: str = ""
    prompt: str = ""
    ink: bool = False
    pending_at: float | None = None
    reply: dict[str, Any] = field(default_factory=dict)
    answer: str = ""
    placement: dict[str, Any] | None = None
    first_stroke_at: float | None = None
    last_stroke_at: float | None = None
    strokes: int = 0
    yielded_s: float = 0.0
    note: str = ""
    error: str = ""
    status_box: tuple[float, float, float, float] | None = None  # page units, last agent_status


class Agentd:
    """The service (module docstring)."""

    def __init__(self, cfg: Config) -> None:
        self.cfg = cfg
        self.term_cwd = Path(cfg.term_cwd or os.getcwd()).resolve()
        self.state = (
            Path(cfg.state_dir).resolve()
            if cfg.state_dir
            else self.term_cwd / ".codrawer" / "agentd"
        )
        self.state.mkdir(parents=True, exist_ok=True)
        self.model = PageModel()
        self.queue = PageQueue(on_error=lambda e: log.exception("request failed", exc_info=e))
        self.terminal = Terminal(
            cfg.term_url, cfg.term_token, str(self.term_cwd), self.state / "state.json"
        )
        self._turn = asyncio.Lock()  # one terminal turn at a time
        self._ws = None
        self._connected = asyncio.Event()
        self._n = self._last_n()
        self._ink_on: bool | None = None
        self._ink_checked = 0.0
        self._tasks: set[asyncio.Task] = set()

    # ── the connection ─────────────────────────────────────────────────────────────────────

    def _url(self) -> str:
        if not self.cfg.token or "token=" in self.cfg.ws:
            return self.cfg.ws
        return self.cfg.ws + ("&" if "?" in self.cfg.ws else "?") + f"token={self.cfg.token}"

    async def run(self, until: asyncio.Event | None = None) -> None:
        import websockets

        backoff = 2.0
        while until is None or not until.is_set():
            try:
                log.info("connecting to %s", self.cfg.ws)
                async with websockets.connect(
                    self._url(),
                    open_timeout=self.cfg.open_timeout_s,
                    ping_interval=20,
                    ping_timeout=40,
                    max_size=2**25,
                ) as ws:
                    self._ws = ws
                    self._connected.set()
                    backoff = 2.0
                    log.info("joined %s", self.cfg.ws)
                    async for raw in ws:
                        try:
                            msg = json.loads(raw)
                        except ValueError:
                            continue
                        if isinstance(msg, dict):
                            self.handle(msg)
                        if until is not None and until.is_set():
                            return
            except asyncio.CancelledError:
                raise
            except Exception as e:  # noqa: BLE001 - any drop: reconnect
                log.warning(
                    "connection lost (%s: %s); retrying in %.0f s", type(e).__name__, e, backoff
                )
            finally:
                self._ws = None
                self._connected.clear()
            await asyncio.sleep(backoff)
            backoff = min(30.0, backoff * 2)

    async def send(self, msg: dict[str, Any]) -> bool:
        """Send now, or when the link is back within ``send_wait_s``; False if dropped."""
        if self.cfg.dry_run:
            return True
        for _ in range(2):
            if self._ws is None:
                try:
                    await asyncio.wait_for(self._connected.wait(), self.cfg.send_wait_s)
                except TimeoutError:
                    return False
            try:
                await self._ws.send(json.dumps(msg))  # type: ignore[union-attr]
                return True
            except Exception:  # noqa: BLE001 - dropped mid-send: wait for the reconnect once
                await asyncio.sleep(0.5)
        return False

    # ── input ──────────────────────────────────────────────────────────────────────────────

    def handle(self, msg: dict[str, Any]) -> None:
        self.model.observe(msg)
        if msg.get("t") != "dock_action":
            return
        aid = msg.get("id")
        if aid == "agent_ink":
            self._ink_checked = 0.0  # the user toggled it: read the setting again next time
            return
        if aid not in ASK_IDS:
            return
        received = time.time()
        key = f"{msg.get('doc') or self.model.doc}/{msg.get('page') or self.model.page}"
        ahead = self.queue.submit(key, lambda: self.answer(msg, received))
        log.info("dock_action %s on %s (%s ahead)", aid, key, ahead)
        if ahead is None:
            self._spawn(
                self._glasses(
                    "Still answering your last question",
                    "One at a time: still answering the previous question.",
                )
            )

    def _spawn(self, coro) -> None:
        t = asyncio.ensure_future(coro)
        self._tasks.add(t)
        t.add_done_callback(self._tasks.discard)

    # ── agent ink on or off ────────────────────────────────────────────────────────────────

    async def ink_enabled(self) -> bool:
        mode = self.cfg.ink
        if mode in ("on", "off"):
            return mode == "on"
        if not self.cfg.ssh:
            return True
        if self._ink_on is not None and time.time() - self._ink_checked < 120:
            return self._ink_on
        try:
            self._ink_on = await asyncio.to_thread(read_tablet_ink, self.cfg.ssh)
            self._ink_checked = time.time()
        except Exception as e:  # noqa: BLE001 - unreachable over ssh: keep the last answer, else on
            log.warning("cannot read the tablet's agent ink setting (%s)", e)
            if self._ink_on is None:
                return True
        return bool(self._ink_on)

    # ── a request ──────────────────────────────────────────────────────────────────────────

    def _last_n(self) -> int:
        try:
            lines = (self.state / "requests.jsonl").read_text(encoding="utf-8").splitlines()
            return int(json.loads(lines[-1]).get("n", 0)) if lines else 0
        except (OSError, ValueError, IndexError):
            return 0

    def _rel(self, path: Path) -> str:
        try:
            return path.relative_to(self.term_cwd).as_posix()
        except ValueError:
            return path.as_posix()

    async def _wait_page(self, page: str, timeout_s: float = 5.0) -> None:
        deadline = time.monotonic() + timeout_s
        while page and self.model.page != page and time.monotonic() < deadline:
            await asyncio.sleep(0.2)

    async def answer(self, msg: dict[str, Any], received: float | None = None) -> Record:
        """One request, start to finish (module docstring); returns its record."""
        received = received or time.time()
        self._n += 1
        n = self._n
        kind = str(msg.get("id"))
        rec = Record(
            n=n,
            kind=kind,
            received=received,
            dock_ts=msg.get("ts"),
            doc=str(msg.get("doc") or ""),
            page=str(msg.get("page") or ""),
        )
        since = lambda: round(time.time() - received, 3)  # noqa: E731
        run = f"{int(received * 1000) % 10**8:x}"
        try:
            # 1. acknowledge
            what = "your selection" if kind == "ask_selection" else "this page"
            await self._glasses(f"Thinking about {what}…", f"Claude is reading {what}…")
            await self._wait_page(rec.page)
            m = self.model
            W, H = m.w, m.h
            sel_box = m.selection_box(msg) if kind == "ask_selection" else None
            rec.bbox = list(msg["bbox"]) if isinstance(msg.get("bbox"), list) else None
            if sel_box is not None:
                selected = m.selected(sel_box)
                anchor = sel_box
            else:
                selected = m.ink(include_ai=self.cfg.include_ai)
                anchor = m.ink_box(include_ai=False) or (0.1, 0.05, 0.9, 0.1)
            rec.ink = await self.ink_enabled()
            prefer = None
            if not self.cfg.dry_run:
                spot = self._reserve(anchor) if rec.ink else None
                status_box = spot.rect if spot is not None else placement.to_pu(anchor, W, H)
                await self._status(rec, "thinking", status_box)
                if spot is not None and self.cfg.thinking == "dots":
                    await self._dots(spot, run)
                    prefer = (spot.x + DOTS_PU, spot.y)
                    rec.pending_at = since()
                elif spot is not None:
                    prefer = (spot.x, spot.y)  # the overlay marks the spot; the answer starts there
            # 3. the picture
            img = self.state / f"req-{n}.png"
            if sel_box is not None:
                region = render.region_with_margin(sel_box, 0.04, W, H)
                context = [
                    s
                    for s in m.ink(include_ai=self.cfg.include_ai)
                    if s not in selected and render.intersects(s, region)
                ]
                png = render.render_region(selected, context, region, W, H)
                rec.region = [round(v, 4) for v in region]
            else:
                png = render.render_page(selected, W, H)
            img.write_bytes(png)
            rec.image, rec.n_strokes = self._rel(img), len(selected)
            ask = prompt.Ask(
                kind=kind, image=rec.image, n_strokes=len(selected), region=sel_box, title=m.title
            )
            rec.prompt = prompt.build_prompt(ask)
            if self.cfg.dry_run:
                print(f"\n--- dry run: request {n} ({kind}) ---\nimage: {img}\n{rec.prompt}\n---")
                rec.note = "dry run"
                if rec.ink:
                    sample = DRY_RUN_ANSWER
                    await self._write(sample, anchor, None, run, rec, since, perform=False)
                    print(f"a sample {len(sample)}-character answer would go: {rec.placement}")
                return rec
            # 4. the turn
            async with self._turn:
                reply = await self.terminal.ask(rec.prompt, self.cfg.timeout_s)
            rec.reply = {k: v for k, v in asdict(reply).items() if k != "text"}
            rec.reply["raw"] = reply.text
            text = prompt.clean_answer(reply.text) if reply.text and not reply.error else ""
            if not text:
                rec.error = reply.error or "empty answer"
                text_out = "couldn't answer just now"
                await self._glasses(
                    "Couldn't answer just now", f"Couldn't answer just now ({rec.error[:80]})."
                )
                if prefer is not None and self.cfg.thinking == "dots":
                    await self._write(text_out, anchor, prefer, run + "e", rec, since)
                return rec
            rec.answer = text
            # 5. ink, 6. glasses
            await self._glasses(text, text)
            if rec.ink:
                await self._write(text, anchor, prefer, run, rec, since)
            else:
                rec.note = "agent ink off: text only"
            return rec
        except Exception as e:  # noqa: BLE001
            rec.error = f"{type(e).__name__}: {e}"[:300]
            log.exception("request %d failed", n)
            return rec
        finally:
            if rec.status_box is not None:
                await self._status(rec, "done", rec.status_box)
            self._log(rec)

    def _reserve(self, anchor: Box) -> placement.Placement | None:
        """A spot near ``anchor`` for a typical answer (three lines, ~80 mm), before it is known."""
        m = self.model
        occ = placement.Occupancy([s.pts for s in m.ink()], m.w, m.h, height=_ink_height(m))
        typical = [
            placement.Block(
                w=(DOTS_PU + 80 / placement.MM_PER_PU) * s, h=34 / placement.MM_PER_PU * s, scale=s
            )
            for s in self.cfg.scales
        ]
        return placement.place(occ, typical, placement.to_pu(anchor, m.w, m.h))

    async def _dots(self, spot: placement.Placement, run: str) -> None:
        """The static pending mark: three dots at the reserved spot, on the first baseline."""
        m = self.model
        x, y = spot.x, spot.y + 5.2 * spot.block.scale / placement.MM_PER_PU
        msgs = handmod.dots(
            x,
            y,
            m.w,
            m.h,
            time.time() * 1000,
            run,
            color=self.cfg.color,
            author=f"agentd:{self.cfg.persona}",
        )
        await self._play(msgs)
        for d in range(3):
            cx = x + 6 + d * 22
            m.add_own(
                f"agentd_{run}_dot{d}",
                [[(cx - 3) / m.w, (y - 3) / m.h, 0.6], [(cx + 3) / m.w, (y + 3) / m.h, 0.6]],
            )

    async def _status(self, rec: Record, state: str, box_pu: Box) -> None:
        """
        ``agent_status`` (docs/protocol.md): what agentd is doing and where, for an animated,
        unsaved overlay on the tablet. ``bbox`` is in xochitl's page units with x centred, like
        ``dock_action``'s; ``done`` carries ``ok``.
        """
        x0, y0, x1, y1 = box_pu
        half = self.model.w / 2
        bbox = [round(x0 - half, 1), round(y0, 1), round(x1 - half, 1), round(y1, 1)]
        rec.status_box = box_pu
        msg: dict[str, Any] = {
            "t": "agent_status",
            "id": f"agentd_{rec.n}",
            "agent": "agentd",
            "state": state,
            "bbox": bbox,
            "doc": rec.doc or self.model.doc,
            "page": rec.page or self.model.page,
            "ts": int(time.time() * 1000),
        }
        if state == "done":
            msg["ok"] = bool(rec.answer) and not rec.error
        await self.send(msg)

    async def _write(
        self,
        text: str,
        anchor: Box,
        prefer: tuple[float, float] | None,
        run: str,
        rec: Record,
        since,
        perform: bool = True,
    ) -> None:
        """Lay out, place and (unless not ``perform``) write ``text`` (module docstring, step 5)."""
        m = self.model
        try:
            lays = await handmod.layouts_async(
                text, persona=self.cfg.persona, widths=self.cfg.widths
            )
        except handmod.HandUnavailable as e:
            rec.note = f"no handwriting ({e}); text only"
            return
        occ = placement.Occupancy([s.pts for s in m.ink()], m.w, m.h, height=_ink_height(m))
        blocks = [
            lay.block(i, s) for i, lay in enumerate(lays) for s in self.cfg.scales if lay.strokes
        ]
        # the dots are ink now; the answer may start right after them
        spot = placement.place(
            occ,
            blocks,
            placement.to_pu(anchor, m.w, m.h),
            prefer=prefer,
            clearance=30.0 if prefer else 36.0,
        )
        if spot is None:
            rec.note = "no free space near the selection: text only"
            return
        lay = lays[spot.block.layout]
        origin = lay.origin_for((spot.x, spot.y), spot.block.scale, m.w, m.h)
        start = time.time() * 1000 + 50
        msgs = handmod.to_messages(
            lay,
            origin,
            spot.block.scale,
            start,
            speed=self.cfg.speed,
            run=run,
            color=self.cfg.color,
            author=f"agentd:{self.cfg.persona}",
        )
        rec.placement = {
            "rect_norm": [round(v, 4) for v in spot.norm],
            "rect_pu": [round(v, 1) for v in spot.rect],
            "side": spot.side,
            "scale": spot.block.scale,
            "width_mm": lay.width_mm,
            "anchor_norm": [round(v, 4) for v in anchor],
            "origin_norm": [round(v, 5) for v in origin],
        }
        rec.strokes = len(lay.strokes)
        if not perform:
            return
        await self._status(rec, "writing", spot.rect)
        first = await self._play(
            msgs, on_first=lambda: setattr(rec, "first_stroke_at", since()), rec=rec
        )
        rec.last_stroke_at = since()
        if not first:
            rec.note = "link dropped while writing"
        for sid, pts in _own_strokes(msgs):
            m.add_own(sid, pts)

    async def _play(
        self, msgs: list[tuple[float, dict]], on_first=None, rec: Record | None = None
    ) -> bool:
        """
        Send ``(due_ms, msg)`` pairs on time. Before each stroke, wait while the user's pen is down
        or moved within 300 ms, until 1.5 s of quiet; the rest of the performance shifts by the
        wait. Returns False if a message was dropped.
        """
        shift = 0.0
        sent_first = False
        for due, msg in msgs:
            if msg["t"] == "stroke_begin" and self.model.user_active():
                t0 = time.time()
                while self.model.user_active(quiet_ms=1500):
                    await asyncio.sleep(0.1)
                waited = (time.time() - t0) * 1000
                shift += waited
                if rec is not None:
                    rec.yielded_s += waited / 1000
            delay = (due + shift) / 1000 - time.time()
            if delay > 0:
                await asyncio.sleep(delay)
            if shift:
                msg = _shifted(msg, shift)
            if not await self.send(msg):
                return False
            if not sent_first and msg["t"] == "stroke_begin":
                sent_first = True
                if on_first:
                    on_first()
        return True

    async def _glasses(self, glance: str, text: str) -> None:
        """The glasses' line and the phone's panel (``primer`` notice), and ``ai_intent``."""
        self._seq_glance = getattr(self, "_seq_glance", 0) + 1
        await self.send(
            {
                "t": "primer",
                "v": 1,
                "id": f"agentd_{self._seq_glance}",
                "agent": "agentd",
                "mode": "live",
                "model": "claude-code",
                "move": {"kind": "notice", "text": text[:2000], "glance": glance[:200]},
            }
        )
        await self.send({"t": "ai_intent", "plan": text[:120]})

    def _log(self, rec: Record) -> None:
        line = json.dumps(asdict(rec), ensure_ascii=False)
        with open(self.state / "requests.jsonl", "a", encoding="utf-8") as f:
            f.write(line + "\n")
        log.info(
            "request %d %s: %s%s (first stroke %ss, turn %ss)",
            rec.n,
            rec.kind,
            (rec.answer or rec.error or rec.note)[:100],
            f" [{rec.note}]" if rec.note and rec.answer else "",
            rec.first_stroke_at,
            rec.reply.get("done_s"),
        )


#: Width of the pending mark in page units.
DOTS_PU = handmod.DOTS_W

#: What a dry run places, to show where an answer of typical length would go.
DRY_RUN_ANSWER = (
    "Nice line of thought. Check the second step: the sign flips when you move the term across, "
    "so the last line should read minus. The rest holds."
)


def _ink_height(m: PageModel) -> float:
    box = m.ink_box(include_ai=True)
    return max(m.h, (box[3] * m.h + 600) if box else m.h)


def _shifted(msg: dict, shift_ms: float) -> dict:
    out = dict(msg)
    if "ts" in out:
        out["ts"] = int(out["ts"] + shift_ms)
    if out.get("t") == "stroke_pts":
        out["pts"] = [[p[0], p[1], p[2], int(p[3] + shift_ms)] for p in out["pts"]]
    return out


def _own_strokes(msgs: list[tuple[float, dict]]) -> list[tuple[str, list[list[float]]]]:
    pts: dict[str, list[list[float]]] = {}
    for _, m in msgs:
        if m["t"] == "stroke_pts":
            pts.setdefault(m["id"], []).extend([p[0], p[1], p[2]] for p in m["pts"])
    return list(pts.items())


def read_tablet_ink(host: str) -> bool:
    """The tablet's agent ink setting: the dock's kept choice, else NATIVE_AGENT_INK."""
    out = subprocess.run(
        [
            "ssh",
            "-o",
            "BatchMode=yes",
            "-o",
            "ConnectTimeout=15",
            host,
            "cd /home/root/codrawer && (set -a; . ./bridge.env; set +a; "
            "printf 'env=%s\\n' \"$NATIVE_AGENT_INK\"); "
            "printf 'state=%s\\n' \"$(cat state/native_agent_ink 2>/dev/null)\"",
        ],
        capture_output=True,
        text=True,
        timeout=40,
    )
    if out.returncode != 0:
        raise RuntimeError(out.stderr.strip()[:200] or f"ssh exit {out.returncode}")
    kv = dict(line.split("=", 1) for line in out.stdout.splitlines() if "=" in line)
    state = kv.get("state", "").strip()
    if state:
        return state == "1"
    return kv.get("env", "").strip().lower() in ("1", "true", "yes", "on")


_ = Reply  # re-exported for callers that type the reply
