from __future__ import annotations

import argparse
import asyncio
import json
import time
from pathlib import Path

import websockets


def _now_ms() -> int:
    return int(time.time() * 1000)


async def record(ws_url: str, out_path: Path, *, echo: bool) -> None:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with out_path.open("a", encoding="utf-8") as f:
        async with websockets.connect(ws_url, max_size=2**22) as ws:
            while True:
                raw = await ws.recv()
                if isinstance(raw, bytes):
                    raw = raw.decode("utf-8", errors="replace")
                msg = json.loads(raw)
                if echo:
                    t = msg.get("t") if isinstance(msg, dict) else None
                    print(f"[record] t={t} msg={msg}")
                f.write(json.dumps({"ts": _now_ms(), "msg": msg}, ensure_ascii=False) + "\n")
                f.flush()


def main() -> None:
    ap = argparse.ArgumentParser(description="Record WS traffic to a JSONL file.")
    ap.add_argument("--ws", required=True, help="WebSocket URL, e.g. ws://127.0.0.1:8000/ws/session1")
    ap.add_argument("--out", required=True, help="Output JSONL path")
    ap.add_argument("--print", action="store_true", help="Print received messages to stdout")
    args = ap.parse_args()

    asyncio.run(record(args.ws, Path(args.out), echo=args.print))


if __name__ == "__main__":
    main()


