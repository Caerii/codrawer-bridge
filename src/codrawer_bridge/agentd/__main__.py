"""
codrawer-agentd on the command line (the package docstring says what it does).

    uv run python -m codrawer_bridge.agentd --ws ws://<tablet>:8577/ws/session1 --token <code> \\
        --term-cwd C:/Github/tool-codrawer-bridge --ssh root@<tablet>

``--dry-run`` joins, renders and prints the prompt (and where a typical answer would go) for each
request, sending nothing; ``--simulate ask_page|ask_selection [--bbox x0,y0,x1,y1]`` makes one
request as soon as the page snapshot arrives (``--bbox`` in xochitl scene units, x centred, as the
dock sends it, or normalized) and exits when it is done.
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import os
import sys
import time

from .service import Agentd, Config


def _args(argv: list[str] | None = None) -> argparse.Namespace:
    ap = argparse.ArgumentParser(
        prog="codrawer-agentd", description="Answer the reMarkable dock's Ask entries in ink."
    )
    ap.add_argument(
        "--ws",
        required=True,
        help="the tablet router's session, e.g. ws://<tablet>:8577/ws/session1",
    )
    ap.add_argument(
        "--token",
        default=os.environ.get("CODRAWER_ROUTER_TOKEN", ""),
        help="pairing code (ROUTER_TOKEN)",
    )
    ap.add_argument(
        "--term-url",
        default=os.environ.get("CODRAWER_TERM_URL", "http://127.0.0.1:3456"),
        help="the even-terminal to ask; a second one started with ANTHROPIC_MODEL set picks the "
        "model (even-terminal has no model option), e.g. Haiku on :3457 for faster answers",
    )
    ap.add_argument("--term-token", default=os.environ.get("CODRAWER_TERM_TOKEN", "sig-glasses"))
    ap.add_argument(
        "--term-cwd",
        default=os.environ.get("CODRAWER_TERM_CWD", ""),
        help="the repository; the state directory (logs, images) goes under it (default: here)",
    )
    ap.add_argument(
        "--backend",
        choices=("claude-stream", "even-terminal"),
        default="claude-stream",
        help="claude-stream: warm `claude -p` processes, the image attached (claude_stream.py; "
        "~1 s warm); even-terminal: the --term-url server, the image Read from a file (~23 s)",
    )
    ap.add_argument(
        "--model",
        default="claude-sonnet-5-5",
        help="the 'careful' model (claude-stream; 10/10 handwriting reads on 2026-10-07, ~1.3 s)",
    )
    ap.add_argument(
        "--fast-model",
        default="claude-haiku-4-5-20251001",
        help="the 'fast' model, chosen from the dock (7/10 reads, ~0.5 s)",
    )
    ap.add_argument("--pool", type=int, default=2, help="asks answered at once")
    ap.add_argument(
        "--agent-cwd",
        default="",
        help="Claude Code's working directory, where the images it Reads go (default: the "
        "--term-cwd). An empty directory outside any repository loads no project context and "
        "answers faster, e.g. ~/.codrawer-agentd/cwd",
    )
    ap.add_argument(
        "--state-dir", default="", help="logs and images (default <term-cwd>/.codrawer/agentd)"
    )
    ap.add_argument(
        "--persona", default="archivist", help="packages/hand persona: archivist, sketcher, …"
    )
    ap.add_argument("--color", default="#3a6ea5", help="agent ink colour hint")
    ap.add_argument(
        "--speed", type=float, default=1.5, help="hand speed factor (1 = the persona's own pace)"
    )
    ap.add_argument(
        "--ink",
        choices=("auto", "on", "off"),
        default="auto",
        help="write answers as agent ink (auto: ask the tablet over --ssh)",
    )
    ap.add_argument("--ssh", default="", help="root@<tablet> for --ink auto")
    ap.add_argument(
        "--thinking",
        choices=("dots", "overlay", "none"),
        default="dots",
        help="pending mark: '…' in agent ink (dots), or none because the tablet draws an "
        "agent_status overlay (overlay); agent_status is sent either way",
    )
    ap.add_argument("--timeout", type=float, default=90.0, help="seconds to wait for an answer")
    ap.add_argument(
        "--open-timeout", type=float, default=60.0, help="seconds to wait for the router to accept"
    )
    ap.add_argument(
        "--include-ai", action="store_true", help="show the agent layer to the model too"
    )
    ap.add_argument(
        "--dry-run", action="store_true", help="render and print the prompt; send nothing"
    )
    ap.add_argument(
        "--simulate",
        choices=("ask_page", "ask_selection"),
        help="make one request after the page arrives, then exit",
    )
    ap.add_argument("--bbox", default="", help="x0,y0,x1,y1 for --simulate ask_selection")
    ap.add_argument("-v", "--verbose", action="store_true")
    return ap.parse_args(argv)


def config(a: argparse.Namespace) -> Config:
    """The service's configuration from the command line."""
    return Config(
        ws=a.ws,
        token=a.token,
        term_url=a.term_url,
        term_token=a.term_token,
        term_cwd=a.term_cwd,
        agent_cwd=a.agent_cwd,
        backend=a.backend,
        model=a.model,
        fast_model=a.fast_model,
        pool=a.pool,
        state_dir=a.state_dir,
        persona=a.persona,
        color=a.color,
        speed=a.speed,
        ink=a.ink,
        ssh=a.ssh,
        thinking=a.thinking,
        timeout_s=a.timeout,
        open_timeout_s=a.open_timeout,
        include_ai=a.include_ai,
        dry_run=a.dry_run,
    )


async def _main(a: argparse.Namespace) -> int:
    cfg = config(a)
    agent = Agentd(cfg)
    fh = logging.FileHandler(agent.state / "agentd.log", encoding="utf-8")
    fh.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
    logging.getLogger("agentd").addHandler(fh)
    log = logging.getLogger("agentd")
    if not a.dry_run and not await agent.terminal.reachable():
        log.warning(
            "even-terminal does not answer at %s; requests will fail until it does", cfg.term_url
        )
    if not a.simulate:
        log.info("listening for ask_page / ask_selection (state in %s)", agent.state)
        await agent.run()
        return 0
    stop = asyncio.Event()
    runner = asyncio.ensure_future(agent.run(stop))
    deadline = time.monotonic() + cfg.open_timeout_s + 30
    while not agent.model.has_snapshot and time.monotonic() < deadline:
        await asyncio.sleep(0.2)
    if not agent.model.has_snapshot:
        log.error("no page snapshot arrived")
        stop.set()
        runner.cancel()
        return 2
    await asyncio.sleep(1.0)  # the live strokes replayed after the page
    msg = {
        "t": "dock_action",
        "id": a.simulate,
        "doc": agent.model.doc,
        "page": agent.model.page,
        "source": "agentd-simulate",
    }
    if a.bbox:
        msg["bbox"] = [float(v) for v in a.bbox.split(",")]
    rec = await agent.answer(msg)
    stop.set()
    runner.cancel()
    return 0 if not rec.error else 1


def main(argv: list[str] | None = None) -> int:
    a = _args(argv)
    for stream in (sys.stdout, sys.stderr):  # a Windows console is cp1252: ≤ and … would raise
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    logging.basicConfig(
        level=logging.DEBUG if a.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        stream=sys.stderr,
    )
    logging.getLogger("websockets").setLevel(logging.WARNING)
    logging.getLogger("httpx").setLevel(logging.WARNING)
    try:
        return asyncio.run(_main(a))
    except KeyboardInterrupt:
        return 0


if __name__ == "__main__":
    sys.exit(main())
