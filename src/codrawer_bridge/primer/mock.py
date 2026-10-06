"""
Putnam mock-exam mode: a proctored rehearsal of the 2026 format, graded the next morning.

**The problem.** From 5 December 2026 the Putnam is four 90-minute sessions of three problems,
with breaks of 15 minutes, about an hour and three quarters, and 15 minutes (Eastern 11:00–12:30,
12:45–14:15, 16:00–17:30, 17:45–19:15; ADR 010). Rehearsing that shape (the clock, the triage, the
long day, writing up under time) matters as much as solving problems. The roadmap's first item
asks for a mock that runs like the real thing on the tablet: a quiet timer, problems written onto
fresh pages at each session's start, write-ups collected when time is up, and grades the next
morning, never during the exam.

**How it runs.** A :class:`Mock` is a state machine on the wall clock, driven by the Primer
agent's tick (agent.py), persisted after every change so a restarted router resumes it:

    scheduled ─start─▶ session 1 ─90 min─▶ break 15 ─▶ session 2 ─▶ break 105 ─▶ session 3
               ─▶ break 15 ─▶ session 4 ─90 min─▶ awaiting grading ─06:00 next day─▶ graded

- **Placing problems.** At a session's start the Primer announces its three problems as text
  (panel and glasses) and, when agent ink is enabled (``CODRAWER_PRIMER_INK=1``, set when the
  tablet runs ``NATIVE_AGENT_INK=1``, ADR 009), writes them as agent ink on the ``ai`` layer once
  the learner is on a fresh page: if the page on screen already has ink, the Primer asks her to
  turn to a new page and writes when the page changes.
- **Write-ups.** Every user stroke during a session is attributed to the problem she is writing
  ("the cursor", set by ``/p 2`` on the keyboard or the panel; it starts at 1) and to the page it
  was drawn on. At the session's end the write-ups are frozen into the mock file; ink drawn in a
  break is not collected.
- **Quiet.** While a mock runs the Primer does not tutor: requests for a reading or a hint get
  "graded tomorrow morning", and automatic readings are off. The only thing it sends is the
  timer state at each phase change; the app counts down on its own.
- **Grading** happens at 06:00 local time the next day (or on request, ``mock_grade``): each
  write-up is rendered and read like any proof (recognize.py, with the problem statement), assessed
  (assess.py) and scored 0–10 Putnam-style, labelled as an estimate, with rigour and exposition
  feedback; the report totals the twelve out of 120 and updates the learner model and attempt log.

Times are Unix ms unless named otherwise; durations are minutes.
"""

from __future__ import annotations

# ruff: noqa: E501  (the learner-facing messages read better unwrapped)
import datetime as dt
import json
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

from .practice import BANK, EXAM_BREAKS, PROBLEMS_PER_SESSION, SESSION_MINUTES, mock_exam

MIN_MS = 60_000
#: The morning hour (local time) after which the previous day's mock is graded.
GRADE_HOUR = 6


@dataclass
class WriteUp:
    """One problem's write-up: the pages it was written on and its strokes (``{"id","brush","pts"}``)."""

    problem: str
    pages: list[str] = field(default_factory=list)
    strokes: list[dict] = field(default_factory=list)
    first_ms: float | None = None
    last_ms: float | None = None


@dataclass
class Session:
    n: int
    starts_ms: float
    ends_ms: float
    problems: list[str]
    placed: bool = False
    collected: bool = False
    writeups: dict[str, WriteUp] = field(default_factory=dict)


@dataclass
class Mock:
    """A mock exam in progress or done (module docstring); serialized as one JSON file."""

    id: str
    learner: str
    started_ms: float
    sessions: list[Session]
    status: str = "running"  # running | awaiting_grading | graded | abandoned
    cursor: int = 1  # the problem (1..3) she is writing in the current session
    page: str = ""  # the page on screen, from the latest `page` message
    page_has_ink: bool = False
    waiting_for_fresh_page: bool = False
    grade_after_ms: float = 0.0
    report: dict[str, Any] | None = None
    scale: float = 1.0  # time compression, demos and tests only (schedule)

    # ── The clock ────────────────────────────────────────────────────────────────────────────

    def phase(self, now_ms: float) -> tuple[str, int, float]:
        """``(phase, session number, when this phase ends)``: ``session``, ``break``, ``before``, ``done``."""
        if self.status != "running":
            return ("done", 4, self.sessions[-1].ends_ms)
        for s in self.sessions:
            if now_ms < s.starts_ms:
                return ("break" if s.n > 1 else "before", s.n, s.starts_ms)
            if now_ms < s.ends_ms:
                return ("session", s.n, s.ends_ms)
        return ("done", 4, self.sessions[-1].ends_ms)

    def current(self, now_ms: float) -> Session | None:
        ph, n, _ = self.phase(now_ms)
        return self.sessions[n - 1] if ph == "session" else None

    # ── Ink ──────────────────────────────────────────────────────────────────────────────────

    def record_stroke(self, stroke: dict, now_ms: float) -> bool:
        """Attribute a finished user stroke to the current session's cursor problem."""
        s = self.current(now_ms)
        if s is None or not stroke.get("pts"):
            return False
        pid = s.problems[min(max(self.cursor, 1), len(s.problems)) - 1]
        w = s.writeups.setdefault(pid, WriteUp(problem=pid))
        w.strokes.append(stroke)
        if self.page and self.page not in w.pages:
            w.pages.append(self.page)
        w.first_ms = w.first_ms or now_ms
        w.last_ms = now_ms
        return True

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @staticmethod
    def from_dict(d: dict[str, Any]) -> Mock:
        sessions = []
        for s in d["sessions"]:
            s = dict(s)
            s["writeups"] = {k: WriteUp(**v) for k, v in (s.get("writeups") or {}).items()}
            sessions.append(Session(**s))
        rest = {k: v for k, v in d.items() if k != "sessions"}
        return Mock(sessions=sessions, **rest)


def schedule(start_ms: float, scale: float = 1.0) -> list[tuple[float, float]]:
    """
    The four sessions' (start, end) from ``start_ms``, with the exam's breaks between them.
    ``scale`` shrinks every duration (0.01: a 90-minute session lasts 54 s), for demos and tests
    only; a real mock runs at 1.
    """
    out = []
    t = start_ms
    minute = MIN_MS * scale
    for i in range(4):
        out.append((t, t + SESSION_MINUTES * minute))
        t += SESSION_MINUTES * minute + (EXAM_BREAKS[i] * minute if i < 3 else 0)
    return out


def next_morning(ms: float, hour: int = GRADE_HOUR) -> float:
    """Unix ms of ``hour``:00 local time on the day after ``ms``."""
    d = dt.datetime.fromtimestamp(ms / 1000) + dt.timedelta(days=1)
    return dt.datetime(d.year, d.month, d.day, hour).timestamp() * 1000


def new_mock(
    learner_obj, now_ms: float, problems: list[list[str]] | None = None, scale: float = 1.0
) -> Mock:
    """
    A mock starting now. ``problems`` (four lists of three bank ids) overrides the draw from the
    learner model (practice.mock_exam: per session one problem she should finish, one at her
    edge, one beyond, in shuffled order, seeded by the date).
    """
    if problems is None:
        seed = int(time.strftime("%Y%m%d", time.localtime(now_ms / 1000)))
        exam = mock_exam(learner_obj, now_ms, seed=seed)
        problems, used = [], set()
        for sess in exam["sessions"]:
            ids = [p["id"] for p in sess["problems"] if p["id"] not in used][:PROBLEMS_PER_SESSION]
            for pid in sorted(
                BANK, key=lambda k: BANK[k].difficulty
            ):  # top up repeats across sessions
                if len(ids) >= PROBLEMS_PER_SESSION:
                    break
                if pid not in used and pid not in ids:
                    ids.append(pid)
            used.update(ids)
            problems.append(ids)
    sessions = [
        Session(n=i + 1, starts_ms=a, ends_ms=b, problems=list(problems[i]))
        for i, (a, b) in enumerate(schedule(now_ms, scale))
    ]
    mid = "mock-" + time.strftime("%Y%m%d-%H%M", time.localtime(now_ms / 1000))
    return Mock(id=mid, learner=learner_obj.name, started_ms=now_ms, sessions=sessions, scale=scale)


class MockStore:
    """Mock files under ``<state>/primer/mocks/<learner>/<id>.json``, beside the learner file."""

    def __init__(self, learners_dir: Path) -> None:
        self.root = learners_dir.parent / "mocks"

    def path(self, learner: str, mid: str) -> Path:
        return self.root / learner / f"{mid}.json"

    def save(self, m: Mock) -> Path:
        p = self.path(m.learner, m.id)
        p.parent.mkdir(parents=True, exist_ok=True)
        tmp = p.with_suffix(".tmp")
        tmp.write_text(json.dumps(m.to_dict(), ensure_ascii=False), encoding="utf-8")
        tmp.replace(p)
        return p

    def latest(self, learner: str) -> Mock | None:
        d = self.root / learner
        files = sorted(d.glob("mock-*.json")) if d.exists() else []
        return Mock.from_dict(json.loads(files[-1].read_text(encoding="utf-8"))) if files else None


def timer_block(m: Mock, now_ms: float) -> dict[str, Any]:
    """The ``mock`` block of a ``primer`` message: the phase, its end, the problems, the report."""
    ph, n, until = m.phase(now_ms)
    s = m.sessions[n - 1]
    out: dict[str, Any] = {
        "id": m.id,
        "status": m.status,
        "phase": ph,
        "session": n,
        "of": len(m.sessions),
        "until": until,
        "cursor": m.cursor,
        "problems": [
            {
                "n": i + 1,
                "id": pid,
                "title": BANK[pid].title if pid in BANK else pid,
                "statement": BANK[pid].statement if pid in BANK else "",
            }
            for i, pid in enumerate(s.problems)
        ]
        if ph in ("session", "before")
        else [],
        "grade_after": m.grade_after_ms or None,
        "fresh_page": m.waiting_for_fresh_page,
    }
    if m.report:
        out["report"] = m.report
    return out


def glance(m: Mock, now_ms: float) -> str:
    """The glasses' quiet line: ``Mock S2/4 · 47 min`` or ``Break · 12 min``."""
    ph, n, until = m.phase(now_ms)
    minute = MIN_MS * m.scale
    mins = max(0, int((until - now_ms + minute - 1) // minute))
    if ph == "session":
        return f"Mock S{n}/4 · {mins} min · P{m.cursor}"
    if ph in ("break", "before"):
        return f"Break · S{n} in {mins} min"
    if m.status == "awaiting_grading":
        return "Mock done · graded tomorrow morning"
    if m.status == "graded" and m.report:
        return f"Mock graded: {m.report['total']}/120 (estimate)"
    return "Mock"


def writeup_strokes(w: WriteUp):
    """A write-up's strokes as ink_signals.InkStroke objects (for rendering and recognition)."""
    from .ink_signals import InkStroke

    return [
        InkStroke(
            id=str(st.get("id")),
            brush=str(st.get("brush") or "pen"),
            pts=[list(p) for p in st.get("pts") or []],
            order=i,
            ended=True,
        )
        for i, st in enumerate(w.strokes)
    ]
