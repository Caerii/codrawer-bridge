"""
Item memory: the Free Spaced Repetition Scheduler (FSRS) for what she should be able to recall.

**The problem.** Mastery (learner.py, Bayesian Knowledge Tracing) answers "does she know how to
do this?". It does not answer "will she remember it on 5 December?". Memory decays item by item:
when to use the extremal principle, the lemma that an odd square is odd, her own recurring mistake
of forgetting lowest terms, the problem she failed last week and should re-attempt. Each of these
is an *item* with its own memory state, reviewed in the medium (a prompt written onto a fresh page,
a quick recall on the glasses) and rescheduled from how the review went.

**The model.** FSRS (Ye, Su & Cao 2022, "A stochastic shortest path algorithm for optimizing
spaced repetition scheduling", KDD; Su, Ye et al. 2023, IEEE TKDE; the open-spaced-repetition
project, github.com/open-spaced-repetition) describes an item's memory by three numbers:

- **retrievability** R, the probability of recall now: R(t, S) = (1 + F·t/S)^C with C = −0.5 and
  F = 19/81, so that R = 0.9 when the elapsed time t equals the stability S;
- **stability** S, in days: the time for R to fall from 1 to 0.9;
- **difficulty** D, 1..10: how hard the item is to make stable.

A review is rated 1 Again (forgotten), 2 Hard, 3 Good, 4 Easy. With the 17 weights ``W`` below
(the FSRS-4.5 defaults of the open-spaced-repetition project, before any fitting to her own
review log):

    S₀(G) = w[G−1]                         D₀(G) = w4 − (G−3)·w5          (first review)
    D' = D − w6·(G−3);  D'' = w7·D₀(4) + (1−w7)·D'   (mean reversion), clamped to [1, 10]
    success: S' = S·(1 + e^{w8}·(11−D)·S^{−w9}·(e^{w10(1−R)} − 1)·(w15 if Hard)·(w16 if Easy))
    lapse:   S' = w11·D^{−w12}·((S+1)^{w13} − 1)·e^{w14(1−R)}

and the next interval for a desired retention r is I = (S/F)·(r^{1/C} − 1) days (r = 0.9 gives
I = S). The weights are a starting point; FSRS's optimizer fits them to a review log, and hers will
exist after a few weeks.

**How it meets mastery** (ADR 010, "Two layers of memory"): an item belongs to concepts; a review
rated Good or Easy is a BKT observation of credit 1 on them (weight 0.5, since recall is not a full
proof), Hard 0.5, Again 0; and BKT gates FSRS: items are scheduled for recall only once their
concepts' mastery is at least 0.3 (below that the policy teaches, with worked examples, instead of
testing recall). Ratings come from the medium: the Primer's reading of a re-attempt (ok → Good,
fluent and quick → Easy, gap or hints → Hard, error → Again), or her own rating on the phone or
glasses for a quick recall.
"""

from __future__ import annotations

# ruff: noqa: E501  (formulas and the sentences she reads are kept whole)
import math
from dataclasses import asdict, dataclass, field
from typing import Any

#: FSRS-4.5 default weights (open-spaced-repetition), w0..w16.
W = (
    0.4872,
    1.4003,
    3.7145,
    13.8206,
    5.1618,
    1.2298,
    0.8975,
    0.031,
    1.6474,
    0.1367,
    1.0461,
    2.1072,
    0.0793,
    0.3246,
    1.587,
    0.2272,
    2.8755,
)
DECAY = -0.5
FACTOR = 19 / 81
DAY_MS = 86_400_000
AGAIN, HARD, GOOD, EASY = 1, 2, 3, 4

#: The kinds of item (module docstring).
KINDS = ("technique", "lemma", "mistake", "problem", "concept")


def retrievability(elapsed_days: float, stability: float) -> float:
    """R(t, S): the probability of recall after ``elapsed_days`` for an item of this stability."""
    return (1 + FACTOR * max(0.0, elapsed_days) / max(stability, 1e-6)) ** DECAY


def interval_days(stability: float, retention: float = 0.9) -> float:
    """Days until R falls to ``retention`` (0.9 gives the stability itself)."""
    return stability / FACTOR * (retention ** (1 / DECAY) - 1)


def init_difficulty(g: int) -> float:
    return min(10.0, max(1.0, W[4] - (g - 3) * W[5]))


def next_difficulty(d: float, g: int) -> float:
    d2 = d - W[6] * (g - 3)
    return min(10.0, max(1.0, W[7] * init_difficulty(EASY) + (1 - W[7]) * d2))


def stability_after_success(d: float, s: float, r: float, g: int) -> float:
    hard = W[15] if g == HARD else 1.0
    easy = W[16] if g == EASY else 1.0
    return s * (
        1 + math.exp(W[8]) * (11 - d) * s ** (-W[9]) * (math.exp(W[10] * (1 - r)) - 1) * hard * easy
    )


def stability_after_lapse(d: float, s: float, r: float) -> float:
    return W[11] * d ** (-W[12]) * ((s + 1) ** W[13] - 1) * math.exp(W[14] * (1 - r))


@dataclass
class Review:
    """One review: when (Unix ms), the rating, R just before it, and S and D just after."""

    ts: float
    grade: int
    r: float | None
    s: float
    d: float
    source: str = ""  # "reading" (the Primer graded a re-attempt) or "self" (she rated a recall)


@dataclass
class Item:
    """
    A thing to remember (module docstring). ``prompt`` is what a review shows or writes; ``concepts``
    link it to the mastery layer; ``source`` is where it came from (a problem id, a finding, a
    notebook entry). ``due_ms`` is when R falls to the desired retention.
    """

    id: str
    kind: str
    prompt: str
    concepts: list[str] = field(default_factory=list)
    source: str = ""
    created_ms: float = 0.0
    s: float = 0.0
    d: float = 0.0
    last_ms: float | None = None
    due_ms: float | None = None
    reps: int = 0
    lapses: int = 0
    log: list[Review] = field(default_factory=list)

    def r(self, now_ms: float) -> float | None:
        if self.last_ms is None:
            return None
        return retrievability((now_ms - self.last_ms) / DAY_MS, self.s)

    def review(self, grade: int, now_ms: float, retention: float = 0.9, source: str = "") -> Review:
        """Apply a rating (1–4) now; reschedule. Returns the review logged."""
        grade = min(EASY, max(AGAIN, int(grade)))
        if self.reps == 0:
            r = None
            self.s = W[grade - 1]
            self.d = init_difficulty(grade)
        else:
            r = self.r(now_ms) or 1.0
            if grade == AGAIN:
                self.s = stability_after_lapse(self.d, self.s, r)
                self.lapses += 1
            else:
                self.s = stability_after_success(self.d, self.s, r, grade)
            self.d = next_difficulty(self.d, grade)
        self.reps += 1
        self.last_ms = now_ms
        self.due_ms = now_ms + interval_days(self.s, retention) * DAY_MS
        rv = Review(
            ts=now_ms,
            grade=grade,
            r=None if r is None else round(r, 4),
            s=round(self.s, 4),
            d=round(self.d, 4),
            source=source,
        )
        self.log.append(rv)
        self.log = self.log[-200:]
        return rv

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @staticmethod
    def from_dict(d: dict[str, Any]) -> Item:
        d = dict(d)
        d["log"] = [Review(**x) for x in d.get("log") or []]
        return Item(**d)


def grade_from_step(
    status: str, hints: int = 0, hesitation: float = 0.0, minutes: float | None = None
) -> int:
    """
    A rating from the Primer's reading of a re-attempt (module docstring): an error is Again; a
    gap, hints or marked hesitation are Hard; a sound step written fluently and quickly is Easy;
    otherwise Good.
    """
    if status == "error":
        return AGAIN
    if status in ("gap", "unclear") or hints > 0 or hesitation >= 0.6:
        return HARD
    if hesitation < 0.2 and (minutes is None or minutes < 10):
        return EASY
    return GOOD


def due(
    items: list[Item], now_ms: float, mastery: dict[str, float] | None = None, gate: float = 0.3
) -> list[Item]:
    """
    Items due now, most forgotten first; items never reviewed are due once. With ``mastery``
    (concept → P(known)), items whose concepts are not yet at ``gate`` are left to teaching.
    """
    out = []
    for it in items:
        if (
            mastery is not None
            and it.concepts
            and min(mastery.get(c, 0.0) for c in it.concepts) < gate
        ):
            continue
        if it.due_ms is None or it.due_ms <= now_ms:
            out.append(it)
    return sorted(out, key=lambda it: (it.r(now_ms) if it.last_ms is not None else -1.0))
