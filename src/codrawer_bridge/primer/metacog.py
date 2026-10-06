"""
Metacognition and consent: calibration, self-explanation, goals she agrees to, and what she lets
the Primer watch.

**Why.** Knowing mathematics is not enough under exam pressure; knowing *what you know* decides
where the minutes go. Students who monitor their own understanding learn more (Flavell 1979,
"Metacognition and cognitive monitoring", *American Psychologist*; Schraw & Dennison 1994 on
metacognitive awareness), and people are systematically miscalibrated about it, the least skilled
the most (Kruger & Dunning 1999; Lichtenstein, Fischhoff & Phillips 1982 on calibration of
probabilities). Explaining a solution to yourself is one of the best-replicated learning gains
(Chi, Bassok, Lewis, Reimann & Glaser 1989; Chi, de Leeuw, Chiu & LaVancher 1994), and goals that
are specific and one's own work better than imposed ones (Locke & Latham 2002; Deci & Ryan's
self-determination theory, 2000, on autonomy). This module holds the data for all of that.

- **Calibration.** Before the Primer checks a proof she may say how sure she is (0–100 %, a slider
  on the phone or ``/sure 70`` on the keyboard). After the grade, the pair (confidence, outcome)
  is kept, where the outcome is the score over 10. :func:`calibration` bins them into a curve,
  computes the Brier score and the mean gap (confidence − outcome), and per technique says where
  she is over- or under-confident (a gap beyond ±0.2 over at least three proofs), so the coach can
  say so kindly and specifically.
- **Self-explanation.** After a complete proof the debrief asks "what was the key idea?"; her
  answer (typed, or written and read) goes into the technique notebook in her own words
  (:data:`SELF_EXPLANATION_PROMPTS`).
- **Goals** (:class:`Goals`) are a conversation, never a setting the Primer imposes: a target
  (score or percentile), the topics she cares about, weekly hours, how much nudging she wants, and
  which features may watch her. Each change is recorded with its date and who proposed it (her, or
  the Primer with her "yes"); a weekly revisit is offered, not forced.
- **Per-feature consent** (:data:`FEATURES`): every kind of watching is opt-in on its own.
- **"That's wrong."** She can correct anything the model believes (a mastery estimate, an insight,
  her calibration); a correction is evidence, recorded with a modest weight (:func:`self_report`),
  never silently overwritten either way.
"""

from __future__ import annotations

# ruff: noqa: E501  (formulas and the sentences she reads are kept whole)
from dataclasses import asdict, dataclass, field
from typing import Any

#: Features that observe her, each opt-in on its own (all off until she turns them on).
FEATURES: dict[str, str] = {
    "reading_position": "Which textbook page you are on (to suggest matching problems)",
    "attempt_log": "Each problem you attempt: time, hints, score estimate, mistakes",
    "ink_signals": "Pauses, erasures and rewrites in your writing (to time hints)",
    "reviews": "Spaced review prompts written onto fresh pages or shown on the glasses",
    "nudges": "Short coaching lines after attempts",
    "activity_review": "A weekly look at your work: weaknesses, approach, blind spots, report",
}

NUDGING = ("off", "light", "normal")

SELF_EXPLANATION_PROMPTS = (
    "What was the key idea, in one sentence?",
    "Where did you first see that this approach would work?",
    "Which step would you check first if this were marked wrong?",
)

REFLECTION_PROMPTS = (
    "What went well in this session?",
    "Where did you get stuck, and what got you unstuck?",
    "What will you do differently next time?",
)


# =============================================================================================
# Calibration
# =============================================================================================


@dataclass
class Judgment:
    """A confidence she gave before a check, and the outcome: score/10 (None until graded)."""

    ts: float
    confidence: float
    outcome: float | None = None
    technique: str = ""
    problem: str | None = None


def calibration(judgments: list[Judgment], bins: int = 5) -> dict[str, Any]:
    """
    The calibration curve (per confidence bin: mean confidence, mean outcome, count), the Brier
    score (mean squared gap, 0 is perfect), the mean gap (positive: overconfident), and the
    techniques where she is over- or under-confident (|gap| ≥ 0.2 over ≥ 3 judgments).
    """
    done = [j for j in judgments if j.outcome is not None]
    curve = []
    for b in range(bins):
        lo, hi = b / bins, (b + 1) / bins
        inb = [
            j for j in done if lo <= j.confidence < hi or (b == bins - 1 and j.confidence == 1.0)
        ]
        if inb:
            curve.append(
                {
                    "bin": [lo, hi],
                    "confidence": round(sum(j.confidence for j in inb) / len(inb), 3),
                    "outcome": round(sum(j.outcome or 0 for j in inb) / len(inb), 3),
                    "n": len(inb),
                }
            )
    brier = sum((j.confidence - (j.outcome or 0)) ** 2 for j in done) / len(done) if done else None
    gap = sum(j.confidence - (j.outcome or 0) for j in done) / len(done) if done else None
    by: dict[str, list[Judgment]] = {}
    for j in done:
        if j.technique:
            by.setdefault(j.technique, []).append(j)
    flags = []
    for t, js in by.items():
        if len(js) >= 3:
            g = sum(j.confidence - (j.outcome or 0) for j in js) / len(js)
            if abs(g) >= 0.2:
                flags.append(
                    {
                        "technique": t,
                        "gap": round(g, 3),
                        "n": len(js),
                        "kind": "over" if g > 0 else "under",
                    }
                )
    return {
        "curve": curve,
        "brier": None if brier is None else round(brier, 4),
        "gap": None if gap is None else round(gap, 3),
        "n": len(done),
        "flags": flags,
    }


def calibration_nudge(cal: dict[str, Any], labels: dict[str, str]) -> str | None:
    """One kind, specific line about the largest calibration gap, or None."""
    if not cal.get("flags"):
        return None
    f = max(cal["flags"], key=lambda f: abs(f["gap"]))
    name = labels.get(f["technique"], f["technique"].replace("_", " "))
    pct = round(abs(f["gap"]) * 100)
    if f["kind"] == "over":
        return f"On {name} you've been about {pct} points more sure than the grades. Re-check the key step before you finish."
    return f"On {name} you've been about {pct} points less sure than you should be: your proofs there hold up. Trust them a bit more."


# =============================================================================================
# Goals
# =============================================================================================


@dataclass
class GoalChange:
    """One change to the goals: when, which fields, and who proposed it (``learner`` or ``primer``)."""

    ts: float
    fields: dict[str, Any]
    by: str = "learner"
    note: str = ""


@dataclass
class Goals:
    """
    Her goals, in her words where possible. ``target`` is free text ("40 on the Putnam", "top 500")
    with an optional numeric ``target_score`` out of 120; ``topics`` are areas she wants to focus on;
    ``weekly_hours``; ``nudging`` one of :data:`NUDGING`; ``revisit_days`` how often the Primer may
    offer to revisit them (it asks; she decides). ``agreed_ms`` is when she last confirmed them.
    """

    target: str = ""
    target_score: int | None = None
    topics: list[str] = field(default_factory=list)
    weekly_hours: float | None = None
    nudging: str = "light"
    revisit_days: int = 7
    agreed_ms: float | None = None
    history: list[GoalChange] = field(default_factory=list)

    EDITABLE = ("target", "target_score", "topics", "weekly_hours", "nudging", "revisit_days")

    def apply(
        self, changes: dict[str, Any], now_ms: float, by: str = "learner", note: str = ""
    ) -> dict[str, Any]:
        """Apply the editable fields she changed (validated), record the change, and mark them agreed."""
        clean: dict[str, Any] = {}
        for k, v in changes.items():
            if k not in self.EDITABLE:
                continue
            if k == "nudging" and v not in NUDGING:
                continue
            if k == "target_score":
                v = None if v in (None, "") else max(0, min(120, int(v)))
            if k == "weekly_hours":
                v = None if v in (None, "") else max(0.0, min(80.0, float(v)))
            if k == "revisit_days":
                v = max(1, min(60, int(v)))
            if k == "topics":
                v = [str(t)[:60] for t in (v or [])][:12]
            if k == "target":
                v = str(v)[:200]
            clean[k] = v
            setattr(self, k, v)
        if clean:
            self.history.append(GoalChange(ts=now_ms, fields=clean, by=by, note=note[:200]))
            self.history = self.history[-100:]
        if by == "learner":
            self.agreed_ms = now_ms
        return clean

    def revisit_due(self, now_ms: float) -> bool:
        return self.agreed_ms is None or now_ms - self.agreed_ms >= self.revisit_days * 86_400_000

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        return d

    @staticmethod
    def from_dict(d: dict[str, Any] | None) -> Goals:
        if not d:
            return Goals()
        d = dict(d)
        d["history"] = [GoalChange(**h) for h in d.get("history") or []]
        return Goals(**{k: v for k, v in d.items() if k in Goals.__dataclass_fields__})


# =============================================================================================
# "That's wrong": corrections as evidence
# =============================================================================================

#: The weight of her own claim about her mastery, against the Primer's readings (weight 1 each).
SELF_REPORT_WEIGHT = 0.3


@dataclass
class Correction:
    """She disputed something the model believes: what (``target``), her claim, and when."""

    ts: float
    target: str  # "mastery:<concept>", "insight:<id>", "calibration", "misconception:<id>"
    claim: str  # e.g. "known", "not_known", "wrong", "right"
    note: str = ""
