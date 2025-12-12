from __future__ import annotations

import argparse
import asyncio
import json
from pathlib import Path

import websockets


async def replay(
    ws_url: str,
    jsonl_path: Path,
    *,
    speed: float = 1.0,
    default_dt_ms: int = 0,
    only_t_prefix: str | None = None,
) -> None:
    """
    Replay previously-recorded JSONL into a websocket.

    Expected JSONL format:
      - record_jsonl.py output: {"ts": <ms>, "msg": {...}}
      - or raw messages per line: {...}
    """
    lines = jsonl_path.read_text(encoding="utf-8").splitlines()
    events: list[tuple[int | None, dict]] = []

    for line in lines:
        if not line.strip():
            continue
        obj = json.loads(line)
        if isinstance(obj, dict) and "msg" in obj and isinstance(obj["msg"], dict):
            ts = obj.get("ts")
            events.append((int(ts) if isinstance(ts, (int, float)) else None, obj["msg"]))
        elif isinstance(obj, dict):
            events.append((None, obj))

    async with websockets.connect(ws_url, max_size=2**22) as ws:
        prev_ts: int | None = None
        for ts, msg in events:
            t = msg.get("t")
            if only_t_prefix and (not isinstance(t, str) or not t.startswith(only_t_prefix)):
                continue

            if ts is not None and prev_ts is not None:
                dt_ms = max(0, ts - prev_ts)
            else:
                dt_ms = default_dt_ms

            prev_ts = ts if ts is not None else prev_ts
            if dt_ms:
                await asyncio.sleep((dt_ms / 1000.0) / max(0.01, speed))

            await ws.send(json.dumps(msg, ensure_ascii=False, separators=(",", ":")))


def main() -> None:
    ap = argparse.ArgumentParser(description="Replay stroke JSONL into the server websocket.")
    ap.add_argument("--ws", required=True, help="WebSocket URL, e.g. ws://127.0.0.1:8000/ws/session1")
    ap.add_argument("--in", dest="inp", required=True, help="Input JSONL path")
    ap.add_argument("--speed", type=float, default=1.0, help="Speed multiplier (2.0 = 2x faster)")
    ap.add_argument("--default-dt-ms", type=int, default=0, help="Delay between messages if no timestamps")
    ap.add_argument(
        "--only-t-prefix",
        default=None,
        help="If set, only replay messages whose 't' starts with this prefix (e.g. 'stroke_').",
    )
    args = ap.parse_args()

    asyncio.run(
        replay(
            args.ws,
            Path(args.inp),
            speed=args.speed,
            default_dt_ms=args.default_dt_ms,
            only_t_prefix=args.only_t_prefix,
        )
    )


if __name__ == "__main__":
    main()


