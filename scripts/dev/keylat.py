"""Keyboard latency harness: how long a keystroke takes from the tablet to the glasses, per hop.

The keyboard path (CLAUDE.md, ADR 006) is

    BLE HID ─▶ kernel evdev ─▶ bridge keyboard reader ─▶ `key` message (`ts`) ─▶ router
        ─▶ phone app (link, hud/keyboard.ts) ─▶ text pacing (glasses/text.ts) ─▶ host call
        ─▶ glasses status strip

and no single clock sees all of it. So each hop is measured where its two ends share a clock,
or where the clocks can be aligned:

    bridge → LAN      `ts` (tablet wall clock, stamped by the bridge when it reads the key) to the
                      moment a listener on this PC receives the message. The tablet's clock is
                      aligned to this PC's by watching `date +%s` tick over a persistent SSH shell
                      (BusyBox `date` has no sub-second format); the estimate's error is about the
                      shell round trip / 2 plus one `date` fork, a few ms, and is printed.
    app wait          app receive → the text update carrying that key starts (performance.now on
                      the phone), logged by the app's keylat tracer (src/keylat.ts).
    glasses           that update's start → the host's answer (the G2 text update itself).
    app total         app receive → host answer: what the wearer waits after the phone has the key.

The kernel → bridge hop is not observable from outside: the Rust bridge stamps `ts` with the wall
clock when its blocking read returns (linux.rs, `KeyTranslator`), which is within a scheduler
wakeup of the kernel's own event time. The BLE hop (keyboard → controller) is bounded by the LE
connection interval (see `docs/investigations/keyboard-latency.md`).

Subcommands (run from the repo root with `uv run python scripts/dev/keylat.py …`):

    tap URL OUT [SECS]      listen to a router session, append one JSON line per `key` message
                            (`ts`, desktop receive ms, key) and clock samples to OUT. Joining with
                            the pairing code: ws://192.168.50.156:8577/ws/session1?token=…&replay=0
    clock HOST              print the tablet-minus-PC clock offset estimate (ms) and its error
    phonelog LOG OUT [SINCE]  pull the app tracer's records out of the dev server's phone log
                            (.codrawer/logs/phone.log) into OUT, optionally only after SINCE (ISO)
    inject URL N [GAP_MS]   type N keys into a (local) session as the bridge would, with a fresh
                            `ts`, GAP_MS apart (or replayed gaps from a tap file: GAP_MS=@tap.jsonl)
    relay URL N OUT         the router + Wi-Fi hop alone: two clients on this PC, one sends N keys
                            through the router to the other; records half of each trip (use a
                            scratch session, never session1)
    report FILE…            per-hop median and p95 (ms) over tap and phonelog files

Tap lines: {"kind":"key","ts":<tablet ms>,"recv":<PC ms>,"key":"a"};
clock lines: {"kind":"clock","offset":<tablet - PC, ms>,"err":<ms>}.
Phonelog lines: {"kind":"app","net":<ms or null>,"wait":<ms>,"glass":<ms>,"total":<ms>}.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import statistics
import subprocess
import sys
import time

# ── clock alignment ──────────────────────────────────────────────────────────────────────────────

CLOCK_PROBE = (
    # Per round: wait for a line from the PC, answer at once (the PC times that round trip), then
    # spin on `date +%s` until the second changes and print the new second. The line leaves the
    # tablet within one `date` fork (~5 ms measured on the Paper Pro) of the tick. The script is
    # the SSH command itself: fed through a remote shell's stdin, the loop never ran.
    'while read x; do echo r; p=$(date +%s); s=$p; '
    'while [ "$s" = "$p" ]; do s=$(date +%s); done; echo "$s"; done'
)


def clock_offset(host: str, rounds: int = 3) -> tuple[float, float]:
    """Tablet clock minus this PC's clock, ms, and the estimate's error bound (ms).

    One SSH session running CLOCK_PROBE; each round measures the session's round trip, then
    catches one second boundary. The tick happened between (arrival − rtt) and arrival; the
    midpoint is the estimate, half the round trip plus one fork its error. The best round wins.
    """
    sh = subprocess.Popen(
        ["ssh", "-T", "-o", "ConnectTimeout=8", "-o", "BatchMode=yes", f"root@{host}", CLOCK_PROBE],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, bufsize=1,
    )
    assert sh.stdin and sh.stdout
    try:
        best: tuple[float, float] | None = None
        for i in range(rounds + 1):
            t0 = time.time()
            sh.stdin.write("go\n")
            sh.stdin.flush()
            sh.stdout.readline()
            rtt = (time.time() - t0) * 1000
            line = sh.stdout.readline().strip()
            arrived = time.time() * 1000
            if not line.isdigit() or i == 0:  # the first round trip includes the session setup
                continue
            offset = int(line) * 1000 - (arrived - rtt / 2)
            err = rtt / 2 + 5
            if best is None or err < best[1]:
                best = (offset, err)
        if best is None:
            raise RuntimeError("clock probe got no tick")
        return best
    finally:
        sh.stdin.close()
        sh.terminate()


# ── tap: a listener on the router ────────────────────────────────────────────────────────────────

async def tap(url: str, out: str, secs: float, host: str | None) -> None:
    """Append every `key` message (and a clock sample every 2 min) to `out` for `secs` seconds."""
    import websockets

    def write(rec: dict) -> None:
        with open(out, "a", encoding="utf-8") as f:
            f.write(json.dumps(rec) + "\n")

    def sample_clock() -> None:
        if not host:
            return
        try:
            off, err = clock_offset(host)
            write({"kind": "clock", "offset": round(off, 1), "err": round(err, 1), "at": time.time() * 1000})
        except Exception as e:  # the tablet sleeps and drops SSH; the next sample will do
            print(f"[keylat] clock sample failed: {e}", file=sys.stderr)

    end = time.time() + secs
    next_clock = 0.0
    while time.time() < end:
        try:
            async with websockets.connect(url, open_timeout=10) as ws:
                print(f"[keylat] tapping {url}", file=sys.stderr)
                while time.time() < end:
                    if time.time() >= next_clock:
                        await asyncio.to_thread(sample_clock)
                        next_clock = time.time() + 120
                    try:
                        raw = await asyncio.wait_for(ws.recv(), timeout=5)
                    except asyncio.TimeoutError:
                        continue
                    recv = time.time() * 1000
                    m = json.loads(raw)
                    if m.get("t") == "key" and isinstance(m.get("ts"), (int, float)):
                        write({"kind": "key", "ts": m["ts"], "recv": round(recv, 1), "key": m.get("key")})
        except Exception as e:
            print(f"[keylat] reconnecting ({type(e).__name__}: {e})", file=sys.stderr)
            await asyncio.sleep(3)


# ── phonelog: the app tracer's records ───────────────────────────────────────────────────────────

APP_LINE = re.compile(r"^(\S+) \S+ log \[keylat\] (\{.*\})\s*$")


def phonelog(log: str, out: str, since: str | None) -> int:
    """Copy `[keylat] {...}` records (one JSON object of arrays per flush) from the phone log."""
    n = 0
    with open(log, encoding="utf-8", errors="replace") as f, open(out, "a", encoding="utf-8") as o:
        for line in f:
            m = APP_LINE.match(line)
            if not m or (since and m.group(1) < since):
                continue
            rec = json.loads(m.group(2))
            for i in range(len(rec.get("wait", []))):
                o.write(json.dumps({
                    "kind": "app", "at": m.group(1), "v": rec.get("v"),
                    **{k: rec[k][i] for k in ("net", "wait", "glass", "total") if k in rec},
                }) + "\n")
                n += 1
    return n


# ── inject: keys into a local session ────────────────────────────────────────────────────────────

async def inject(url: str, n: int, gaps: list[float]) -> None:
    """Send `n` printable key messages with a fresh `ts`, `gaps[i % len]` ms apart."""
    import websockets

    text = "the quick brown fox jumps over the lazy dog "
    async with websockets.connect(url) as ws:
        await ws.recv()  # hello
        for i in range(n):
            ch = text[i % len(text)]
            m = {"t": "key", "key": ch, "char": ch, "code": 0, "repeat": False,
                 "mods": {"shift": False, "ctrl": False, "alt": False, "meta": False},
                 "ts": int(time.time() * 1000)}
            await ws.send(json.dumps(m))
            await asyncio.sleep(gaps[i % len(gaps)] / 1000)
        # Escape clears the line so the next run starts from the same strip
        await ws.send(json.dumps({"t": "key", "key": "Escape", "code": 0, "repeat": False, "mods": {}, "ts": int(time.time() * 1000)}))


async def relay(url: str, n: int, out: str) -> None:
    """Router + Wi-Fi hop without the bridge: client A sends `n` key messages through the router
    to client B on this PC; half of each send → receive time is the one-way router hop. Use a
    scratch session (never session1): the keys land in that session's line editor."""
    import websockets

    async with websockets.connect(url) as a, websockets.connect(url) as b:
        await a.recv()
        await b.recv()
        with open(out, "a", encoding="utf-8") as f:
            for i in range(n):
                sent = time.time() * 1000
                await a.send(json.dumps({"t": "key", "key": "x", "char": "x", "code": 45, "repeat": False, "mods": {}, "ts": int(sent)}))
                while True:
                    m = json.loads(await b.recv())
                    if m.get("t") == "key":
                        break
                f.write(json.dumps({"kind": "relay", "half": round((time.time() * 1000 - sent) / 2, 1)}) + "\n")
                await asyncio.sleep(0.1)


def tap_gaps(path: str, cap_ms: float = 1000) -> list[float]:
    """Inter-key gaps (ms) from a tap file, idle gaps capped at `cap_ms` (pauses between bursts)."""
    ts = [r["ts"] for r in map(json.loads, open(path, encoding="utf-8")) if r.get("kind") == "key"]
    return [min(b - a, cap_ms) for a, b in zip(ts, ts[1:]) if b >= a] or [60.0]


# ── report ───────────────────────────────────────────────────────────────────────────────────────

def pct(xs: list[float], p: float) -> float:
    """The p-th percentile (nearest rank) of xs."""
    s = sorted(xs)
    return s[min(len(s) - 1, max(0, round(p / 100 * len(s) + 0.5) - 1))]


def report(paths: list[str]) -> None:
    """Median and p95 per hop, plus the typing cadence, over every record in `paths`."""
    recs = [json.loads(l) for p in paths for l in open(p, encoding="utf-8") if l.strip()]
    clocks = [r for r in recs if r["kind"] == "clock"]
    hops: dict[str, list[float]] = {}
    if clocks:
        off = min(clocks, key=lambda r: r["err"])
        keys = [r for r in recs if r["kind"] == "key"]
        # tablet ts → PC clock: ts - offset
        hops["bridge → LAN (tap)"] = [r["recv"] - (r["ts"] - off["offset"]) for r in keys]
        gaps = [b["ts"] - a["ts"] for a, b in zip(keys, keys[1:]) if 0 < b["ts"] - a["ts"] < 1000]
        if gaps:
            hops["inter-key gap (< 1 s)"] = gaps
        print(f"clock offset tablet-PC {off['offset']:.0f} ms +- {off['err']:.0f} ms ({len(clocks)} samples)")
    halves = [r["half"] for r in recs if r["kind"] == "relay"]
    if halves:
        hops["router + Wi-Fi (relay / 2)"] = halves
    for name, field in (("app wait (recv → send start)", "wait"), ("glasses text update", "glass"),
                        ("app total (recv → shown)", "total"), ("bridge → app (local clocks)", "net")):
        xs = [r[field] for r in recs if r["kind"] == "app" and r.get(field) is not None]
        if xs:
            hops[name] = xs
    print(f"{'hop':34} {'n':>5} {'median':>8} {'p95':>8}")
    for name, xs in hops.items():
        print(f"{name:34} {len(xs):5d} {statistics.median(xs):8.0f} {pct(xs, 95):8.0f}")


def main(argv: list[str]) -> None:
    if len(argv) < 2:
        print(__doc__)
        return
    cmd, args = argv[1], argv[2:]
    host = os.environ.get("CODRAWER_TABLET", "192.168.50.156")
    if cmd == "tap":
        asyncio.run(tap(args[0], args[1], float(args[2]) if len(args) > 2 else 900, host))
    elif cmd == "clock":
        off, err = clock_offset(args[0] if args else host)
        print(f"tablet - PC = {off:.1f} ms +- {err:.1f} ms")
    elif cmd == "phonelog":
        print(phonelog(args[0], args[1], args[2] if len(args) > 2 else None), "records")
    elif cmd == "inject":
        g = args[2] if len(args) > 2 else "80"
        gaps = tap_gaps(g[1:]) if g.startswith("@") else [float(g)]
        asyncio.run(inject(args[0], int(args[1]), gaps))
    elif cmd == "relay":
        asyncio.run(relay(args[0], int(args[1]), args[2]))
    elif cmd == "report":
        report(args)
    else:
        print(__doc__)


if __name__ == "__main__":
    main(sys.argv)
