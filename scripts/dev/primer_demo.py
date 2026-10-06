"""
The Primer demo: play a fixture proof into a router session, ask the Primer to read it, and
screenshot the app's Proof panel.

Everything runs locally on its own ports (never the tablet's session1 or the everyday 5188/8577):

    # 1. a router: the Rust engine, router only
    bridge/remarkable/rust/target/release/codrawer_bridge_rs -router-only -serve 127.0.0.1:8583
    # 2. the app
    cd apps/even-g2 && pnpm exec vite --host 127.0.0.1 --port 5198 --strictPort
    # 3. the Primer, joined as a client (offline without ANTHROPIC_API_KEY; --coach records consent)
    uv run python -m codrawer_bridge.primer live --ws ws://127.0.0.1:8583/ws/primerdemo --learner nell --coach
    # 4. this script
    uv run --with playwright python scripts/dev/primer_demo.py --fixture sqrt2_flawed --shots docs/media

What is real and what is scripted: the strokes are the fixture's recorded pen (scripts/dev/
primer_fixtures.py: a simulated hand, timed like a pen), played into the router at ``--speed``
times real time; the Primer, the router and the app are the real programs. In offline mode the
Primer's transcription is the fixture's hand-written one (the panel says "offline: fixture
transcription"); with a key it is a live model reading.

``--shots DIR`` writes ``primer-proof.png`` (the Proof tab with the step the Primer asks about
picked out on the page), ``primer-plan.png``, ``primer-coach.png`` and ``primer-phone.png`` (a
phone-sized view) with a headless Edge or Chrome.
"""

from __future__ import annotations

# ruff: noqa: E501  (command lines read better unwrapped)
import argparse
import asyncio
import json
import sys
from pathlib import Path

import websockets

ROOT = Path(__file__).resolve().parent.parent.parent
FIXTURES = ROOT / "src" / "codrawer_bridge" / "primer" / "fixtures"


async def play(ws_url: str, fixture: str, speed: float, learner: str) -> dict | None:
    """Send the fixture's strokes (time-compressed), then a primer_request; return the reading."""
    lines = (FIXTURES / f"{fixture}.jsonl").read_text(encoding="utf-8").splitlines()
    async with websockets.connect(ws_url, max_size=2**24) as ws:
        got: asyncio.Future[dict] = asyncio.get_running_loop().create_future()

        async def drain():
            # Keep reading while sending: a client that never reads is dropped by the router.
            async for raw in ws:
                m = json.loads(raw)
                if m.get("t") == "primer" and asking and not got.done():
                    got.set_result(m)

        asking = False
        reader = asyncio.create_task(drain())
        await ws.send(json.dumps({"t": "clear"}))
        prev = None
        for line in lines:
            o = json.loads(line)
            if prev is not None:
                await asyncio.sleep(max(0.0, min(0.5, (o["ts"] - prev) / 1000 / speed)))
            prev = o["ts"]
            await ws.send(json.dumps(o["msg"], separators=(",", ":")))
        await asyncio.sleep(0.5)
        asking = True
        await ws.send(json.dumps({"t": "primer_request", "what": "proof", "learner": learner}))
        try:
            return await asyncio.wait_for(got, 60)
        except TimeoutError:
            return None
        finally:
            reader.cancel()


async def run(args) -> dict | None:
    """Open the app (when screenshots are wanted) first, since readings are not replayed to joiners."""
    if not args.shots:
        return await play(args.ws, args.fixture, args.speed, args.learner)
    from playwright.async_api import async_playwright

    out = Path(args.shots)
    out.mkdir(parents=True, exist_ok=True)
    url = f"{args.app}/?ws={args.ws}&panel=proof"
    async with async_playwright() as p:
        browser = None
        for channel in ("msedge", "chrome", None):
            try:
                browser = (
                    await p.chromium.launch(channel=channel)
                    if channel
                    else await p.chromium.launch()
                )
                break
            except Exception:
                continue
        if browser is None:
            raise SystemExit("no Chromium-family browser for Playwright")
        desktop = await browser.new_page(
            viewport={"width": 1440, "height": 900}, device_scale_factor=2
        )
        phone = await browser.new_page(
            viewport={"width": 430, "height": 932}, device_scale_factor=2
        )
        for page in (desktop, phone):
            await page.goto(url)
            await page.wait_for_selector("#primer:not([hidden])", timeout=30_000)
        await asyncio.sleep(1.0)
        reading = await play(args.ws, args.fixture, args.speed, args.learner)
        if reading is None:
            await browser.close()
            return None
        step = int((reading.get("move") or {}).get("step") or 1)
        for page in (desktop, phone):
            await page.wait_for_selector("#primer .pstep", timeout=30_000)
            await page.wait_for_selector("#primer .katex", timeout=30_000)
            await page.click('.seg button[data-view="page"]')
            await page.wait_for_timeout(800)
        await desktop.click(f'#primer .pstep[data-step="{step}"]')
        await desktop.wait_for_timeout(600)
        # the move (the Primer's question) sits at the top of the panel: show it with the steps
        await desktop.evaluate("document.querySelector('#primer .pbody').scrollTop = 0")
        await desktop.wait_for_timeout(300)
        await desktop.screenshot(path=str(out / "primer-proof.png"))
        await desktop.click('#primer .ptabs [data-tab="plan"]')
        await desktop.wait_for_timeout(300)
        await desktop.screenshot(path=str(out / "primer-plan.png"))
        await desktop.click('#primer .ptabs [data-tab="coach"]')
        await desktop.wait_for_timeout(300)
        await desktop.screenshot(path=str(out / "primer-coach.png"))
        await phone.screenshot(path=str(out / "primer-phone.png"))
        await browser.close()
        return reading


def main() -> None:
    a = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    a.add_argument("--ws", default="ws://127.0.0.1:8583/ws/primerdemo")
    a.add_argument("--app", default="http://127.0.0.1:5198")
    a.add_argument(
        "--fixture", default="sqrt2_flawed", choices=["sqrt2_flawed", "sqrt2_correct", "odd_sum"]
    )
    a.add_argument("--learner", default="nell")
    a.add_argument("--speed", type=float, default=20.0, help="times real time")
    a.add_argument("--shots", default=None, help="directory for the screenshots")
    args = a.parse_args()
    for stream in (sys.stdout, sys.stderr):  # √ and ⇒ on a cp1252 Windows console
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    if args.ws.rstrip("/").endswith("/session1"):
        raise SystemExit("refusing session1: that is the tablet's live session")
    reading = asyncio.run(run(args))
    if reading is None:
        raise SystemExit("no primer reading arrived: is the Primer joined to this session?")
    move = reading.get("move") or {}
    print(
        f"[{reading['mode']}] {reading['proof']['title']}: {move.get('kind')} at step {move.get('step')}: {move.get('text')}"
    )
    if args.shots:
        print(f"screenshots in {args.shots}")


if __name__ == "__main__":
    main()
