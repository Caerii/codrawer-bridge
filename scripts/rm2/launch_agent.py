"""On-tablet launcher; keys are loaded by systemd, never sent in command-line arguments."""

import os
import sys
from pathlib import Path

from codrawer_bridge.agentd.__main__ import main

root = Path("/home/root/codrawer-agent")
os.environ["CODRAWER_ROUTER_TOKEN"] = os.environ.get("ROUTER_TOKEN", "")
raise SystemExit(
    main(
        [
            "--backend",
            "anthropic-api",
            "--ws",
            "ws://127.0.0.1:8577/ws/session1",
            "--term-cwd",
            str(root),
            "--state-dir",
            str(root / "state"),
            "--model",
            "claude-sonnet-4-5-20250929",
            "--fast-model",
            "claude-haiku-4-5-20251001",
            "--thinking",
            "overlay",
            "--ink",
            "on",
            "--pool",
            "1",
        ]
        + sys.argv[1:]
    )
)
