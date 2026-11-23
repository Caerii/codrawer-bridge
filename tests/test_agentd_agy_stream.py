"""Unit tests for the ``agy-stream`` warm-pool backend."""

from __future__ import annotations

import json
from pathlib import Path

from codrawer_bridge.agentd.agy_stream import agy_command, agy_user_message
from codrawer_bridge.agentd.config import parse


def test_agy_command_and_user_message(tmp_path: Path) -> None:
    cmd = agy_command("gemini-4-neon-medium", exe="agy", add_dirs=(tmp_path,))
    assert cmd[:6] == [
        "agy",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--model",
    ]
    assert "gemini-4-neon-medium" in cmd
    assert "--add-dir" in cmd and str(tmp_path) in cmd

    raw = agy_user_message("hello")
    payload = json.loads(raw.decode("utf-8"))
    assert payload == {"event": "user", "message": {"content": "hello"}}


def test_config_accepts_agy_stream() -> None:
    cfg = parse(
        """
[tablet]
host = "root@192.168.50.156"

[agentd]
backend = "agy-stream"
model = "gemini-4-neon-medium"
fast_model = "gemini-3.8-flash-low"
"""
    )
    assert cfg.agentd.backend == "agy-stream"
    assert cfg.agentd.model == "gemini-4-neon-medium"
    assert cfg.agentd.fast_model == "gemini-3.8-flash-low"
