"""
Recognition: handwriting to a structured proof, by rendering the ink and asking Claude to read it.

**The problem.** The learner writes a proof by hand; the Primer needs it as a ProofDoc
(proofdoc.py): steps with LaTeX, the reasons given, references between steps, the technique,
and which ink each step came from, with a confidence per step. Handwriting recognition for
mathematics is hard to do locally and well; a multimodal model reads a rendered page well, and
ADR 002 already settled that drawings reach a model as images rendered from the stroke store,
never from a screenshot.

**How it works.**

1. :func:`render_for_recognition` draws the page's user ink (ink_signals.InkLog) to a PNG, cropped
   to the ink with a margin, at most 1568 px on the long side (beyond that the API downsamples).
   Each handwriting line (ink_signals.segment_lines) gets a small grey label ``L1``, ``L2``… in a
   left margin, so the model can say which lines a step was read from; that is how steps are tied
   back to strokes (:func:`link_ink`) for the panel's tap-to-highlight.
2. :class:`LiveRecognizer` sends the PNG and a short instruction to a Claude model with the
   Anthropic Python SDK and a JSON schema (structured outputs), so the reply is a ProofDoc-shaped
   object: steps (LaTeX, plain text, justification, refs, concept ids from the task model,
   confidence, lines), findings (misconception ids from the catalog, concepts.py), a Putnam-style
   grade estimate, and optionally a Lean 4 formalization of the learner's own steps (check.py runs
   it when a prover is installed). The model is ``$CODRAWER_PRIMER_MODEL`` (default
   ``claude-opus-5-5``) at effort ``$CODRAWER_PRIMER_EFFORT`` (default ``high``), with the
   server-side refusal fallback on. The key comes from ``ANTHROPIC_API_KEY`` through the SDK; it is
   never logged or stored here.
3. :class:`OfflineRecognizer` runs with no key: it matches the ink against the fixture recordings
   (``fixtures/*.jsonl``, by stroke ids) and returns the hand-written transcription of the one that
   matches, labelled ``offline:<fixture>``. Ink it does not recognize gets an empty ProofDoc and an
   honest "offline: cannot read new handwriting without a model" message, never a guess.

**What reaches the model** (ADR 010, "Privacy"): the rendered PNG of the user's ink on this page
(no other layers, no names), the number of labelled lines, the problem statement when the coach
assigned a known problem, and the fixed catalogs of concept and misconception ids. Never the
learner file, the learner's name, earlier turns, or the page's document title.
"""

from __future__ import annotations

# ruff: noqa: E501  (catalog prose and prompt text read better unwrapped)
import base64
import io
import json
import os
from dataclasses import dataclass
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

from .concepts import CONCEPTS, MISCONCEPTIONS
from .ink_signals import InkLog, InkStroke, Line, segment_lines
from .proofdoc import Finding, Grade, ProofDoc, Step

FIXTURES = Path(__file__).parent / "fixtures"
DEFAULT_MODEL = "claude-opus-5-5"
MAX_SIDE = 1568
PAGE_W, PAGE_H = 1620, 2160


class RecognitionError(RuntimeError):
    """The model declined, the reply was not the schema, or the API failed (message says which)."""


# =============================================================================================
# Rendering
# =============================================================================================


def render_for_recognition(
    strokes: list[InkStroke], lines: list[Line], max_side: int = MAX_SIDE
) -> bytes:
    """
    PNG of ``strokes`` cropped to their bounds (plus 4 % of the page as margin), black ink on
    white, pressure-weighted width, with a 70 px left gutter holding the line labels ``L1``…
    vertically centred on each line. Coordinates are normalized page coordinates; the crop keeps
    the page's aspect between x and y (Paper Pro 1620 × 2160).
    """
    if not strokes:
        img = Image.new("L", (400, 200), 255)
        bio = io.BytesIO()
        img.save(bio, format="PNG")
        return bio.getvalue()
    xs = [p[0] for s in strokes for p in s.pts]
    ys = [p[1] for s in strokes for p in s.pts]
    m = 0.04
    x0, x1 = max(0.0, min(xs) - m), min(1.0, max(xs) + m)
    y0, y1 = max(0.0, min(ys) - m * PAGE_W / PAGE_H), min(1.0, max(ys) + m * PAGE_W / PAGE_H)
    w_units, h_units = (x1 - x0) * PAGE_W, (y1 - y0) * PAGE_H
    gutter = 70
    scale = min((max_side - gutter) / max(w_units, 1), max_side / max(h_units, 1), 1.5)
    W, H = int(w_units * scale) + gutter, int(h_units * scale)
    img = Image.new("L", (W, H), 255)
    draw = ImageDraw.Draw(img)

    def px(x: float, y: float) -> tuple[float, float]:
        return (gutter + (x - x0) * PAGE_W * scale, (y - y0) * PAGE_H * scale)

    for s in strokes:
        prev = None
        for p in s.pts:
            cur = px(p[0], p[1])
            pr = p[2] if len(p) >= 3 else 0.6
            if prev is not None:
                draw.line([prev, cur], fill=0, width=max(2, int((1.5 + 3.5 * pr) * scale)))
            prev = cur
    draw.line([(gutter - 8, 0), (gutter - 8, H)], fill=225, width=1)
    label_font = ImageFont.load_default(size=22)
    for ln in lines:
        cy = px(0, (ln.bbox[1] + ln.bbox[3]) / 2)[1]
        draw.text((6, cy - 12), f"L{ln.n}", fill=120, font=label_font)
    bio = io.BytesIO()
    img.save(bio, format="PNG", optimize=True)
    return bio.getvalue()


def link_ink(doc: ProofDoc, lines: list[Line]) -> None:
    """Fill each step's ``strokes`` and ``bbox`` from the lines it was read from."""
    by_n = {ln.n: ln for ln in lines}
    for s in doc.steps:
        ls = [by_n[n] for n in s.lines if n in by_n]
        s.strokes = [sid for ln in ls for sid in ln.strokes]
        if ls:
            s.bbox = [
                min(ln.bbox[0] for ln in ls),
                min(ln.bbox[1] for ln in ls),
                max(ln.bbox[2] for ln in ls),
                max(ln.bbox[3] for ln in ls),
            ]


# =============================================================================================
# The live path: Claude reads the page
# =============================================================================================


def _schema() -> dict:
    """The structured-output schema: a ProofDoc as the model returns it (all fields required)."""
    step = {
        "type": "object",
        "properties": {
            "n": {"type": "integer"},
            "latex": {"type": "string"},
            "text": {"type": "string"},
            "justification": {"type": "string"},
            "refs": {"type": "array", "items": {"type": "integer"}},
            "concepts": {"type": "array", "items": {"type": "string", "enum": sorted(CONCEPTS)}},
            "confidence": {"type": "number"},
            "lines": {"type": "array", "items": {"type": "integer"}},
        },
        "required": [
            "n",
            "latex",
            "text",
            "justification",
            "refs",
            "concepts",
            "confidence",
            "lines",
        ],
        "additionalProperties": False,
    }
    finding = {
        "type": "object",
        "properties": {
            "id": {"type": "string", "enum": sorted(MISCONCEPTIONS)},
            "step": {"type": "integer"},
            "detail": {"type": "string"},
        },
        "required": ["id", "step", "detail"],
        "additionalProperties": False,
    }
    grade = {
        "type": "object",
        "properties": {
            "score": {"type": "integer"},
            "band": {"type": "string", "enum": ["complete", "minor_flaws", "partial", "none"]},
            "rigor": {"type": "string"},
            "exposition": {"type": "string"},
        },
        "required": ["score", "band", "rigor", "exposition"],
        "additionalProperties": False,
    }
    return {
        "type": "object",
        "properties": {
            "title": {"type": "string"},
            "goal": {"type": "string"},
            "technique": {"type": "string", "enum": sorted(CONCEPTS)},
            "steps": {"type": "array", "items": step},
            "findings": {"type": "array", "items": finding},
            "grade": grade,
            "formal": {"type": "string"},
        },
        "required": ["title", "goal", "technique", "steps", "findings", "grade", "formal"],
        "additionalProperties": False,
    }


def _system_prompt() -> str:
    concepts = "\n".join(f"- {c.id}: {c.label}" for c in CONCEPTS.values())
    mis = "\n".join(
        f"- {m.id} ({m.kind}, {m.severity}): {m.label}" for m in MISCONCEPTIONS.values()
    )
    return f"""You read a learner's handwritten mathematical proof from an image of their pen strokes and return it as structured data, for a tutor that will respond to them.

Transcription:
- Transcribe what is written, faithfully. Never correct, complete or improve the proof; a missing assumption stays missing. If a symbol is illegible, give your best reading and lower that step's confidence.
- Split the proof into logical steps in the order written. For each: `latex` is the mathematics re-typeset in KaTeX-compatible LaTeX without $ delimiters (use \\text{{}} for words inside math); `text` is a plain-language reading of the whole step; `justification` is the reason the learner wrote for it, or "" if none; `refs` are earlier step numbers it relies on; `concepts` are ids from the list below; `confidence` in 0..1 is how sure you are of the transcription; `lines` are the line labels (L1, L2, ... in the left margin; give the numbers) the step was written on.
- `title` names the claim; `goal` states it in LaTeX; `technique` is the main proof technique's concept id.

Assessment (the tutor shows it as an estimate):
- `findings`: problems a careful grader would mark, each with an id from the catalog below, the step number where it occurs (0 for the whole proof) and a one-line detail. Use only catalog ids; if nothing applies, return an empty list. Missing rigor matters: a true claim used without proof, or a needed hypothesis never stated, is a finding.
- `grade`: estimate the score a Putnam grader would give out of 10. Graders mostly give 10 (complete and rigorous), 8-9 (complete, minor flaw), 1-2 (substantial progress, not a complete proof), or 0. `rigor` and `exposition` are one sentence each, addressed to the learner.
- `formal`: if the proof is short and elementary, a Lean 4 file (core Lean only, no Mathlib imports) that formalizes the learner's steps as written, as a sequence of `have` statements, so that a gap in their argument makes the file fail to check. Never use `sorry` or `admit`. Otherwise "".

Concept ids:
{concepts}

Misconception catalog:
{mis}
"""


@dataclass
class LiveConfig:
    model: str = DEFAULT_MODEL
    effort: str = "high"
    max_tokens: int = 16000

    @staticmethod
    def from_env() -> LiveConfig:
        return LiveConfig(
            model=os.environ.get("CODRAWER_PRIMER_MODEL") or DEFAULT_MODEL,
            effort=os.environ.get("CODRAWER_PRIMER_EFFORT") or "high",
        )


def live_available() -> bool:
    """A key is configured (only ``ANTHROPIC_API_KEY`` is consulted, never printed)."""
    return bool(os.environ.get("ANTHROPIC_API_KEY"))


class LiveRecognizer:
    """Reads ink with a Claude model (module docstring). One API call per reading."""

    mode = "live"

    def __init__(self, config: LiveConfig | None = None) -> None:
        self.config = config or LiveConfig.from_env()

    def recognize(self, log: InkLog, problem_statement: str | None = None) -> ProofDoc:
        import anthropic  # imported here so offline use needs no network stack

        ink = log.ink()
        lines = segment_lines(ink)
        png = render_for_recognition(ink, lines)
        ask = f"The page has {len(lines)} labelled lines of handwriting. Read the proof."
        if problem_statement:
            ask += f"\nThe problem it answers: {problem_statement}"
        client = anthropic.Anthropic()
        try:
            resp = client.beta.messages.create(
                model=self.config.model,
                max_tokens=self.config.max_tokens,
                betas=["server-side-fallback-2026-07-01"],
                fallbacks="default",
                system=_system_prompt(),
                output_config={
                    "effort": self.config.effort,
                    "format": {"type": "json_schema", "schema": _schema()},
                },
                messages=[
                    {
                        "role": "user",
                        "content": [
                            {
                                "type": "image",
                                "source": {
                                    "type": "base64",
                                    "media_type": "image/png",
                                    "data": base64.standard_b64encode(png).decode("ascii"),
                                },
                            },
                            {"type": "text", "text": ask},
                        ],
                    }
                ],
            )
        except anthropic.APIStatusError as e:
            raise RecognitionError(f"API error {e.status_code}") from e
        except anthropic.APIConnectionError as e:
            raise RecognitionError("could not reach the API") from e
        if resp.stop_reason == "refusal":
            raise RecognitionError("the model declined to read this page")
        if resp.stop_reason == "max_tokens":
            raise RecognitionError("the reading was cut off (max_tokens)")
        text = next((b.text for b in resp.content if b.type == "text"), "")
        try:
            data = json.loads(text)
        except json.JSONDecodeError as e:
            raise RecognitionError("the reply was not valid JSON") from e
        doc = ProofDoc(
            title=data["title"],
            goal=data["goal"],
            technique=data["technique"],
            steps=[Step(**s) for s in data["steps"]],
            findings=[Finding(**f) for f in data["findings"]],
            grade=Grade(**data["grade"]),
            source=f"live:{resp.model}",
            formal=data.get("formal") or None,
        )
        link_ink(doc, lines)
        return doc


# =============================================================================================
# The offline path: fixture transcriptions
# =============================================================================================


def fixture_names() -> list[str]:
    return sorted(p.name[: -len(".transcript.json")] for p in FIXTURES.glob("*.transcript.json"))


def load_recording(path: Path) -> list[dict]:
    """Messages of a JSONL recording (``{"ts", "msg"}`` lines, or bare messages)."""
    out = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.strip():
            o = json.loads(line)
            out.append(o.get("msg", o) if isinstance(o, dict) else o)
    return out


def load_fixture(name: str) -> ProofDoc:
    """The hand-written transcription of fixture ``name``, with its Lean file when there is one."""
    doc = ProofDoc.from_dict(
        json.loads((FIXTURES / f"{name}.transcript.json").read_text(encoding="utf-8"))
    )
    lean = FIXTURES / f"{name}.lean"
    if lean.exists():
        doc.formal = lean.read_text(encoding="utf-8")
    doc.source = f"offline:{name}"
    return doc


class OfflineRecognizer:
    """
    Returns fixture transcriptions for fixture ink (module docstring). A fixture matches when at
    least 60 % of the page's stroke ids are that recording's (Jaccard ≥ 0.6), so a replayed
    fixture is recognized even after a few strokes of the learner's own.
    """

    mode = "offline"

    def __init__(self) -> None:
        self._ids: dict[str, set[str]] = {}
        for name in fixture_names():
            rec = FIXTURES / f"{name}.jsonl"
            if rec.exists():
                self._ids[name] = {
                    m["id"]
                    for m in load_recording(rec)
                    if m.get("t") == "stroke_begin" and m.get("layer", "user") != "ai"
                }

    def match(self, log: InkLog) -> str | None:
        ids = {s.id for s in log.ink()}
        best, score = None, 0.0
        for name, fx in self._ids.items():
            j = len(ids & fx) / max(1, len(ids | fx))
            if j > score:
                best, score = name, j
        return best if score >= 0.6 else None

    def recognize(self, log: InkLog, problem_statement: str | None = None) -> ProofDoc:
        name = self.match(log)
        if name is None:
            return ProofDoc(title="", goal="", technique="", steps=[], source="offline:none")
        doc = load_fixture(name)
        link_ink(doc, segment_lines(log.ink()))
        return doc


def make_recognizer(mode: str = "auto"):
    """``live`` when asked or (``auto``) when a key is set, else ``offline``."""
    if mode == "live" or (mode == "auto" and live_available()):
        return LiveRecognizer()
    return OfflineRecognizer()
