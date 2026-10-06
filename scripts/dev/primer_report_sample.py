"""
A sample weekly report (docs/media/primer-report-sample.pdf) from fixture data, clearly labelled.

Simulates two weeks of a learner who opted into every feature: the three fixture proofs read by
the Primer (offline) on different days with confidence ratings before each check, the
transcript-only grading cases (tests/fixtures/eval/grading) as further attempts, and goals she set.
Nothing here is a real learner; the PDF says so on its first page.

    uv run python scripts/dev/primer_report_sample.py [--out docs/media/primer-report-sample.pdf]
"""

from __future__ import annotations

# ruff: noqa: E501  (the sample note reads better unwrapped)
import argparse
import asyncio
import datetime as dt
import json
import shutil
import tempfile
from pathlib import Path

from codrawer_bridge.primer import assess, coach, markup, report
from codrawer_bridge.primer.agent import PrimerAgent
from codrawer_bridge.primer.learner import LearnerStore
from codrawer_bridge.primer.proofdoc import ProofDoc
from codrawer_bridge.primer.recognize import FIXTURES, load_recording

ROOT = Path(__file__).resolve().parent.parent.parent
CASES = ROOT / "tests" / "fixtures" / "eval" / "grading"
DAY = 86_400_000

#: (day, fixture or grading case, confidence 0..1 she gave before the check)
SCHEDULE = [
    (0, "sqrt2_flawed", 0.9),
    (1, "odd_sum", 0.6),
    (2, "case:assumes_conclusion", 0.8),
    (3, "sqrt2_correct", 0.7),
    (5, "case:induction_no_base", 0.85),
    (6, "sqrt2_flawed", 0.9),
    (8, "case:infinitely_many_primes", 0.5),
    (9, "odd_sum", 0.7),
    (11, "case:induction_no_hypothesis", 0.9),
    (12, "sqrt2_correct", 0.8),
]


async def simulate(root: Path) -> tuple[LearnerStore, float]:
    start = dt.datetime(2026, 10, 6, 17, 0).timestamp() * 1000
    clock = {"now": start}

    async def send(m: dict) -> None:
        return None

    store = LearnerStore(root)
    lr = store.load("sample")
    for f in (
        "reading_position",
        "attempt_log",
        "ink_signals",
        "reviews",
        "nudges",
        "activity_review",
    ):
        lr.features[f] = True
    lr.consent = lr.watching = True
    lr.goals.apply(
        {
            "target": "Solve 3 problems cleanly; about 30/120",
            "target_score": 30,
            "topics": ["number_theory", "combinatorics", "inequalities"],
            "weekly_hours": 8,
            "nudging": "light",
        },
        start,
        by="learner",
    )
    store.save(lr)
    agent = PrimerAgent(
        send,
        learner="sample",
        mode="offline",
        store=store,
        clock=lambda: clock["now"],
        renderer=markup.Renderer(),
        markup_speed=0,
    )
    for day, what, conf in SCHEDULE:
        clock["now"] = start + day * DAY
        await agent.handle(
            {
                "t": "page",
                "doc": "notebook",
                "page": f"p{day}",
                "title": "Putnam practice",
                "strokes": [],
            }
        )
        if what.startswith("case:"):
            case = json.loads((CASES / f"{what[5:]}.json").read_text(encoding="utf-8"))
            doc = ProofDoc.from_dict(case["proof"])
            assess.assess(doc)
            lr = store.load("sample")
            lr.judge(conf, clock["now"])
            agent.last_signals = {}  # no ink for a transcript-only case
            agent._update_learner(lr, doc, clock["now"])
            agent._after_reading(lr, doc, clock["now"])
            coach.log_attempt(
                lr, doc, now_ms=clock["now"], minutes=25 + 5 * day % 30, hints=day % 2
            )
            store.save(lr)
        else:
            agent.log.strokes.clear()
            for m in load_recording(FIXTURES / f"{what}.jsonl"):
                await agent.handle(m)
            await agent.handle(
                {"t": "primer_request", "what": "proof", "confidence": conf, "learner": "sample"}
            )
    return store, start + 13 * DAY


def main() -> None:
    a = argparse.ArgumentParser()
    a.add_argument("--out", default=str(ROOT / "docs" / "media" / "primer-report-sample.pdf"))
    args = a.parse_args()
    root = Path(tempfile.mkdtemp(prefix="primer-sample-"))
    try:
        store, now = asyncio.run(simulate(root))
        lr = store.load("sample")
        pdf, log = report.build_pdf(
            lr,
            now,
            root=root,
            sample_note="Sample report: generated from the Primer's fixture proofs and grading cases over simulated dates (scripts/dev/primer_report_sample.py). Not a real learner.",
        )
        if pdf is None:
            raise SystemExit(f"no PDF: {log}")
        Path(args.out).parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(pdf, args.out)
        print(
            f"wrote {args.out} ({Path(args.out).stat().st_size // 1024} KB); {len(lr.attempts)} attempts, {len(lr.items)} items, {len(lr.judgments)} judgments"
        )
    finally:
        shutil.rmtree(root, ignore_errors=True)


if __name__ == "__main__":
    main()
