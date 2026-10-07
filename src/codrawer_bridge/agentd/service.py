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
   page watcher's snapshot of it. The dock's ``view_bbox`` sets the view through which the
   pen's live strokes (screen coordinates) are mapped onto the page (page.py). If the lasso
   finds fewer strokes than the dock's ``items`` (writing not yet saved), wait for the next
   snapshot, up to 15 s. If it still finds nothing, the model is not asked: the glasses say
   "Couldn't see that selection — try again" and nothing is written.
3. *The picture.* ``ask_selection``: the lasso's box with a margin (render.py), the selected
   strokes black. ``ask_page``: the whole page. The PNG goes to the state directory, which lies
   under the terminal's working directory so Claude Code can Read it (ADR 002).
4. *The turn* (prompt.py, terminal.py), with a timeout (90 s by default).
5. *The answer in ink, as it streams* (stream.py). The block reserved in step 1 fixes the wrap
   width and the scale; each sentence is laid out by the warm hand worker (hand.py) as soon as
   the model has finished it, and written on the next line of the block while the model writes
   the rest. The strokes are sent at the hand's pace, pausing while the user's pen is down or
   moving (the bridge also refuses to commit while the user touches the page, ADR 009 §2).
6. *The glasses.* The answer as a ``primer`` message with a ``notice`` move (the tablet's router
   relays ``primer``; its ``glance`` is the glasses' line, its ``text`` the phone panel's) and as
   ``ai_intent`` (for the desktop router, which relays it).
7. *The record.* One JSON line in ``requests.jsonl``.

With agent ink off (``--ink off``, or ``auto`` reading the tablet's setting over SSH), or when no
free space on the page fits the answer within ~33 mm of the selection (placement.py keeps the
block on the page), or when ``packages/hand`` cannot run, step 5 is skipped and the
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
import math
import os
import re
import subprocess
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

from . import hand as handmod
from . import placement, prompt, render
from .aio import within
from .claude_stream import ClaudePool
from .page import Box, PageModel
from .queue import REPLACED, PageQueue
from .stream import InkStream
from .terminal import Reply, Terminal
from .threads import ThreadStore

log = logging.getLogger("agentd")

ASK_IDS = ("ask_page", "ask_selection")


@dataclass
class Config:
    ws: str
    token: str = ""
    term_url: str = "http://127.0.0.1:3456"
    term_token: str = "sig-glasses"
    term_cwd: str = ""  # the repository: the state directory (logs, images) lives under it
    agent_cwd: str = ""  # Claude Code's working directory (default term_cwd); empty is faster
    backend: str = "even-terminal"  # claude-stream (warm claude -p processes) | even-terminal
    model: str = "claude-haiku-4-5-20251001"  # for claude-stream
    pool: int = 1  # asks answered at once (claude-stream keeps one more process warm as a spare)
    state_dir: str = ""
    persona: str = "archivist"
    color: str = "#3a6ea5"
    speed: float = 1.5
    ink: str = "auto"  # on | off | auto (auto reads the tablet over ssh, else on)
    ssh: str = ""  # root@<tablet> for --ink auto
    thinking: str = "dots"  # dots | overlay | none: the pending mark (agent_status is always sent)
    timeout_s: float = 90.0
    save_wait_s: float = 15.0  # how long to wait for a save when the selection is short
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
    view: list[float] | None = None  # zoom, dx, dy of the tablet's view (page.py View)
    live_user: int = 0  # the tablet's pen strokes not yet in a snapshot, at the request
    items: int = 0  # how many items the lasso held (dock_action)
    waited_s: float = 0.0  # waiting for the tablet to save the selection
    status_note: str = ""  # the one line the dock's status row shows at `done` (protocol.md)
    retry_of: dict[str, Any] | None = None  # the failed first turn, when it was retried
    thread: int = 0  # earlier exchanges on this page sent with the ask (threads.py)
    seen: str = ""  # the model's transcription of the selection (its SEEN line; never inked)
    image_bytes: int = 0  # the PNG sent
    chunks: list[dict[str, Any]] = field(default_factory=list)  # what was written, chunk by chunk


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
        # Claude Code's working directory, where the images it Reads go. An empty directory
        # outside any repository loads no project context into every turn (CLAUDE.md is read
        # from the working directory and its parents): measured 2026-10-06 on Haiku with
        # thinking off, a turn took ~23 s there against ~27 s in the repository.
        self.agent_cwd = Path(cfg.agent_cwd).resolve() if cfg.agent_cwd else self.term_cwd
        self.agent_cwd.mkdir(parents=True, exist_ok=True)
        self.model = PageModel()
        self.queue = PageQueue(on_error=lambda e: log.exception("request failed", exc_info=e))
        self.terminal = Terminal(
            cfg.term_url,
            cfg.term_token,
            str(self.agent_cwd),
            # one session per even-terminal: a Haiku terminal must not resume the Opus session
            self.state / f"state-{_slug(cfg.term_url)}.json",
        )
        self._turn = asyncio.Lock()  # one even-terminal turn at a time (its sessions slow down)
        self.claude = (
            ClaudePool(self.agent_cwd, size=cfg.pool + 1, model=cfg.model)
            if cfg.backend == "claude-stream"
            else None
        )
        self._asks = asyncio.Semaphore(max(1, cfg.pool))  # asks in their model turn at once
        self.threads = ThreadStore(self.state)  # the page thread and the memory toggle
        self._reserved: dict[int, Box] = {}  # in-flight asks' answer blocks (page units)
        self._ws = None
        self._connected = asyncio.Event()
        self._n = self._last_n()
        self._ink_on: bool | None = None
        self._ink_checked = 0.0
        self._tasks: set[asyncio.Task] = set()
        self.hand = handmod.HandWorker()  # warm layouts.ts (hand.py), started by run()
        self._joined_at = 0.0  # monotonic s of the latest join (replayed taps are not taps)
        self._last_tap: dict[tuple, float] = {}  # ask signature -> monotonic s (debounce)
        self._open_status: dict[str, tuple] = {}  # agent_status id -> page-unit box, until done

    # ── the connection ─────────────────────────────────────────────────────────────────────

    def _url(self) -> str:
        if not self.cfg.token or "token=" in self.cfg.ws:
            return self.cfg.ws
        return self.cfg.ws + ("&" if "?" in self.cfg.ws else "?") + f"token={self.cfg.token}"

    async def run(self, until: asyncio.Event | None = None) -> None:
        import websockets

        self._spawn(self._warm())
        if self.claude is not None:
            self.claude.fill()  # warm Claude Code processes before the first ask
        backoff = 2.0
        while until is None or not until.is_set():
            try:
                log.info("connecting to %s", self.cfg.ws)
                async with websockets.connect(
                    self._url(),
                    open_timeout=self.cfg.open_timeout_s,
                    # a router restart (the tablet's bridge hosts it) leaves a half-open socket;
                    # 2026-10-06 the old 20 s / 40 s keepalive took 54 s to notice, and the
                    # taps made meanwhile reached nobody; 5 s / 10 s dropped a slow-to-answer
                    # tablet Wi-Fi twice in 15 minutes
                    ping_interval=10,
                    ping_timeout=20,
                    max_size=2**25,
                ) as ws:
                    self._ws = ws
                    self._joined_at = time.monotonic()
                    self._connected.set()
                    backoff = 2.0
                    log.info("joined %s", self.cfg.ws)
                    self._spawn(self._dock_entries())
                    self._spawn(self._end_orphans())
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

    async def _warm(self) -> None:
        """Start the hand's worker and measure the persona now, not at the first request."""
        try:
            t0 = time.monotonic()
            m = await self.hand.metrics(self.cfg.persona)
            log.info(
                "hand worker warm in %.1f s (%s: %s)", time.monotonic() - t0, self.cfg.persona, m
            )
        except handmod.HandUnavailable as e:
            log.warning("hand worker unavailable (%s); answers go to the glasses only", e)

    async def send(self, msg: dict[str, Any]) -> bool:
        """Send now, or when the link is back within ``send_wait_s``; False if dropped."""
        if self.cfg.dry_run:
            return True
        for _ in range(2):
            if self._ws is None:
                try:
                    await within(self._connected.wait(), self.cfg.send_wait_s)
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
        if msg.get("t") == "dock_query":
            self._spawn(self._dock_entries())
            return
        if msg.get("t") != "dock_action":
            return
        aid = msg.get("id")
        if aid == "agent_ink":
            self._ink_checked = 0.0  # the user toggled it: read the setting again next time
            return
        if aid in (MEMORY_ID, FORGET_ID):
            self._spawn(self._on_memory_entry(msg))
            return
        if aid not in ASK_IDS:
            return
        received = time.time()
        now = time.monotonic()
        ts = msg.get("ts")
        age_s = received - float(ts) / 1000 if isinstance(ts, (int, float)) else 0.0
        if now - self._joined_at < REPLAY_WINDOW_S and age_s > STALE_TAP_S:
            log.info("dock_action %s %.0f s old at join: a replay, not a tap; ignored", aid, age_s)
            return
        sig = ask_signature(msg)
        last = self._last_tap.get(sig)
        self._last_tap[sig] = now
        if last is not None and now - last < DEBOUNCE_S:
            log.info("dock_action %s %.1f s after the same tap: one ask", aid, now - last)
            return
        # one line per question: different selections (and the page) run side by side, the same
        # selection asked again replaces itself (queue.py); self._asks bounds the model turns
        page = f"{msg.get('doc') or self.model.doc}/{msg.get('page') or self.model.page}"
        key = f"{page}|{sig}"
        ahead = self.queue.submit(key, lambda: self.answer(msg, received), sig=sig)
        log.info(
            "dock_action %s on %s (%s)",
            aid,
            key,
            "replaces the same ask in flight" if ahead == REPLACED else f"{ahead} ahead",
        )
        if ahead is None:
            self._spawn(
                self._glasses(
                    "Still answering your last question",
                    "One at a time: still answering the previous question.",
                )
            )

    async def _dock_entries(self) -> None:
        """Announce agentd's own dock entries (protocol.md ``dock_entries``): memory and forget."""
        on = self.threads.memory
        await self.send(
            {
                "t": "dock_entries",
                "owner": "agentd",
                "entries": [
                    {
                        "id": MEMORY_ID,
                        "label": "Memory: page thread" if on else "Memory: off",
                        "badge": "on" if on else "off",
                        "hint": "Asks on the same page follow on from each other",
                    },
                    {"id": FORGET_ID, "label": "Forget this page's thread"},
                ],
            }
        )

    async def _on_memory_entry(self, msg: dict[str, Any]) -> None:
        if msg.get("id") == MEMORY_ID:
            self.threads.memory = not self.threads.memory
            on = self.threads.memory
            note = "Memory on: asks on a page follow its thread" if on else "Memory off"
            await self._dock_entries()
        else:
            doc, page = (
                str(msg.get("doc") or self.model.doc),
                str(msg.get("page") or self.model.page),
            )
            gone = self.threads.forget(doc, page)
            note = "Forgot this page's thread" if gone else "This page had no thread"
        log.info("dock %s: %s", msg.get("id"), note)
        await self._glasses(note, note)

    def _spawn(self, coro) -> None:
        t = asyncio.ensure_future(coro)
        self._tasks.add(t)
        t.add_done_callback(self._tasks.discard)

    # ── agent ink on or off ────────────────────────────────────────────────────────────────

    async def ink_enabled(self) -> bool:
        mode = self.cfg.ink
        if mode in ("on", "off"):
            return mode == "on"
        return await self.tablet_ink()

    async def tablet_ink(self) -> bool:
        """The tablet's own agent-ink toggle (over ssh, cached 2 min); True when unknown."""
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
            return path.relative_to(self.agent_cwd).as_posix()
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
        stream: InkStream | None = None
        try:
            # 1. acknowledge
            what = "your selection" if kind == "ask_selection" else "this page"
            await self._glasses(f"Thinking about {what}…", f"Claude is reading {what}…")
            await self._wait_page(rec.page)
            m = self.model
            m.set_view(msg)  # live pen strokes are in screen coordinates (page.py)
            W, H = m.w, m.h
            sel_box = m.selection_box(msg) if kind == "ask_selection" else None
            rec.bbox = list(msg["bbox"]) if isinstance(msg.get("bbox"), list) else None
            rec.view = [round(m.view.zoom, 4), round(m.view.dx, 1), round(m.view.dy, 1)]
            rec.live_user = m.live_user()
            rec.ink = await self.ink_enabled()
            if sel_box is not None:
                # where the answer will go, and the overlay at once (before any wait for a save)
                reserved = await self._reserve(sel_box, rec.n)
                if reserved is not None and not self.cfg.dry_run:
                    await self._status(rec, "thinking", reserved[0].rect)
                selected = await self._selection(msg, sel_box, rec)
                # the larger of the lasso's box and its strokes' bounds (the box can be smaller)
                anchor = _union(sel_box, _bounds(selected)) if selected else sel_box
                if anchor != sel_box:
                    reserved = await self._reserve(anchor, rec.n)
                    if reserved is not None and not self.cfg.dry_run:
                        await self._status(rec, "thinking", reserved[0].rect)
            else:
                selected = m.ink(include_ai=self.cfg.include_ai)
                anchor = m.ink_box(include_ai=False) or (0.1, 0.05, 0.9, 0.1)
                reserved = await self._reserve(anchor, rec.n)
                if reserved is not None and not self.cfg.dry_run:
                    await self._status(rec, "thinking", reserved[0].rect)
            if not selected:
                # never ask about (or answer) an empty picture
                rec.error = "empty selection" if sel_box is not None else "empty page"
                what = "that selection" if sel_box is not None else "anything on this page"
                rec.status_note = f"Couldn't see {what} - try again"
                await self._glasses(
                    f"Couldn't see {what} — try again", f"Couldn't see {what}. Try again."
                )
                return rec
            if rec.ink and reserved is None:
                rec.note = "no free space near the selection: glasses only"
                rec.status_note = "No room near the selection - answer on your glasses"
            elif not rec.ink:
                tablet_on = await self.tablet_ink()
                rec.status_note = (
                    "Answered on your glasses (agent ink off on the desktop)"
                    if tablet_on
                    else "Answered on your glasses (agent ink is off)"
                )
            if reserved is not None:
                spot, width_mm, metrics = reserved
                dots_w = DOTS_PU if self.cfg.thinking == "dots" else 0.0
                rec.placement = {
                    "reserved_pu": [round(v, 1) for v in spot.rect],
                    "reserved_norm": [round(v, 4) for v in spot.norm],
                    "side": spot.side,
                    "scale": spot.block.scale,
                    "width_mm": width_mm,
                    "anchor_norm": [round(v, 4) for v in anchor],
                }
                if rec.ink and not self.cfg.dry_run and self.cfg.thinking == "dots":
                    await self._dots(spot, run)
                    rec.pending_at = since()
            if not rec.ink:
                reserved = None  # the spot only placed the overlay
            # 3. the picture
            img = self.state / f"req-{n}.png"
            if sel_box is not None:
                region = render.region_with_margin(sel_box, 0.04, W, H)
                context = [
                    s
                    for s in m.ink(include_ai=self.cfg.include_ai)
                    if s.id not in {t.id for t in selected} and render.intersects(s, region)
                ]
                png = render.render_region(selected, context, region, W, H)
                rec.region = [round(v, 4) for v in region]
            else:
                png = render.render_page(selected, W, H)
            img.write_bytes(png)  # kept with the log
            if self.agent_cwd != self.term_cwd:
                img = self.agent_cwd / img.name  # and where Claude Code may Read it
                img.write_bytes(png)
            rec.image, rec.n_strokes = self._rel(img), len(selected)
            thread = self.threads.get(rec.doc or m.doc, rec.page or m.page)
            rec.thread = len(thread)
            ask = prompt.Ask(
                kind=kind,
                image=None if self.claude is not None else rec.image,  # attached: no Read
                n_strokes=len(selected),
                region=sel_box,
                title=m.title,
                thread=[(e.seen, e.answer) for e in thread],
            )
            rec.image_bytes = len(png)
            rec.prompt = prompt.build_prompt(ask)
            if self.cfg.dry_run:
                print(f"\n--- dry run: request {n} ({kind}) ---\nimage: {img}\n{rec.prompt}\n---")
                rec.note = "dry run"
                print(f"the answer's block: {rec.placement}")
                return rec
            # 4. the turn, 5. the answer written sentence by sentence as it streams (stream.py)
            if reserved is not None:
                stream = InkStream(
                    self,
                    rec,
                    run,
                    spot.x + dots_w,
                    spot.y,
                    width_mm,
                    spot.block.scale,
                    metrics,
                    since,
                    _page_bottom(m),
                )
            # the stream sees the answer only: the reply's first line is the SEEN transcription
            on_text = (lambda t: stream.feed(prompt.answer_so_far(t))) if stream else None
            async with self._asks:
                t_turn = time.monotonic()
                reply = await self._turn_once(rec.prompt, png, self.cfg.timeout_s, on_text)
                left = self.cfg.timeout_s - (time.monotonic() - t_turn)
                if reply.error and not (stream and stream.written) and left > RETRY_MIN_S:
                    # a failed turn (e.g. "[ede_diagnostic] … stop_reason=tool_use", a dead or
                    # silent process) is retried once, on a fresh session or process
                    log.info("request %d: %s; retrying afresh", n, reply.error[:80])
                    first = reply
                    reply = await self._turn_once(rec.prompt, png, left, on_text)
                    rec.retry_of = {k: v for k, v in asdict(first).items() if k != "text"}
            rec.reply = {k: v for k, v in asdict(reply).items() if k != "text"}
            rec.reply["raw"] = reply.text
            seen, answer_raw = prompt.split_seen(reply.text or "")
            rec.seen = seen
            text = prompt.clean_answer(answer_raw) if answer_raw and not reply.error else ""
            if not text:
                rec.error = reply.error or "empty answer"
                rec.status_note = "Couldn't answer just now - try again"
                await self._glasses(
                    "Couldn't answer just now", f"Couldn't answer just now ({rec.error[:80]})."
                )
                if stream is not None:
                    # keep what was written; after bare dots, say why they lead nowhere
                    dangling = not stream.written and self.cfg.thinking == "dots"
                    await stream.finish("couldn't answer just now" if dangling else "")
                return rec
            rec.answer = text
            self.threads.add(rec.doc or m.doc, rec.page or m.page, seen, text)
            # 6. the glasses
            await self._glasses(text, text)
            if stream is not None:
                await stream.finish(answer_raw)
                if stream.stopped and not rec.status_note:
                    rec.status_note = "Ran out of room - the rest is on your glasses"
            elif not rec.ink:
                rec.note = "agent ink off: text only"
            return rec
        except asyncio.CancelledError:
            # a newer ask for the same selection replaced this one (queue.py); terminal.py has
            # interrupted the model's turn, and the hand stops after its current stroke
            rec.error = "replaced by a newer ask for the same selection"
            if stream is not None:
                stream.stop()
            raise
        except Exception as e:  # noqa: BLE001
            rec.error = f"{type(e).__name__}: {e}"[:300]
            log.exception("request %d failed", n)
            return rec
        finally:
            self._reserved.pop(rec.n, None)  # its block is ink now, or free again
            # every request ends its overlay, answered or not (an orphan spins for 120 s)
            if rec.status_box is not None:
                await self._status(rec, "done", rec.status_box)
            self._log(rec)

    async def _turn_once(self, text: str, png: bytes, timeout_s: float, on_text) -> Reply:
        """One model turn on the configured backend (claude_stream.py, or terminal.py)."""
        if self.claude is not None:
            return await self.claude.ask(text, png, timeout_s, on_text)
        async with self._turn:
            return await self.terminal.ask(text, timeout_s, on_text=on_text)

    async def _selection(self, msg: dict[str, Any], box: Box, rec: Record) -> list:
        """
        The strokes inside the lasso's ``box``. The dock says how many items it selected
        (``items``); while fewer strokes are found (writing not yet saved and not seen live),
        wait for the next ``page`` snapshot, up to ``save_wait_s`` (xochitl saves 6–10 s after a
        pause).
        """
        m = self.model
        want = int(msg.get("items") or 0) if msg.get("contains_stroke", True) else 0
        selected = m.selected(box)
        t0 = time.monotonic()
        saves = 0  # snapshots seen while waiting: one is enough unless nothing was found
        while (not selected or (len(selected) < want and not saves)) and (
            time.monotonic() - t0 < self.cfg.save_wait_s
        ):
            v = m.version
            while m.version == v and time.monotonic() - t0 < self.cfg.save_wait_s:
                await asyncio.sleep(0.2)
            saves += m.version != v
            selected = m.selected(box)
        rec.waited_s = round(time.monotonic() - t0, 2) if time.monotonic() - t0 > 0.3 else 0.0
        rec.items = want
        return selected

    async def _reserve(
        self, anchor: Box, owner: int | None = None
    ) -> tuple[placement.Placement, float, handmod.Metrics] | None:
        """
        A block near ``anchor`` for an answer not yet written: sized for ``TYPICAL_CHARS``
        characters (plus a line, as each streamed sentence starts a new one) at each wrap width
        and scale, from the persona's metrics. Returns the placement, its wrap width in mm and the
        metrics, or None when nothing fits (or the hand cannot run).
        """
        m = self.model
        try:
            met = await self.hand.metrics(self.cfg.persona)
        except handmod.HandUnavailable:
            return None
        dots_w = DOTS_PU if self.cfg.thinking == "dots" else 0.0
        mm = placement.MM_PER_PU
        blocks = []
        a = placement.to_pu(anchor, m.w, m.h)
        for i, w_mm in enumerate(self._widths(a[0], dots_w)):
            lines = math.ceil(TYPICAL_CHARS * met.mm_per_char / w_mm) + 1
            h_mm = -met.ascent + (lines - 1) * met.pitch + met.descent + 1.0
            for s in self.cfg.scales:
                blocks.append(
                    placement.Block(w=w_mm * s / mm + dots_w, h=h_mm * s / mm, layout=i, scale=s)
                )
        occ = placement.Occupancy(
            [s.pts for s in m.ink()] + self.others_blocks(owner), m.w, m.h, height=_ink_height(m)
        )
        spot = placement.place(
            occ,
            blocks,
            placement.to_pu(anchor, m.w, m.h),
            page_bottom=_page_bottom(m),
            page_top=_page_top(m),
            max_gap=MAX_GAP_PU,
        )
        if spot is None:
            return None
        if owner is not None:
            self._reserved[owner] = spot.rect  # other asks now plan around it (no await since)
        return spot, self._widths(a[0], dots_w)[spot.block.layout], met

    def others_blocks(self, owner: int | None) -> list[list[list[float]]]:
        """The other in-flight asks' reserved blocks, as filled 'strokes' for an Occupancy."""
        m = self.model
        return [
            row
            for k, r in self._reserved.items()
            if k != owner
            for row in placement.fill_strokes(r, m.w, m.h)
        ]

    def _widths(self, left_pu: float, dots_w: float) -> list[float]:
        """
        Wrap widths to try, mm at scale 1: first the comfortable measure that fits between the
        selection's left edge and the page's right margin (capped at ``MAX_MEASURE_MM``, never
        under ``MIN_MEASURE_MM``: a selection near the right edge shifts the block left, as
        placement may), then the configured ones. Not the selection's own width: a narrow lasso
        gave a column of two words a line on 2026-10-06.
        """
        m = self.model
        room_mm = (m.w - 60.0 - max(left_pu, 150.0) - dots_w) * placement.MM_PER_PU
        first = max(MIN_MEASURE_MM, min(MAX_MEASURE_MM, room_mm))
        return [first, *[w for w in self.cfg.widths if abs(w - first) > 5]]

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
            if rec.status_note:
                msg["note"] = rec.status_note
        if state == "done":
            if await self.send(msg):
                self._open_status.pop(msg["id"], None)
        else:
            self._open_status[msg["id"]] = (bbox, msg["doc"], msg["page"])
            await self.send(msg)

    async def _end_orphans(self) -> None:
        """After a (re)join: end every overlay whose `done` was lost with the connection."""
        for sid, (bbox, doc, page) in list(self._open_status.items()):
            if any(not t.done() and t.get_name() == sid for t in self._tasks):
                continue
            log.info("ending orphaned overlay %s", sid)
            ok = await self.send(
                {
                    "t": "agent_status",
                    "id": sid,
                    "agent": "agentd",
                    "state": "done",
                    "ok": False,
                    "bbox": bbox,
                    "doc": doc,
                    "page": page,
                    "ts": int(time.time() * 1000),
                }
            )
            if ok:
                self._open_status.pop(sid, None)

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

#: The answer length a block is reserved for before the answer exists (characters): the prompt
#: asks for under 25 words, ~140 characters.
TYPICAL_CHARS = 140

#: A comfortable line for an answer, mm at scale 1, and the narrowest acceptable.
MAX_MEASURE_MM = 125.0
MIN_MEASURE_MM = 70.0

#: Taps: arriving within this long of a (re)join and older than STALE_TAP_S, a dock_action is a
#: replay, not a tap; the same ask again within DEBOUNCE_S is one ask (seconds).
REPLAY_WINDOW_S = 3.0
STALE_TAP_S = 10.0
DEBOUNCE_S = 1.5

#: A failed turn is retried only with at least this much of the timeout left (seconds).
RETRY_MIN_S = 10.0

#: agentd's own dock entries (dock_entries): the page-thread memory toggle, and forgetting.
MEMORY_ID = "agentd_memory"
FORGET_ID = "agentd_forget"


def _bounds(strokes) -> Box:
    bs = [st.bbox() for st in strokes]
    return (
        min(b[0] for b in bs),
        min(b[1] for b in bs),
        max(b[2] for b in bs),
        max(b[3] for b in bs),
    )


def _union(a: Box, b: Box) -> Box:
    return (min(a[0], b[0]), min(a[1], b[1]), max(a[2], b[2]), max(a[3], b[3]))


#: The farthest an answer may sit from what it answers, page units (~33 mm); farther away it
#: would read as unrelated ink, so the answer goes to the glasses only.
MAX_GAP_PU = 300.0


def _page_bottom(m: PageModel) -> float:
    """
    How far down the page reaches, page units: its height, the lowest ink, or the bottom of
    the screen when the user has scrolled further down (xochitl grows the page as one writes
    there; the view comes from the request's ``view_bbox``, page.py).
    """
    box = m.ink_box(include_ai=True)
    v = m.view
    visible = (v.screen_h - v.dy) / v.zoom
    return max(m.h, box[3] * m.h if box else m.h, visible)


def _page_top(m: PageModel) -> float:
    """The top of the screen on the page, page units (0 unless the user has scrolled down)."""
    return max(0.0, -m.view.dy / m.view.zoom)


def ask_signature(msg: dict[str, Any]) -> tuple:
    """
    What makes two asks the same question (queue.py): the entry and, for a selection, the
    lasso's box rounded to 10 page units (a second tap on the same lasso repeats it exactly; a
    redrawn lasso differs by more). The page is the queue's key already.
    """
    box = msg.get("bbox")
    rounded = (
        tuple(round(float(v) / 10) for v in box) if isinstance(box, list) and len(box) == 4 else ()
    )
    return (str(msg.get("id")), rounded)


def _slug(url: str) -> str:
    """A file-name-safe form of a URL (``http://127.0.0.1:3457`` → ``127.0.0.1-3457``)."""
    return re.sub(r"[^A-Za-z0-9.]+", "-", url.split("://", 1)[-1]).strip("-")


def _ink_height(m: PageModel) -> float:
    """The height the occupancy grid covers, page units: the page, its ink and the screen."""
    box = m.ink_box(include_ai=True)
    return max(m.h, (box[3] * m.h + 600) if box else m.h, _page_bottom(m))


def _shifted(msg: dict, shift_ms: float) -> dict:
    out = dict(msg)
    if "ts" in out:
        out["ts"] = int(out["ts"] + shift_ms)
    if out.get("t") == "stroke_pts":
        out["pts"] = [[p[0], p[1], p[2], int(p[3] + shift_ms)] for p in out["pts"]]
    return out


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
