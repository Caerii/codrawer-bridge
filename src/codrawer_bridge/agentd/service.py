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
import dataclasses
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
    model: str = "claude-sonnet-5-5"  # "careful", the default (claude-stream)
    fast_model: str = "claude-haiku-4-5-20251001"  # "fast", from the dock's Model entry
    pool: int = 1  # asks answered at once (claude-stream keeps one more process warm as a spare)
    state_dir: str = ""
    persona: str = "archivist"
    color: str = "#3a6ea5"
    speed: float = 1.0  # an extra playback factor on top of the writing-speed setting
    max_page_y: float = 1.5  # page heights: the deployed bridge refuses agent ink further down
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
        self.threads = ThreadStore(self.state)  # the page thread, the memory and model choices
        self.claude = (
            ClaudePool(self.agent_cwd, size=cfg.pool + 1, model=self.model_id)
            if cfg.backend == "claude-stream"
            else None
        )
        self._asks = asyncio.Semaphore(max(1, cfg.pool))  # asks in their model turn at once
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
                    self._spawn(
                        self.send(
                            {"t": "settings", "agent": "agentd", "state": self.settings_state()}
                        )
                    )
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
        if msg.get("t") == "settings" and isinstance(msg.get("set"), dict):
            self._spawn(self._apply_settings(msg["set"]))
            return
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
        if aid in (SIZE_ID, SPACING_ID, SPEED_ID):
            key, order = {
                SIZE_ID: ("text_size", SIZES),
                SPACING_ID: ("spacing", SPACINGS),
                SPEED_ID: ("writing_speed", SPEEDS),
            }[aid]
            now = self.setting(key)
            self._spawn(self._apply_settings({key: order[(order.index(now) + 1) % len(order)]}))
            return
        if aid == MODEL_ID:
            self._spawn(self._on_model_entry())
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
                    {
                        "id": SIZE_ID,
                        "label": f"Text size: {self.setting('text_size')}",
                        "badge": self.setting("text_size"),
                    },
                    {
                        "id": SPACING_ID,
                        "label": f"Spacing: {self.setting('spacing')}",
                        "badge": self.setting("spacing"),
                    },
                    {
                        "id": SPEED_ID,
                        "label": "Writing speed: "
                        + self.setting("writing_speed").replace("_", " "),
                        "badge": self.setting("writing_speed"),
                    },
                    {
                        "id": MODEL_ID,
                        "label": f"Model: {self.speed} ({_model_name(self.model_id)})",
                        "badge": self.speed,
                        "hint": "careful reads handwriting best; fast answers sooner",
                    },
                ],
            }
        )

    def setting(self, key: str) -> str:
        """A user setting with a fixed set of values (SETTINGS), from settings.json."""
        values, default = SETTINGS[key]
        v = self.threads.setting(key, default)
        return v if v in values else default

    @property
    def hurry(self) -> float:
        """The hand's hurry for the writing-speed setting (WRITING_SPEED)."""
        return WRITING_SPEED[self.setting("writing_speed")][0]

    @property
    def playback(self) -> float:
        """How much faster than the (hurried) hand's own timing strokes are sent."""
        return WRITING_SPEED[self.setting("writing_speed")][1] * self.cfg.speed

    def scales_for(self, met: handmod.Metrics) -> list[float]:
        """
        The scales placement may choose from, by the text-size setting (TEXT_SIZE), leaving out
        any that would write lowercase letters under MIN_XHEIGHT_MM (the largest always stays).
        """
        k = TEXT_SIZE[self.setting("text_size")]
        scales = [round(s * k, 3) for s in self.cfg.scales]
        if met.x_height > 0:
            legible = [s for s in scales if met.x_height * s >= MIN_XHEIGHT_MM]
            scales = legible or scales[:1]
        return scales

    def effective_metrics(self, met: handmod.Metrics) -> handmod.Metrics:
        """
        The persona's metrics with the line pitch the spacing setting asks for (LINE_PITCH):
        ``compact`` is 1.25 times a line's ink height (ascender top to descender bottom),
        ``normal`` the persona's own leading, ``airy`` 1.25 times that.
        """
        ink = met.descent - met.ascent
        pitch = {
            "compact": 1.25 * ink,
            "normal": met.pitch,
            "airy": 1.25 * met.pitch,
        }[self.setting("spacing")]
        return dataclasses.replace(met, pitch=max(pitch, ink + 0.5))

    def settings_state(self) -> dict[str, Any]:
        return {
            "text_size": self.setting("text_size"),
            "spacing": self.setting("spacing"),
            "writing_speed": self.setting("writing_speed"),
            "memory": self.threads.memory,
            "model": self.speed,
        }

    async def _apply_settings(self, changes: dict[str, Any]) -> None:
        """Apply ``settings`` from the dock or another surface (protocol.md), then announce."""
        for key, value in changes.items():
            if key in SETTINGS and value in SETTINGS[key][0]:
                self.threads.set_setting(key, value)
            elif key == "memory" and isinstance(value, bool):
                self.threads.memory = value
            elif key == "model" and value in ("careful", "fast") and value != self.speed:
                await self._on_model_entry()
        state = self.settings_state()
        log.info("settings: %s", state)
        await self.send({"t": "settings", "agent": "agentd", "state": state})
        await self._dock_entries()
        note = f"Text {state['text_size']}, spacing {state['spacing']}"
        await self._glasses(note, note)

    @property
    def speed(self) -> str:
        """The dock's model choice: ``careful`` (default) or ``fast``."""
        return "fast" if self.threads.setting("model", "careful") == "fast" else "careful"

    @property
    def model_id(self) -> str:
        """The Claude model in use, by the dock's choice."""
        return self.cfg.fast_model if self.speed == "fast" else self.cfg.model

    async def _on_model_entry(self) -> None:
        """Switch careful/fast: kept in settings; the pool restarts on the other model."""
        self.threads.set_setting("model", "careful" if self.speed == "fast" else "fast")
        if self.claude is not None:
            old = self.claude
            self.claude = ClaudePool(self.agent_cwd, size=self.cfg.pool + 1, model=self.model_id)
            self.claude.fill()
            await old.close()  # asks already running keep their process until they finish
        note = f"Model: {self.speed} ({_model_name(self.model_id)})"
        log.info("dock %s: %s", MODEL_ID, note)
        await self._dock_entries()
        await self._glasses(note, note)

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
                # The answer goes just under the selected ink itself, not under the lasso's box: a
                # lasso is often drawn much taller than the writing (placement keeps clear of every
                # stroke on the page). The overlay goes there at once; only when the ink is not
                # all known yet (an unsaved selection) does it start under the box and move.
                # The tablet may propose where the answer goes (`spot`, its thinking doodle's
                # place) and say where the selected ink is (`ink`): honour both when they hold.
                spot = _scene_box(msg.get("spot"), m.w)  # page units, x from the left edge
                tablet_ink = _scene_box(msg.get("ink"), m.w)
                want = int(msg.get("items") or 0) if msg.get("contains_stroke", True) else 0
                known = m.selected(sel_box)
                if tablet_ink is not None and _within(
                    tablet_ink, placement.to_pu(sel_box, m.w, m.h)
                ):
                    first = _norm_box(tablet_ink, m.w, m.h)
                else:
                    first = _bounds(known) if known and len(known) >= want else sel_box
                reserved = await self._reserve(first, rec.n, at=spot)
                if reserved is not None and not self.cfg.dry_run:
                    await self._status(rec, "thinking", self._shown_box(reserved[0], spot))
                selected = await self._selection(msg, sel_box, rec)
                anchor = (
                    first if first is not sel_box else (_bounds(selected) if selected else sel_box)
                )
                if anchor != first:
                    reserved = await self._reserve(anchor, rec.n, at=spot)
                    if reserved is not None and not self.cfg.dry_run:
                        await self._status(rec, "thinking", self._shown_box(reserved[0], spot))
            else:
                selected = m.ink(include_ai=self.cfg.include_ai)
                anchor = m.ink_box(include_ai=False) or (0.1, 0.05, 0.9, 0.1)
                spot = _scene_box(msg.get("spot"), m.w)
                reserved = await self._reserve(anchor, rec.n, at=spot)
                if reserved is not None and not self.cfg.dry_run:
                    await self._status(rec, "thinking", self._shown_box(reserved[0], spot))
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
                too_low = anchor[3] > self.cfg.max_page_y - 0.05
                rec.status_note = (
                    "Too far down the page for agent ink - answer on your glasses"
                    if too_low
                    else "No room near the selection - answer on your glasses"
                )
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
                    _page_bottom(m, self.cfg.max_page_y),
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
        self, anchor: Box, owner: int | None = None, at: Box | None = None
    ) -> tuple[placement.Placement, float, handmod.Metrics] | None:
        """
        A block near ``anchor`` for an answer not yet written: sized for ``TYPICAL_CHARS``
        characters (plus a line, as each streamed sentence starts a new one) at each wrap width
        and scale, from the persona's metrics. Returns the placement, its wrap width in mm and the
        metrics, or None when nothing fits (or the hand cannot run).
        """
        m = self.model
        try:
            met = self.effective_metrics(await self.hand.metrics(self.cfg.persona))
        except handmod.HandUnavailable:
            return None
        dots_w = DOTS_PU if self.cfg.thinking == "dots" else 0.0
        mm = placement.MM_PER_PU
        blocks = []
        a = placement.to_pu(anchor, m.w, m.h)
        # measures are on the page (mm): smaller writing fills the same width with more words
        # per line, rather than becoming a narrow column
        combos = [(p, s) for p in self._widths(a[0], dots_w) for s in self.scales_for(met)]
        for i, (page_mm, s) in enumerate(combos):
            lines = math.ceil(TYPICAL_CHARS * met.mm_per_char * s / page_mm) + 1
            h_mm = -met.ascent + (lines - 1) * met.pitch + met.descent + 1.0
            blocks.append(
                placement.Block(w=page_mm / mm + dots_w, h=h_mm * s / mm, layout=i, scale=s)
            )
        occ = placement.Occupancy(
            [s.pts for s in m.ink()] + self.others_blocks(owner), m.w, m.h, height=_ink_height(m)
        )
        rules = dict(
            page_bottom=_page_bottom(m, self.cfg.max_page_y),
            page_top=_page_top(m),
            max_gap=MAX_GAP_PU,
        )
        spot = None
        if at is not None:  # the tablet's proposal: its top-left, if a block fits there
            spot = placement.place_at(
                occ, blocks, placement.to_pu(anchor, m.w, m.h), at[:2], **rules
            )
        if spot is None:
            spot = placement.place(occ, blocks, placement.to_pu(anchor, m.w, m.h), **rules)
        if spot is None:
            return None
        if owner is not None:
            self._reserved[owner] = spot.rect  # other asks now plan around it (no await since)
        page_mm, s = combos[spot.block.layout]
        return spot, page_mm / s, met  # the hand's wrap width is at scale 1

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
        Measures to try, mm on the page: first the comfortable measure that fits between the
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

    @staticmethod
    def _shown_box(spot: placement.Placement, proposed: Box | None) -> Box:
        """The thinking bbox: the tablet's own when its proposal was honoured (no visible move)."""
        if proposed is not None and abs(spot.x - proposed[0]) < 1 and abs(spot.y - proposed[1]) < 1:
            return proposed
        return spot.rect

    async def _status(self, rec: Record, state: str, box_pu: Box) -> None:
        """
        ``agent_status`` (docs/protocol.md): what agentd is doing and where, for an animated,
        unsaved overlay on the tablet. ``bbox`` is in xochitl's page units with x centred, like
        ``dock_action``'s; ``done`` carries ``ok``.
        """
        x0, y0, x1, y1 = box_pu
        half = self.model.w / 2
        bbox = [round(x0 - half, 1), round(y0, 1), round(x1 - half, 1), round(y1, 1)]
        if state == "thinking" and rec.status_box is not None:
            # one move at most: a correction under STATUS_SLACK units would only jitter the doodle
            if max(abs(a - b) for a, b in zip(box_pu, rec.status_box, strict=True)) < STATUS_SLACK:
                return
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
MODEL_ID = "agentd_model"
SIZE_ID = "agentd_text_size"
SPACING_ID = "agentd_spacing"

#: The user's layout settings: the values each may take (in the dock's tap order) and its default.
#: Compact spacing is the default because the user asked for answers that fit a more compact space
#: (2026-10-07); separate_lines (hand.py) guarantees its lines never touch.
SIZES = ("micro", "tiny", "small", "medium", "large")  # the dock cycles smallest to largest
SPACINGS = ("compact", "normal", "airy")
SPEEDS = ("calm", "fast", "very_fast")
SETTINGS: dict[str, tuple[tuple[str, ...], str]] = {
    "text_size": (SIZES, "medium"),
    "spacing": (SPACINGS, "compact"),
    "writing_speed": (SPEEDS, "fast"),
}

#: Writing speed presets: (the hand's hurry, packages/hand `hurried`; playback factor). A hurried
#: hand cuts its pauses more than its strokes and loosens a little, which reads as a person writing
#: fast; past a hurry of 2 the letters lose their shape (2026-10-07), so the rest of the speed is
#: playback. With the Archivist: calm ~4.6 letters/s, fast ~7.3, very fast ~9.9 (fast print is
#: 8-12). The pre-setting live default (no hurry, playback 3) wrote ~4.2.
WRITING_SPEED = {"calm": (1.5, 2.0), "fast": (2.0, 2.2), "very_fast": (2.0, 3.0)}
SPEED_ID = "agentd_writing_speed"

#: Text size presets as factors on the scales placement chooses from (Config.scales, 1, 0.8 and
#: 0.65): medium is the original size (the Archivist's x-height 3.52 mm at scale 1).
TEXT_SIZE = {"micro": 0.42, "tiny": 0.55, "small": 0.7, "medium": 1.0, "large": 1.3}

#: The smallest lowercase the hand may write, mm: the tablet's pen is ~0.22 mm wide, and below
#: ~1.5 mm an x-height's counters (a, e, o) fill in. At scale 1 the Archivist's x-height is
#: 3.52 mm, so micro (0.42) writes only at its largest scale (1.48 mm), tiny at two (1.93, 1.55).
MIN_XHEIGHT_MM = 1.45
FORGET_ID = "agentd_forget"


#: Page units: a thinking spot that moves less than this is not sent again.
STATUS_SLACK = 20.0


def _scene_box(box: Any, page_w: float) -> Box | None:
    """A box from the tablet in scene units (x centred), as page units from the left edge."""
    if not (isinstance(box, list) and len(box) == 4):
        return None
    try:
        x0, y0, x1, y1 = (float(v) for v in box)
    except (TypeError, ValueError):
        return None
    if not (x0 <= x1 and y0 <= y1):
        return None
    return (x0 + page_w / 2, y0, x1 + page_w / 2, y1)


def _norm_box(box_pu: Box, page_w: float, page_h: float) -> Box:
    return (box_pu[0] / page_w, box_pu[1] / page_h, box_pu[2] / page_w, box_pu[3] / page_h)


def _within(inner: Box, outer: Box, slack: float = 40.0) -> bool:
    """``inner`` lies inside ``outer`` grown by ``slack`` (page units): ink inside its lasso."""
    return (
        inner[0] >= outer[0] - slack
        and inner[1] >= outer[1] - slack
        and inner[2] <= outer[2] + slack
        and inner[3] <= outer[3] + slack
    )


def _bounds(strokes) -> Box:
    bs = [st.bbox() for st in strokes]
    return (
        min(b[0] for b in bs),
        min(b[1] for b in bs),
        max(b[2] for b in bs),
        max(b[3] for b in bs),
    )


#: The farthest an answer may sit from what it answers, page units (~33 mm); farther away it
#: would read as unrelated ink, so the answer goes to the glasses only.
MAX_GAP_PU = 300.0


def _page_bottom(m: PageModel, max_y: float | None = None) -> float:
    """
    How far down the page reaches, page units: its height, the lowest ink, or the bottom of
    the screen when the user has scrolled further down (xochitl grows the page as one writes
    there; the view comes from the request's ``view_bbox``, page.py). Never below ``max_y``
    page heights: the tablet's bridge refuses agent ink further down (Config.max_page_y).
    """
    box = m.ink_box(include_ai=True)
    v = m.view
    visible = (v.screen_h - v.dy) / v.zoom
    bottom = max(m.h, box[3] * m.h if box else m.h, visible)
    return min(bottom, max_y * m.h) if max_y else bottom


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


def _model_name(model: str) -> str:
    """``claude-sonnet-5-5`` → ``Sonnet``."""
    parts = model.split("-")
    return parts[1].capitalize() if len(parts) > 1 else model


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
