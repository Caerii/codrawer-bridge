"""Unit tests for the ``agy-stream`` warm-pool backend."""

from __future__ import annotations

import asyncio
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


def test_extract_sets_and_clean_answer() -> None:
    from codrawer_bridge.agentd.prompt import answer_so_far, clean_answer, extract_sets

    raw = (
        "SEEN: switch to mathematician and drop\n"
        "SET: persona=mathematician\n"
        "SET: thinking_style=drop\n"
        "SET: memory=off\n"
        "Switched to mathematician with cloud thinking."
    )
    assert extract_sets(raw) == {
        "persona": "mathematician",
        "thinking_style": "drop",
        "memory": False,
    }
    assert clean_answer(answer_so_far(raw)) == "Switched to mathematician with cloud thinking."


def test_persona_prosody_and_ornamental_marks() -> None:
    from codrawer_bridge.agentd.hand import Layout, apply_prosody
    from codrawer_bridge.agentd.marks import extract_marks, mark_messages

    for persona in ("calligrapher", "sketcher", "mathematician", "elder"):
        pts = [[float(i), float((i % 3) * 2), 0.5, float(i * 10)] for i in range(10)]
        lay = Layout(
            width_mm=80.0,
            bbox_mm=(0.0, 0.0, 9.0, 2.0),
            duration_ms=90.0,
            strokes=[(0.0, 90.0, pts)],
        )
        apply_prosody([lay], persona=persona)
        assert all(0.06 <= p[2] <= 1.0 for p in pts)

    marks, prose = extract_marks("MARK: bracket 0.1 0.1 0.1 0.8\nMARK: star 0.9 0.2 0.9 0.2\nGood.")
    assert [m[0] for m in marks] == ["bracket", "star"]
    assert prose == "Good."
    msgs = mark_messages(marks, (100.0, 200.0, 500.0, 600.0), 1620.0, 2160.0, run="7")
    assert len(msgs) == 6


def test_persona_voice_in_prompt() -> None:
    from codrawer_bridge.agentd.prompt import PERSONA_VOICES, Ask, build_prompt

    for persona in PERSONA_VOICES:
        p = build_prompt(Ask(kind="ask_page", image="page.png", persona=persona))
        assert PERSONA_VOICES[persona] in p


def test_calligrapher_resampling_and_combined_directives() -> None:
    from codrawer_bridge.agentd.hand import Layout, apply_prosody
    from codrawer_bridge.agentd.marks import extract_marks
    from codrawer_bridge.agentd.prompt import clean_answer, extract_sets, split_seen

    lay = Layout(
        width_mm=80.0,
        bbox_mm=(0.0, 0.0, 5.0, 2.0),
        duration_ms=40.0,
        strokes=[(0.0, 40.0, [[0.0, 0.0, 0.5, 0.0], [3.0, 2.0, 0.5, 20.0], [5.0, 0.0, 0.5, 40.0]])],
    )
    apply_prosody([lay], persona="calligrapher")
    assert len(lay.strokes[0][2]) > 3

    raw = (
        "SEEN: f(x) = x^2\n"
        "SET: persona=sketcher\n"
        "MARK: bracket 0.1 0.2 0.1 0.8\n"
        "Differentiate term by term."
    )
    seen, body = split_seen(raw)
    assert seen == "f(x) = x^2"
    assert extract_sets(body) == {"persona": "sketcher"}
    marks, prose = extract_marks(body)
    assert marks[0][0] == "bracket"
    assert clean_answer(prose) == "Differentiate term by term."


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
    assert any(m["t"] == "stroke_begin" for _, m in msgs)
    assert any(m["t"] == "stroke_pts" for _, m in msgs)
    assert any(m["t"] == "stroke_end" for _, m in msgs)


def test_autopilot_triggers_after_user_stroke_end(tmp_path: Path) -> None:
    from codrawer_bridge.agentd.service import Agentd, Config

    async def go() -> list[dict]:
        a = Agentd(Config(ws="ws://x", term_cwd=str(tmp_path), backend="agy-stream", dry_run=True))
        triggered: list[dict] = []

        async def fake_answer(msg: dict) -> None:
            triggered.append(msg)

        a.answer = fake_answer  # type: ignore[method-assign]
        a.handle(
            {"t": "page", "doc": "d1", "page": "p1", "rev": 1, "w": 1620, "h": 2160, "strokes": []}
        )
        a.handle({"t": "stroke_begin", "id": "u1", "layer": "user", "brush": "pen"})
        a.handle({"t": "stroke_pts", "id": "u1", "pts": [[0.1, 0.1, 0.5, 10], [0.2, 0.1, 0.5, 20]]})
        a.handle({"t": "stroke_end", "id": "u1"})
        assert a._autopilot_task is not None
        a._autopilot_task.cancel()
        a._schedule_autopilot(reset=True, delay_s=0.05)
        await asyncio.sleep(0.15)
        if a.claude is not None:
            await a.claude.close()
        return triggered

    out = asyncio.run(go())
    assert len(out) == 1
    assert out[0]["id"] == "ask_selection" and out[0]["source"] == "autopilot"
    assert "bbox" in out[0] and "spot" in out[0]
