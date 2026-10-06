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

from codrawer_bridge.primer import assess, check, coach, latex, markup, policy, practice
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


# =============================================================================================
# Mock-exam mode
# =============================================================================================


def test_mock_schedule_follows_the_2026_format():
    from codrawer_bridge.primer import mock

    sched = mock.schedule(0)
    mins = [(a / 60_000, b / 60_000) for a, b in sched]
    assert mins == [(0, 90), (105, 195), (300, 390), (405, 495)]  # 11:00, 12:45, 16:00, 17:45 ET
    fast = mock.schedule(0, scale=0.01)
    assert fast[3][1] == pytest.approx(495 * 600)


def test_a_mock_collects_write_ups_and_grades_them_the_next_morning(tmp_path):
    from codrawer_bridge.primer import mock

    clock = {"now": dt.datetime(2026, 10, 24, 11, 0).timestamp() * 1000}
    sent: list[dict] = []

    async def send(m: dict) -> None:
        sent.append(m)

    agent = PrimerAgent(
        send,
        renderer=markup.Renderer(),
        markup_speed=0,
        learner="nell",
        mode="offline",
        store=LearnerStore(tmp_path),
        clock=lambda: clock["now"],
    )
    problems = [
        ["sqrt2_irrational", "odd_sum_squares", "am_gm_two"],
        ["pigeonhole_square", "handshake", "vieta_sum_squares"],
        ["squares_mod_4", "harmonic_diverges", "roots_unity_sum"],
        ["fixed_points_expectation", "infinitely_many_primes", "rank_ab"],
    ]

    async def go():
        await agent.handle({"t": "primer_request", "what": "mock_start", "problems": problems})
        first = [m for m in sent if m.get("t") == "primer"][-1]
        assert first["mock"]["phase"] == "session" and first["mock"]["session"] == 1
        assert first["mock"]["glance"] == "Mock S1/4 · 90 min · P1"
        assert [p["id"] for p in first["mock"]["problems"]] == problems[0]
        # write problem 1, then switch to problem 2 from the keyboard and write it
        for m in load_recording(FIXTURES / "sqrt2_flawed.jsonl"):
            await agent.handle(m)
        for ch in "/p 2":
            await agent.handle({"t": "key", "key": ch, "char": ch})
        await agent.handle({"t": "key", "key": "Enter"})
        for m in load_recording(FIXTURES / "odd_sum.jsonl"):
            await agent.handle(m)
        # no tutoring during the exam
        await agent.handle({"t": "primer_request", "what": "hint"})
        assert sent[-1]["move"]["kind"] == "notice" and "mock" in sent[-1]["move"]["text"].lower()
        # the break: ink is not collected
        clock["now"] += 95 * 60_000
        await agent.tick()
        assert sent[-1]["mock"]["phase"] == "break"
        await agent.handle({"t": "stroke_begin", "id": "brk", "layer": "user", "ts": 1})
        await agent.handle(
            {"t": "stroke_pts", "id": "brk", "pts": [[0.5, 0.9, 0.5, 1], [0.6, 0.9, 0.5, 2]]}
        )
        await agent.handle({"t": "stroke_end", "id": "brk", "ts": 2})
        # the day ends; nothing is graded until the next morning
        clock["now"] += 500 * 60_000
        await agent.tick()
        assert agent.mock.status == "awaiting_grading"
        assert sent[-1]["mock"]["grade_after"] == dt.datetime(2026, 10, 25, 6, 0).timestamp() * 1000
        clock["now"] = dt.datetime(2026, 10, 25, 7, 0).timestamp() * 1000
        await agent.tick()

    asyncio.run(go())
    report = [m for m in sent if m.get("t") == "primer"][-1]["mock"]["report"]
    assert report["estimate"] is True and report["max"] == 120
    by_id = {r["problem"]: r for r in report["problems"]}
    assert by_id["sqrt2_irrational"]["score"] == 2 and "lowest terms" in " ".join(
        by_id["sqrt2_irrational"]["findings"]
    )
    assert by_id["odd_sum_squares"]["score"] == 10
    assert by_id["am_gm_two"]["score"] == 0 and by_id["am_gm_two"]["rigor"].startswith(
        "No write-up"
    )
    assert report["total"] == 12
    m = mock.MockStore(LearnerStore(tmp_path).dir).latest("nell")
    s1 = m.sessions[0]
    assert "brk" not in {st["id"] for w in s1.writeups.values() for st in w.strokes}
    lr = LearnerStore(tmp_path).load("nell")
    assert lr.sessions[-1].kind == "mock" and sum(lr.sessions[-1].scores) == 12


def test_a_different_page_starts_the_view_over():
    log = InkLog()
    log.observe({"t": "page", "doc": "d", "page": "p1", "strokes": []})
    for m in _line_msgs("a", 0.2, 0.0)[0]:
        log.observe(m)
    assert log.ink()
    log.observe({"t": "page", "doc": "d", "page": "p2", "strokes": []})
    assert log.ink() == [] and log.page_key == "d/p2"


def test_problem_of_the_day_is_stable_for_a_day():
    lr = Learner(name="t", created_ms=NOW)
    a = practice.problem_of_the_day(lr, "2026-10-07", NOW)
    assert a is not None and a == practice.problem_of_the_day(lr, "2026-10-07", NOW)
    assert a.why


# =============================================================================================
# The scored evaluation, and the live recognizer's request (no network)
# =============================================================================================


def test_scored_evaluation_passes_offline_and_scores_a_replayed_reading(tmp_path):
    from codrawer_bridge.primer import scoring

    scores = scoring.gate(scoring.run("offline"), scoring.OFFLINE_GATE)
    assert scores and all(s.passed for s in scores), scoring.report(scores)
    kinds = {s.kind for s in scores}
    assert kinds == {"recognize", "grade"} and sum(s.kind == "grade" for s in scores) >= 7
    # A recorded "model reply" that merged two steps and missed the lowest-terms finding.
    for name in ("sqrt2_correct", "odd_sum", "sqrt2_flawed"):
        gold = load_fixture(name).to_dict()
        reply = {k: gold[k] for k in ("title", "goal", "technique", "steps")}
        reply.update(received_text="L1: ...", kind="proof", findings=[], formal="")
        reply["grade"] = {"score": 10, "band": "complete", "rigor": "", "exposition": ""}
        if name == "sqrt2_flawed":
            reply["steps"] = reply["steps"][:4] + [reply["steps"][5]]
        rec = {"model": "fake", "usage": {"ms": 1}, "reply": reply}
        (tmp_path / f"{name}.json").write_text(json.dumps(rec), encoding="utf-8")
    replay = scoring.gate(scoring.run("replay", recorded=tmp_path), scoring.MODEL_GATE)
    by = {(s.kind, s.case): s for s in replay}
    assert by[("recognize", "sqrt2_flawed")].metrics["steps_match"] == 0.0
    assert by[("recognize", "sqrt2_flawed")].metrics["latex_f1"] < 1.0
    g = by[("grade", "sqrt2_flawed")]
    assert g.metrics["findings_recall"] == 0.0 and not g.passed
    assert by[("grade", "sqrt2_correct")].passed


def test_live_recognizer_sends_the_selection_and_page_and_parses_the_reply(monkeypatch):
    import types

    import anthropic

    from codrawer_bridge.primer.recognize import LiveRecognizer

    gold = load_fixture("sqrt2_flawed").to_dict()
    reply = {k: gold[k] for k in ("title", "goal", "technique", "steps")}
    finding = {"id": "sqrt2_no_lowest_terms", "step": 6, "detail": "x"}
    reply.update(received_text="L1: Claim", kind="proof", formal="", findings=[finding])
    reply["grade"] = {"score": 2, "band": "partial", "rigor": "r", "exposition": "e"}
    seen = {}

    def create(**kw):
        seen.update(kw)
        return types.SimpleNamespace(
            stop_reason="end_turn",
            model="claude-opus-5-5",
            usage=types.SimpleNamespace(input_tokens=1200, output_tokens=900),
            content=[types.SimpleNamespace(type="text", text=json.dumps(reply))],
        )

    messages = types.SimpleNamespace(create=create)
    fake = types.SimpleNamespace(beta=types.SimpleNamespace(messages=messages))
    monkeypatch.setattr(anthropic, "Anthropic", lambda *a, **k: fake)
    page = fixture_log("sqrt2_flawed")
    sel = InkLog()
    for s in page.ink()[:40]:
        sel.strokes[s.id] = s
    doc = LiveRecognizer().recognize(sel, "Prove that sqrt 2 is irrational.", page=page)
    content = seen["messages"][0]["content"]
    assert [c["type"] for c in content] == ["image", "image", "text"]
    assert "Image 2 is the whole page" in content[-1]["text"]
    assert "irrational" in content[-1]["text"]
    schema = seen["output_config"]["format"]["schema"]
    assert {"received_text", "kind"} <= set(schema["required"])
    assert seen["fallbacks"] == "default" and "never to complete" in seen["system"]
    assert doc.source == "live:claude-opus-5-5" and doc.received_text == "L1: Claim"
    assert doc.findings[0].id == "sqrt2_no_lowest_terms"


def test_a_stopped_mock_is_not_graded_and_tutoring_resumes(tmp_path):
    sent: list[dict] = []

    async def send(m: dict) -> None:
        sent.append(m)

    agent = PrimerAgent(send, learner="x", mode="offline", store=LearnerStore(tmp_path))

    async def go():
        await agent.handle({"t": "primer_request", "what": "mock_start", "scale": 0.001})
        assert sent[-1]["mock"]["status"] == "running" and len(sent[-1]["mock"]["problems"]) == 3
        await agent.handle({"t": "primer_request", "what": "mock_stop"})
        assert sent[-1]["mock"]["status"] == "abandoned" and agent.mock is None
        for m in load_recording(FIXTURES / "sqrt2_flawed.jsonl"):
            await agent.handle(m)
        await agent.handle({"t": "primer_request", "what": "proof"})
        assert sent[-1]["move"]["kind"] == "socratic"

    asyncio.run(go())


# =============================================================================================
# Teacher's markup
# =============================================================================================


def _assessed(name: str):
    log = fixture_log(name)
    doc = OfflineRecognizer().recognize(log)
    assess.assess(doc)
    return doc, log


def test_marks_point_at_the_flawed_proofs_problems_without_fixing_them():
    doc, _ = _assessed("sqrt2_flawed")
    specs = markup.select_marks(doc)
    kinds = {(s.kind, s.step) for s in specs}
    assert ("caret", 1) in kinds  # where lowest terms should have been assumed
    assert ("circle", 6) in kinds and ("question", 6) in kinds  # the "contradiction"
    assert ("underline", 3) in kinds  # p² even ⇒ p even, unproved (minor)
    assert {s.step for s in specs if s.kind == "check"} == {2, 4}  # the key steps that stand
    comments = [s.short for s in specs if s.kind == "comment"]
    assert all(len(c.split()) <= 8 for c in comments)
    assert not any("gcd" in c or "= 1" in c for c in comments), "a pointer, never the fix"
    score = next(s for s in specs if s.kind == "score")
    assert score.short == "2/10" and "estimate" in score.long.lower()
    summary = next(s for s in specs if s.kind == "summary")
    assert summary.short.startswith("Good idea;") and summary.short.endswith("?")


def test_a_complete_proof_gets_ticks_and_praise_and_an_unreadable_step_a_question():
    doc, _ = _assessed("odd_sum")
    specs = markup.select_marks(doc)
    assert not [s for s in specs if s.kind in ("comment", "circle", "strike")]
    assert any(s.kind == "check" for s in specs)
    assert next(s for s in specs if s.kind == "summary").short.startswith("Complete")
    doc.steps[2].status = "unclear"
    doc.steps[2].confidence = 0.3
    specs = markup.select_marks(doc)
    assert any(s.kind == "comment" and s.short == markup.UNREADABLE and s.step == 3 for s in specs)


def test_marks_land_on_free_paper():
    for name in ("sqrt2_flawed", "sqrt2_correct", "odd_sum"):
        doc, log = _assessed(name)
        ink = [s.bbox() for s in log.ink()]
        mk = markup.build(
            doc, ink, markup.Renderer(), stroke_boxes={s.id: s.bbox() for s in log.ink()}
        )
        for m in mk.marks:
            b = m.bbox
            assert 0 <= b[0] <= b[2] <= 1 and 0 <= b[1] <= b[3] <= 1, (name, m)
            if m.kind in ("comment", "question", "check", "score", "summary"):
                assert not any(markup._hit(tuple(b), i) for i in ink), (name, m.kind, m.short)
        texts = [m for m in mk.marks if m.kind in ("comment", "question", "score", "summary")]
        for i, a in enumerate(texts):
            for c in texts[i + 1 :]:
                assert not markup._hit(tuple(a.bbox), tuple(c.bbox)), (name, a.short, c.short)
        assert all(
            m["layer"] == "ai"
            and m["author"] == "primer:teacher"
            and m["ink_layer"] == "codrawer: teacher"
            for m in mk.messages
            if m["t"] == "stroke_begin"
        )


def test_grading_from_the_agent_draws_marks_that_can_be_taken_back(tmp_path):
    sent: list[dict] = []

    async def send(m: dict) -> None:
        sent.append(m)

    agent = PrimerAgent(
        send,
        learner="x",
        mode="offline",
        store=LearnerStore(tmp_path),
        renderer=markup.Renderer(),
        markup_speed=0,
    )

    async def go():
        for m in load_recording(FIXTURES / "sqrt2_flawed.jsonl"):
            await agent.handle(m)
        await agent.handle({"t": "dock_action", "id": "grade_page", "doc": "d", "page": "p"})
        await agent.settle()
        await agent.handle({"t": "primer_request", "what": "clear_marks"})

    asyncio.run(go())
    reading = next(m for m in sent if m.get("t") == "primer")
    marks = reading["markup"]["marks"]
    assert reading["markup"]["color"] == "#d03030" and any(m["kind"] == "caret" for m in marks)
    ids = [
        m["id"]
        for m in sent
        if m.get("t") == "stroke_begin" and m.get("author") == "primer:teacher"
    ]
    assert ids and sorted(ids) == sorted(i for mk in marks for i in mk["strokes"])
    assert sent[-1]["t"] == "stroke_delete" and sorted(sent[-1]["ids"]) == sorted(ids)
    tap = next(m for m in marks if m["kind"] == "circle")
    assert tap["long"] and tap["latex"], "the phone gets the long explanation and the step's LaTeX"


# =============================================================================================
# Item memory (FSRS), metacognition, goals, the reflective layer, the report
# =============================================================================================


def test_fsrs_follows_its_formulas():
    from codrawer_bridge.primer import fsrs

    assert fsrs.retrievability(10, 10) == pytest.approx(0.9)
    assert fsrs.interval_days(10, 0.9) == pytest.approx(10)
    it = fsrs.Item(id="t", kind="technique", prompt="?")
    it.review(fsrs.GOOD, 0)
    assert it.s == pytest.approx(fsrs.W[2]) and it.d == pytest.approx(fsrs.W[4])
    assert it.due_ms == pytest.approx(it.s * fsrs.DAY_MS)
    s1 = it.s
    it.review(fsrs.GOOD, it.due_ms)  # on time: R = 0.9
    assert it.s > s1 * 2, "a successful review on time multiplies stability"
    s2 = it.s
    it.review(fsrs.AGAIN, it.due_ms + 30 * fsrs.DAY_MS)
    assert it.s < s2 and it.lapses == 1
    d = fsrs.next_difficulty(5.0, fsrs.AGAIN)
    assert d > 5.0 and fsrs.next_difficulty(5.0, fsrs.EASY) < 5.0
    assert (
        fsrs.grade_from_step("error") == fsrs.AGAIN
        and fsrs.grade_from_step("ok", hesitation=0.1, minutes=5) == fsrs.EASY
    )


def test_items_link_to_mastery_and_are_gated_by_it():
    lr = Learner(name="t", created_ms=NOW)
    it = lr.ensure_item(
        "technique:pigeonhole", "technique", "When pigeonhole?", ["pigeonhole"], "", NOW
    )
    assert lr.ensure_item("technique:pigeonhole", "technique", "x", [], "", NOW) is it
    from codrawer_bridge.primer import fsrs

    assert fsrs.due(lr.items, NOW, {"pigeonhole": 0.1}) == [], (
        "not yet learned: teach, don't test recall"
    )
    assert fsrs.due(lr.items, NOW, {"pigeonhole": 0.5}) == [it]
    before = lr.mastery("pigeonhole")
    lr.review_item("technique:pigeonhole", fsrs.GOOD, NOW)
    assert lr.mastery("pigeonhole") > before and lr.evidence[-1].kind == "review"
    assert "pigeonhole" not in lr.due(NOW + 1000) and "pigeonhole" in lr.due(NOW + 30 * DAY_MS)


def test_calibration_curve_brier_and_flags():
    from codrawer_bridge.primer.metacog import calibration, calibration_nudge

    lr = Learner(name="t", created_ms=NOW)
    for conf, score in ((0.9, 2), (0.85, 1), (0.95, 2), (0.3, 10)):
        lr.judge(conf, NOW)
        lr.settle(score, "induction" if conf > 0.5 else "parity", None)
    cal = calibration(lr.judgments)
    assert cal["n"] == 4 and cal["brier"] > 0.4 and cal["gap"] > 0
    assert cal["flags"] == [
        {"technique": "induction", "gap": pytest.approx(0.733, abs=0.01), "n": 3, "kind": "over"}
    ]
    assert "more sure" in calibration_nudge(cal, {"induction": "Mathematical induction"})


def test_goals_are_hers_and_corrections_count_as_evidence():
    lr = Learner(name="t", created_ms=NOW)
    changed = lr.goals.apply(
        {"target": "40/120", "weekly_hours": 200, "nudging": "loud", "secret": 1}, NOW
    )
    assert changed == {"target": "40/120", "weekly_hours": 80.0} and lr.goals.agreed_ms == NOW
    assert not lr.goals.revisit_due(NOW + DAY_MS) and lr.goals.revisit_due(NOW + 8 * DAY_MS)
    lr.goals.apply({"topics": ["combinatorics"]}, NOW, by="primer")
    assert lr.goals.history[-1].by == "primer" and lr.goals.agreed_ms == NOW
    before = lr.mastery("induction")
    lr.self_report("mastery:induction", "known", NOW)
    after = lr.mastery("induction")
    assert before < after < 0.9, "her word counts without overruling her proofs"
    lr.self_report("insight:time_sink", "wrong", NOW)
    assert lr.insight_verdicts["time_sink"] == "dismissed"
    back = Learner.from_dict(lr.to_dict())
    assert back.goals.target == "40/120" and back.corrections[0].target == "mastery:induction"


def test_agent_records_confidence_and_builds_items(tmp_path):
    sent: list[dict] = []

    async def send(m: dict) -> None:
        sent.append(m)

    store = LearnerStore(tmp_path)
    agent = PrimerAgent(send, learner="x", mode="offline", store=store)

    async def go():
        await agent.handle(
            {
                "t": "primer_request",
                "what": "features",
                "features": {"reviews": True, "activity_review": True},
            }
        )
        for m in load_recording(FIXTURES / "odd_sum.jsonl"):
            await agent.handle(m)
        await agent.handle({"t": "primer_request", "what": "proof", "confidence": 0.9})

    asyncio.run(go())
    lr = store.load("x")
    assert lr.judgments[-1].confidence == 0.9 and lr.judgments[-1].outcome == pytest.approx(1.0)
    ids = {it.id for it in lr.items}
    assert {"technique:induction", "problem:odd_sum_squares"} <= ids
    meta = [m for m in sent if m.get("t") == "primer"][-1]["metacog"]
    assert meta["features"]["reviews"]["on"] and meta["review"] is not None and "insights" in meta


def test_reflective_layer_and_report_from_fixture_history(tmp_path):
    from codrawer_bridge.primer import latex, reflect, report

    store = LearnerStore(tmp_path)
    clock = {"now": NOW}

    async def nothing(m: dict) -> None:
        return None

    agent = PrimerAgent(
        nothing,
        learner="r",
        mode="offline",
        store=store,
        clock=lambda: clock["now"],
        renderer=markup.Renderer(),
        markup_speed=0,
    )

    async def go():
        lr = store.load("r")
        lr.consent = lr.watching = True
        lr.features.update(attempt_log=True, reading_position=True, activity_review=True)
        store.save(lr)
        for day, name, conf in (
            (0, "sqrt2_flawed", 0.9),
            (1, "odd_sum", 0.5),
            (2, "sqrt2_flawed", 0.95),
            (3, "sqrt2_correct", 0.8),
        ):
            clock["now"] = NOW + day * DAY_MS
            agent.log = InkLog()
            await agent.handle({"t": "page", "doc": "nb", "page": f"p{day}", "strokes": []})
            for m in load_recording(FIXTURES / f"{name}.jsonl"):
                await agent.handle(m)
            await agent.handle({"t": "primer_request", "what": "proof", "confidence": conf})

    asyncio.run(go())
    lr = store.load("r")
    review = reflect.activity_review(lr, clock["now"])
    assert len(review["problems"]) >= 3 and review["approach"]
    assert any(w["id"] == "sqrt2_no_lowest_terms" and w["evidence"] for w in review["weaknesses"])
    ev = review["weaknesses"][0]["evidence"][0]
    assert ev["replay"]["page"] and ev["thumb"], (
        "evidence links to a replayable page and a thumbnail"
    )
    insights = reflect.blind_spots(lr, clock["now"])
    assert all(0 < i.confidence <= 0.9 and i.suggestion for i in insights)
    tex, files = report.build_tex(lr, clock["now"])
    assert latex.syntax_problems(tex) == [] and all(ord(c) < 128 for c in tex)
    assert "Your reflection" in tex
    if latex.tex_engine() is None:
        pytest.skip("no TeX engine: report checked as LaTeX only")
    pdf, log = report.build_pdf(lr, clock["now"], root=tmp_path)
    assert pdf is not None and pdf.read_bytes()[:4] == b"%PDF", log
    assert report.portfolio("r", tmp_path)[-1]["file"] == pdf.name
