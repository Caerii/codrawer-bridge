"""
The Primer's command line.

    # read a recorded session (JSONL from the app's "Export recording" or the fixtures) offline
    uv run python -m codrawer_bridge.primer src/codrawer_bridge/primer/fixtures/sqrt2_flawed.jsonl --learner nell

    # join a router as a client and answer requests (and, with --auto, lulls)
    uv run python -m codrawer_bridge.primer live --ws ws://127.0.0.1:8583/ws/primerdemo --learner nell

    # show or delete a learner's file
    uv run python -m codrawer_bridge.primer learner nell --show
    uv run python -m codrawer_bridge.primer learner nell --forget

    # the scored evaluation of recognition and grading (scoring.py): offline by default, gated
    uv run python -m codrawer_bridge.primer score [--mode offline|live|replay] [--record DIR] [--recorded DIR]

``--mode`` is ``auto`` (live when ``ANTHROPIC_API_KEY`` is set, else offline), ``live`` or
``offline``. ``--out DIR`` writes the ``primer`` message (``primer.json``) and ``proof.tex``;
``--pdf`` also compiles it when a TeX engine is installed. ``--coach`` turns the practice coach on
for this learner (consent recorded in the file). ``--state DIR`` overrides the state directory
(default ``$CODRAWER_STATE_DIR`` or ``~/.codrawer``).
"""

from __future__ import annotations

# ruff: noqa: E501  (command lines and LaTeX templates read better unwrapped)
import argparse
import asyncio
import json
import sys
import time
from pathlib import Path

from .agent import PrimerAgent
from .latex import compile_tex
from .learner import LearnerStore
from .recognize import load_recording


def _store(args) -> LearnerStore:
    return LearnerStore(Path(args.state)) if args.state else LearnerStore()


def _print_reading(msg: dict) -> None:
    proof = msg.get("proof") or {}
    print(
        f"[{msg['mode']}{' · ' + msg['model'] if msg.get('model') else ''}] {proof.get('title', '')}  ({proof.get('source', '')})"
    )
    for s in proof.get("steps", []):
        print(
            f"  {s['n']}. [{s['status']:>7}] {s['text']}"
            + (f"  ({s['justification']})" if s.get("justification") else "")
            + (f"  ← {s['note']}" if s.get("note") else "")
        )
    for f in msg.get("findings", []):
        print(f"  finding: step {f['step']}: {f['label']} ({f['kind']})")
    g = msg.get("grade")
    if g:
        print(f"  grade (estimate): {g['score']}/{g['max']} {g['band']}: {g['rigor']}")
    c = proof.get("check") or {}
    print(f"  formal check: {c.get('status')} {('· ' + c['detail']) if c.get('detail') else ''}")
    mv = msg.get("move") or {}
    print(f"  move: {mv.get('kind')}: {mv.get('text')}")
    print(f"  glasses: {mv.get('glance')}")
    lr = msg.get("learner") or {}
    print(f"  learner {lr.get('name')}: {lr.get('summary')}")
    co = msg.get("coach") or {}
    if co.get("nudge"):
        print(f"  coach: {co['nudge']}")
    for q in (msg.get("plan") or {}).get("queue", [])[:3]:
        print(f"  next: {q['title']}: {q['why']}")


async def run_recording(args) -> int:
    sent: list[dict] = []

    async def send(m: dict) -> None:
        sent.append(m)

    store = _store(args)
    if args.coach:
        lr = store.load(args.learner)
        lr.consent = lr.watching = True
        store.save(lr)
    agent = PrimerAgent(send, learner=args.learner, mode=args.mode, store=store)
    for m in load_recording(Path(args.source)):
        if m.get("t") not in ("primer_request",):
            await agent.handle(m)
    reading = await agent.read(args.request)
    if reading is None:
        print("silence (the learner is mid-thought)")
        return 0
    _print_reading(reading)
    if args.out:
        out = Path(args.out)
        out.mkdir(parents=True, exist_ok=True)
        (out / "primer.json").write_text(
            json.dumps(reading, indent=1, ensure_ascii=False), encoding="utf-8"
        )
        tex = (reading.get("proof") or {}).get("tex") or ""
        (out / "proof.tex").write_text(tex, encoding="utf-8")
        print(f"  wrote {out / 'primer.json'} and {out / 'proof.tex'}")
        if args.pdf and tex:
            pdf, log = compile_tex(tex)
            if pdf:
                (out / "proof.pdf").write_bytes(pdf)
                print(f"  wrote {out / 'proof.pdf'} ({log})")
            else:
                print(f"  pdf: {log.splitlines()[0] if log else 'failed'}")
    return 0


async def run_live(args) -> int:
    import websockets

    store = _store(args)
    if args.coach:
        lr = store.load(args.learner)
        lr.consent = lr.watching = True
        store.save(lr)
    async with websockets.connect(args.ws, max_size=2**24) as ws:

        async def send(m: dict) -> None:
            await ws.send(json.dumps(m, separators=(",", ":"), ensure_ascii=False))
            if m.get("t") == "primer":
                mv = m.get("move") or {}
                print(
                    f"{time.strftime('%H:%M:%S')} primer → {mv.get('kind')}: {mv.get('glance') or ''}",
                    flush=True,
                )

        agent = PrimerAgent(
            send,
            learner=args.learner,
            mode=args.mode,
            auto=args.auto,
            store=store,
            markup_speed=args.markup_speed,
        )
        print(
            f"primer joined {args.ws} as learner {agent.learner_name} ({agent.recognizer.mode} recognition)",
            flush=True,
        )

        async def ticker():
            while True:
                await asyncio.sleep(1.0)
                try:
                    await agent.tick()
                except Exception as e:  # a failed auto reading must not end the session
                    print(f"auto reading failed: {e}", file=sys.stderr, flush=True)

        tick_task = asyncio.create_task(ticker())
        try:
            async for raw in ws:
                try:
                    m = json.loads(raw)
                except (TypeError, json.JSONDecodeError):
                    continue
                if isinstance(m, dict) and m.get("t") != "primer":
                    try:
                        await agent.handle(m)
                    except Exception as e:
                        print(f"primer: {m.get('t')} failed: {e}", file=sys.stderr, flush=True)
        finally:
            tick_task.cancel()
    return 0


def run_learner(args) -> int:
    store = _store(args)
    path = store.path(args.name)
    if args.forget:
        print(("deleted " if store.delete(args.name) else "no file at ") + str(path))
        return 0
    if not path.exists():
        print(f"no learner file at {path}")
        return 0
    lr = store.load(args.name)
    print(f"{path}")
    print(json.dumps(lr.summary(time.time() * 1000), indent=1, ensure_ascii=False))
    print(
        f"{len(lr.attempts)} attempts, {len(lr.evidence)} evidence events, coach {'on' if lr.watching and lr.consent else 'off'}"
    )
    return 0


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    for stream in (
        sys.stdout,
        sys.stderr,
    ):  # proofs are full of √ and ⇒; Windows consoles default to cp1252
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument(
        "--learner",
        default="learner",
        help="the learner's name (their file is <state>/primer/learners/<name>.json)",
    )
    common.add_argument("--mode", default="auto", choices=["auto", "live", "offline"])
    common.add_argument(
        "--state", default=None, help="state directory (default $CODRAWER_STATE_DIR or ~/.codrawer)"
    )
    common.add_argument(
        "--coach", action="store_true", help="turn the practice coach on for this learner"
    )
    if argv and argv[0] == "live":
        p = argparse.ArgumentParser(prog="primer live", parents=[common])
        p.add_argument(
            "--ws", required=True, help="router session URL, ws://host:port/ws/<session>"
        )
        p.add_argument("--auto", action="store_true", help="also read the page at lulls")
        p.add_argument(
            "--markup-speed", type=float, default=1.0, help="the teacher's pen, times real time"
        )
        return asyncio.run(run_live(p.parse_args(argv[1:])))
    if argv and argv[0] == "score":
        from . import scoring as primer_eval

        p = argparse.ArgumentParser(prog="primer score")
        p.add_argument("--mode", default="offline", choices=["offline", "live", "replay"])
        p.add_argument("--record", default=None, help="live: save each model reply here")
        p.add_argument("--recorded", default=None, help="replay: read the saved replies from here")
        a = p.parse_args(argv[1:])
        scores = primer_eval.run(
            a.mode, Path(a.record) if a.record else None, Path(a.recorded) if a.recorded else None
        )
        primer_eval.gate(
            scores, primer_eval.OFFLINE_GATE if a.mode == "offline" else primer_eval.MODEL_GATE
        )
        print(primer_eval.report(scores))
        return 0 if all(s.passed for s in scores) else 1
    if argv and argv[0] == "learner":
        p = argparse.ArgumentParser(prog="primer learner")
        p.add_argument("name")
        p.add_argument("--forget", action="store_true")
        p.add_argument("--show", action="store_true")
        p.add_argument("--state", default=None)
        return run_learner(p.parse_args(argv[1:]))
    p = argparse.ArgumentParser(
        prog="primer", parents=[common], description="Read a recorded session's proof."
    )
    p.add_argument("source", help="session recording (.jsonl)")
    p.add_argument("--request", default="proof", choices=["proof", "hint", "auto"])
    p.add_argument("--out", default=None)
    p.add_argument("--pdf", action="store_true")
    return asyncio.run(run_recording(p.parse_args(argv)))


if __name__ == "__main__":
    raise SystemExit(main())
