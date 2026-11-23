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


def test_clause_streaming_and_prosody() -> None:
    from codrawer_bridge.agentd.hand import Layout, apply_prosody
    from codrawer_bridge.agentd.prompt import ready_sentences

    s = "When ink flows smoothly across the page, it feels alive."
    chunks, used = ready_sentences(s, 0, allow_clause=True)
    assert chunks == ["When ink flows smoothly across the page,"]
    assert s[used:].strip() == "it feels alive."

    pts = [[float(i), 0.0, 0.5, float(i * 10)] for i in range(12)]
    lay = Layout(
        width_mm=80.0,
        bbox_mm=(0.0, 0.0, 11.0, 1.0),
        duration_ms=110.0,
        strokes=[(0.0, 110.0, pts)],
    )
    apply_prosody([lay])
    assert pts[0][2] < pts[5][2]  # gentle attack < mid-stroke swell
    assert pts[-1][2] < pts[5][2]  # tapered lift-off < mid-stroke swell


def test_marks_extraction_and_strokes() -> None:
    from codrawer_bridge.agentd.marks import extract_marks, mark_messages
    from codrawer_bridge.agentd.prompt import clean_answer

    raw = "MARK: circle 0.1 0.2 0.8 0.9\nMARK: underline 0.2 0.7 0.7 0.7\nNice insight here."
    marks, prose = extract_marks(raw)
    assert len(marks) == 2
    assert marks[0][0] == "circle" and marks[1][0] == "underline"
    assert prose == "Nice insight here."
    assert clean_answer(raw) == "Nice insight here."

    msgs = mark_messages(marks, (100.0, 200.0, 500.0, 400.0), 1620.0, 2160.0, run="99")
    assert any(m["t"] == "stroke_start" for _, m in msgs)
    assert any(m["t"] == "stroke_pts" for _, m in msgs)
    assert any(m["t"] == "stroke_end" for _, m in msgs)
