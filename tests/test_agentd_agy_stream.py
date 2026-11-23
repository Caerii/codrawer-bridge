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


def test_idiolect_and_cross_page_thread(tmp_path: Path) -> None:
    from codrawer_bridge.agentd.idiolect import recognize_idiolect
    from codrawer_bridge.agentd.page import Stroke
    from codrawer_bridge.agentd.prompt import Ask, build_prompt
    from codrawer_bridge.agentd.threads import ThreadStore

    store = ThreadStore(tmp_path)
    store.add("doc-1", "page-1", "Let x = 2", "Then x^2 = 4.")
    nb = store.notebook_context("doc-1", "page-2")
    assert nb == [("Let x = 2", "Then x^2 = 4.")]

    p = build_prompt(Ask(kind="ask_page", image="p2.png", notebook_thread=nb, idiolect="lasso"))
    assert "other page 1, written: Let x = 2" in p
    assert "idiolect gesture: lasso" in p

    # Starburst: two crossing short strokes
    s1 = Stroke(id="u1", layer="user", tool="pen", pts=[[0.50, 0.50], [0.52, 0.50]])
    s2 = Stroke(id="u2", layer="user", tool="pen", pts=[[0.51, 0.49], [0.51, 0.51]])
    hit = recognize_idiolect([s1, s2], 1620.0, 2160.0)
    assert hit is not None and hit[0] == "star"


def test_pinned_notebook_recall_ack_and_pins(tmp_path: Path) -> None:
    from codrawer_bridge.agentd.idiolect import ack_messages
    from codrawer_bridge.agentd.prompt import clean_answer, extract_pins
    from codrawer_bridge.agentd.threads import ThreadStore

    store = ThreadStore(tmp_path)
    store.add("doc-9", "p1", "alpha = 0.05", "Significance level alpha is 0.05.")
    store.pin_last("doc-9", "p1")
    store.add("doc-9", "p2", "coffee sketch", "Nice mug.")
    nb = store.notebook_context("doc-9", "p3", query="alpha", limit=1)
    assert nb == [("alpha = 0.05", "Significance level alpha is 0.05.")]
    assert store.stats("doc-9") == (2, 1)

    raw = "PIN: Always check boundary conditions.\nChecked."
    assert extract_pins(raw) == ["Always check boundary conditions."]
    assert clean_answer(raw) == "Checked."

    ack = ack_messages("star", (100.0, 200.0, 200.0, 260.0), 1620.0, 2160.0, run="12")
    assert len(ack) == 3 and ack[0][1]["color"] == "#1e6091"


def test_multiscale_compaction_and_cross_notebook_fts(tmp_path: Path) -> None:
    from codrawer_bridge.agentd.threads import MAX_EXCHANGES, ThreadStore

    store = ThreadStore(tmp_path)
    # Fill beyond MAX_EXCHANGES so oldest turn compacts into page_digest
    for i in range(MAX_EXCHANGES + 2):
        store.add("nb-a", "p1", f"note {i} on architecture", f"insight {i}")
    assert len(store.get("nb-a", "p1")) == MAX_EXCHANGES
    assert "note 0 on architecture" in store.page_digest("nb-a", "p1")

    # Pin a durable memory in nb-a and verify cross-notebook Meta recall from nb-b
    store.add("nb-a", "p2", "superintelligent.group workflow", "Dispatch research via MCP.")
    assert store.pin_last("nb-a", "p2")
    gl = store.global_context("nb-b", query="superintelligent workflow")
    assert gl == [("superintelligent.group workflow", "Dispatch research via MCP.")]


def test_four_stroke_box_lasso_idiolect() -> None:
    from codrawer_bridge.agentd.idiolect import recognize_idiolect
    from codrawer_bridge.agentd.page import Stroke

    inner = Stroke(id="i1", layer="user", tool="pen", pts=[[0.40, 0.40], [0.45, 0.40]])
    top = Stroke(id="b1", layer="user", tool="pen", pts=[[0.35, 0.35], [0.55, 0.35]])
    bot = Stroke(id="b2", layer="user", tool="pen", pts=[[0.35, 0.45], [0.55, 0.45]])
    left = Stroke(id="b3", layer="user", tool="pen", pts=[[0.35, 0.35], [0.35, 0.45]])
    right = Stroke(id="b4", layer="user", tool="pen", pts=[[0.55, 0.35], [0.55, 0.45]])
    hit = recognize_idiolect([inner, top, bot, left, right], 1620.0, 2160.0)
    assert hit is not None and hit[0] == "lasso"


def test_sketch_primitives_and_messages() -> None:
    from codrawer_bridge.agentd.marks import extract_sketches, sketch_messages
    from codrawer_bridge.agentd.prompt import clean_answer

    raw = (
        "SKETCH: box 0.1 0.1 0.4 0.4 #1f6fe0\n"
        "SKETCH: curve 0.4,0.25 0.55,0.1 0.7,0.25\n"
        "SKETCH: poly 0.7,0.2 0.8,0.3 0.7,0.4\n"
        "Here is a quick diagram."
    )
    sketches = extract_sketches(raw)
    assert [s[0] for s in sketches] == ["box", "curve", "poly"]
    assert sketches[0][2] == "#1f6fe0"
    assert clean_answer(raw) == "Here is a quick diagram."
    msgs = sketch_messages(sketches, (100.0, 200.0, 600.0, 600.0), 1620.0, 2160.0, run="21")
    assert len(msgs) == 9


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
