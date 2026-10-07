"""
A stand-in for ``claude -p --input-format stream-json --output-format stream-json`` (tests).

Reads one JSON user message per stdin line and answers as Claude Code does (claude_stream.py):
the warm-up turn ("ready") with a result; a real turn with stream_event text deltas and a
result. ``FAKE_CLAUDE`` picks the behaviour of real turns:

- ``ok`` (default): "SEEN: <what>" then the answer, in a few deltas;
- ``slow``: the same after ``FAKE_DELAY`` seconds (default 0.5);
- ``hang``: never answers;
- ``crash``: exits at once;
- ``error``: a result with ``subtype`` ``error_during_execution``.

Each process appends its pid to ``FAKE_LOG`` (if set) when it serves a real turn, so a test can
check that no process serves two.
"""

import json
import os
import sys
import time


def emit(obj) -> None:
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def main() -> None:
    mode = os.environ.get("FAKE_CLAUDE", "ok")
    emit({"type": "system", "subtype": "init", "tools": [], "model": "fake"})
    for line in sys.stdin:
        msg = json.loads(line)
        content = msg["message"]["content"]
        text = next(c["text"] for c in content if c["type"] == "text")
        if "ready" in text and len(text) < 60:
            emit({"type": "result", "subtype": "success", "result": "ready"})
            continue
        if os.environ.get("FAKE_LOG"):
            with open(os.environ["FAKE_LOG"], "a") as f:
                f.write(f"{os.getpid()}\n")
        if mode == "crash":
            sys.exit(1)
        if mode == "hang":
            time.sleep(3600)
        if mode == "slow":
            time.sleep(float(os.environ.get("FAKE_DELAY", "0.5")))
        if mode == "error":
            emit({"type": "result", "subtype": "error_during_execution", "result": "boom"})
            continue
        has_image = any(c["type"] == "image" for c in content)
        reply = f"SEEN: a circled word\nA circled word{' with an image' if has_image else ''}."
        for i in range(0, len(reply), 7):
            emit(
                {
                    "type": "stream_event",
                    "event": {
                        "type": "content_block_delta",
                        "delta": {"type": "text_delta", "text": reply[i : i + 7]},
                    },
                }
            )
        emit({"type": "result", "subtype": "success", "result": reply})


if __name__ == "__main__":
    main()
