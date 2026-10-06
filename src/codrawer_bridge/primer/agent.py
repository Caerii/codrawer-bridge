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

import asyncio
import time
from collections.abc import Awaitable, Callable
from typing import Any

from . import assess, check, coach, latex, policy
from .ink_signals import InkLog, InkStroke, LineSignals, LullDetector, line_features, segment_lines
from .learner import Learner, LearnerStore, safe_name
from .practice import BANK, plan
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

    async def tick(self) -> None:
        """Call every second or so: starts an ``auto`` reading at a lull after new ink."""
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
        async with self._busy:
            now = self.clock()
            lr = self.store.load(self.learner_name)
            log = self._selection_log(selection) if selection else self.log
            if request == "hint" and self.last_doc is not None:
                doc = self.last_doc
            else:
                doc = await self._recognize(log)
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

    async def _recognize(self, log: InkLog) -> ProofDoc:
        problem = None
        try:
            if isinstance(self.recognizer, OfflineRecognizer):
                return self.recognizer.recognize(log)
            return await asyncio.to_thread(self.recognizer.recognize, log, problem)
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
        if sketch:
            msg["coach"]["sketched"] = True
        return msg

    async def send_plan(self, include_coach: bool = True, sketch: bool = False) -> dict:
        """Answer ``plan``/``forget``/``coach`` requests: learner, plan, coach view (no proof)."""
        now = self.clock()
        lr = self.store.load(self.learner_name)
        ink = None
        if sketch:
            nxt = coach.suggest(lr, now, n=1)
            p = BANK.get(nxt[0]["id"]) if nxt else None
            ink = coach.problem_ink(p) if p else None
            if ink:
                for m in ink:
                    await self.send(m)
        out = self._message(None, None, lr, now, sketch=ink)
        if not include_coach:
            out.pop("coach", None)
        await self.send(out)
        return out
