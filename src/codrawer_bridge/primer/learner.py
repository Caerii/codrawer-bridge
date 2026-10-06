"""
The learner model: what one person knows, misunderstands and is due to review, kept local.

**The problem.** A tutor that forgets is a worksheet. The Primer needs, for each concept of the
task model (concepts.py), a calibrated belief that this learner has mastered it; a record of the
misconceptions it has seen in her work and whether they have stopped recurring; the evidence
behind both, turn by turn; a schedule for revisiting what is fading; and the notebook of
techniques she has made her own. It must be hers: one JSON file on the desktop she can open,
read, copy and delete (ADR 010, "Privacy").

**Mastery: Bayesian Knowledge Tracing** (Corbett & Anderson 1995, "Knowledge tracing: Modeling
the acquisition of procedural knowledge", *User Modeling and User-Adapted Interaction* 4:253–278).
Each concept is a hidden binary state, known or not, with four parameters:

- ``p_init`` P(L₀), the prior that it is known before any evidence. Seeded from the concept's
  level: 0.35, 0.20, 0.12, 0.08 for levels 1–4. A Putnam candidate knows most first-proof
  material, so level-1 priors sit near the upper end of the 0.1–0.4 range typical of fitted
  tutors; per-student priors (Pardos & Heffernan 2010, "Modeling individualization in a Bayesian
  networks implementation of knowledge tracing", UMAP) are the next step once there is data.
- ``p_transit`` P(T) = 0.12, the chance of learning it at each opportunity, inside the 0.05–0.3
  band fitted values usually fall in.
- ``p_guess`` P(G) = 0.12 and ``p_slip`` P(S) = 0.10. Corbett & Anderson bounded guess at 0.3 and
  slip at 0.1; Baker, Corbett & Aleven (2008, "More accurate student modeling through contextual
  estimation of slip and guess probabilities in Bayesian Knowledge Tracing", ITS) show that
  unbounded fits degenerate (guess or slip above 0.5 make "correct" evidence of not knowing). A
  correct proof step is harder to produce by luck than a multiple-choice answer, hence a low
  guess.

The update on an observation with credit c ∈ [0, 1] (1 = the step was sound, 0 = wrong) is the
standard posterior for a correct and for an incorrect response, mixed by c, a soft-evidence
approximation in the spirit of partial-credit BKT (Wang & Heffernan 2013, "Extending knowledge
tracing to allow partial credit: using continuous versus binary nodes", AIED), followed by the
learning transition:

    P(L | ✓) = P(L)(1−S) / (P(L)(1−S) + (1−P(L))G)
    P(L | ✗) = P(L)S / (P(L)S + (1−P(L))(1−G))
    post     = c·P(L | ✓) + (1−c)·P(L | ✗)
    P(L)'    = post + (1 − post)·T

Evidence is weighted (``weight`` w, the recognizer's confidence in what was read): the new value
is ``prior + w·(P(L)' − prior)``, so an illegible step barely moves the model. Credit is reduced
by help and hesitation before the update: each hint rung used costs a quarter of the credit
(help-seeking as evidence, as in Corbett & Anderson's tutors), and a hesitant line (ink_signals
``hesitation`` h) scales credit by ``1 − 0.3·h``. Those two factors are hand-set and labelled so
in the ADR; they are the first parameters to fit.

**Misconceptions** are counted, with the turn they were last seen and the number of turns since
in which a proof exercised the same concepts without them (``clear_streak``): two clean turns in
a row mark one as "not recurring".

**Spaced review** uses a half-life model (Settles & Meeder 2016, "A trainable spaced repetition
model for language learning", ACL): recall is predicted as 2^(−Δ/h) for Δ days since the concept
was last exercised and half-life h; a success doubles h (to 60 days at most), a failure halves it
(to half a day at least), partial credit grows it by a fifth. A concept is due when predicted
recall falls under 0.5, or under 0.7 while its mastery is still shaky (0.3–0.8). The spacing
effect itself is one of the most robust results in learning science (Cepeda, Pashler, Vul,
Wixted & Rohrer 2006, "Distributed practice in verbal recall tasks", *Psychological Bulletin*).

**The file.** ``<state dir>/primer/learners/<name>.json``, state dir ``$CODRAWER_STATE_DIR`` or
``~/.codrawer``; never inside the repository. Writes are atomic (temp file, then replace).
``LearnerStore.delete`` removes it. Nothing here sends it anywhere: what reaches a model call is
listed in ADR 010 and built in recognize.py.
"""

from __future__ import annotations

import json
import os
import re
import tempfile
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

from .concepts import CONCEPTS, MISCONCEPTIONS

SCHEMA_VERSION = 1
DAY_MS = 86_400_000

# =============================================================================================
# BKT
# =============================================================================================

#: P(L₀) by concept level (1..4); see the module docstring.
P_INIT_BY_LEVEL = {1: 0.35, 2: 0.20, 3: 0.12, 4: 0.08}
P_TRANSIT = 0.12
P_GUESS = 0.12
P_SLIP = 0.10

#: Credit lost per hint rung used, and the scale of the hesitation discount.
HINT_COST = 0.25
HESITATION_COST = 0.3


def bkt_posterior(p: float, correct: bool, guess: float = P_GUESS, slip: float = P_SLIP) -> float:
    """P(known | one correct or incorrect observation), before the learning transition."""
    if correct:
        num = p * (1 - slip)
        den = num + (1 - p) * guess
    else:
        num = p * slip
        den = num + (1 - p) * (1 - guess)
    return num / den if den > 0 else p


def bkt_update(
    p: float,
    credit: float,
    *,
    weight: float = 1.0,
    transit: float = P_TRANSIT,
    guess: float = P_GUESS,
    slip: float = P_SLIP,
) -> float:
    """
    One BKT step with soft evidence: ``credit`` in [0, 1] mixes the correct and incorrect
    posteriors, then the learning transition applies, then ``weight`` in [0, 1] interpolates
    between the prior and that result. Returns the new P(known), in (0, 1).
    """
    credit = min(1.0, max(0.0, credit))
    weight = min(1.0, max(0.0, weight))
    post = credit * bkt_posterior(p, True, guess, slip) + (1 - credit) * bkt_posterior(
        p, False, guess, slip
    )
    learned = post + (1 - post) * transit
    return p + weight * (learned - p)


def effective_credit(credit: float, hint_level: int = 0, hesitation: float = 0.0) -> float:
    """Credit after the help and hesitation discounts (module docstring), clamped to [0, 1]."""
    c = credit * max(0.0, 1 - HINT_COST * max(0, hint_level))
    c *= 1 - HESITATION_COST * min(1.0, max(0.0, hesitation))
    return min(1.0, max(0.0, c))


# =============================================================================================
# The learner's state
# =============================================================================================


@dataclass
class ConceptState:
    """Mastery and review state for one concept. ``last_ms`` is Unix ms of the last evidence."""

    p: float
    opportunities: int = 0
    half_life_days: float = 1.0
    last_ms: float | None = None

    def recall(self, now_ms: float) -> float | None:
        """Predicted recall now (2^(−Δ/h)), or None if never exercised."""
        if self.last_ms is None:
            return None
        days = max(0.0, (now_ms - self.last_ms) / DAY_MS)
        return 2 ** (-days / max(0.01, self.half_life_days))


@dataclass
class MisconceptionState:
    count: int = 0
    last_turn: int = 0
    last_ms: float | None = None
    clear_streak: int = 0

    @property
    def recurring(self) -> bool:
        return self.count > 0 and self.clear_streak < 2


@dataclass
class Evidence:
    """
    One evidence event: a concept observed at a step of a turn's proof, with the raw and
    effective credit, the discounts' inputs and the mastery before and after. ``kind`` is
    ``step`` (a step exercised the concept) or ``finding`` (a misconception entry counted against
    it). Kept in the file so the learner (or a parent) can see why the model believes what it
    believes.
    """

    ts: float
    turn: int
    concept: str
    credit: float
    effective: float
    weight: float
    p_before: float
    p_after: float
    kind: str = "step"
    step: int = 0
    problem: str | None = None
    hint_level: int = 0
    hesitation: float = 0.0
    finding: str | None = None


@dataclass
class NotebookEntry:
    """A technique she used to solve a problem, in her words where possible (practice.py)."""

    ts: float
    problem: str
    technique: str
    key_idea: str
    why: str = ""


@dataclass
class SessionRecord:
    """A timed practice session: when, which problems, minutes used, and estimated scores."""

    ts: float
    kind: str  # "session" (90 min, 3 problems) or "mock" (4 sessions)
    problems: list[str]
    minutes: float
    scores: list[int] = field(default_factory=list)


@dataclass
class Attempt:
    """
    One attempt at a problem, the practice coach's log entry (coach.py): which problem (a bank
    id, or ``page:<doc>/<page>`` for unrecognized work), when it started and how long the pen
    was on it, hints used, the steps where it went wrong, the score estimate and the
    misconception ids seen. ``reading`` is the textbook position she came from, when known.
    ``note`` is free text the learner may edit (the log is hers to correct).
    """

    ts: float
    problem: str
    minutes: float = 0.0
    hints: int = 0
    wrong_steps: list[int] = field(default_factory=list)
    score: int | None = None
    misconceptions: list[str] = field(default_factory=list)
    technique: str = ""
    reading: dict[str, Any] | None = None
    note: str = ""


@dataclass
class ReadingEvent:
    """
    Where she was reading: a document open on the tablet (the bridge's page watcher reports the
    document id, title and page id; docs/protocol.md ``page``), first and last seen, Unix ms.
    ``page_index`` is the page's position in the document when the watcher reports it.
    """

    doc: str
    title: str
    page: str
    first_ms: float
    last_ms: float
    page_index: int | None = None


@dataclass
class Learner:
    """Everything the Primer keeps about one learner; serialized as one JSON file."""

    name: str
    created_ms: float
    concepts: dict[str, ConceptState] = field(default_factory=dict)
    misconceptions: dict[str, MisconceptionState] = field(default_factory=dict)
    evidence: list[Evidence] = field(default_factory=list)
    notebook: list[NotebookEntry] = field(default_factory=list)
    sessions: list[SessionRecord] = field(default_factory=list)
    solved: dict[str, int] = field(default_factory=dict)  # problem id → best estimated score
    seen: list[str] = field(default_factory=list)  # problem ids attempted
    attempts: list[Attempt] = field(default_factory=list)
    reading: list[ReadingEvent] = field(default_factory=list)
    #: The coach watches only with consent, and only while ``watching`` is on (ADR 010).
    consent: bool = False
    watching: bool = False
    turn: int = 0
    exam_date: str = "2026-12-05"
    schema: int = SCHEMA_VERSION

    # ── Concept state ────────────────────────────────────────────────────────────────────────

    def state(self, concept: str) -> ConceptState:
        if concept not in self.concepts:
            level = CONCEPTS[concept].level if concept in CONCEPTS else 2
            self.concepts[concept] = ConceptState(p=P_INIT_BY_LEVEL.get(level, 0.2))
        return self.concepts[concept]

    def mastery(self, concept: str) -> float:
        return (
            self.concepts[concept].p
            if concept in self.concepts
            else P_INIT_BY_LEVEL.get(CONCEPTS[concept].level if concept in CONCEPTS else 2, 0.2)
        )

    def observe(
        self,
        concept: str,
        credit: float,
        *,
        now_ms: float,
        weight: float = 1.0,
        hint_level: int = 0,
        hesitation: float = 0.0,
        step: int = 0,
        problem: str | None = None,
        kind: str = "step",
        finding: str | None = None,
    ) -> Evidence:
        """Apply one observation to ``concept`` (BKT, then the review half-life) and log it."""
        st = self.state(concept)
        eff = effective_credit(credit, hint_level, hesitation)
        before = st.p
        st.p = bkt_update(before, eff, weight=weight)
        st.opportunities += 1
        if eff >= 0.7:
            st.half_life_days = min(60.0, st.half_life_days * 2)
        elif eff < 0.4:
            st.half_life_days = max(0.5, st.half_life_days / 2)
        else:
            st.half_life_days = min(60.0, st.half_life_days * 1.2)
        st.last_ms = now_ms
        ev = Evidence(
            ts=now_ms,
            turn=self.turn,
            concept=concept,
            credit=round(credit, 3),
            effective=round(eff, 3),
            weight=round(weight, 3),
            p_before=round(before, 4),
            p_after=round(st.p, 4),
            kind=kind,
            step=step,
            problem=problem,
            hint_level=hint_level,
            hesitation=round(hesitation, 3),
            finding=finding,
        )
        self.evidence.append(ev)
        self.evidence = self.evidence[-2000:]
        return ev

    def saw_misconception(self, mid: str, now_ms: float) -> None:
        ms = self.misconceptions.setdefault(mid, MisconceptionState())
        ms.count += 1
        ms.last_turn = self.turn
        ms.last_ms = now_ms
        ms.clear_streak = 0

    def clean_turn_for(self, concepts_exercised: set[str], seen: set[str]) -> None:
        """A turn used these concepts without these misconceptions: extend their clean streaks."""
        for mid, ms in self.misconceptions.items():
            if mid in seen:
                continue
            entry = MISCONCEPTIONS.get(mid)
            if entry and concepts_exercised & set(entry.concepts):
                ms.clear_streak += 1

    # ── Queries ──────────────────────────────────────────────────────────────────────────────

    def due(self, now_ms: float) -> list[str]:
        """Concepts due for review now (module docstring), most faded first."""
        out = []
        for cid, st in self.concepts.items():
            r = st.recall(now_ms)
            if r is None:
                continue
            if r < 0.5 or (0.3 <= st.p <= 0.8 and r < 0.7):
                out.append((r, cid))
        return [cid for _, cid in sorted(out)]

    def frontier(self, threshold: float = 0.7) -> list[str]:
        """Concepts not yet mastered whose prerequisites all are: where stretch problems live."""
        out = []
        for cid, c in CONCEPTS.items():
            if self.mastery(cid) >= threshold:
                continue
            if all(self.mastery(p) >= threshold for p in c.prereqs):
                out.append(cid)
        return out

    def summary(self, now_ms: float, top: int = 6) -> dict[str, Any]:
        """The learner block of a ``primer`` message (docs/protocol.md)."""
        touched = sorted(self.concepts.items(), key=lambda kv: kv[1].p)
        weak = [cid for cid, st in touched if st.opportunities > 0][:top]
        strong = [cid for cid, st in reversed(touched) if st.opportunities >= 3 and st.p >= 0.8][:3]
        recurring = [mid for mid, ms in self.misconceptions.items() if ms.recurring]
        parts = []
        if strong:
            parts.append(
                "Solid: " + ", ".join(CONCEPTS[c].label for c in strong if c in CONCEPTS) + "."
            )
        if weak:
            parts.append(
                "Working on: "
                + ", ".join(CONCEPTS[c].label for c in weak[:3] if c in CONCEPTS)
                + "."
            )
        if recurring:
            parts.append(
                "Watch for: "
                + "; ".join(
                    MISCONCEPTIONS[m].label.lower() for m in recurring[:2] if m in MISCONCEPTIONS
                )
                + "."
            )
        if not parts:
            parts.append("No evidence yet: write a proof and ask the Primer to read it.")
        shown = sorted({*weak, *strong}, key=lambda c: self.mastery(c))
        return {
            "name": self.name,
            "summary": " ".join(parts),
            "mastery": [
                {
                    "concept": c,
                    "label": CONCEPTS[c].label if c in CONCEPTS else c,
                    "p": round(self.mastery(c), 3),
                }
                for c in shown
            ],
            "misconceptions": [
                {
                    "id": m,
                    "label": MISCONCEPTIONS[m].label if m in MISCONCEPTIONS else m,
                    "count": ms.count,
                    "recurring": ms.recurring,
                }
                for m, ms in sorted(self.misconceptions.items(), key=lambda kv: -kv[1].count)
            ],
            "due": self.due(now_ms)[:6],
            "notebook": len(self.notebook),
            "turns": self.turn,
        }

    # ── Serialization ────────────────────────────────────────────────────────────────────────

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @staticmethod
    def from_dict(d: dict[str, Any]) -> Learner:
        lr = Learner(name=d["name"], created_ms=d.get("created_ms", 0.0))
        lr.concepts = {k: ConceptState(**v) for k, v in (d.get("concepts") or {}).items()}
        lr.misconceptions = {
            k: MisconceptionState(**v) for k, v in (d.get("misconceptions") or {}).items()
        }
        lr.evidence = [Evidence(**e) for e in d.get("evidence") or []]
        lr.notebook = [NotebookEntry(**e) for e in d.get("notebook") or []]
        lr.sessions = [SessionRecord(**e) for e in d.get("sessions") or []]
        lr.solved = dict(d.get("solved") or {})
        lr.seen = list(d.get("seen") or [])
        lr.attempts = [Attempt(**e) for e in d.get("attempts") or []]
        lr.reading = [ReadingEvent(**e) for e in d.get("reading") or []]
        lr.consent = bool(d.get("consent", False))
        lr.watching = bool(d.get("watching", False))
        lr.turn = int(d.get("turn") or 0)
        lr.exam_date = str(d.get("exam_date") or "2026-12-05")
        return lr


# =============================================================================================
# The store: one file per learner
# =============================================================================================

_NAME_OK = re.compile(r"[^a-z0-9_-]+")


def safe_name(name: str) -> str:
    """Fold a learner name to ``[a-z0-9_-]{1,32}`` (protocol.md); empty becomes ``learner``."""
    n = _NAME_OK.sub("-", (name or "").strip().lower()).strip("-")[:32]
    return n or "learner"


def state_dir() -> Path:
    """``$CODRAWER_STATE_DIR`` or ``~/.codrawer``: the desktop's state, outside any repo."""
    return Path(os.environ.get("CODRAWER_STATE_DIR") or Path.home() / ".codrawer")


class LearnerStore:
    """Loads, saves and deletes learner files under ``<root>/primer/learners/``."""

    def __init__(self, root: Path | None = None) -> None:
        self.dir = (root or state_dir()) / "primer" / "learners"

    def path(self, name: str) -> Path:
        return self.dir / f"{safe_name(name)}.json"

    def load(self, name: str) -> Learner:
        p = self.path(name)
        if p.exists():
            return Learner.from_dict(json.loads(p.read_text(encoding="utf-8")))
        return Learner(name=safe_name(name), created_ms=time.time() * 1000)

    def save(self, learner: Learner) -> Path:
        self.dir.mkdir(parents=True, exist_ok=True)
        p = self.path(learner.name)
        fd, tmp = tempfile.mkstemp(prefix=".tmp-", suffix=".json", dir=self.dir)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(learner.to_dict(), f, indent=1, ensure_ascii=False)
        os.replace(tmp, p)
        return p

    def delete(self, name: str) -> bool:
        p = self.path(name)
        if p.exists():
            p.unlink()
            return True
        return False
