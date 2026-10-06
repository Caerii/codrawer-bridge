"""
The reflective layer: a kind mirror of how she works, built only from what she let the Primer see.

**The problem.** Some patterns are invisible from inside: always stalling at the same kind of
step, quietly avoiding a topic, being surest exactly where the grades are lowest, spending an hour
on problems that end at 1/10, never trying the technique that would have cracked them, the same
mistake turning up in number theory and in combinatorics. A good coach names these, with the
evidence, and one concrete thing to try. This module reads her learner file (learner.py: the
attempt log, evidence events, misconceptions, judgments, reading positions, mock sessions) and
writes three things:

- :func:`activity_review`: problems attempted with outcomes, weaknesses with their evidence, an
  **approach profile** ("reaches for contradiction first; little sign of testing small cases;
  strong at induction set-up"), and topics with time spent and the trend of mastery;
- :func:`blind_spots`: insights, each with evidence (attempts, with links to replay the page at
  that moment), a confidence, and one suggestion; she can confirm or dismiss each, and her
  verdict is feedback (learner.self_report): dismissed insights are not shown again;
- the data the weekly report typesets (report.py).

**Consent and tone.** Nothing here runs unless she turned on ``activity_review`` (metacog.FEATURES),
and it only reads what the other features she allowed recorded. Every sentence is specific
(counts, problems), kind (what to try, never a judgement of her), and labelled with how sure the
Primer is. A heuristic stays a heuristic: the text says "from N attempts".
"""

from __future__ import annotations

# ruff: noqa: E501  (the sentences she reads are kept whole)
from collections import Counter, defaultdict
from dataclasses import asdict, dataclass, field
from typing import Any

from .concepts import AREA_LABELS, CONCEPTS, MISCONCEPTIONS
from .learner import Attempt, Learner
from .metacog import calibration
from .practice import BANK

DAY_MS = 86_400_000


def _area(technique_or_problem: str) -> str:
    """The topic an attempt belongs to: its bank problem's first concept, else its technique's."""
    p = BANK.get(technique_or_problem)
    if p and p.concepts and p.concepts[0] in CONCEPTS:
        return CONCEPTS[p.concepts[0]].area
    if technique_or_problem in CONCEPTS:
        return CONCEPTS[technique_or_problem].area
    return "techniques"


def _evidence_link(a: Attempt) -> dict[str, Any]:
    """An attempt as evidence: what, when, and where to replay it (the page and the moment)."""
    r = a.reading or {}
    title = BANK[a.problem].title if a.problem in BANK else a.problem.split(":", 1)[-1]
    return {
        "ts": a.ts,
        "problem": a.problem,
        "title": title,
        "score": a.score,
        "doc": r.get("doc"),
        "page": r.get("page"),
        "replay": {"doc": r.get("doc"), "page": r.get("page"), "at_ms": a.ts},
        "thumb": getattr(a, "thumb", ""),
    }


# =============================================================================================
# Activity review
# =============================================================================================


def approach_profile(lr: Learner) -> list[dict[str, Any]]:
    """How she approaches problems, from her own work (module docstring). Each line has its basis."""
    out: list[dict[str, Any]] = []
    n = len(lr.attempts)
    if n == 0:
        return out
    tech = Counter(a.technique for a in lr.attempts if a.technique)
    if tech:
        t, k = tech.most_common(1)[0]
        if k >= 2:
            out.append(
                {
                    "text": f"Reaches for {CONCEPTS[t].label.lower() if t in CONCEPTS else t} first",
                    "basis": f"{k} of {n} attempts",
                }
            )
    strong = [
        cid
        for cid, st in lr.concepts.items()
        if st.opportunities >= 3 and st.p >= 0.8 and cid in CONCEPTS
    ]
    if strong:
        out.append(
            {
                "text": "Strong at " + ", ".join(CONCEPTS[c].label.lower() for c in strong[:3]),
                "basis": "mastery above 0.8 over at least 3 observations each",
            }
        )
    if n >= 5 and not any(e.concept == "symmetry" for e in lr.evidence):
        out.append(
            {
                "text": "Little sign of testing small cases or examples before proving",
                "basis": f"no such step in {n} attempts",
            }
        )
    edge = sum(
        1
        for a in lr.attempts
        for m in a.misconceptions
        if m in ("equality_case_missing", "cases_not_exhaustive", "division_by_zero")
    )
    if edge:
        out.append(
            {
                "text": "Edge cases sometimes go unchecked",
                "basis": f"{edge} times across {n} attempts",
            }
        )
    kinds = Counter(
        MISCONCEPTIONS[m].kind for a in lr.attempts for m in a.misconceptions if m in MISCONCEPTIONS
    )
    if sum(kinds.values()) >= 2:
        k, c = kinds.most_common(1)[0]
        what = {
            "missing_rigor": "missing justification rather than wrong ideas",
            "misconception": "a wrong step, not just a missing one",
            "exposition": "how the argument is written up",
        }[k]
        out.append(
            {"text": f"Most marks are for {what}", "basis": f"{c} of {sum(kinds.values())} marks"}
        )
    hes: dict[str, list[float]] = defaultdict(list)
    for e in lr.evidence:
        if e.kind == "step" and e.hesitation:
            hes[e.concept].append(e.hesitation)
    slow = [(sum(v) / len(v), c) for c, v in hes.items() if len(v) >= 2]
    if slow:
        h, c = max(slow)
        if h >= 0.5 and c in CONCEPTS:
            out.append(
                {
                    "text": f"Pauses longest before steps that use {CONCEPTS[c].label.lower()}",
                    "basis": f"mean hesitation {h:.2f} over {len(hes[c])} steps",
                }
            )
    hints = sum(a.hints for a in lr.attempts)
    if hints:
        out.append(
            {
                "text": "Asks for hints"
                + (" early" if any(a.hints and a.minutes < 10 for a in lr.attempts) else ""),
                "basis": f"{hints} hints over {n} attempts",
            }
        )
    return out


def topics(lr: Learner, now_ms: float, days: int = 7) -> list[dict[str, Any]]:
    """Per area: attempts, minutes, and the mastery trend over the last ``days`` (sum of changes)."""
    by: dict[str, dict[str, Any]] = {}
    for a in lr.attempts:
        ar = _area(a.problem if a.problem in BANK else a.technique)
        d = by.setdefault(
            ar,
            {
                "area": ar,
                "label": AREA_LABELS.get(ar, ar),
                "attempts": 0,
                "minutes": 0.0,
                "trend": 0.0,
            },
        )
        d["attempts"] += 1
        d["minutes"] += a.minutes
    for e in lr.evidence:
        if now_ms - e.ts <= days * DAY_MS and e.concept in CONCEPTS:
            ar = CONCEPTS[e.concept].area
            d = by.setdefault(
                ar,
                {
                    "area": ar,
                    "label": AREA_LABELS.get(ar, ar),
                    "attempts": 0,
                    "minutes": 0.0,
                    "trend": 0.0,
                },
            )
            d["trend"] += e.p_after - e.p_before
    for d in by.values():
        d["minutes"] = round(d["minutes"], 1)
        d["trend"] = round(d["trend"], 3)
    return sorted(by.values(), key=lambda d: -d["minutes"])


def weaknesses_with_evidence(lr: Learner) -> list[dict[str, Any]]:
    """Weak concepts and recurring mistakes, each with the attempts that show it."""
    out = []
    for mid, ms in sorted(lr.misconceptions.items(), key=lambda kv: -kv[1].count):
        if mid not in MISCONCEPTIONS:
            continue
        ev = [_evidence_link(a) for a in lr.attempts if mid in a.misconceptions]
        out.append(
            {
                "kind": "mistake",
                "id": mid,
                "label": MISCONCEPTIONS[mid].label,
                "count": ms.count,
                "recurring": ms.recurring,
                "evidence": ev[-5:],
            }
        )
    for cid, st in sorted(lr.concepts.items(), key=lambda kv: kv[1].p):
        if st.opportunities >= 2 and st.p < 0.5 and cid in CONCEPTS:
            ev = [
                _evidence_link(a)
                for a in lr.attempts
                if a.problem in BANK and cid in BANK[a.problem].concepts
            ]
            out.append(
                {
                    "kind": "concept",
                    "id": cid,
                    "label": CONCEPTS[cid].label,
                    "mastery": round(st.p, 2),
                    "evidence": ev[-5:],
                }
            )
    return out[:8]


def activity_review(lr: Learner, now_ms: float) -> dict[str, Any]:
    """The whole review (module docstring), for the panel and the report."""
    problems = [
        {
            **_evidence_link(a),
            "minutes": a.minutes,
            "hints": a.hints,
            "mistakes": [MISCONCEPTIONS[m].label for m in a.misconceptions if m in MISCONCEPTIONS],
        }
        for a in lr.attempts[-30:]
    ]
    return {
        "problems": problems,
        "weaknesses": weaknesses_with_evidence(lr),
        "approach": approach_profile(lr),
        "topics": topics(lr, now_ms),
        "calibration": calibration(lr.judgments),
        "reading": [asdict(r) for r in lr.reading[-10:]],
        "mocks": [asdict(s) for s in lr.sessions if s.kind == "mock"][-4:],
    }


# =============================================================================================
# Blind spots
# =============================================================================================


@dataclass
class Insight:
    """A pattern she may not see, with evidence, confidence 0..1 and one suggestion."""

    id: str
    kind: str
    text: str
    suggestion: str
    confidence: float
    evidence: list[dict[str, Any]] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def _conf(n: int) -> float:
    return round(min(0.9, 0.35 + 0.15 * n), 2)


def blind_spots(lr: Learner, now_ms: float) -> list[Insight]:
    """Insights (module docstring), strongest first, minus those she dismissed."""
    out: list[Insight] = []
    # 1. the same mistake across different topics
    for mid in lr.misconceptions:
        atts = [a for a in lr.attempts if mid in a.misconceptions]
        areas = {_area(a.problem if a.problem in BANK else a.technique) for a in atts}
        if len(areas) >= 2 and mid in MISCONCEPTIONS:
            label = MISCONCEPTIONS[mid].label.lower()
            out.append(
                Insight(
                    f"cross_topic:{mid}",
                    "cross_topic",
                    f"The same mistake shows up in {len(areas)} different topics: {label}.",
                    "Before you finish any proof, scan once just for this.",
                    _conf(len(atts)),
                    [_evidence_link(a) for a in atts[-4:]],
                )
            )
    # 2. overconfidence (and underconfidence) by technique
    for f in calibration(lr.judgments)["flags"]:
        name = (
            CONCEPTS[f["technique"]].label.lower() if f["technique"] in CONCEPTS else f["technique"]
        )
        if f["kind"] == "over":
            out.append(
                Insight(
                    f"overconfident:{f['technique']}",
                    "overconfidence",
                    f"On {name} you've felt about {round(f['gap'] * 100)} points surer than the grades ({f['n']} proofs).",
                    "Rate your confidence again after re-reading the key step: does it change?",
                    _conf(f["n"]),
                )
            )
        else:
            out.append(
                Insight(
                    f"underconfident:{f['technique']}",
                    "underconfidence",
                    f"On {name} your proofs hold up better than you expect ({f['n']} proofs).",
                    "Commit to these sooner in timed sessions; save the doubt for the write-up check.",
                    _conf(f["n"]),
                )
            )
    # 3. time sinks
    sinks = [a for a in lr.attempts if a.minutes >= 45 and (a.score or 0) <= 2]
    if len(sinks) >= 2:
        out.append(
            Insight(
                "time_sink",
                "time_sink",
                f"{len(sinks)} attempts took 45 minutes or more and ended at 2/10 or less.",
                "In timed sessions, at 30 minutes write up what you have and switch; come back with fresh eyes.",
                _conf(len(sinks)),
                [_evidence_link(a) for a in sinks[-4:]],
            )
        )
    # 4. stalling at the same kind of step
    stall: dict[str, set[str]] = defaultdict(set)
    for e in lr.evidence:
        if e.kind == "step" and e.hesitation >= 0.6 and e.problem:
            stall[e.concept].add(e.problem)
    for c, probs in stall.items():
        if len(probs) >= 2 and c in CONCEPTS:
            ev = [_evidence_link(a) for a in lr.attempts if a.problem in probs][-4:]
            out.append(
                Insight(
                    f"stall:{c}",
                    "stall",
                    f"You pause longest at steps that use {CONCEPTS[c].label.lower()}, across {len(probs)} problems.",
                    f"Put the {CONCEPTS[c].label.lower()} fact you need on a card and review it (it's in your reviews now).",
                    _conf(len(probs)),
                    ev,
                )
            )
    # 5. avoidance: an area with no attempts in two weeks while others had some
    recent = [a for a in lr.attempts if now_ms - a.ts <= 14 * DAY_MS]
    if len(recent) >= 4:
        touched = {_area(a.problem if a.problem in BANK else a.technique) for a in recent}
        goal_areas = [t for t in lr.goals.topics if t in AREA_LABELS] or [
            "number_theory",
            "combinatorics",
            "inequalities",
            "analysis",
        ]
        for ar in goal_areas:
            if ar not in touched:
                out.append(
                    Insight(
                        f"avoid:{ar}",
                        "avoidance",
                        f"No {AREA_LABELS[ar].lower()} in the last two weeks ({len(recent)} attempts elsewhere).",
                        "One short problem from it this week keeps it from going cold.",
                        0.5,
                    )
                )
                break
    # 6. a technique never tried on problems that needed it
    used = {e.concept for e in lr.evidence if e.kind == "step"}
    missed: Counter[str] = Counter()
    for a in lr.attempts:
        if (a.score or 0) <= 2 and a.problem in BANK:
            for c in BANK[a.problem].concepts:
                if c in CONCEPTS and CONCEPTS[c].area == "techniques" and c not in used:
                    missed[c] += 1
    for c, k in missed.most_common(1):
        out.append(
            Insight(
                f"unused:{c}",
                "unused_technique",
                f"{k} problem(s) you found hard turn on {CONCEPTS[c].label.lower()}, which doesn't appear in your work yet.",
                f"Try one problem that is all {CONCEPTS[c].label.lower()}.",
                _conf(k),
            )
        )
    out = [i for i in out if lr.insight_verdicts.get(i.id) != "dismissed"]
    return sorted(out, key=lambda i: -i.confidence)
