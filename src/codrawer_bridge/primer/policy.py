"""
The Primer's policy: given both models and the moment, what to say, if anything.

**The problem.** Knowing that step 6 is wrong is not tutoring. The Primer must choose a *move*:
stay silent because the learner is mid-thought; ask a question that lets her find the gap
herself; give the next, smallest hint; show a worked example of the idea on a different problem;
affirm a sound proof and debrief what made it work. The vision is a co-thinker that "does not
talk over you while you are mid-thought" and, like Nell's Primer in *The Diamond Age*, answers
the child's own work rather than replacing it.

**The moves and when** (:func:`choose_move`):

1. ``silence`` whenever the lull detector (ink_signals.LullDetector) says the pen is down or the
   learner paused only briefly, unless she asked. Asking (``/proof``, the panel's buttons) always
   gets an answer.
2. With a gap or error to address, the target is the most serious finding (fatal before major
   before minor; wrong beliefs before missing rigor before exposition; earliest step first).
   - ``socratic``: the catalog entry's probe question, at the step where the gap bites. This is
     the default: questions that make the learner locate the gap preserve the productive
     struggle that drives learning (Kapur 2008, "Productive failure", *Cognition and
     Instruction*; Graesser, Person & Magliano 1995 on tutorial dialogue).
   - ``hint``: only when she asks for one, one rung at a time up the entry's ladder (concepts.py),
     each rung more specific: the contingent tutoring of Wood, Bruner & Ross (1976, "The role of
     tutoring in problem solving") and Wood & Middleton (1975): more help after failure, less
     after success. Exception: a misconception she has shown three or more times with mastery
     under 0.3 starts at the first rung unasked, since novices learn more from guidance than
     from unguided search (the expertise reversal effect, Kalyuga, Ayres, Chandler & Sweller
     2003, *Educational Psychologist*).
   - ``worked_example``: after the last rung, if she asks again, the idea demonstrated on a
     *different* problem (:data:`WORKED_EXAMPLES`), never her own proof completed for her. The
     Primer does not hand over a solution unprompted, ever (ADR 010).
3. With no gaps: ``debrief`` for a complete proof: the technique, the key idea, why it worked,
   and a notebook entry (practice.py); ``affirm`` when only minor or exposition notes remain,
   naming one. A step written after marked hesitation (ink signals) gets a line saying it was
   right, and why: confidence is part of mastery.

**Timed practice.** :func:`pacing_nudge` coaches triage in a 90-minute, three-problem session
(the 2026 Putnam format; practice.py): read all three early, start with the most tractable,
around the half-hour mark decide whether to write up partial progress, and keep the last ten
minutes for writing up. Nudges are delivered only at a lull.

Every move carries ``glance``: one line of at most 48 characters for the glasses.
"""

from __future__ import annotations

# ruff: noqa: E501  (catalog prose and prompt text read better unwrapped)
from dataclasses import dataclass

from .concepts import CONCEPTS, MISCONCEPTIONS
from .ink_signals import LineSignals
from .learner import Learner
from .practice import BANK
from .proofdoc import Finding, ProofDoc

GLANCE_MAX = 48
#: Ink-signal hesitation (0..1, ink_signals.hesitation_score) above which a step counts as hesitant.
HESITANT = 0.6

#: Worked examples on *other* problems, for the rung after the last hint. Our own words.
WORKED_EXAMPLES: dict[str, str] = {
    "sqrt2_no_lowest_terms": (
        "The same move on √3: suppose √3 = a/b with gcd(a, b) = 1 (every rational can be reduced). "
        "Then a² = 3b², so 3 | a; write a = 3c, then b² = 3c², so 3 | b. Now 3 divides both a and b, "
        "which contradicts gcd(a, b) = 1. The contradiction exists only because the gcd was assumed at the start."
    ),
    "induction_no_hypothesis": (
        "On 1 + 2 + ⋯ + n = n(n+1)/2: assume it for k. Then 1 + ⋯ + k + (k+1) = k(k+1)/2 + (k+1), using the "
        "assumption for the first k terms, and that equals (k+1)(k+2)/2. The hypothesis does the work of the first k terms."
    ),
    "converse_confusion": (
        "'If n is divisible by 4 then n is even' is true; its converse 'if n is even then n is divisible by 4' fails at n = 6. "
        "A proof may use only the direction that has been proved."
    ),
    "quantifier_swap": (
        "'For every x there is y with y > x' is true for integers (take y = x+1); 'there is y with y > x for every x' is false. "
        "Same words, swapped order, different claim."
    ),
    "square_parity_unproved": (
        "To show n² odd ⇒ n odd, prove the contrapositive: if n is even, n = 2k, then n² = 4k² is even. One line, and it closes the gap."
    ),
}


#: One-line versions of the probes, for the glasses (at most 48 characters with the prefix).
GLANCES: dict[str, str] = {
    "sqrt2_no_lowest_terms": "why is 'both even' a contradiction?",
    "square_parity_unproved": "why does p² even give p even?",
    "induction_no_hypothesis": "where do you use the case k?",
    "induction_no_base": "what about the first n?",
    "assumes_conclusion": "is step {step} using the goal?",
    "converse_confusion": "which direction does step {step} need?",
    "quantifier_swap": "check the quantifier order",
    "no_conclusion": "say what you proved",
}


def _glance(text: str) -> str:
    text = " ".join(text.split())
    return text if len(text) <= GLANCE_MAX else text[: GLANCE_MAX - 1].rstrip() + "…"


@dataclass
class Move:
    """A chosen move (docs/protocol.md ``move``). ``finding`` is the catalog id it addresses."""

    kind: str
    text: str = ""
    glance: str = ""
    step: int = 0
    hint_level: int = 0
    finding: str | None = None

    def to_dict(self) -> dict:
        return {
            "kind": self.kind,
            "text": self.text,
            "glance": self.glance,
            "step": self.step,
            "hint_level": self.hint_level,
            "finding": self.finding,
        }


@dataclass
class HintState:
    """Where she is on the ladder for one target (a finding id on one proof)."""

    target: str | None = None
    level: int = 0


_KIND_RANK = {"misconception": 0, "missing_rigor": 1, "exposition": 2}
_SEV_RANK = {"fatal": 0, "major": 1, "minor": 2}


def target_finding(findings: list[Finding]) -> Finding | None:
    """
    The finding to address first: by severity, then kind, then the step where it bites (for an
    entry seen at several steps, the last of them: the lowest-terms gap is felt at the
    "contradiction", where the probe can ask about it).
    """
    if not findings:
        return None
    last_step: dict[str, int] = {}
    for f in findings:
        last_step[f.id] = max(last_step.get(f.id, 0), f.step)
    uniq = {f.id: Finding(f.id, last_step[f.id], f.detail) for f in findings}
    return min(
        uniq.values(),
        key=lambda f: (
            _SEV_RANK[MISCONCEPTIONS[f.id].severity],
            _KIND_RANK[MISCONCEPTIONS[f.id].kind],
            f.step,
        ),
    )


def choose_move(
    doc: ProofDoc,
    learner: Learner,
    *,
    request: str = "auto",
    lull: str = "lull",
    hints: HintState | None = None,
    signals: dict[int, LineSignals] | None = None,
) -> Move:
    """
    The next move (module docstring). ``request`` is ``auto`` (a lull, nobody asked), ``proof``
    or ``hint``; ``lull`` is the detector's state; ``hints`` is updated in place when a hint is
    given; ``signals`` maps step numbers to their ink signals.
    """
    hints = hints if hints is not None else HintState()
    if request == "auto" and lull != "lull":
        return Move("silence")
    if not doc.steps:
        text = (
            "I can't read this page in offline mode: no model key is configured, and this ink is not one of the fixtures."
            if doc.source.startswith("offline")
            else "I don't see a proof on the page yet. Write one, then ask me to read it."
        )
        return Move(
            "notice",
            text,
            _glance(
                "Primer: can't read this page offline"
                if doc.source.startswith("offline")
                else "Primer: no proof on the page yet"
            ),
        )

    target = target_finding(doc.findings)
    if target is not None:
        entry = MISCONCEPTIONS[target.id]
        if hints.target != target.id:
            hints.target, hints.level = target.id, 0
        seen = learner.misconceptions.get(target.id)
        weakest = min(entry.concepts, key=learner.mastery)
        struggling = seen is not None and seen.count >= 3 and learner.mastery(weakest) < 0.3
        if request == "hint" or (struggling and hints.level == 0):
            if hints.level < len(entry.hints):
                hints.level += 1
                text = entry.hints[hints.level - 1]
                return Move(
                    "hint",
                    text,
                    _glance(f"Hint {hints.level}: {text}"),
                    target.step,
                    hints.level,
                    target.id,
                )
            example = WORKED_EXAMPLES.get(target.id)
            if example and hints.level == len(entry.hints):
                hints.level += 1
                return Move(
                    "worked_example",
                    example,
                    _glance("Primer: a worked example, on another problem"),
                    target.step,
                    hints.level,
                    target.id,
                )
            return Move(
                "hint",
                "That was the last hint for this step. Try rewriting it, and ask me to read it again.",
                _glance("Primer: last hint given; try it now"),
                target.step,
                hints.level,
                target.id,
            )
        probe = entry.probe.replace("{step}", str(target.step or 1))
        short = GLANCES.get(target.id, "look again at step {step}").replace(
            "{step}", str(target.step or 1)
        )
        return Move("socratic", probe, _glance("Primer: " + short), target.step, 0, target.id)

    hints.target, hints.level = None, 0
    hes_step = None
    if signals:
        hes = [
            (sig.hesitation, n)
            for n, sig in signals.items()
            if sig.hesitation >= HESITANT and doc.step(n) and doc.step(n).status == "ok"
        ]  # type: ignore[union-attr]
        if hes:
            hes_step = max(hes)[1]
    grade = doc.grade
    if grade is not None and grade.score >= 10:
        problem = BANK.get(doc.problem or "")
        technique = CONCEPTS[doc.technique].label if doc.technique in CONCEPTS else doc.technique
        key = (
            problem.key_idea
            if problem and problem.key_idea
            else (CONCEPTS[doc.technique].blurb if doc.technique in CONCEPTS else "")
        )
        text = f"Complete. Technique: {technique}. The key idea: {key}"
        if hes_step:
            text += (
                f" You paused before step {hes_step}; it was right, so trust that move next time."
            )
        return Move("debrief", text, _glance(f"Primer: complete: {technique}"), 0, 0, None)
    minor = [f for f in doc.findings]
    note = MISCONCEPTIONS[minor[0].id].label.lower() if minor else "nothing major"
    text = f"The argument holds. One thing a grader would note: {note}."
    if hes_step:
        text += f" Step {hes_step}, where you hesitated, is right."
    return Move(
        "affirm",
        text,
        _glance("Primer: the argument holds"),
        minor[0].step if minor else 0,
        0,
        minor[0].id if minor else None,
    )


def pacing_nudge(
    elapsed_min: float, finished: int, session_min: int = 90, problems: int = 3
) -> str | None:
    """
    A triage nudge for a timed session, or None. ``elapsed_min`` since the start, ``finished``
    problems she has written up completely. Checkpoints: 5 min (choose), 30 and 60 (move on or
    write up partial progress if stuck), ``session_min − 10`` (write up now).
    """
    if elapsed_min >= session_min - 10:
        return "Ten minutes left: write up your partial progress cleanly. Rigorous partial work scores."
    if elapsed_min >= 60 and finished < 2:
        return "An hour in: if the current problem isn't converging, write up what you have and switch."
    if elapsed_min >= 30 and finished < 1:
        return "Half an hour in: is this the most tractable of the three? If not, note your ideas and switch."
    if 4 <= elapsed_min < 6 and finished == 0:
        return "You've seen all three: start with the one you're most likely to finish."
    return None
