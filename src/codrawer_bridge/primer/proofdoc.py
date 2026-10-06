"""
ProofDoc: a handwritten proof as structured data, the one shape every Primer stage shares.

Recognition (recognize.py) turns ink into a ProofDoc; assessment (assess.py) annotates its steps
and adds findings and a grade estimate; latex.py typesets it; check.py may attach a prover
verdict; the router sends it to clients inside a ``primer`` message (docs/protocol.md). Keeping
it typed and serializable here means the fixture files (``fixtures/*.proof.json``), a live model's
structured output and the wire format are the same document, so a test on a fixture tests the
path a live reading takes.

Units: ``bbox`` is in normalized page coordinates ``[x0, y0, x1, y1]`` (0..1 of the page's width
and height, origin top-left, the protocol's frame). ``lines`` are 1-based indices into the
ink's line segmentation (ink_signals.segment_lines), which is how a step is tied to its strokes.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any

#: A step's assessment: sound, a gap a grader would mark, wrong, or not legible enough to judge.
STEP_STATUSES = ("ok", "gap", "error", "unclear")


@dataclass
class Step:
    """
    One logical step of the proof as the learner wrote it (never as the Primer would have).

    ``latex`` is KaTeX-safe math with no ``$`` delimiters; ``text`` is a plain reading of the
    whole step; ``justification`` the reason the learner wrote, ``""`` when none. ``refs`` are
    earlier step numbers the step uses; ``concepts`` concept ids (concepts.py). ``confidence``
    is the recognizer's 0..1 belief that the transcription is what was written. ``lines`` tie the
    step to ink lines; ``strokes`` and ``bbox`` are filled from them (recognize.link_ink).
    """

    n: int
    latex: str
    text: str
    justification: str = ""
    refs: list[int] = field(default_factory=list)
    concepts: list[str] = field(default_factory=list)
    confidence: float = 1.0
    lines: list[int] = field(default_factory=list)
    status: str = "ok"
    note: str = ""
    strokes: list[str] = field(default_factory=list)
    bbox: list[float] | None = None


@dataclass
class Finding:
    """A misconception entry (concepts.MISCONCEPTIONS) seen at a step (0 = the whole proof)."""

    id: str
    step: int = 0
    detail: str = ""


@dataclass
class Grade:
    """
    A Putnam-style score estimate for the write-up: ``score`` of 10, the grader's band, and
    one-line comments on rigor and exposition. Always an estimate (ADR 010): no model or rule
    set here is a Putnam grader.
    """

    score: int
    band: str
    rigor: str = ""
    exposition: str = ""
    max: int = 10
    estimate: bool = True


@dataclass
class Check:
    """
    A formal check's outcome. ``status`` is ``checked`` only after a prover run exited cleanly
    on a file with no ``sorry``/``admit``; ``failed`` when it ran and rejected the file;
    ``not_checked`` when no prover or no formalization was available (``detail`` says which).
    ``source`` says where the formalization came from (``fixture``, ``model``).
    """

    prover: str | None
    status: str
    detail: str = ""
    source: str | None = None


@dataclass
class ProofDoc:
    """
    A whole proof: what it proves (``title``, ``goal`` in LaTeX), the main ``technique`` (a
    concept id), the ``steps``, and, once assessed, ``findings`` and ``grade``. ``problem`` is
    the practice-bank id when the proof answers a known problem (practice.py). ``source`` is
    ``live:<model>`` or ``offline:<fixture>``; ``formal`` is a prover-ready formalization (Lean 4)
    when one exists.
    """

    title: str
    goal: str
    technique: str
    steps: list[Step]
    problem: str | None = None
    findings: list[Finding] = field(default_factory=list)
    grade: Grade | None = None
    check: Check | None = None
    source: str = ""
    formal: str | None = None
    #: The literal transcription of everything written, before any structuring (the envelope's
    #: ``received_text``, after smart_remarkable): what the model saw, for audit and the eval.
    received_text: str = ""
    #: What the ink is: ``proof``, ``computation``, ``diagram`` or ``other``.
    kind: str = "proof"

    # ── Serialization ────────────────────────────────────────────────────────────────────────

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @staticmethod
    def from_dict(d: dict[str, Any]) -> ProofDoc:
        """Build from a dict (a fixture file or a model's JSON); unknown keys are ignored."""

        def pick(cls, src: dict[str, Any]):
            names = cls.__dataclass_fields__.keys()
            return cls(**{k: v for k, v in src.items() if k in names})

        steps = []
        for i, s in enumerate(d.get("steps") or [], start=1):
            s = dict(s)
            s.setdefault("n", i)
            steps.append(pick(Step, s))
        return ProofDoc(
            title=str(d.get("title") or ""),
            goal=str(d.get("goal") or ""),
            technique=str(d.get("technique") or ""),
            steps=steps,
            problem=d.get("problem"),
            findings=[pick(Finding, f) for f in d.get("findings") or []],
            grade=pick(Grade, d["grade"]) if d.get("grade") else None,
            check=pick(Check, d["check"]) if d.get("check") else None,
            source=str(d.get("source") or ""),
            formal=d.get("formal"),
            received_text=str(d.get("received_text") or ""),
            kind=str(d.get("kind") or "proof"),
        )

    def step(self, n: int) -> Step | None:
        return next((s for s in self.steps if s.n == n), None)
