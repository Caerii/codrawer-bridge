"""
Tests for the Primer (src/codrawer_bridge/primer, ADR 010). All offline: no API key, no
network. A prover or TeX engine on PATH is used when present and the test says which.
"""

from __future__ import annotations

import asyncio
import datetime as dt
import json
import math

import pytest

from codrawer_bridge.primer import assess, check, coach, latex, policy, practice
from codrawer_bridge.primer.agent import PrimerAgent
from codrawer_bridge.primer.concepts import (
    CONCEPTS,
    MISCONCEPTIONS,
    check_graph,
    prereq_closure,
    topological_order,
)
from codrawer_bridge.primer.ink_signals import InkLog, LullDetector, line_features, segment_lines
from codrawer_bridge.primer.learner import (
    DAY_MS,
    P_GUESS,
    P_SLIP,
    P_TRANSIT,
    Learner,
    LearnerStore,
    bkt_posterior,
    bkt_update,
    effective_credit,
    safe_name,
)
from codrawer_bridge.primer.recognize import (
    FIXTURES,
    OfflineRecognizer,
    load_fixture,
    load_recording,
)

NOW = 1_759_800_000_000.0


def fixture_log(name: str) -> InkLog:
    log = InkLog()
    for m in load_recording(FIXTURES / f"{name}.jsonl"):
        log.observe(m)
    return log


def expected(name: str) -> dict:
    return json.loads((FIXTURES / f"{name}.expected.json").read_text(encoding="utf-8"))


# =============================================================================================
# The task model
# =============================================================================================


def test_concept_graph_is_sound():
    assert check_graph() == []
    order = topological_order()
    assert len(order) == len(CONCEPTS)
    pos = {c: i for i, c in enumerate(order)}
    for cid, c in CONCEPTS.items():
        assert cid not in prereq_closure(cid), f"{cid} depends on itself"
        for p in c.prereqs:
            assert pos[p] < pos[cid]


def test_graph_reaches_putnam_topics_and_catalog_is_first_class():
    areas = {c.area for c in CONCEPTS.values()}
    for a in (
        "number_theory",
        "inequalities",
        "polynomials",
        "combinatorics",
        "linear_algebra",
        "analysis",
        "probability",
        "functional_equations",
        "complex",
    ):
        assert a in areas
    for cid in (
        "pigeonhole",
        "invariants",
        "monovariants",
        "extremal_principle",
        "strong_induction",
        "am_gm",
        "cauchy_schwarz",
        "vieta",
        "eigenvalues",
        "mvt",
        "generating_functions",
        "roots_of_unity",
    ):
        assert cid in CONCEPTS
    kinds = {m.kind for m in MISCONCEPTIONS.values()}
    assert kinds == {"misconception", "missing_rigor", "exposition"}
    for mid in (
        "assumes_conclusion",
        "converse_confusion",
        "square_parity_unproved",
        "sqrt2_no_lowest_terms",
        "induction_no_hypothesis",
        "quantifier_swap",
    ):
        assert mid in MISCONCEPTIONS


def test_bank_problems_reference_known_concepts():
    for p in practice.BANK.values():
        assert p.concepts and all(c in CONCEPTS for c in p.concepts), p.id
        assert 1 <= p.difficulty <= 5 and p.key_idea


# =============================================================================================
# BKT
# =============================================================================================


def test_bkt_posteriors_match_the_formula():
    p = 0.3
    correct = p * (1 - P_SLIP) / (p * (1 - P_SLIP) + (1 - p) * P_GUESS)
    wrong = p * P_SLIP / (p * P_SLIP + (1 - p) * (1 - P_GUESS))
    assert bkt_posterior(p, True) == pytest.approx(correct)
    assert bkt_posterior(p, False) == pytest.approx(wrong)
    assert bkt_update(p, 1.0) == pytest.approx(correct + (1 - correct) * P_TRANSIT)
    assert bkt_update(p, 0.0) == pytest.approx(wrong + (1 - wrong) * P_TRANSIT)
    half = 0.5 * correct + 0.5 * wrong
    assert bkt_update(p, 0.5) == pytest.approx(half + (1 - half) * P_TRANSIT)


def test_bkt_update_properties():
    assert bkt_update(0.4, 1.0, weight=0.0) == pytest.approx(0.4)
    ups = [bkt_update(0.4, c) for c in (0.0, 0.25, 0.5, 0.75, 1.0)]
    assert ups == sorted(ups)
    p = 0.2
    for _ in range(8):
        p = bkt_update(p, 1.0)
    assert p > 0.95
    q = 0.9
    for _ in range(3):
        q = bkt_update(q, 0.0)
    assert q < 0.6


def test_help_and_hesitation_reduce_credit():
    assert effective_credit(1.0) == 1.0
    assert effective_credit(1.0, hint_level=2) == pytest.approx(0.5)
    assert effective_credit(1.0, hesitation=1.0) == pytest.approx(0.7)
    assert effective_credit(1.0, hint_level=9) == 0.0


def test_learner_file_roundtrip_review_and_delete(tmp_path):
    store = LearnerStore(tmp_path)
    lr = store.load("Nell Primer!")
    assert lr.name == safe_name("Nell Primer!") == "nell-primer"
    lr.observe("parity", 1.0, now_ms=NOW)
    lr.saw_misconception("sqrt2_no_lowest_terms", NOW)
    path = store.save(lr)
    assert path.parent == tmp_path / "primer" / "learners"
    back = store.load("nell-primer")
    assert back.concepts["parity"].p == pytest.approx(lr.concepts["parity"].p)
    assert (
        back.evidence[0].concept == "parity"
        and back.evidence[0].p_after > back.evidence[0].p_before
    )
    # A success doubles the half-life from one day: due once recall falls under 0.5 (> 2 days).
    assert back.due(NOW + 1 * DAY_MS) == []
    assert "parity" in back.due(NOW + 3 * DAY_MS)
    assert store.delete("nell-primer") and not path.exists()


def test_misconception_stops_recurring_after_two_clean_turns():
    lr = Learner(name="t", created_ms=NOW)
    lr.saw_misconception("sqrt2_no_lowest_terms", NOW)
    assert lr.misconceptions["sqrt2_no_lowest_terms"].recurring
    lr.clean_turn_for({"rationality"}, set())
    lr.clean_turn_for({"induction"}, set())  # unrelated concepts: no credit
    assert lr.misconceptions["sqrt2_no_lowest_terms"].recurring
    lr.clean_turn_for({"irrationality"}, set())
    assert not lr.misconceptions["sqrt2_no_lowest_terms"].recurring


# =============================================================================================
# Ink signals on synthetic timing
# =============================================================================================


def _line_msgs(
    sid_base: str,
    y: float,
    t0: float,
    n: int = 4,
    brush: str = "pen",
    dur: float = 300.0,
    gap: float = 200.0,
):
    """n short horizontal strokes on one line, each `dur` ms long, `gap` ms apart."""
    msgs, t = [], t0
    for i in range(n):
        sid = f"{sid_base}{i}"
        x = 0.1 + 0.08 * i
        msgs.append({"t": "stroke_begin", "id": sid, "layer": "user", "brush": brush, "ts": t})
        msgs.append(
            {
                "t": "stroke_pts",
                "id": sid,
                "pts": [
                    [x, y, 0.5, t],
                    [x + 0.03, y + 0.005, 0.5, t + dur / 2],
                    [x + 0.05, y, 0.5, t + dur],
                ],
            }
        )
        msgs.append({"t": "stroke_end", "id": sid, "ts": t + dur})
        t += dur + gap
    return msgs, t


def test_ink_signals_find_the_pause_the_erasure_and_the_rewrite():
    log = InkLog()
    m1, t = _line_msgs("a", 0.20, 0.0)
    m2, t = _line_msgs("b", 0.30, t + 1500)
    # erase line 2's strokes, then rewrite one of them
    erase = [
        {"t": "stroke_begin", "id": "e0", "layer": "user", "brush": "eraser", "ts": t + 500},
        {
            "t": "stroke_pts",
            "id": "e0",
            "pts": [
                [0.1 + 0.01 * k, 0.30 + (0.004 if k % 2 else -0.004), 0.5, t + 500 + 20 * k]
                for k in range(32)
            ],
        },
        {"t": "stroke_end", "id": "e0", "ts": t + 1200},
    ]
    re_, t = _line_msgs("r", 0.302, t + 2500, n=2)
    m3, _ = _line_msgs("c", 0.40, t + 12000)  # a 12 s pause before line 3
    for m in m1 + m2 + erase + re_ + m3:
        log.observe(m)
    lines = segment_lines(log.ink())
    assert len(lines) == 3
    sig = {s.line: s for s in line_features(log, lines)}
    assert sig[3].pause_before_ms == pytest.approx(12200)  # 12 s plus the last inter-stroke gap
    assert sig[2].erasures == 1 and sig[2].removed >= 3 and sig[2].rewrites >= 1
    assert sig[3].hesitation > 0.5 and sig[2].hesitation > 0.5
    assert sig[1].hesitation < 0.3


def test_crossout_is_a_long_straight_stroke_over_ink():
    log = InkLog()
    msgs, t = _line_msgs("w", 0.5, 0.0, n=4)
    msgs += [
        {"t": "stroke_begin", "id": "x", "layer": "user", "ts": t + 400},
        {
            "t": "stroke_pts",
            "id": "x",
            "pts": [[0.09 + 0.03 * k, 0.502, 0.5, t + 400 + 10 * k] for k in range(12)],
        },
        {"t": "stroke_end", "id": "x", "ts": t + 520},
    ]
    for m in msgs:
        log.observe(m)
    sig = line_features(log, segment_lines(log.ink()))
    assert sig[0].crossouts == 1


def test_lull_detector_adapts_to_the_writer():
    det = LullDetector(min_ms=4000, max_ms=15000)
    log = InkLog()
    t = 0.0
    for i in range(10):
        det.stroke_begin(t)
        log.observe({"t": "stroke_begin", "id": f"s{i}", "ts": t}, t)
        log.observe({"t": "stroke_end", "id": f"s{i}", "ts": t + 200}, t + 200)
        det.stroke_end(t + 200)
        t += 200 + 2000  # a deliberate writer: 2 s between strokes
    assert det.threshold_ms() == pytest.approx(6000)
    last = t - 2000
    assert det.state(log, last + 3000) == "mid_thought"
    assert det.state(log, last + 6500) == "lull"
    log.observe({"t": "stroke_begin", "id": "down", "ts": last + 7000}, last + 7000)
    assert det.state(log, last + 20000) == "writing"


def test_fixture_ink_segments_into_its_written_lines():
    for name, n in (("sqrt2_correct", 8), ("sqrt2_flawed", 6), ("odd_sum", 6)):
        log = fixture_log(name)
        lines = segment_lines(log.ink())
        assert len(lines) == n, name
        sig = {s.line: s for s in line_features(log, lines)}
        for ln in expected(name)["hesitant_lines"]:
            assert sig[ln].hesitation >= 0.5, (name, ln, sig[ln])


# =============================================================================================
# Recognition (offline), assessment, the move
# =============================================================================================


@pytest.mark.parametrize("name", ["sqrt2_correct", "sqrt2_flawed", "odd_sum"])
def test_offline_recognition_and_assessment_match_expectations(name):
    rec = OfflineRecognizer()
    log = fixture_log(name)
    assert rec.match(log) == name
    doc = rec.recognize(log)
    assert doc.source == f"offline:{name}" and doc.steps
    assert all(s.strokes and s.bbox for s in doc.steps), "every step is tied to its ink"
    assess.assess(doc)
    exp = expected(name)
    assert sorted([f.id, f.step] for f in doc.findings) == sorted(exp["findings"])
    assert {str(s.n): s.status for s in doc.steps} == exp["statuses"]
    assert doc.grade is not None and doc.grade.estimate
    assert (doc.grade.score, doc.grade.band) == (exp["grade"]["score"], exp["grade"]["band"])


def test_flawed_proof_gets_a_socratic_question_about_the_missing_step():
    doc = OfflineRecognizer().recognize(fixture_log("sqrt2_flawed"))
    assess.assess(doc)
    move = policy.choose_move(doc, Learner(name="t", created_ms=NOW), request="proof")
    assert (move.kind, move.step, move.finding) == ("socratic", 6, "sqrt2_no_lowest_terms")
    assert "?" in move.text and "assume" in move.text
    assert len(move.glance) <= policy.GLANCE_MAX


def test_hint_ladder_protects_productive_struggle():
    doc = OfflineRecognizer().recognize(fixture_log("sqrt2_flawed"))
    assess.assess(doc)
    lr = Learner(name="t", created_ms=NOW)
    hs = policy.HintState()
    first = policy.choose_move(doc, lr, request="proof", hints=hs)
    assert first.kind == "socratic" and hs.level == 0  # no hint unless asked
    ladder = MISCONCEPTIONS["sqrt2_no_lowest_terms"].hints
    for i in range(len(ladder)):
        m = policy.choose_move(doc, lr, request="hint", hints=hs)
        assert (m.kind, m.hint_level, m.text) == ("hint", i + 1, ladder[i])
    example = policy.choose_move(doc, lr, request="hint", hints=hs)
    assert example.kind == "worked_example" and "√3" in example.text  # another problem, not hers
    last = policy.choose_move(doc, lr, request="hint", hints=hs)
    assert last.kind == "hint" and "last hint" in last.text


def test_silence_while_mid_thought_unless_asked():
    doc = load_fixture("sqrt2_flawed")
    assess.assess(doc)
    lr = Learner(name="t", created_ms=NOW)
    assert policy.choose_move(doc, lr, request="auto", lull="mid_thought").kind == "silence"
    assert policy.choose_move(doc, lr, request="auto", lull="writing").kind == "silence"
    assert policy.choose_move(doc, lr, request="proof", lull="writing").kind == "socratic"


def test_unknown_ink_offline_is_honest():
    log = InkLog()
    for m in _line_msgs("z", 0.5, 0.0)[0]:
        log.observe(m)
    doc = OfflineRecognizer().recognize(log)
    assert doc.steps == [] and doc.source == "offline:none"
    move = policy.choose_move(doc, Learner(name="t", created_ms=NOW), request="proof")
    assert move.kind == "notice" and "offline" in move.text


def test_pacing_nudges_train_triage():
    assert "start with" in policy.pacing_nudge(5, 0)
    assert policy.pacing_nudge(15, 0) is None
    assert "Half an hour" in policy.pacing_nudge(31, 0)
    assert "write up" in policy.pacing_nudge(81, 1).lower()


# =============================================================================================
# LaTeX and the formal check
# =============================================================================================


@pytest.mark.parametrize("name", ["sqrt2_correct", "sqrt2_flawed", "odd_sum"])
def test_latex_is_well_formed_and_compiles_when_an_engine_exists(name):
    doc = load_fixture(name)
    assess.assess(doc)
    tex = latex.to_tex(doc)
    assert latex.syntax_problems(tex) == []
    assert all(ord(c) < 128 for c in tex), "pdfLaTeX-safe"
    if latex.tex_engine() is None:
        pytest.skip("no TeX engine installed: syntax check only")
    pdf, log = latex.compile_tex(tex)
    if pdf is None and ("network" in log.lower() or "download" in log.lower()):
        pytest.skip(f"engine could not fetch packages offline: {log[:120]}")
    assert pdf is not None and pdf[:4] == b"%PDF", log


def test_formal_check_never_claims_without_a_run(monkeypatch):
    assert check.run(None).status == "not_checked"
    monkeypatch.setattr(check, "provers", lambda: {})
    assert check.run("theorem t : True := trivial").status == "not_checked"
    monkeypatch.setattr(check, "provers", lambda: {"lean": "lean"})
    r = check.run("theorem t : 1 = 2 := by sorry")
    assert r.status == "failed" and "sorry" in r.detail


@pytest.mark.skipif(not check.provers().get("lean"), reason="lean is not installed")
def test_lean_checks_the_fixture_formalizations():
    ok = check.run(load_fixture("sqrt2_correct").formal, "fixture")
    assert ok.status == "checked", ok.detail
    assert check.run(load_fixture("odd_sum").formal, "fixture").status == "checked"
    bad = check.run(load_fixture("sqrt2_flawed").formal, "fixture")
    assert bad.status == "failed" and "step 6" in bad.detail


# =============================================================================================
# Practice, the plan, the coach
# =============================================================================================


def test_plan_runs_to_the_exam_with_saturday_mocks():
    lr = Learner(name="t", created_ms=NOW)
    p = practice.plan(lr, "2026-10-06")
    assert p["exam"] == "2026-12-05" and p["days_left"] == 60
    assert p["weeks"][0]["start"] == "2026-10-05"
    assert p["weeks"][-1]["exam"] == "2026-12-05"
    mocks = [w["mock"] for w in p["weeks"] if w["mock"]]
    assert mocks == ["2026-10-24", "2026-11-07", "2026-11-21"]
    assert all(dt.date.fromisoformat(m).weekday() == 5 for m in mocks)
    assert p["weeks"][-1]["mock"] is None, "the last week tapers"


def test_timed_sessions_follow_the_2026_format():
    lr = Learner(name="t", created_ms=NOW)
    s = practice.timed_session(lr, NOW, seed=1)
    assert s["minutes"] == 90 and len(s["problems"]) == 3
    assert len({p["id"] for p in s["problems"]}) == 3
    m = practice.mock_exam(lr, NOW, seed=1)
    assert len(m["sessions"]) == 4 and m["breaks"] == [15, 105, 15]
    with pytest.raises(ValueError):
        practice.putnam_ref(1995, "C", 1)
    ref = practice.putnam_ref(1995, "B", 1)
    assert ref.id == "putnam_1995_B1" and "kskedlaya.org" in ref.statement


def test_queue_explains_every_pick_and_follows_reading():
    lr = Learner(name="t", created_ms=NOW)
    lr.consent = lr.watching = True
    coach.note_reading(
        lr, {"t": "page", "doc": "d1", "page": "p7", "title": "Engel 4 Pigeonhole"}, NOW
    )
    picks = practice.choose_queue(
        lr, NOW, n=4, reading_keywords=coach.reading_keywords(lr, NOW + 60_000)
    )
    assert picks[0].kind == "reading" and picks[0].problem == "pigeonhole_square"
    assert all(p.why for p in picks)


def test_queue_targets_a_weak_spot_with_a_fresh_problem():
    lr = Learner(name="t", created_ms=NOW)
    lr.seen.append("sqrt2_irrational")
    for _ in range(2):
        lr.saw_misconception("sqrt2_no_lowest_terms", NOW)
        lr.observe("irrationality", 0.0, now_ms=NOW)
    picks = practice.choose_queue(lr, NOW, n=4)
    weak = [p for p in picks if p.kind == "weakness"]
    assert weak and weak[0].problem == "sqrt3_irrational"
    assert "weak spot" in weak[0].why


def test_coach_watches_only_with_consent():
    lr = Learner(name="t", created_ms=NOW)
    doc = load_fixture("sqrt2_flawed")
    assess.assess(doc)
    assert coach.note_reading(lr, {"doc": "d", "page": "p", "title": "x"}, NOW) is None
    assert coach.log_attempt(lr, doc, now_ms=NOW, minutes=12, hints=0) is None
    lr.consent = lr.watching = True
    a = coach.log_attempt(lr, doc, now_ms=NOW, minutes=12, hints=0)
    assert (
        a
        and a.score == 2
        and a.wrong_steps == [1, 3, 6]
        and "sqrt2_no_lowest_terms" in a.misconceptions
    )
    # re-reading the same problem soon after is the same attempt
    coach.log_attempt(lr, doc, now_ms=NOW + 5 * 60_000, minutes=17, hints=1)
    assert len(lr.attempts) == 1 and lr.attempts[0].hints == 1
    assert coach.edit_attempt(lr, 0, note="forgot lowest terms again")
    assert lr.attempts[0].note.startswith("forgot")
    assert coach.dock_entries(True)[0]["badge"] == "watching"
    assert coach.dock_entries(False)[0]["badge"] == ""


# =============================================================================================
# The agent, end to end (offline)
# =============================================================================================


def test_agent_reads_a_recorded_session_and_answers_requests(tmp_path):
    sent: list[dict] = []

    async def send(m: dict) -> None:
        sent.append(m)

    async def go():
        agent = PrimerAgent(
            send, learner="nell", mode="offline", store=LearnerStore(tmp_path), today="2026-10-06"
        )
        for m in load_recording(FIXTURES / "sqrt2_flawed.jsonl"):
            await agent.handle(m)
        # "/proof" typed on the tablet's keyboard
        for ch in "/proof":
            await agent.handle({"t": "key", "key": ch, "char": ch})
        await agent.handle({"t": "key", "key": "Enter"})
        await agent.handle({"t": "primer_request", "what": "hint", "learner": "nell"})
        await agent.handle({"t": "primer_request", "what": "forget", "learner": "nell"})

    asyncio.run(go())
    readings = [m for m in sent if m.get("t") == "primer"]
    assert len(readings) == 3
    first = readings[0]
    assert first["mode"] == "offline" and first["move"]["kind"] == "socratic"
    assert first["grade"]["estimate"] is True
    assert first["proof"]["tex"].startswith("\\documentclass")
    assert first["proof"]["steps"][5]["strokes"], "step 6 carries its stroke ids"
    assert first["learner"]["name"] == "nell"
    assert first["plan"]["exam"] == "2026-12-05" and first["plan"]["queue"]
    assert readings[1]["move"]["kind"] == "hint" and readings[1]["move"]["hint_level"] == 1
    assert "proof" not in readings[2] and not LearnerStore(tmp_path).path("nell").exists()


def test_dock_selection_in_scene_units_picks_the_lassoed_line(tmp_path):
    async def nothing(m: dict) -> None:
        return None

    agent = PrimerAgent(nothing, learner="x", mode="offline", store=LearnerStore(tmp_path))
    for m in load_recording(FIXTURES / "sqrt2_flawed.jsonl"):
        agent.log.observe(m)
    last = segment_lines(agent.log.ink())[-1]
    x0, y0, x1, y1 = last.bbox
    pad = 0.005
    scene = [(x0 - pad) * 1620 - 810, (y0 - pad) * 2160, (x1 + pad) * 1620 - 810, (y1 + pad) * 2160]
    sel = agent._selection_log({"t": "dock_action", "id": "ask_selection", "bbox": scene})
    assert {s.id for s in sel.ink()} == set(last.strokes)


def test_dock_practice_coach_answers_with_the_coach_view(tmp_path):
    sent: list[dict] = []

    async def send(m: dict) -> None:
        sent.append(m)

    store = LearnerStore(tmp_path)
    lr = store.load("nell")
    lr.consent = lr.watching = True
    store.save(lr)
    agent = PrimerAgent(send, learner="nell", mode="offline", store=store, today="2026-10-06")
    asyncio.run(agent.handle({"t": "dock_action", "id": "practice_coach", "doc": "d", "page": "p"}))
    reading = [m for m in sent if m["t"] == "primer"][-1]
    assert reading["coach"]["watching"] and reading["coach"]["next"]
    assert all(q["why"] for q in reading["coach"]["next"])
    ink = [m for m in sent if m["t"] == "stroke_begin"]
    assert all(m["layer"] == "ai" for m in ink), "a sketched problem is agent ink only"
    assert coach.dock_entries(True)[0] == {
        **coach.DOCK_ENTRIES[0],
        "badge": "watching",
        "label": "Practice coach · watching",
    }


def test_bkt_values_stay_probabilities_after_a_session(tmp_path):
    store = LearnerStore(tmp_path)

    async def go():
        agent = PrimerAgent(lambda m: asyncio.sleep(0), learner="x", mode="offline", store=store)
        for name in ("sqrt2_flawed", "sqrt2_correct", "odd_sum"):
            agent.log = InkLog()
            for m in load_recording(FIXTURES / f"{name}.jsonl"):
                await agent.handle(m)
            await agent.read("proof")

    asyncio.run(go())
    lr = store.load("x")
    assert lr.turn == 3
    assert all(0 < st.p < 1 and not math.isnan(st.p) for st in lr.concepts.values())
    assert lr.misconceptions["sqrt2_no_lowest_terms"].count == 1
