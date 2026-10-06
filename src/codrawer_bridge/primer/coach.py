"""
The practice coach: a background agent that turns doing problems into deliberate practice.

**The problem.** Most people who do math problems are not practising deliberately: they pick
problems they can already do, skip the debrief, and repeat the same errors without noticing.
Deliberate practice needs work at the edge of ability, immediate feedback, focus on specific
weaknesses and repetition spaced over time (Ericsson, Krampe & Tesch-Römer 1993, "The role of
deliberate practice in the acquisition of expert performance", *Psychological Review*). The
coach supplies that structure quietly, so it "happens to" the learner: short nudges, never
lectures, and every suggestion says why (ADR 010, "The practice coach").

**What it does.**

- **Watches, with consent.** Nothing is logged until the learner turns the coach on
  (``Learner.consent`` and ``Learner.watching``; the dock entry and the panel show "watching").
  Then it records which document and page she has open (the bridge's ``page`` messages carry the
  document id, page id and title; PDFs and EPUBs on the reMarkable are documents too) and every
  attempt the Primer reads.
- **Logs attempts** (learner.Attempt): problem, minutes the pen was on it, hints used, the steps
  that went wrong, the score estimate, misconceptions, and the reading position she came from.
  The log is hers: she can read it in her file and edit notes (``edit_attempt``).
- **Finds weaknesses** across attempts: low-mastery concepts with repeated evidence and
  recurring misconceptions (:func:`weaknesses`), each with its evidence count.
- **Suggests next problems** through practice.choose_queue: tied to the section she was just
  reading when the bank has a match, then spaced review, then stretch problems at the edge of
  ability. Each carries its "why".
- **Writes problems onto the page**, when asked: as agent ink on the ``ai`` layer (ADR 003),
  rendered by a handwriting provider. ``packages/hand`` personas when present; until then the
  public-domain Hershey "futural" stroke font if installed (``Hershey-Fonts``), neat and plainly
  machine-written; otherwise text on the phone and glasses only. The native ink path (the XOVI
  extension's ``/run/codrawer/ink.sock``, fed by the bridge from ai-layer strokes) draws the same
  strokes on the tablet itself; the coach does not need to know which surface renders them.
- **Dock entries.** :data:`DOCK_ENTRIES` are what the Primer announces for the tablet's toolbar
  dock (``/run/codrawer/dock.json``, ADR 009 §4): "Practice coach" (labelled "watching" while it
  observes), "Ask about this page" and the lasso's "Ask about selection". The dock sends
  ``dock_action`` messages; the Primer agent handles them (agent.py).

The coach is a SIG background agent in the sense of docs/sig-integration.md: its memory is the
learner file (mastery, misconceptions, the attempt log, reading positions), its suggestions
improve as that evidence accumulates, and it can always show its reasons.
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Any

from .concepts import CONCEPTS, MISCONCEPTIONS
from .learner import Attempt, Learner, ReadingEvent
from .practice import BANK, Problem, choose_queue
from .proofdoc import ProofDoc

#: The dock entries the Primer answers (docs/protocol.md ``dock_entries``). The ids are the
#: tablet extension's own (``practice_coach``, ``ask_page``, ``ask_selection``), so its built-in
#: list works before the bridge writes dock.json from these.
DOCK_ENTRIES: list[dict[str, Any]] = [
    {
        "id": "practice_coach",
        "label": "Practice coach",
        "hint": "What's next, weak spots, today's plan",
    },
    {
        "id": "ask_page",
        "label": "Ask about this page",
        "hint": "The Primer reads the proof on this page",
    },
    {
        "id": "ask_selection",
        "label": "Ask about selection",
        "kind": "selection",
        "hint": "The Primer reads the selected ink",
    },
    {
        "id": "grade_page",
        "label": "Grade this page",
        "hint": "Teacher's marks in red, on their own layer",
    },
    {
        "id": "grade_selection",
        "label": "Grade selection",
        "kind": "selection",
        "hint": "Teacher's marks on the lassoed proof",
    },
]


def dock_entries(watching: bool) -> list[dict[str, Any]]:
    """The dock entries with the coach's state shown: a ``badge`` "watching" while it observes."""
    out = []
    for e in DOCK_ENTRIES:
        e = dict(e)
        if e["id"] == "practice_coach":
            e["badge"] = "watching" if watching else ""
            e["label"] = "Practice coach · watching" if watching else "Practice coach"
        out.append(e)
    return out


# =============================================================================================
# Reading position
# =============================================================================================


def note_reading(learner: Learner, msg: dict, now_ms: float) -> ReadingEvent | None:
    """
    Record a ``page`` message as a reading position, only while the coach is on. Consecutive
    reports of the same document and page extend one event; a new page starts another. The
    log keeps the latest 500 events.
    """
    if not (learner.consent and learner.watching):
        return None
    doc, page = str(msg.get("doc") or ""), str(msg.get("page") or "")
    if not doc:
        return None
    title = str(msg.get("title") or "")
    idx = msg.get("index") if isinstance(msg.get("index"), int) else None
    last = learner.reading[-1] if learner.reading else None
    if last and last.doc == doc and last.page == page:
        last.last_ms = now_ms
        return last
    ev = ReadingEvent(
        doc=doc, title=title, page=page, first_ms=now_ms, last_ms=now_ms, page_index=idx
    )
    learner.reading.append(ev)
    learner.reading = learner.reading[-500:]
    return ev


def reading_keywords(
    learner: Learner, now_ms: float, within_ms: float = 2 * 3_600_000
) -> list[str]:
    """
    Words from the document she read most recently (within two hours), for matching problems:
    the title's words of four letters or more, lowercased (e.g. "Engel Problem-Solving
    Strategies 4 Pigeonhole" gives engel, problem, solving, strategies, pigeonhole).
    """
    recent = [r for r in learner.reading if now_ms - r.last_ms <= within_ms and r.title]
    if not recent:
        return []
    return [w for w in re.split(r"[^a-z]+", recent[-1].title.lower()) if len(w) >= 4]


# =============================================================================================
# Attempts and weaknesses
# =============================================================================================


def log_attempt(
    learner: Learner,
    doc: ProofDoc,
    *,
    now_ms: float,
    minutes: float,
    hints: int,
    reading: ReadingEvent | None = None,
) -> Attempt | None:
    """
    Log the Primer's reading of an attempt, while the coach is on. Re-reading the same problem
    within 30 minutes updates the last entry instead of adding one (the learner fixing her proof
    is one attempt).
    """
    if not (learner.consent and learner.watching) or not doc.steps:
        return None
    problem = doc.problem or (
        f"page:{reading.doc}/{reading.page}" if reading else f"untitled:{doc.title[:40]}"
    )
    att = Attempt(
        ts=now_ms,
        problem=problem,
        minutes=round(minutes, 1),
        hints=hints,
        wrong_steps=[s.n for s in doc.steps if s.status in ("gap", "error")],
        score=doc.grade.score if doc.grade else None,
        misconceptions=sorted({f.id for f in doc.findings}),
        technique=doc.technique,
        reading={
            "doc": reading.doc,
            "title": reading.title,
            "page": reading.page,
            "index": reading.page_index,
        }
        if reading
        else None,
    )
    last = learner.attempts[-1] if learner.attempts else None
    if last and last.problem == att.problem and now_ms - last.ts < 30 * 60_000:
        att.ts = last.ts
        att.minutes = max(att.minutes, last.minutes)
        att.hints = max(att.hints, last.hints)
        att.note = last.note
        learner.attempts[-1] = att
    else:
        learner.attempts.append(att)
    return att


def edit_attempt(
    learner: Learner, index: int, note: str | None = None, delete: bool = False
) -> bool:
    """The learner corrects her log: annotate an attempt, or remove it."""
    if not 0 <= index < len(learner.attempts):
        return False
    if delete:
        del learner.attempts[index]
    elif note is not None:
        learner.attempts[index].note = note[:500]
    return True


def weaknesses(learner: Learner, top: int = 4) -> list[dict[str, Any]]:
    """
    Concepts with mastery under 0.5 after at least two observations, and misconceptions seen at
    least twice that still recur, worst first, each with a one-line reason.
    """
    out: list[tuple[float, dict[str, Any]]] = []
    for cid, st in learner.concepts.items():
        if st.opportunities >= 2 and st.p < 0.5 and cid in CONCEPTS:
            out.append(
                (
                    st.p,
                    {
                        "kind": "concept",
                        "id": cid,
                        "label": CONCEPTS[cid].label,
                        "why": f"mastery {st.p:.2f} after {st.opportunities} observations",
                    },
                )
            )
    for mid, ms in learner.misconceptions.items():
        if ms.count >= 2 and ms.recurring and mid in MISCONCEPTIONS:
            out.append(
                (
                    0.3 - 0.05 * ms.count,
                    {
                        "kind": "misconception",
                        "id": mid,
                        "label": MISCONCEPTIONS[mid].label,
                        "why": f"seen {ms.count} times, not yet two clean proofs in a row",
                    },
                )
            )
    return [d for _, d in sorted(out, key=lambda t: t[0])[:top]]


def nudge(learner: Learner, attempt: Attempt | None, now_ms: float) -> str | None:
    """
    One short deliberate-practice nudge after an attempt, or None. In order: a recurring error
    named; a hint taken within the first ten minutes (try alone first); a quick full score (go
    harder); a long attempt with no score (write up partial progress, then debrief).
    """
    if attempt is None:
        return None
    for mid in attempt.misconceptions:
        ms = learner.misconceptions.get(mid)
        if ms and ms.count >= 2 and mid in MISCONCEPTIONS:
            label = MISCONCEPTIONS[mid].label.lower()
            return (
                f"A pattern now: {label}. Check for it before you finish."
                if ms.count >= 3
                else f"Seen before: {label}."
            )
    if attempt.hints and attempt.minutes < 10:
        return "Next time give it ten minutes alone before the first hint."
    if attempt.score is not None and attempt.score >= 8 and attempt.minutes < 12:
        return "That was quick: the next one should be harder."
    if attempt.minutes >= 45 and (attempt.score or 0) <= 2:
        return "Long one. Write up your partial progress, then let's debrief the key idea."
    return None


# =============================================================================================
# Suggestions and the problem on the page
# =============================================================================================


def suggest(learner: Learner, now_ms: float, n: int = 3) -> list[dict[str, Any]]:
    """The next ``n`` problems with their reasons (practice.choose_queue with her reading)."""
    return [
        p.to_dict()
        for p in choose_queue(
            learner, now_ms, n=n, reading_keywords=reading_keywords(learner, now_ms)
        )
    ]


def coach_view(learner: Learner, now_ms: float) -> dict[str, Any]:
    """What the "Practice coach" dock entry opens: next problems, weak spots, and the state."""
    return {
        "watching": learner.watching and learner.consent,
        "next": suggest(learner, now_ms),
        "weak": weaknesses(learner),
        "attempts": len(learner.attempts),
        "last_reading": (lambda r: {"title": r.title, "page": r.page, "index": r.page_index})(
            learner.reading[-1]
        )
        if learner.reading
        else None,
    }


def problem_ink(
    problem: Problem,
    x: float = 0.08,
    y: float = 0.06,
    width: float = 0.84,
    author: str = "primer",
    color: str = "#3a6ea5",
) -> list[dict] | None:
    """
    The problem statement as ``stroke_begin``/``stroke_pts``/``stroke_end`` messages on the
    ``ai`` layer, from the top-left anchor ``(x, y)`` (normalized), or None when no handwriting
    provider is available (then the statement goes out as text only). Providers, in order:
    a ``packages/hand`` persona (:func:`hand_ink`, the biomechanical hand, ADR 009 §3), then the
    public-domain Hershey "futural" font word-wrapped into ``width`` (neat, plainly
    machine-written; needs ``Hershey-Fonts``).
    """
    via_hand = hand_ink(f"{problem.title}: {problem.statement}", x, y)
    if via_hand:
        return via_hand
    try:
        from HersheyFonts import HersheyFonts  # optional: uv run --with Hershey-Fonts
    except ImportError:
        return None
    font = HersheyFonts()
    font.load_default_font("futural")
    unit = 1.25  # page px per font unit: ~26 px capitals on the 1620-px-wide page
    page_w, page_h = 1620.0, 2160.0
    max_px = width * page_w
    words = f"{problem.title}: {problem.statement}".split()
    lines_out: list[str] = []
    cur = ""
    for w in words:
        trial = (cur + " " + w).strip()
        if sum(g.char_width for g in font.glyphs_for_text(trial)) * unit > max_px and cur:
            lines_out.append(cur)
            cur = w
        else:
            cur = trial
    if cur:
        lines_out.append(cur)
    msgs: list[dict] = []
    k = 0
    for li, text in enumerate(lines_out):
        base_y = y * page_h + li * 44
        for stroke in font.strokes_for_text(text):
            pts = [
                [
                    round((x * page_w + px * unit) / page_w, 5),
                    round((base_y + py * unit) / page_h, 5),
                    0.45,
                ]
                for px, py in stroke
            ]
            if len(pts) < 2:
                continue
            sid = f"primer_{problem.id}_{k}"
            k += 1
            msgs.append(
                {
                    "t": "stroke_begin",
                    "id": sid,
                    "layer": "ai",
                    "brush": "pen",
                    "color": color,
                    "author": author,
                }
            )
            msgs.append({"t": "stroke_pts", "id": sid, "pts": pts})
            msgs.append({"t": "stroke_end", "id": sid})
    return msgs


#: The repository root, where ``packages/hand`` lives when this runs from a checkout.
REPO = Path(__file__).resolve().parents[3]


def hand_ink(
    text: str, x: float, y: float, persona: str = "mathematician", seed: int = 1
) -> list[dict] | None:
    """
    ``text`` written by a ``packages/hand`` persona, through its CLI (``pnpm --filter hand cli
    … --out``): ``stroke_*`` messages on the ``ai`` layer with real pen timing in their point
    timestamps. None when the package, pnpm or Node is missing, or the run fails (60 s cap).
    """
    if not (REPO / "packages" / "hand" / "package.json").exists() or not shutil.which("pnpm"):
        return None
    with tempfile.TemporaryDirectory(prefix="primer-hand-") as d:
        out = Path(d) / "hand.jsonl"
        cmd = [
            shutil.which("pnpm") or "pnpm",
            "--filter",
            "hand",
            "cli",
            text,
            "--persona",
            persona,
            "--out",
            str(out),
            "--seed",
            str(seed),
            "--x",
            f"{x:.3f}",
            "--y",
            f"{y:.3f}",
        ]
        try:
            subprocess.run(cmd, cwd=REPO, capture_output=True, timeout=60, check=True)
            lines = out.read_text(encoding="utf-8").splitlines()
        except (OSError, subprocess.SubprocessError):
            return None
    msgs = []
    for line in lines:
        o = json.loads(line)
        m = o.get("msg", o)
        if m.get("t", "").startswith("stroke_"):
            msgs.append(m)
    return msgs or None


def bank_problem(pid: str) -> Problem | None:
    return BANK.get(pid)
