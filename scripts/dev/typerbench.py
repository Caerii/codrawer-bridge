"""Typer calibration: how fast can the bridge type into xochitl before characters go missing?

The bridge types terminal replies into the tablet's focused text field through a uinput
keyboard, at a speed set by `typer_config` (docs/protocol.md; bridge typer.rs / typer.go). The
`instant` preset's defaults (bursts of 10 keys, 40 ms apart) are guesses until this harness has
been run against a scratch text box; this is how its numbers get measured.

The tablet's own router does not take `term` messages from clients (it has no terminal), so this
script stands in for a router: the bridge is pointed at it (DESKTOP_WS, see below), and for each
run it sends a `typer_config`, waits for the bridge's acknowledgement, sends one `term` reply
with a test text, and waits for the typing to finish (the planned time plus a margin). It writes
everything it asked to be typed to OUT (default typerbench-expected.txt), run by run, to compare
with what arrived: read back from the saved page (rmscene on the page's .rm), a framebuffer grab,
or the user's eyes.

Characters the US keyboard table cannot type (``^ [ ] { } ` ~``) are never sent: the bridge
leaves them out anyway and says so in a `typer_note`, which this script prints. The first runs
check the fixes for the keys lost after a leading Enter on 2026-10-06: `enter0` types a leading
Enter with no settle, `enter150` with the 150 ms settle, and `dash` a line starting with "--" and
no leading Enter. Keep the pen away from the screen and the hand off it while a run types: the
bridge waits until both are clear, which is the point, but it makes a run slower.

    uv run python scripts/dev/typerbench.py [--port 8590] [--out FILE] [--plan calibrate|quick] [RUN…]

A RUN is `label:speed[:char_ms[:burst[:enter_ms]]]`, e.g. `i10:instant:10:10`; given RUNs replace
the plan. ONLY run this with the user's go-ahead and a scratch text box focused on the tablet:
the bridge types into whatever field has focus.

Pointing the bridge at this script (and back) on the tablet, as root:

    printf 'DESKTOP_WS=ws://<this PC>:8590/ws/bench\\n' >> /run/codrawer/env   # after a backup
    systemctl restart codrawer-bridge
    … run this script …
    restore /run/codrawer/env from the backup; systemctl restart codrawer-bridge
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
import time

import websockets

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

# Body of each run: letters, digits and the punctuation xochitl accepts, in ~260 characters over
# four lines, so a drop, a doubling or a reordering is visible by eye and by diff.
BODY = (
    "The quick brown fox jumps over the lazy dog 0123456789.\n"
    "THE QUICK BROWN FOX JUMPS OVER THE LAZY DOG! @#$%&*()-_=+;:'\",.<>/?|\n"
    "Pack my box with five dozen liquor jugs; sphinx of black quartz, judge my vow.\n"
    "9876543210 zyxwvutsrqponmlkjihgfedcba ZYXWVUTSRQPONMLKJIHGFEDCBA\n"
)

PLANS = {
    # leading-Enter hypotheses first, then each preset, then instant ever faster
    "calibrate": [
        "enter0:careful:12:10:0",
        "enter150:careful:12:10:150",
        "dash:careful",
        "fast:fast",
        "i40:instant:40:10",
        "i20:instant:20:10",
        "i10:instant:10:10",
        "i5:instant:5:10",
        "i10b16:instant:10:16",
    ],
    "quick": ["careful:careful", "fast:fast", "instant:instant"],
}


def run_text(label: str) -> str:
    """The reply typed in one run. `dash` starts with "--" and no Enter; the others start with an
    Enter and then a separator-free line naming the run."""
    if label == "dash":
        return f"-- dash run --\n{BODY}end {label}\n"
    return f"\nrun {label} begins\n{BODY}end {label}\n"


def planned_seconds(text: str, speed: str, char_ms: int, burst: int, enter_ms: int) -> float:
    """How long the bridge's plan for `text` pauses in total (typer.rs `plan`): writes end at
    each key (careful), word separator (fast) or `burst` keys (instant), and always at Enter."""
    writes = enters = keys = 0
    for ch in text:
        keys += 1
        ends = ch == "\n" or {
            "careful": True,
            "fast": ch in " \t" or keys >= 16,
            "instant": keys >= burst,
        }[speed]
        if ends:
            writes += 1
            enters += ch == "\n"
            keys = 0
    writes += keys > 0
    return ((writes - enters) * char_ms + enters * max(char_ms, enter_ms)) / 1000


def parse_run(spec: str) -> dict:
    label, speed, *rest = spec.split(":")
    req: dict = {"t": "typer_config", "speed": speed}
    for key, value in zip(("char_ms", "burst", "enter_ms"), rest):
        req[key] = int(value)
    return {"label": label, "req": req}


async def bench(port: int, runs: list[dict], out_path: str) -> None:
    bridge: asyncio.Queue = asyncio.Queue()

    async def handler(ws):
        await ws.send(json.dumps({"t": "hello", "session": "bench"}))
        inbox: asyncio.Queue = asyncio.Queue()
        await bridge.put((ws, inbox))
        async for raw in ws:
            m = json.loads(raw)
            if m.get("t") == "typer_config":
                await inbox.put(m)
            elif m.get("t") == "typer_note":
                print(f"[bench] the bridge left out {m.get('dropped')!r} ({m.get('keymap')} keyboard)")

    async with websockets.serve(handler, "0.0.0.0", port):
        print(f"[bench] waiting for the bridge on :{port} (DESKTOP_WS=ws://<this PC>:{port}/ws/bench)")
        ws, inbox = await bridge.get()
        first = await asyncio.wait_for(inbox.get(), 30)
        print(f"[bench] bridge connected, typing at {first.get('speed')} {first.get('char_ms')} ms")
        with open(out_path, "w", encoding="utf-8", newline="\n") as out:
            for run in runs:
                await ws.send(json.dumps(run["req"]))
                ack = await asyncio.wait_for(inbox.get(), 10)
                if not ack.get("ok"):
                    print(f"[bench] {run['label']}: refused: {ack}")
                    continue
                text = run_text(run["label"])
                secs = planned_seconds(text, ack["speed"], ack["char_ms"], ack["burst"], ack["enter_ms"])
                t0 = time.monotonic()
                await ws.send(json.dumps({"t": "term", "kind": "text", "text": text}))
                out.write(text)
                out.flush()
                print(f"[bench] {run['label']}: {ack['speed']} {ack['char_ms']} ms, burst {ack['burst']}, enter {ack['enter_ms']} ms: {len(text)} chars, ~{secs:.1f} s planned")
                await asyncio.sleep(secs + 3)  # the typing, plus xochitl catching up
                print(f"[bench] {run['label']}: done after {time.monotonic() - t0:.1f} s")
            # leave the bridge at careful, the verified pace
            await ws.send(json.dumps({"t": "typer_config", "speed": "careful"}))
            await asyncio.wait_for(inbox.get(), 10)
    print(f"[bench] expected text in {out_path}; compare it with what the tablet shows")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", type=int, default=8590)
    ap.add_argument("--out", default="typerbench-expected.txt")
    ap.add_argument("--plan", choices=sorted(PLANS), default="calibrate")
    ap.add_argument("runs", nargs="*", help="label:speed[:char_ms[:burst[:enter_ms]]]")
    a = ap.parse_args()
    runs = [parse_run(s) for s in (a.runs or PLANS[a.plan])]
    asyncio.run(bench(a.port, runs, a.out))


if __name__ == "__main__":
    main()
