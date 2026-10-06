"""
Assessment: what is wrong or missing in a transcribed proof, and what a grader would give it.

**The problem.** Recognition (recognize.py) says what was written; the Primer must say whether it
proves the claim. Two sources can annotate a ProofDoc:

- a **live model** reads the page and returns findings and a grade with the transcription (the
  schema in recognize.py asks for misconception ids from concepts.MISCONCEPTIONS, so its answers
  land on the learner model's entries); :func:`validate_findings` drops ids it invented;
- the **offline detector** here, a small set of structural rules over the steps, for the
  fixture proofs and for running without a key. It knows the shapes of the onboarding proofs
  (irrationality by contradiction, induction) and the generic exposition checks, nothing more,
  and says so: its findings are marked ``detail: "offline rule"``.

**Grading like a Putnam grader** (ADR 010, "Assessment"). Each Putnam problem is scored out of
10, and graders award mostly 0, 1, 2, 8, 9 or 10: a complete, rigorous solution earns 10, a
complete one with a minor flaw 8 or 9, substantial progress without a complete argument 1 or 2,
and scores from 3 to 7 are rare. :func:`grade` follows that spirit: any fatal finding caps the
score at partial credit (1–2 by how much of the argument stands); one major gap gives 8; two or
more major gaps fall to partial credit; minor gaps cost a point each down to 8. The comments
address rigor (what a grader would mark) and exposition (whether a grader could follow it)
separately. The result is always labelled an estimate: no rule set and no model call here is a
grader, and the panel says so.

Step statuses (proofdoc.STEP_STATUSES) are set from findings: a ``misconception`` or a fatal
``missing_rigor`` marks its step ``error``; other ``missing_rigor`` marks ``gap``; ``exposition``
leaves the status and adds a note.
"""

from __future__ import annotations

import re

from .concepts import MISCONCEPTIONS
from .proofdoc import Finding, Grade, ProofDoc, Step

# =============================================================================================
# The offline detector
# =============================================================================================


def _txt(s: Step) -> str:
    return f"{s.text} {s.latex} {s.justification}".lower()


def _has(s: Step, *words: str) -> bool:
    t = _txt(s)
    return any(w in t for w in words)


LOWEST_TERMS = MISCONCEPTIONS["sqrt2_no_lowest_terms"].signals
_EVEN_BOTH = (
    "both even",
    "both are even",
    "common factor",
    "2 divides both",
    "2 | p and 2 | q",
    "p and q are even",
    "p,q even",
)


def detect_offline(doc: ProofDoc) -> list[Finding]:
    """
    Structural rules over the steps; each returns a finding with the step it belongs to. The
    rules, in order:

    1. irrationality by contradiction that ends in "both even" / "common factor" but never
       assumes lowest terms → ``sqrt2_no_lowest_terms`` at the step introducing p/q;
    2. "p² even ⇒ p even" with no reason mentioning odd squares or the contrapositive →
       ``square_parity_unproved``;
    3. induction with no base case → ``induction_no_base``; an inductive step that neither cites
       the hypothesis nor refers to the step that states it → ``induction_no_hypothesis``;
    4. a step justified by the goal itself → ``assumes_conclusion``;
    5. a last step that states no conclusion → ``no_conclusion``.
    """
    out: list[Finding] = []
    steps = doc.steps
    if not steps:
        return out
    technique = (doc.technique or "").lower()
    all_text = " ".join(_txt(s) for s in steps)

    # 1. Lowest terms
    irr = (
        "irrational" in (doc.title + doc.goal).lower()
        or "irrationality" in technique
        or any("irrationality" in s.concepts for s in steps)
    )
    if irr and not any(sig in all_text for sig in LOWEST_TERMS):
        intro = next(
            (s for s in steps if re.search(r"p\s*/\s*q|\\frac\{?p\}?\{?q\}?|tfrac\{?p", _txt(s))),
            steps[0],
        )
        out.append(
            Finding(
                "sqrt2_no_lowest_terms",
                intro.n,
                "offline rule: p/q introduced without lowest terms",
            )
        )
        end = next((s for s in reversed(steps) if _has(s, *_EVEN_BOTH)), None)
        if end is not None and end.n != intro.n:
            out.append(
                Finding(
                    "sqrt2_no_lowest_terms",
                    end.n,
                    "offline rule: 'both even' contradicts nothing assumed",
                )
            )

    # 2. p² even ⇒ p even
    for s in steps:
        t = _txt(s)
        if (
            re.search(r"p\^?2|p²", t)
            and "even" in t
            and re.search(r"(⇒|\\implies|\\rightarrow|so|hence|therefore)\s*p\s*(is\s*)?even", t)
        ):
            if not _has(s, "odd", "contrapositive", "(2k+1)", "2k+1") and not any(
                _has(steps[r - 1], "odd") for r in s.refs if 0 < r <= len(steps)
            ):
                out.append(
                    Finding(
                        "square_parity_unproved", s.n, "offline rule: p² even ⇒ p even asserted"
                    )
                )
                break

    # 3. Induction
    if "induction" in technique or any("induction" in s.concepts for s in steps):
        if not any(_has(s, "base", "n=1", "n = 1", "n=0", "n = 0", "p(1)", "p(0)") for s in steps):
            out.append(Finding("induction_no_base", 0, "offline rule: no base case"))
        hyp_steps = {
            s.n for s in steps if _has(s, "assume", "suppose", "hypothesis") and _has(s, "k")
        }
        for s in steps:
            if _has(s, "k+1", "k + 1") and s.n not in hyp_steps:
                cites = _has(s, "hypothesis", "ih", "by assumption", "inductive") or bool(
                    set(s.refs) & hyp_steps
                )
                if not cites:
                    out.append(
                        Finding(
                            "induction_no_hypothesis",
                            s.n,
                            "offline rule: step to k+1 does not use the hypothesis",
                        )
                    )
                break

    # 4. Assumes the conclusion
    for s in steps[:-1]:
        if re.search(
            r"\b(what we want|to be proved|to prove|the goal|the claim)\b", s.justification.lower()
        ):
            out.append(Finding("assumes_conclusion", s.n, "offline rule: justified by the goal"))
            break

    # 5. Conclusion
    last = steps[-1]
    if not _has(
        last,
        "contradiction",
        "therefore",
        "hence",
        "thus",
        "so ",
        "∎",
        "qed",
        "\\blacksquare",
        "proved",
        "irrational",
        "=",
    ):
        out.append(Finding("no_conclusion", last.n, "offline rule: no concluding statement"))
    return out


# =============================================================================================
# Applying findings, and the grade
# =============================================================================================


def validate_findings(findings: list[Finding], doc: ProofDoc) -> list[Finding]:
    """Keep findings with catalog ids and step numbers that exist (0 = the whole proof)."""
    steps = {s.n for s in doc.steps}
    return [f for f in findings if f.id in MISCONCEPTIONS and (f.step == 0 or f.step in steps)]


def apply_findings(doc: ProofDoc, findings: list[Finding]) -> None:
    """
    Set step statuses and notes from findings (module docstring); the steps' text stays as
    written. A fatal ``missing_rigor`` entry seen at several steps is a ``gap`` where it opens
    (the first such step, e.g. p/q introduced without lowest terms) and an ``error`` where it
    bites (the "contradiction" that is no contradiction).
    """
    opens: dict[str, int] = {}
    for f in findings:
        opens.setdefault(f.id, f.step)
    for f in findings:
        m = MISCONCEPTIONS[f.id]
        s = doc.step(f.step)
        if s is None:
            continue
        bites = m.kind == "missing_rigor" and m.severity == "fatal" and f.step != opens[f.id]
        if m.kind == "misconception" or bites:
            s.status = "error"
        elif m.kind == "missing_rigor" and s.status != "error":
            s.status = "gap"
        if not s.note:
            s.note = m.label
    doc.findings = findings


def grade(doc: ProofDoc, findings: list[Finding]) -> Grade:
    """A Putnam-style estimate from the findings (module docstring). Always ``estimate=True``."""
    if not doc.steps:
        return Grade(0, "none", "Nothing to grade yet.", "")
    ids = list(dict.fromkeys(f.id for f in findings))
    entries = [MISCONCEPTIONS[i] for i in ids]
    fatal = [m for m in entries if m.severity == "fatal"]
    major = [m for m in entries if m.severity == "major"]
    minor = [m for m in entries if m.severity == "minor"]
    sound = sum(1 for s in doc.steps if s.status == "ok") / len(doc.steps)
    if fatal:
        score = 2 if sound >= 0.5 else 1
    elif len(major) >= 2:
        score = 2
    elif major:
        score = 8
    else:
        score = max(8, 10 - len([m for m in minor if m.kind != "exposition"]))
    band = (
        "complete"
        if score == 10
        else "minor_flaws"
        if score >= 8
        else "partial"
        if score >= 1
        else "none"
    )
    rigor_issues = [m.label.lower() for m in fatal + major + minor if m.kind != "exposition"]
    expo_issues = [m.label.lower() for m in entries if m.kind == "exposition"]
    rigor = (
        "No gaps found."
        if not rigor_issues
        else "A grader would mark: " + "; ".join(rigor_issues) + "."
    )
    if fatal:
        rigor += (
            " As written the argument does not prove the claim, so this is partial credit at best."
        )
    exposition = (
        "Clear and followable."
        if not expo_issues
        else "Exposition: " + "; ".join(expo_issues) + "."
    )
    return Grade(score=score, band=band, rigor=rigor, exposition=exposition)


def assess(doc: ProofDoc, use_model_findings: bool = False) -> ProofDoc:
    """
    Annotate ``doc`` in place: findings (the model's, validated, when ``use_model_findings``; else
    the offline detector's), step statuses and notes, and a grade estimate (the model's when it
    gave one and ``use_model_findings``; else :func:`grade`). Returns ``doc``.
    """
    if use_model_findings:
        findings = validate_findings(doc.findings, doc)
    else:
        findings = detect_offline(doc)
    doc.findings = []
    apply_findings(doc, findings)
    if not (use_model_findings and doc.grade is not None):
        doc.grade = grade(doc, findings)
    else:
        doc.grade.estimate = True
    return doc
