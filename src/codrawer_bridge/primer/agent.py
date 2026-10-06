"""
The Primer agent: one per session, from protocol messages in to ``primer`` messages out.

This is where the parts meet, in the order a reading happens:

    messages ─▶ InkLog + LullDetector (ink_signals)          when may it speak?
    trigger  ─▶ recognize (live Claude call, or fixture)     what was written?
             ─▶ assess (findings, statuses, grade estimate)  is it a proof?
             ─▶ check (Lean/Rocq if installed)               does a prover agree?
             ─▶ learner.observe (BKT, misconceptions)        what does she know now?
             ─▶ policy.choose_move                           what should the Primer say?
             ─▶ coach (attempt log, nudge, next problems)    what should she do next?
             ─▶ latex.to_tex                                  the proof, typeset
             ─▶ one ``primer`` message (docs/protocol.md)

**Triggers.** An explicit request always gets an answer: ``primer_request`` (the phone's Proof
panel), a keyboard line ``/proof`` or ``/hint`` assembled from ``key`` messages, or a
``dock_action`` from the tablet's toolbar dock (``ask_page``, ``ask_selection``
with the lasso's ``bbox``, ``practice_coach``). With ``auto`` on, a lull after new ink
(ink_signals.LullDetector) starts a reading too, at most once per ``auto_min_interval_s``; a lull
reading whose move is ``silence`` sends nothing.

**Where it runs.** Inside the desktop router (server/app.py, ``CODRAWER_PRIMER=1``), with
``send`` broadcasting to the session; or as a client of any router (``__main__.py live``), with
``send`` writing to its socket. The same class either way.

**Privacy.** The learner file is loaded and saved on this machine (learner.LearnerStore); the
only thing that leaves it is the model call recognize.py documents. A ``forget`` request deletes
the file. The coach logs only with consent (coach.py).
"""

from __future__ import annotations

# ruff: noqa: E501  (the learner-facing messages read better unwrapped)
import asyncio
import os
import time
from collections.abc import Awaitable, Callable
from typing import Any

from . import assess, check, coach, latex, policy
from . import mock as mockmod
from .ink_signals import InkLog, InkStroke, LineSignals, LullDetector, line_features, segment_lines
from .learner import Learner, LearnerStore, safe_name
from .practice import BANK, plan, problem_of_the_day
from .proofdoc import ProofDoc
from .recognize import OfflineRecognizer, RecognitionError, make_recognizer

Send = Callable[[dict], Awaitable[None]]

#: Credit per step status for the learner model (``unclear`` steps are not evidence).
STATUS_CREDIT = {"ok": 1.0, "gap": 0.5, "error": 0.0}


def _now_ms() -> float:
    return time.time() * 1000


class PrimerAgent:
    """The Primer for one session (module docstring)."""

    def __init__(
        self,
        send: Send,
        *,
        learner: str = "learner",
        mode: str = "auto",
        auto: bool = False,
        auto_min_interval_s: float = 30.0,
        store: LearnerStore | None = None,
        today: str | None = None,
        clock: Callable[[], float] = _now_ms,
    ) -> None:
        self.send = send
        self.learner_name = safe_name(learner)
        self.recognizer = make_recognizer(mode)
        self.store = store or LearnerStore()
        self.auto = auto
        self.auto_min_interval_s = auto_min_interval_s
        self.today = today
        self.clock = clock
        self.log = InkLog()
        self.lull = LullDetector()
        self.hints = policy.HintState()
        self.last_doc: ProofDoc | None = None
        self.last_signals: dict[int, LineSignals] = {}
        self._read_version = -1
        self._last_auto = 0.0
        self._line = ""  # keyboard line being typed (for /proof, /hint)
        self._seq = 0
        self._busy = asyncio.Lock()
        # Mock-exam mode (mock.py): the learner's running or ungraded mock, resumed from its file.
        self.mocks = mockmod.MockStore(self.store.dir)
        self.mock: mockmod.Mock | None = None
        self._mock_phase: tuple | None = None
        self._mock_saved = 0.0
        self.ink_enabled = os.environ.get("CODRAWER_PRIMER_INK", "") in ("1", "true", "yes", "on")
        self._load_mock()

    # ── Input ────────────────────────────────────────────────────────────────────────────────

    async def handle(self, msg: dict) -> None:
        """Feed one protocol message; answers requests (awaits the reading)."""
        now = self.clock()
        t = msg.get("t")
        if t == "stroke_begin" and msg.get("layer", "user") != "ai":
            self.lull.stroke_begin(now)
        elif t == "stroke_end":
            self.lull.stroke_end(now)
        self.log.observe(msg, now)
        if self.mock is not None and self.mock.status == "running":
            await self._mock_observe(msg, now)
        if t == "page":
            lr = self.store.load(self.learner_name)
            if coach.note_reading(lr, msg, now):
                self.store.save(lr)
        elif t == "key":
            await self._on_key(msg)
        elif t == "primer_request":
            await self._on_request(msg)
        elif t == "dock_action":
            await self._on_dock(msg)

    async def _on_key(self, msg: dict) -> None:
        ch = msg.get("char")
        key = msg.get("key")
        if isinstance(ch, str) and ch:
            self._line = (self._line + ch)[-200:]
        elif key == "Backspace":
            self._line = self._line[:-1]
        elif key == "Enter":
            line, self._line = self._line.strip(), ""
            if line == "/proof":
                await self.read("proof")
            elif line == "/hint":
                await self.read("hint")
            elif line == "/coach":
                await self.send_plan(include_coach=True)
            elif line == "/mock start":
                await self.mock_start()
            elif line == "/mock grade":
                await self.mock_grade()
            elif line in ("/p 1", "/p 2", "/p 3"):
                await self.mock_cursor(int(line[-1]))

    async def _on_request(self, msg: dict) -> None:
        if isinstance(msg.get("learner"), str) and msg["learner"].strip():
            self.set_learner(msg["learner"])
        what = msg.get("what")
        if what in ("proof", "hint"):
            await self.read(str(what))
        elif what == "plan":
            await self.send_plan(include_coach=True)
        elif what == "forget":
            self.store.delete(self.learner_name)
            await self.send_plan(include_coach=False)
        elif what == "mock_start":
            await self.mock_start(
                problems=msg.get("problems"), scale=float(msg.get("scale") or 1.0)
            )
        elif what == "mock_problem" and isinstance(msg.get("n"), int):
            await self.mock_cursor(int(msg["n"]))
        elif what == "mock_grade":
            await self.mock_grade()
        elif what == "mock_stop":
            await self.mock_stop()
        elif what == "mock_status":
            await self.send_plan(include_coach=False)
        elif what in ("coach_on", "coach_off"):
            lr = self.store.load(self.learner_name)
            lr.consent = lr.consent or what == "coach_on"
            lr.watching = what == "coach_on"
            self.store.save(lr)
            await self.send_plan(include_coach=True)

    async def _on_dock(self, msg: dict) -> None:
        """The tablet dock's entries (docs/protocol.md ``dock_action``; ids as the extension's)."""
        aid = msg.get("id")
        if aid == "practice_coach":
            await self.send_plan(include_coach=True, sketch=True)
        elif aid == "ask_page":
            await self.read("proof")
        elif aid == "ask_selection":
            await self.read("proof", selection=msg)

    def set_learner(self, name: str) -> None:
        name = safe_name(name)
        if name != self.learner_name:
            self.learner_name = name
            self.hints = policy.HintState()
            self._load_mock()

    async def tick(self) -> None:
        """
        Call every second or so: advances a mock exam's clock (mock.py), and starts an ``auto``
        reading at a lull after new ink (never during a mock).
        """
        if self.mock is not None and self.mock.status in ("running", "awaiting_grading"):
            await self._mock_tick()
            return
        if not self.auto or self._busy.locked():
            return
        now = self.clock()
        if self.log.ink_version == self._read_version or not self.log.ink():
            return
        if now - self._last_auto < self.auto_min_interval_s * 1000:
            return
        if self.lull.state(self.log, now) != "lull":
            return
        self._last_auto = now
        await self.read("auto")

    # ── A reading ────────────────────────────────────────────────────────────────────────────

    def _selection_log(self, sel: dict) -> InkLog:
        """
        A log of only the lasso's strokes: the ids in ``line_ids`` when given, else the strokes
        whose points lie inside ``bbox``. The dock sends ``bbox`` in xochitl's scene units (x
        centred on the page, docs/protocol.md ``dock_action``); a box with any coordinate outside
        [-0.5, 1.5] is taken to be in scene units and normalized with the page size (1620 × 2160).
        """
        ids = {str(i) for i in sel.get("line_ids") or []}
        box = sel.get("bbox")
        if isinstance(box, list) and len(box) == 4 and any(abs(float(v)) > 1.5 for v in box):
            w, h = 1620.0, 2160.0
            box = [
                (float(box[0]) + w / 2) / w,
                float(box[1]) / h,
                (float(box[2]) + w / 2) / w,
                float(box[3]) / h,
            ]
        out = InkLog()
        for s in self.log.ink():
            keep = s.id in ids
            if not keep and isinstance(box, list) and len(box) == 4:
                keep = all(box[0] <= p[0] <= box[2] and box[1] <= p[1] <= box[3] for p in s.pts)
            if keep:
                out.strokes[s.id] = InkStroke(**{**s.__dict__})
        return out

    async def read(self, request: str = "proof", selection: dict | None = None) -> dict | None:
        """One reading (module docstring); returns the message sent, or None for silence."""
        if self.mock is not None and self.mock.status == "running":
            # A mock is an exam: no readings or hints until it is graded (mock.py).
            if request == "auto":
                return None
            lr = self.store.load(self.learner_name)
            note = policy.Move(
                "notice",
                "A mock exam is running: the Primer reads nothing until it grades the write-ups tomorrow morning.",
                "Mock running: graded tomorrow",
            )
            out = self._message(None, note, lr, self.clock())
            await self.send(out)
            return out
        async with self._busy:
            now = self.clock()
            lr = self.store.load(self.learner_name)
            log = self._selection_log(selection) if selection else self.log
            if request == "hint" and self.last_doc is not None:
                doc = self.last_doc
            else:
                doc = await self._recognize(log, page=self.log if selection else None)
                self._read_version = self.log.ink_version
                lines = segment_lines(log.ink())
                sig = {s.line: s for s in line_features(log, lines)}
                self.last_signals = {
                    st.n: max(
                        (sig[n] for n in st.lines if n in sig),
                        key=lambda x: x.hesitation,
                        default=LineSignals(line=0),
                    )
                    for st in doc.steps
                }
                assess.assess(doc, use_model_findings=doc.source.startswith("live"))
                doc.check = await asyncio.to_thread(
                    check.run, doc.formal, "model" if doc.source.startswith("live") else "fixture"
                )
                if self.last_doc is None or doc.title != self.last_doc.title:
                    self.hints = policy.HintState()
                self.last_doc = doc
                self._update_learner(lr, doc, now)
            lull_state = self.lull.state(self.log, now)
            move = policy.choose_move(
                doc,
                lr,
                request=request,
                lull=lull_state,
                hints=self.hints,
                signals=self.last_signals,
            )
            if move.kind == "silence":
                self.store.save(lr)
                return None
            attempt = None
            if request != "hint" and doc.problem and doc.steps:
                # Outcomes of a reading she asked for are part of the learner model, coach or not.
                if doc.problem not in lr.seen:
                    lr.seen.append(doc.problem)
                if doc.grade is not None:
                    lr.solved[doc.problem] = max(doc.grade.score, lr.solved.get(doc.problem, 0))
            if request != "hint" and doc.steps:
                minutes = self._attempt_minutes(log)
                reading = lr.reading[-1] if lr.reading else None
                attempt = coach.log_attempt(
                    lr, doc, now_ms=now, minutes=minutes, hints=self.hints.level, reading=reading
                )
                if move.kind == "debrief" and doc.technique:
                    self._notebook(lr, doc, now)
            elif request == "hint" and lr.attempts:
                lr.attempts[-1].hints = max(lr.attempts[-1].hints, self.hints.level)
            self.store.save(lr)
            out = self._message(doc, move, lr, now, nudge=coach.nudge(lr, attempt, now))
            await self.send(out)
            return out

    async def _recognize(
        self, log: InkLog, problem: str | None = None, page: InkLog | None = None
    ) -> ProofDoc:
        """Read ``log``; ``problem`` is the statement when the problem is known (sent to a live model)."""
        try:
            if isinstance(self.recognizer, OfflineRecognizer):
                return self.recognizer.recognize(log)
            return await asyncio.to_thread(self.recognizer.recognize, log, problem, page)
        except RecognitionError as e:
            doc = ProofDoc(title="", goal="", technique="", steps=[], source=f"live:error:{e}")
            return doc

    def _attempt_minutes(self, log: InkLog) -> float:
        ts = [s for s in log.ink() if s.t0 is not None and s.t1 is not None]
        if not ts:
            return 0.0
        return max(0.0, (max(s.t1 or 0 for s in ts) - min(s.t0 or 0 for s in ts)) / 60_000)

    def _update_learner(self, lr: Learner, doc: ProofDoc, now: float) -> None:
        """BKT evidence from each step's concepts and each finding (learner.py)."""
        if not doc.steps:
            return
        lr.turn += 1
        exercised: set[str] = set()
        for st in doc.steps:
            if st.status not in STATUS_CREDIT:
                continue
            hes = self.last_signals.get(st.n)
            for c in st.concepts:
                exercised.add(c)
                lr.observe(
                    c,
                    STATUS_CREDIT[st.status],
                    now_ms=now,
                    weight=max(0.2, min(1.0, st.confidence)),
                    hint_level=self.hints.level,
                    hesitation=hes.hesitation if hes else 0.0,
                    step=st.n,
                    problem=doc.problem,
                )
        seen = set()
        for f in doc.findings:
            if f.id in seen:
                continue
            seen.add(f.id)
            lr.saw_misconception(f.id, now)
            from .concepts import MISCONCEPTIONS

            for c in MISCONCEPTIONS[f.id].concepts:
                exercised.add(c)
                lr.observe(
                    c,
                    0.0,
                    now_ms=now,
                    weight=0.8,
                    step=f.step,
                    problem=doc.problem,
                    kind="finding",
                    finding=f.id,
                )
        lr.clean_turn_for(exercised, seen)

    def _notebook(self, lr: Learner, doc: ProofDoc, now: float) -> None:
        from .learner import NotebookEntry

        pid = doc.problem or doc.title
        if any(e.problem == pid for e in lr.notebook):
            return
        p = BANK.get(doc.problem or "")
        lr.notebook.append(
            NotebookEntry(
                ts=now,
                problem=pid,
                technique=doc.technique,
                key_idea=p.key_idea if p else "",
                why="",
            )
        )

    # ── Output ───────────────────────────────────────────────────────────────────────────────

    def _today(self, now: float) -> str:
        return self.today or time.strftime("%Y-%m-%d", time.localtime(now / 1000))

    def _message(
        self,
        doc: ProofDoc | None,
        move: policy.Move | None,
        lr: Learner,
        now: float,
        nudge: str | None = None,
        sketch: list[dict] | None = None,
    ) -> dict[str, Any]:
        self._seq += 1
        live = bool(
            doc and doc.source.startswith("live:") and not doc.source.startswith("live:error")
        )
        msg: dict[str, Any] = {
            "t": "primer",
            "v": 1,
            "id": f"pr_{self._seq}",
            "mode": "live" if live else "offline",
            "model": doc.source.split(":", 1)[1] if live and doc else None,
        }
        if doc is not None:
            msg["proof"] = {
                "title": doc.title,
                "goal": doc.goal,
                "technique": doc.technique,
                "problem": doc.problem,
                "source": doc.source,
                "steps": [
                    {
                        "n": s.n,
                        "latex": s.latex,
                        "text": s.text,
                        "justification": s.justification,
                        "refs": s.refs,
                        "concepts": s.concepts,
                        "confidence": s.confidence,
                        "status": s.status,
                        "note": s.note,
                        "strokes": s.strokes,
                        "bbox": s.bbox,
                    }
                    for s in doc.steps
                ],
                "tex": latex.to_tex(doc) if doc.steps else "",
                "check": doc.check.__dict__
                if doc.check
                else {"prover": None, "status": "not_checked", "detail": ""},
            }
            from .concepts import MISCONCEPTIONS

            msg["findings"] = [
                {
                    "id": f.id,
                    "label": MISCONCEPTIONS[f.id].label,
                    "kind": MISCONCEPTIONS[f.id].kind,
                    "step": f.step,
                    "detail": f.detail,
                }
                for f in doc.findings
            ]
            if doc.grade:
                msg["grade"] = doc.grade.__dict__
        if move is not None:
            msg["move"] = move.to_dict()
        msg["learner"] = lr.summary(now)
        p = plan(lr, self._today(now))
        p["queue"] = coach.suggest(lr, now, n=4)
        msg["plan"] = p
        msg["coach"] = {**coach.coach_view(lr, now), "nudge": nudge}
        potd = problem_of_the_day(lr, self._today(now), now)
        if potd is not None:
            p = BANK.get(potd.problem)
            msg["coach"]["potd"] = {**potd.to_dict(), "statement": p.statement if p else ""}
        if sketch:
            msg["coach"]["sketched"] = True
        if self.mock is not None and self.mock.status != "abandoned":
            msg["mock"] = mockmod.timer_block(self.mock, now)
            msg["mock"]["glance"] = mockmod.glance(self.mock, now)
        return msg

    async def send_plan(self, include_coach: bool = True, sketch: bool = False) -> dict:
        """Answer ``plan``/``forget``/``coach`` requests: learner, plan, coach view (no proof)."""
        now = self.clock()
        lr = self.store.load(self.learner_name)
        ink = None
        if sketch:
            # The dock's "Practice coach": the problem of the day, written onto the page.
            potd = problem_of_the_day(lr, self._today(now), now)
            p = BANK.get(potd.problem) if potd else None
            ink = await asyncio.to_thread(coach.problem_ink, p) if p and self.ink_enabled else None
            if ink:
                for m in ink:
                    await self.send(m)
        out = self._message(None, None, lr, now, sketch=ink)
        if not include_coach:
            out.pop("coach", None)
        await self.send(out)
        return out

    # ── Mock-exam mode (mock.py) ─────────────────────────────────────────────────────────────

    def _load_mock(self) -> None:
        m = self.mocks.latest(self.learner_name)
        self.mock = (
            m if m is not None and m.status in ("running", "awaiting_grading", "graded") else None
        )
        self._mock_phase = None

    def _save_mock(self) -> None:
        if self.mock is not None:
            self.mocks.save(self.mock)
            self._mock_saved = self.clock()

    async def mock_start(self, problems: list | None = None, scale: float = 1.0) -> dict:
        """Start a mock now: four timed sessions; problems drawn from her model unless given."""
        now = self.clock()
        lr = self.store.load(self.learner_name)
        if (
            isinstance(problems, list)
            and len(problems) == 4
            and all(isinstance(s, list) and len(s) == 3 for s in problems)
        ):
            chosen = [[str(p) for p in s] for s in problems]
        else:
            chosen = None
        self.mock = mockmod.new_mock(lr, now, chosen, scale=max(0.0001, min(1.0, scale)))
        self.mock.page = self.log.page_key
        self.mock.page_has_ink = bool(self.log.ink())
        self._mock_phase = None
        self.hints = policy.HintState()
        self._save_mock()
        return await self._mock_tick(force=True) or {}

    async def mock_cursor(self, n: int) -> None:
        if self.mock is not None and self.mock.status == "running" and 1 <= n <= 3:
            self.mock.cursor = n
            self._save_mock()
            await self.send(
                self._message(None, None, self.store.load(self.learner_name), self.clock())
            )

    async def mock_stop(self) -> None:
        """Abandon the running mock: nothing is graded; clients see the ``abandoned`` state once."""
        m = self.mock
        if m is not None and m.status == "running":
            m.status = "abandoned"
            self._save_mock()
            now = self.clock()
            out = self._message(
                None,
                policy.Move("notice", "Mock stopped. Nothing was graded.", "Mock stopped"),
                self.store.load(self.learner_name),
                now,
            )
            out["mock"] = mockmod.timer_block(m, now)
            self.mock = None
            await self.send(out)

    async def _mock_observe(self, msg: dict, now: float) -> None:
        """During a running mock: follow the page on screen, and collect finished strokes."""
        m = self.mock
        assert m is not None
        t = msg.get("t")
        if t == "page":
            key = self.log.page_key
            if key != m.page:
                m.page = key
                m.page_has_ink = bool(self.log.ink())
                if m.waiting_for_fresh_page and not m.page_has_ink:
                    m.waiting_for_fresh_page = False
                    s = m.current(now)
                    if s is not None:
                        await self._place(s, now)
            else:
                m.page_has_ink = bool(self.log.ink())
        elif t == "clear":
            m.page_has_ink = False
        elif t == "stroke_end":
            st = self.log.strokes.get(str(msg.get("id")))
            if st is not None and st.layer != "ai" and not st.is_eraser and st.pts:
                m.page_has_ink = True
                m.record_stroke(
                    {"id": st.id, "brush": st.brush, "pts": [p[:4] for p in st.pts]}, now
                )

    async def _place(self, s: mockmod.Session, now: float) -> None:
        """A session's problems onto the page: agent ink when enabled (one per block), always text."""
        s.placed = True
        if self.ink_enabled:
            y = 0.06
            for pid in s.problems:
                p = BANK.get(pid)
                ink = await asyncio.to_thread(coach.problem_ink, p, 0.08, y) if p else None
                for msg in ink or []:
                    await self.send(msg)
                y += 0.11
        self._save_mock()

    async def _mock_tick(self, force: bool = False) -> dict | None:
        """Advance the mock's clock: place problems, collect write-ups, grade in the morning."""
        m = self.mock
        if m is None:
            return None
        now = self.clock()
        out = None
        if m.status == "running":
            ph, n, _ = m.phase(now)
            for s in m.sessions:  # sessions whose time is up are frozen
                if now >= s.ends_ms and not s.collected:
                    s.collected = True
            if ph == "session" and not m.sessions[n - 1].placed:
                s = m.sessions[n - 1]
                m.cursor = 1
                if m.page_has_ink:
                    m.waiting_for_fresh_page = True  # placed when she turns to a fresh page
                    s.placed = True  # announced as text now; the ink follows the page turn
                else:
                    await self._place(s, now)
            if ph == "done":
                m.status = "awaiting_grading"
                end = m.sessions[-1].ends_ms
                m.grade_after_ms = end if m.scale < 1 else mockmod.next_morning(end)
            key = (m.status, ph, n)
            if force or key != self._mock_phase:
                self._mock_phase = key
                self._save_mock()
                out = self._message(None, None, self.store.load(self.learner_name), now)
                await self.send(out)
            elif now - self._mock_saved > 30_000:
                self._save_mock()
        if m.status == "awaiting_grading" and now >= m.grade_after_ms:
            out = await self.mock_grade()
        return out

    async def mock_grade(self) -> dict | None:
        """Grade every write-up of the mock (module docstring of mock.py) and send the report."""
        m = self.mock
        if m is None or m.status not in ("running", "awaiting_grading"):
            return None
        async with self._busy:
            now = self.clock()
            lr = self.store.load(self.learner_name)
            results = []
            for s in m.sessions:
                for i, pid in enumerate(s.problems, start=1):
                    p = BANK.get(pid)
                    w = s.writeups.get(pid)
                    entry = {
                        "session": s.n,
                        "n": i,
                        "problem": pid,
                        "title": p.title if p else pid,
                        "estimate": True,
                    }
                    if w is None or not w.strokes:
                        entry.update(
                            score=0,
                            band="none",
                            rigor="No write-up was collected.",
                            exposition="",
                            findings=[],
                            mode="none",
                        )
                        results.append(entry)
                        continue
                    log = InkLog()
                    for st in mockmod.writeup_strokes(w):
                        log.strokes[st.id] = st
                    doc = await self._recognize(log, p.statement if p else None)
                    doc.problem = pid
                    live = doc.source.startswith("live:") and not doc.source.startswith(
                        "live:error"
                    )
                    if doc.steps:
                        self.last_signals = {}
                        assess.assess(doc, use_model_findings=live)
                        doc.check = await asyncio.to_thread(
                            check.run, doc.formal, "model" if live else "fixture"
                        )
                        self._update_learner(lr, doc, now)
                        lr.solved[pid] = max(
                            doc.grade.score if doc.grade else 0, lr.solved.get(pid, 0)
                        )
                        if pid not in lr.seen:
                            lr.seen.append(pid)
                        minutes = (
                            ((w.last_ms or 0) - (w.first_ms or 0)) / 60_000 / max(m.scale, 1e-6)
                        )
                        coach.log_attempt(lr, doc, now_ms=now, minutes=minutes, hints=0)
                    from .concepts import MISCONCEPTIONS

                    g = doc.grade
                    entry.update(
                        score=g.score if g else 0,
                        band=g.band if g else "none",
                        rigor=g.rigor
                        if g
                        else (
                            "Not readable offline: no model key, and this ink is not a fixture."
                            if not live
                            else "The write-up could not be read."
                        ),
                        exposition=g.exposition if g else "",
                        findings=sorted(
                            {
                                MISCONCEPTIONS[f.id].label
                                for f in doc.findings
                                if f.id in MISCONCEPTIONS
                            }
                        ),
                        check=doc.check.status if doc.check else "not_checked",
                        mode="live" if live else "offline",
                        steps=len(doc.steps),
                    )
                    results.append(entry)
            total = sum(int(r["score"]) for r in results)
            from .learner import SessionRecord

            lr.sessions.append(
                SessionRecord(
                    ts=now,
                    kind="mock",
                    problems=[r["problem"] for r in results],
                    minutes=4 * 90,
                    scores=[int(r["score"]) for r in results],
                )
            )
            self.store.save(lr)
            m.report = {
                "total": total,
                "max": 12 * 10,
                "estimate": True,
                "graded_ms": now,
                "problems": results,
            }
            m.status = "graded"
            self._save_mock()
            out = self._message(None, None, lr, now)
            await self.send(out)
            return out
