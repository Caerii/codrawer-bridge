"""
codrawer-agentd's warm Claude Code pool, page thread and concurrency, with a fake ``claude``.

- The pool (claude_stream.py): warm processes answer with the image attached; every ask gets a
  process of its own (none serves two, so no ask can read another's output); a silent or crashed
  process fails its ask (and is replaced) instead of hanging it; asks beyond the pool wait.
- The page thread (threads.py, prompt.py): a second ask on a page carries the first exchange; a
  different page does not; memory off sends none; forget clears it; the cap holds; the SEEN line
  never reaches the ink.
- Concurrency (service.py): two asks on one page run at once, get blocks that do not overlap,
  and each ends its own overlay; a replace touches only its own ask.
"""

from __future__ import annotations

import asyncio
import json
import sys
import time
from pathlib import Path

import pytest

from codrawer_bridge.agentd import prompt
from codrawer_bridge.agentd.claude_stream import ClaudePool
from codrawer_bridge.agentd.threads import MAX_EXCHANGES, ThreadStore

FAKE = [sys.executable, str(Path(__file__).with_name("fake_claude.py"))]
W, H = 1620.0, 2160.0


def pool(tmp_path, size=2, **env) -> ClaudePool:
    p = ClaudePool(tmp_path, size=size, cmd=FAKE, warm_timeout_s=20)
    p.env = {**p.env, **{k: str(v) for k, v in env.items()}}
    return p


# ── the pool ─────────────────────────────────────────────────────────────────────────────────


def test_warm_processes_answer_with_the_image_one_ask_each(tmp_path):
    log = tmp_path / "pids.log"

    async def go():
        p = pool(tmp_path, FAKE_LOG=log)
        seen: list[str] = []
        r1 = await p.ask("question", b"\x89PNG fake", 20, on_text=seen.append)
        r2 = await p.ask("question", b"\x89PNG fake", 20)
        await p.close()
        return r1, r2, seen

    r1, r2, seen = asyncio.run(go())
    assert r1.ok and r1.text.endswith("with an image.") and prompt.split_seen(r1.text)[0]
    assert seen and seen[-1] == r1.text  # streamed as it came
    assert r1.first_text_s is not None and r1.done_s is not None
    pids = log.read_text().split()
    assert len(pids) == 2 and pids[0] != pids[1]  # no process served two asks


@pytest.mark.parametrize(
    "mode,why", [("hang", "no output"), ("crash", "exited"), ("error", "claude")]
)
def test_a_failing_process_fails_its_ask_not_the_pool(tmp_path, mode, why):
    async def go():
        p = pool(tmp_path, FAKE_CLAUDE=mode)
        r = await p.ask("question", None, 20, stall_s=1.0)
        alive = p._alive()
        await p.close()
        return r, alive

    r, alive = asyncio.run(go())
    assert not r.ok and why in r.error
    assert alive >= 1  # a replacement is on its way


def test_asks_beyond_the_pool_wait_for_a_process(tmp_path):
    async def go():
        p = pool(tmp_path, size=2, FAKE_CLAUDE="slow", FAKE_DELAY=0.6)
        p.fill()
        while p._ready.qsize() < 2:
            await asyncio.sleep(0.05)
        t0 = time.monotonic()
        done: list[float] = []

        async def one():
            r = await p.ask("question", None, 30)
            done.append(time.monotonic() - t0)
            return r

        rs = await asyncio.gather(one(), one(), one())
        await p.close()
        return rs, sorted(done)

    rs, done = asyncio.run(go())
    assert all(r.ok for r in rs)
    assert done[1] < 1.5 and done[2] > done[1] + 0.3  # the third waited for a fresh process


# ── the page thread ──────────────────────────────────────────────────────────────────────────


def test_thread_store_bounds_toggle_forget_and_pages(tmp_path):
    t = ThreadStore(tmp_path)
    assert t.memory is True  # on by default
    t.add("d", "p1", "What is life?", "Self-sustaining chemistry.")
    t.add("d", "p1", "What do they contain?", "DNA and ribosomes.")
    assert [e.seen for e in t.get("d", "p1")] == ["What is life?", "What do they contain?"]
    assert t.get("d", "p2") == []  # never another page's
    for i in range(MAX_EXCHANGES + 3):
        t.add("d", "p1", f"q{i}", "a" * 50)
    ex = t.get("d", "p1")
    assert len(ex) == MAX_EXCHANGES and ex[-1].seen == f"q{MAX_EXCHANGES + 2}"
    t.add("d", "p3", "x" * 400, "y" * 600)
    for _ in range(12):
        t.add("d", "p3", "x" * 400, "y" * 600)
    assert sum(len(e.seen) + len(e.answer) for e in t.get("d", "p3")) <= 6000
    t.memory = False
    assert t.get("d", "p1") == [] and ThreadStore(tmp_path).memory is False  # kept on disk
    t.add("d", "p1", "ignored", "ignored")
    t.memory = True
    assert t.forget("d", "p1") and t.get("d", "p1") == [] and not t.forget("d", "p1")


def test_seen_line_never_reaches_the_ink():
    assert prompt.split_seen("SEEN: What is life?\nSelf-sustaining chemistry.") == (
        "What is life?",
        "Self-sustaining chemistry.",
    )
    assert prompt.split_seen("No seen line here.") == ("", "No seen line here.")
    # while streaming: nothing until the SEEN line is complete, then only the answer
    assert prompt.answer_so_far("SE") == ""
    assert prompt.answer_so_far("SEEN: What is li") == ""
    assert prompt.answer_so_far("SEEN: What is life?\nSelf-sus") == "Self-sus"
    assert prompt.answer_so_far("Sure, here.") == "Sure, here."


def test_the_prompt_carries_the_thread_as_page_data():
    ask = prompt.Ask(
        kind="ask_selection",
        image=None,
        thread=[("What is life?", "Self-sustaining chemistry.")],
    )
    text = prompt.build_prompt(ask)
    i_open, i_close = text.index(prompt.FENCE_OPEN), text.index(prompt.FENCE_CLOSE)
    assert i_open < text.index("earlier 1, written: What is life?") < i_close
    assert "attached above" in text and "Use no tools" in text and "continue that thread" in text
    alone = prompt.build_prompt(prompt.Ask(kind="ask_selection", image=None))
    assert "earlier 1" not in alone and "stands alone" in alone


# ── the service: thread, concurrency ─────────────────────────────────────────────────────────


def _page(strokes):
    return {
        "t": "page",
        "doc": "d",
        "page": "p1",
        "title": "T",
        "rev": 1,
        "w": 1620,
        "h": 2160,
        "strokes": strokes,
    }


def _word(i: int, x: float, y: float):
    return {"id": f"1:{i}", "tool": "pen", "pts": [[x, y, 0.5], [x + 0.1, y + 0.01, 0.5]]}


def _tap(x0: float, y0: float, x1: float, y1: float) -> dict:
    """A dock_action for the normalized box, in scene units (x centred)."""
    return {
        "t": "dock_action",
        "id": "ask_selection",
        "doc": "d",
        "page": "p1",
        "bbox": [x0 * W - W / 2, y0 * H, x1 * W - W / 2, y1 * H],
        "ts": int(time.time() * 1000),
    }


class _Hand:
    async def layouts(
        self, text, persona="archivist", widths=(80.0,), seed=7, pitch=None, tempo=None
    ):
        from codrawer_bridge.agentd.hand import Layout

        return [
            Layout(
                widths[0], (0.0, -5.0, 30.0, 1.0), 50, [(0, 50, [[0, 0, 0.5, 0], [30, 0, 0.5, 50]])]
            )
        ]

    async def metrics(self, persona="archivist"):
        from codrawer_bridge.agentd.hand import Metrics

        return Metrics(mm_per_char=4.7, pitch=11.4, ascent=-5.7, descent=1.7)


def _agent(tmp_path, ink="off", pool_size=2, **env):
    from codrawer_bridge.agentd.service import Agentd, Config

    a = Agentd(
        Config(
            ws="ws://x",
            term_cwd=str(tmp_path),
            ink=ink,
            thinking="overlay",
            backend="claude-stream",
            pool=pool_size,
            speed=50.0,
        )
    )
    a.claude = pool(tmp_path, size=pool_size + 1, **env)
    a.hand = _Hand()
    sent: list[dict] = []

    async def send(msg):
        sent.append(msg)
        return True

    a.send = send  # type: ignore[method-assign]
    a.handle(_page([_word(1, 0.2, 0.15), _word(2, 0.2, 0.45)]))
    return a, sent


def test_a_second_ask_on_the_page_follows_the_thread(tmp_path):
    async def go():
        a, sent = _agent(tmp_path)
        r1 = await a.answer(_tap(0.18, 0.13, 0.33, 0.18))
        r2 = await a.answer(_tap(0.18, 0.43, 0.33, 0.48))
        await a.claude.close()
        return a, r1, r2, sent

    a, r1, r2, sent = asyncio.run(go())
    assert r1.answer == "A circled word with an image." and r1.seen == "a circled word"
    assert r1.thread == 0 and r2.thread == 1
    assert "earlier 1, written: a circled word" in r2.prompt
    assert "SEEN" not in json.dumps([m for m in sent if m["t"] == "primer"])  # not on the glasses


def test_two_asks_on_one_page_at_once_get_their_own_blocks_and_overlays(tmp_path):
    async def go():
        a, sent = _agent(tmp_path, FAKE_CLAUDE="slow", FAKE_DELAY=0.4)
        a.claude.fill()
        while a.claude._ready.qsize() < 3:
            await asyncio.sleep(0.05)
        t0 = time.monotonic()
        a.handle(_tap(0.18, 0.13, 0.33, 0.18))
        a.handle(_tap(0.18, 0.43, 0.33, 0.48))
        await a.queue.drain()
        took = time.monotonic() - t0
        await a.claude.close()
        recs = [json.loads(x) for x in (a.state / "requests.jsonl").read_text().splitlines()]
        return recs, sent, took

    recs, sent, took = asyncio.run(go())
    assert [r["answer"] for r in recs] == ["A circled word with an image."] * 2
    assert took < 0.4 * 2 + 0.6  # side by side, not one after the other
    blocks = [r["placement"]["reserved_pu"] for r in recs]
    (ax0, ay0, ax1, ay1), (bx0, by0, bx1, by1) = blocks
    assert ax1 <= bx0 or bx1 <= ax0 or ay1 <= by0 or by1 <= ay0  # never the same space
    done = {m["id"] for m in sent if m["t"] == "agent_status" and m["state"] == "done"}
    assert done == {f"agentd_{r['n']}" for r in recs}


def test_reserved_blocks_of_other_asks_are_occupied(tmp_path):
    async def go():
        a, _ = _agent(tmp_path)
        r1 = await a._reserve((0.18, 0.13, 0.33, 0.18), owner=1)
        # the next line down, asked while the first answer is still being thought about: its
        # natural spot is where the first answer will go
        r2 = await a._reserve((0.18, 0.43, 0.33, 0.48), owner=2)
        # the same selection again: nothing within reach is free, so no block (glasses only)
        r3 = await a._reserve((0.18, 0.13, 0.33, 0.18), owner=3)
        await a.claude.close()
        return r1, r2, r3

    r1, r2, r3 = asyncio.run(go())
    assert r1 is not None and r2 is not None
    (ax0, ay0, ax1, ay1), (bx0, by0, bx1, by1) = r1[0].rect, r2[0].rect
    assert ax1 <= bx0 or bx1 <= ax0 or ay1 <= by0 or by1 <= ay0
    if r3 is not None:
        for other in (r1[0].rect, r2[0].rect):
            x0, y0, x1, y1 = r3[0].rect
            assert x1 <= other[0] or other[2] <= x0 or y1 <= other[1] or other[3] <= y0


def test_a_replace_touches_only_its_own_ask(tmp_path, monkeypatch):
    from codrawer_bridge.agentd import service

    monkeypatch.setattr(service, "DEBOUNCE_S", 0.05)

    async def go():
        a, _ = _agent(tmp_path, FAKE_CLAUDE="slow", FAKE_DELAY=0.5)
        a.claude.fill()
        while a.claude._ready.qsize() < 3:
            await asyncio.sleep(0.05)
        tap_a, tap_b = _tap(0.18, 0.13, 0.33, 0.18), _tap(0.18, 0.43, 0.33, 0.48)
        a.handle(tap_a)
        a.handle(tap_b)
        await asyncio.sleep(0.2)
        a.handle({**tap_a, "ts": int(time.time() * 1000)})  # A again: replaces A only
        await a.queue.drain()
        await a.claude.close()
        return [json.loads(x) for x in (a.state / "requests.jsonl").read_text().splitlines()]

    recs = asyncio.run(go())
    by_err = sorted((r["error"], r["bbox"][1]) for r in recs)
    assert [e for e, _ in by_err].count("replaced by a newer ask for the same selection") == 1
    assert sum(1 for r in recs if r["answer"]) == 2  # B, and A's replacement


def test_the_model_toggle_switches_careful_and_fast(tmp_path, monkeypatch):
    from codrawer_bridge.agentd import service

    made: list[str] = []

    class FakePool:
        def __init__(self, cwd, size=2, model="", **kw):
            made.append(model)
            self.model = model

        def fill(self):
            pass

        async def close(self):
            pass

    monkeypatch.setattr(service, "ClaudePool", FakePool)

    def agentd():
        return service.Agentd(
            service.Config(ws="ws://x", term_cwd=str(tmp_path), backend="claude-stream")
        )

    async def go():
        a = agentd()
        sent: list[dict] = []

        async def send(msg):
            sent.append(msg)
            return True

        a.send = send  # type: ignore[method-assign]
        assert a.speed == "careful" and a.claude.model == "claude-sonnet-5-5"  # the default
        a.handle({"t": "dock_action", "id": service.MODEL_ID, "doc": "d", "page": "p"})
        await asyncio.sleep(0.05)
        assert a.speed == "fast" and a.claude.model == "claude-haiku-4-5-20251001"
        entries = [m for m in sent if m["t"] == "dock_entries"][-1]["entries"]
        entry = next(e for e in entries if e["id"] == service.MODEL_ID)
        assert entry["badge"] == "fast" and "Haiku" in entry["label"]
        b = agentd()  # kept across a restart
        assert b.speed == "fast" and b.claude.model == "claude-haiku-4-5-20251001"

    asyncio.run(go())
    assert made == ["claude-sonnet-5-5", "claude-haiku-4-5-20251001", "claude-haiku-4-5-20251001"]


# ── text size and line spacing ───────────────────────────────────────────────────────────────


def test_size_and_spacing_settings_cycle_persist_and_label(tmp_path):
    from codrawer_bridge.agentd import service

    async def go():
        a, sent = _agent(tmp_path)
        assert a.setting("text_size") == "medium" and a.setting("spacing") == "compact"
        a.handle({"t": "dock_action", "id": service.SIZE_ID, "doc": "d", "page": "p1"})
        a.handle({"t": "dock_action", "id": service.SPACING_ID, "doc": "d", "page": "p1"})
        await asyncio.sleep(0.05)
        assert a.setting("text_size") == "large" and a.setting("spacing") == "normal"
        entries = {e["id"]: e for e in [m for m in sent if m["t"] == "dock_entries"][-1]["entries"]}
        assert entries[service.SIZE_ID]["label"] == "Text size: large"
        assert entries[service.SPACING_ID]["label"] == "Spacing: normal"
        # the same from another surface: a settings message
        a.handle({"t": "settings", "set": {"text_size": "small", "spacing": "airy", "bogus": 1}})
        await asyncio.sleep(0.05)
        state = [m for m in sent if m["t"] == "settings"][-1]["state"]
        assert state["text_size"] == "small" and state["spacing"] == "airy"
        b, _ = _agent(tmp_path)  # kept across a restart
        assert b.setting("text_size") == "small" and b.setting("spacing") == "airy"
        await a.claude.close()
        await b.claude.close()

    asyncio.run(go())


def test_text_size_scales_the_block_and_compact_spacing_shrinks_it(tmp_path):
    async def go():
        a, _ = _agent(tmp_path)
        box = (0.18, 0.13, 0.33, 0.18)
        out = {}
        for size, spacing in (
            ("medium", "normal"),
            ("medium", "compact"),
            ("small", "compact"),
            ("large", "compact"),
        ):
            a.threads.set_setting("text_size", size)
            a.threads.set_setting("spacing", spacing)
            a._reserved.clear()
            spot, width_mm, met = await a._reserve(box)
            out[(size, spacing)] = (spot.block.h / spot.block.scale, spot.block.scale, met.pitch)
        await a.claude.close()
        return out

    out = asyncio.run(go())
    assert out[("medium", "compact")][2] < out[("medium", "normal")][2]  # tighter lines
    assert out[("medium", "compact")][0] < out[("medium", "normal")][0]  # a shorter block
    # the chosen scale follows the preset (placement picks among the preset's scales)
    assert out[("small", "compact")][1] <= 0.7 + 1e-9 < out[("large", "compact")][1]


@pytest.mark.parametrize("persona", ["archivist", "sketcher", "elder", "mathematician", "teacher"])
def test_compact_lines_never_collide(persona):
    """Property: at the compact pitch, no line's ink comes within LINE_GAP_MM of the next's."""
    from codrawer_bridge.agentd.hand import HandUnavailable, HandWorker, line_bands, separate_lines
    from codrawer_bridge.agentd.stream import LINE_GAP_MM

    text = "Gyp jagged quips; fly by. Quickly judge the gyroscope! Hypothesis: pygmy jaguars glow."

    async def go():
        w = HandWorker()
        try:
            met = await w.metrics(persona)
        except HandUnavailable:
            pytest.skip("packages/hand is not installed")
        compact = 1.25 * (met.descent - met.ascent)
        for seed in (1, 2, 3, 4):
            lay = (await w.layouts(text, persona, (70.0,), seed=seed, pitch=compact))[0]
            lay = separate_lines(lay, LINE_GAP_MM)
            bands = line_bands(lay)
            assert len(bands) >= 3
            for n in sorted(bands)[:-1]:
                assert bands[n + 1][0] >= bands[n][1] + LINE_GAP_MM - 1e-6, (persona, seed, n)
        await w.close()

    asyncio.run(go())


def test_size_presets_cycle_smallest_to_largest_and_stay_legible(tmp_path):
    from codrawer_bridge.agentd import service
    from codrawer_bridge.agentd.hand import Metrics

    async def go():
        a, _ = _agent(tmp_path)
        seen = []
        for _ in range(len(service.SIZES) + 1):
            seen.append(a.setting("text_size"))
            a.handle({"t": "dock_action", "id": service.SIZE_ID, "doc": "d", "page": "p1"})
            await asyncio.sleep(0.02)
        await a.claude.close()
        met = Metrics(mm_per_char=4.7, pitch=11.4, ascent=-5.7, descent=1.7, x_height=3.52)
        scales = {}
        for size in service.SIZES:
            a.threads.set_setting("text_size", size)
            scales[size] = a.scales_for(met)
        return seen, scales

    seen, scales = asyncio.run(go())
    assert seen == ["medium", "large", "micro", "tiny", "small", "medium"]  # wraps
    for size, ss in scales.items():
        assert ss and all(3.52 * s >= service.MIN_XHEIGHT_MM or len(ss) == 1 for s in ss), size
    assert scales["micro"] == [0.42] and len(scales["tiny"]) == 2 and len(scales["medium"]) == 3


def test_smaller_text_keeps_a_comfortable_width(tmp_path):
    from codrawer_bridge.agentd import placement

    async def go():
        a, _ = _agent(tmp_path)
        box = (0.18, 0.13, 0.33, 0.18)
        out = {}
        for size in ("medium", "tiny"):
            a.threads.set_setting("text_size", size)
            a._reserved.clear()
            spot, width_mm, _ = await a._reserve(box)
            out[size] = (spot.block.w, spot.block.h, spot.block.scale, width_mm)
        await a.claude.close()
        return out

    out = asyncio.run(go())
    (wm, hm, sm, _), (wt, ht, st, text_t) = out["medium"], out["tiny"]
    assert st < sm and ht < hm  # smaller writing, a shorter block
    assert wt >= 0.9 * wm  # but as wide on the page: more words a line, not a narrow column
    assert abs(text_t * st - wt * placement.MM_PER_PU) < 1.0  # the hand wraps at that width


def test_writing_speed_presets_hurry_the_hand_and_the_playback(tmp_path):
    from codrawer_bridge.agentd import service

    async def go():
        a, sent = _agent(tmp_path)
        out = []
        for _ in range(len(service.SPEEDS)):
            out.append((a.setting("writing_speed"), a.hurry, a.playback))
            a.handle({"t": "dock_action", "id": service.SPEED_ID, "doc": "d", "page": "p1"})
            await asyncio.sleep(0.02)
        entries = {e["id"]: e for e in [m for m in sent if m["t"] == "dock_entries"][-1]["entries"]}
        await a.claude.close()
        return out, entries

    out, entries = asyncio.run(go())
    assert [o[0] for o in out] == ["fast", "very_fast", "calm"]  # default fast, cycling
    speeds = {name: hurry * playback for name, hurry, playback in out}
    assert speeds["calm"] < speeds["fast"] < speeds["very_fast"]
    assert all(h <= 2.0 for _, h, _ in out)  # past 2 the hand's letters lose their shape
    assert entries[service.SPEED_ID]["label"] == "Writing speed: fast"


def test_no_ink_below_what_the_bridge_accepts(tmp_path):
    async def go():
        a, sent = _agent(tmp_path)
        a.handle(
            {**_page([_word(1, 0.2, 0.15)]), "strokes": [_word(1, 0.2, 0.15), _word(9, 0.2, 1.47)]}
        )
        low = await a._reserve((0.18, 1.45, 0.33, 1.49), owner=1)  # writing at 1.47 page heights
        high = await a._reserve((0.18, 0.13, 0.33, 0.18), owner=2)
        await a.claude.close()
        return low, high, a

    low, high, a = asyncio.run(go())
    assert high is not None
    if low is not None:  # beside it perhaps, but never below the bridge's limit
        assert low[0].rect[3] <= a.cfg.max_page_y * 2160


# ── the tablet's proposed spot and ink bounds ───────────────────────────────────────────────


def _thinking(sent):
    return [m for m in sent if m["t"] == "agent_status" and m["state"] == "thinking"]


def test_the_tablets_proposed_spot_is_honoured_when_free(tmp_path):
    async def go():
        a, sent = _agent(tmp_path)
        # the selection is the word at y 0.15; the tablet proposes a spot just under it, free
        spot = [0.2 * W - W / 2, 0.16 * H + 40, 0.2 * W - W / 2 + 600, 0.16 * H + 200]
        rec = await a.answer({**_tap(0.18, 0.13, 0.33, 0.18), "spot": spot, "items": 1})
        await a.claude.close()
        return rec, sent, spot

    rec, sent, spot = asyncio.run(go())
    th = _thinking(sent)
    assert len(th) == 1 and th[0]["bbox"] == [round(v, 1) for v in spot]  # the doodle stays put
    x0, y0 = rec.placement["reserved_pu"][:2]
    assert abs(x0 - (spot[0] + W / 2)) < 1 and abs(y0 - spot[1]) < 1  # the answer starts there


def test_a_colliding_spot_is_overridden_once(tmp_path):
    async def go():
        a, sent = _agent(tmp_path)
        # proposed right on top of the other word on the page (y 0.45): not free
        spot = [0.2 * W - W / 2, 0.44 * H, 0.2 * W - W / 2 + 600, 0.44 * H + 160]
        rec = await a.answer({**_tap(0.18, 0.13, 0.33, 0.18), "spot": spot, "items": 1})
        await a.claude.close()
        return rec, sent, spot

    rec, sent, spot = asyncio.run(go())
    th = _thinking(sent)
    assert len(th) == 1  # one final spot, never two steps
    assert th[0]["bbox"] != [round(v, 1) for v in spot]
    x0, y0, x1, y1 = rec.placement["reserved_pu"]
    word = (0.2 * W, 0.45 * H, 0.3 * W, 0.46 * H)
    assert x1 <= word[0] or x0 >= word[2] or y1 <= word[1] or y0 >= word[3]


def test_small_corrections_of_the_spot_are_not_sent(tmp_path):
    from codrawer_bridge.agentd.service import Record

    async def go():
        a, sent = _agent(tmp_path)
        rec = Record(n=7, kind="ask_selection", received=0.0)
        await a._status(rec, "thinking", (300.0, 400.0, 900.0, 600.0))
        await a._status(rec, "thinking", (310.0, 412.0, 905.0, 615.0))  # < 20 units: kept still
        await a._status(rec, "thinking", (300.0, 500.0, 900.0, 700.0))  # a real move: sent
        await a.claude.close()
        return sent

    th = _thinking(asyncio.run(go()))
    assert [m["bbox"][1] for m in th] == [400.0, 500.0]


def test_the_tablets_ink_bounds_are_preferred(tmp_path):
    from codrawer_bridge.agentd import placement

    async def go():
        a, sent = _agent(tmp_path)
        # a tall lasso (to y 0.30) around the word at y 0.15-0.16; the tablet says where the ink is
        ink = [0.2 * W - W / 2, 0.15 * H, 0.3 * W - W / 2, 0.16 * H]
        rec = await a.answer({**_tap(0.18, 0.10, 0.36, 0.30), "ink": ink, "items": 1})
        await a.claude.close()
        return rec

    rec = asyncio.run(go())
    y0 = rec.placement["reserved_pu"][1]
    assert abs(y0 - (0.16 * H + placement.BELOW_GAP)) < 1  # under the ink, not under the lasso
