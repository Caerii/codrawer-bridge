"""
A scored evaluation of the Primer's recognition and grading, with fixtures and a regression gate.

**The problem.** A tutor that misreads a step or mis-grades a proof does harm quietly. The study of
smart_remarkable (docs/investigations/smart-remarkable-integration.md §1.5, §3.7) found its
evaluation to be a gallery: inputs run through models and composited for a human to look at, with
no expected outputs, no scores and no gate. This module is the scored version for the Primer:
every case has an expected answer, every run produces numbers, and the numbers gate.

**Cases.**

- *Recognition* (``recognize``): the three stroke fixtures (``primer/fixtures/*.jsonl``) with
  their hand-written transcriptions as the gold. Scored per proof: step count, step-aligned
  LaTeX token F1, concept-id Jaccard, line-assignment Jaccard (what ties steps to ink), and
  whether a literal ``received_text`` came back.
- *Grading* (``grade``): the stroke fixtures' expectations (``*.expected.json``) plus
  transcript-only cases in ``tests/fixtures/eval/grading/*.json`` (a gold ProofDoc and the
  findings, score, band and move a careful grader and tutor would give). Scored: findings
  precision and recall by catalog id, score absolute error, band accuracy, move-kind accuracy.

**Modes.**

- ``offline``: no network. Recognition uses the fixture recognizer, so its scores check the
  pipeline (rendering, linking, matching) rather than a model; grading runs the offline rules
  (assess.py) on the gold transcripts. The gate requires every case to pass.
- ``live``: calls the model (recognize.LiveRecognizer) on each stroke fixture and scores its
  reading and grade, with latency and token columns; ``--record DIR`` saves each raw reply.
- ``replay``: scores recorded replies with no network, so a model's measured quality is a
  regression test in CI, gated by :data:`MODEL_GATE`.

    uv run python -m codrawer_bridge.primer score                       # offline, gated
    uv run python -m codrawer_bridge.primer score --mode live \
        --record tests/fixtures/eval/recorded
    uv run python -m codrawer_bridge.primer score --mode replay \
        --recorded tests/fixtures/eval/recorded
"""

from __future__ import annotations

import json
import re
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from . import assess, policy
from .ink_signals import InkLog
from .learner import Learner
from .proofdoc import Finding, Grade, ProofDoc, Step
from .recognize import FIXTURES, OfflineRecognizer, fixture_names, load_fixture, load_recording

REPO = Path(__file__).resolve().parents[3]
GRADING_CASES = REPO / "tests" / "fixtures" / "eval" / "grading"


# =============================================================================================
# Metrics
# =============================================================================================


def latex_tokens(s: str) -> list[str]:
    """Tokens of a LaTeX string for comparison: commands, identifiers, numbers, single symbols."""
    s = s.replace("\\,", " ").replace("\\;", " ").replace("\\quad", " ").replace("\\ ", " ")
    s = re.sub(r"\\(t|d)?frac", r"\\frac", s)
    return re.findall(r"\\[A-Za-z]+|[A-Za-z]+|\d+|[^\s{}]", s)


def f1(a: list[str], b: list[str]) -> float:
    """Multiset F1 between two token lists (1.0 when both are empty)."""
    if not a and not b:
        return 1.0
    from collections import Counter

    ca, cb = Counter(a), Counter(b)
    common = sum((ca & cb).values())
    if common == 0:
        return 0.0
    p, r = common / sum(ca.values()), common / sum(cb.values())
    return 2 * p * r / (p + r)


def jaccard(a: set, b: set) -> float:
    return 1.0 if not a and not b else len(a & b) / len(a | b)


@dataclass
class Score:
    """One case's scores: named metrics in 0..1 (or errors), and whether it passed its gate."""

    case: str
    kind: str
    metrics: dict[str, float] = field(default_factory=dict)
    passed: bool = True
    notes: list[str] = field(default_factory=list)
    usage: dict[str, Any] | None = None


def score_recognition(case: str, got: ProofDoc, gold: ProofDoc) -> Score:
    """Step-aligned comparison of a reading with the gold transcription (module docstring)."""
    n = max(len(gold.steps), 1)
    pairs = list(zip(got.steps, gold.steps, strict=False))
    lat = sum(f1(latex_tokens(a.latex), latex_tokens(b.latex)) for a, b in pairs) / n
    con = sum(jaccard(set(a.concepts), set(b.concepts)) for a, b in pairs) / n
    lin = sum(jaccard(set(a.lines), set(b.lines)) for a, b in pairs) / n
    m = {
        "steps_match": 1.0 if len(got.steps) == len(gold.steps) else 0.0,
        "latex_f1": round(lat, 3),
        "concepts_jaccard": round(con, 3),
        "lines_jaccard": round(lin, 3),
        "received_text": 1.0 if got.received_text or got.source.startswith("offline") else 0.0,
    }
    return Score(case, "recognize", m)


def score_grading(case: str, doc: ProofDoc, move: policy.Move, expected: dict) -> Score:
    """Findings precision/recall (by id), score error, band and move accuracy."""
    want = {f[0] for f in expected.get("findings", [])}
    got = {f.id for f in doc.findings}
    precision = 1.0 if not got else len(got & want) / len(got)
    recall = 1.0 if not want else len(got & want) / len(want)
    g = doc.grade or Grade(0, "none")
    m = {
        "findings_precision": round(precision, 3),
        "findings_recall": round(recall, 3),
        "score_abs_error": float(abs(g.score - int(expected.get("score", 0)))),
        "band_ok": 1.0 if g.band == expected.get("band") else 0.0,
        "move_ok": 1.0 if not expected.get("move") or move.kind == expected["move"] else 0.0,
    }
    return Score(case, "grade", m)


# =============================================================================================
# Running the cases
# =============================================================================================


def _fixture_log(name: str) -> InkLog:
    log = InkLog()
    for m in load_recording(FIXTURES / f"{name}.jsonl"):
        log.observe(m)
    return log


def _expected(name: str) -> dict:
    e = json.loads((FIXTURES / f"{name}.expected.json").read_text(encoding="utf-8"))
    return {
        "findings": e["findings"],
        "score": e["grade"]["score"],
        "band": e["grade"]["band"],
        "move": e["move"]["kind"],
    }


def _doc_from_reply(data: dict, source: str) -> ProofDoc:
    """A recorded live reply (the structured output) as a ProofDoc."""
    return ProofDoc(
        title=data.get("title", ""),
        goal=data.get("goal", ""),
        technique=data.get("technique", ""),
        steps=[Step(**s) for s in data.get("steps", [])],
        findings=[Finding(**f) for f in data.get("findings", [])],
        grade=Grade(**data["grade"]) if data.get("grade") else None,
        source=source,
        received_text=data.get("received_text", ""),
        kind=data.get("kind", "proof"),
    )


def _grade(doc: ProofDoc, use_model: bool) -> tuple[ProofDoc, policy.Move]:
    assess.assess(doc, use_model_findings=use_model)
    move = policy.choose_move(doc, Learner(name="eval", created_ms=0), request="proof")
    return doc, move


def run(
    mode: str = "offline", record: Path | None = None, recorded: Path | None = None
) -> list[Score]:
    """Run every case in ``mode`` (module docstring); returns the scores."""
    scores: list[Score] = []
    recognizer: Any
    if mode == "live":
        from .recognize import LiveRecognizer

        recognizer = LiveRecognizer()
    else:
        recognizer = OfflineRecognizer()

    for name in fixture_names():
        gold = load_fixture(name)
        expected = _expected(name)
        if mode == "replay":
            path = (recorded or Path()) / f"{name}.json"
            if not path.exists():
                scores.append(
                    Score(name, "recognize", passed=False, notes=[f"no recording at {path}"])
                )
                continue
            rec = json.loads(path.read_text(encoding="utf-8"))
            got = _doc_from_reply(rec["reply"], f"live:{rec.get('model', '?')}")
            usage = rec.get("usage")
        else:
            log = _fixture_log(name)
            started = time.perf_counter()
            got = recognizer.recognize(log)
            usage = getattr(recognizer, "last_usage", None) or {
                "ms": round((time.perf_counter() - started) * 1000)
            }
            if record and mode == "live":
                record.mkdir(parents=True, exist_ok=True)
                reply = {
                    k: v
                    for k, v in got.to_dict().items()
                    if k not in ("check", "source", "problem")
                }
                (record / f"{name}.json").write_text(
                    json.dumps(
                        {"model": usage.get("model"), "usage": usage, "reply": reply},
                        indent=1,
                        ensure_ascii=False,
                    ),
                    encoding="utf-8",
                )
        rs = score_recognition(name, got, gold)
        rs.usage = usage
        scores.append(rs)
        live = mode in ("live", "replay")
        doc, move = _grade(got, use_model=live)
        gs = score_grading(name, doc, move, expected)
        gs.usage = usage
        scores.append(gs)

    for path in sorted(GRADING_CASES.glob("*.json")):
        case = json.loads(path.read_text(encoding="utf-8"))
        doc = ProofDoc.from_dict(case["proof"])
        doc, move = _grade(doc, use_model=False)
        scores.append(score_grading(path.stem, doc, move, case["expected"]))
    return scores


#: Gates for offline runs: the pipeline and rules must be exact on their own fixtures.
OFFLINE_GATE = {
    "steps_match": 1.0,
    "latex_f1": 1.0,
    "lines_jaccard": 1.0,
    "findings_precision": 1.0,
    "findings_recall": 1.0,
    "band_ok": 1.0,
    "move_ok": 1.0,
}
#: Default gates for live and replay runs: what a model reading should reach on the fixtures.
MODEL_GATE = {
    "steps_match": 0.0,
    "latex_f1": 0.6,
    "lines_jaccard": 0.5,
    "findings_recall": 0.5,
    "band_ok": 1.0,
}


def gate(scores: list[Score], thresholds: dict[str, float]) -> list[Score]:
    """Mark each score passed or not against ``thresholds`` (a metric at or above its floor)."""
    for s in scores:
        for k, floor in thresholds.items():
            if k in s.metrics and s.metrics[k] < floor:
                s.passed = False
                s.notes.append(f"{k} {s.metrics[k]} < {floor}")
        if s.metrics.get("score_abs_error", 0) > 2:
            s.passed = False
            s.notes.append(f"score off by {s.metrics['score_abs_error']:.0f}")
    return scores


def report(scores: list[Score]) -> str:
    """A plain-text table: one row per case and kind, metrics, latency and tokens when known."""
    rows = []
    for s in scores:
        u = s.usage or {}
        cost = f"{u.get('ms', '')} ms" if u else ""
        if u.get("input_tokens"):
            cost += f" {u['input_tokens']}+{u.get('output_tokens') or 0} tok"
        m = " ".join(f"{k}={v:g}" for k, v in s.metrics.items())
        rows.append(
            f"{'PASS' if s.passed else 'FAIL'}  {s.kind:9} {s.case:26} {m}  {cost}  "
            + "; ".join(s.notes)
        )
    passed = sum(s.passed for s in scores)
    rows.append(f"{passed}/{len(scores)} passed")
    return "\n".join(rows)
