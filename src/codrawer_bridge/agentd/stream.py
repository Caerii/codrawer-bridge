"""
Writing the answer while the model is still writing it: sentence by sentence, into a reserved block.

**Why.** On the first live day (2026-10-06) the first answer stroke came 17 s after the tap:
~12 s for the whole turn, then 4–5 s laying out the whole answer at three widths. The model's
first sentence was complete seconds before its last. Writing it at once, and the next while the
hand is busy with the first, turns the wait for the whole reply into a wait for one sentence.

**The cost: the block is chosen before the text is known.** The answer's spot is reserved at the
tap (service.py ``_reserve``), sized for a typical answer from the persona's measured metrics
(hand.py :class:`Metrics`): the wrap width and the scale come from it. Each chunk (one or more
sentences, prompt.py :func:`ready_sentences`) is laid out at that width and written starting on
the line below the previous chunk; each sentence begins a new line, which for an answer of one
to three short sentences reads naturally.

**Never over ink, never off the page.** Before a chunk is written its rectangle is checked
against the page's ink (other than this answer's own) and the page's bottom (placement.py); a
chunk that does not fit is not written, nor is anything after it: the glasses carry the whole
answer anyway (service.py), and the record notes it.

**Units.** Page units (1620 per page width, x from the left edge) for positions; millimetres for
the hand's layouts (``x_norm = origin_x + scale · x_mm / 179.6``, hand.py); Unix ms for timing.
"""

from __future__ import annotations

import asyncio
import time
from typing import TYPE_CHECKING

from . import hand as handmod
from . import placement, prompt

if TYPE_CHECKING:
    from .service import Agentd, Record


#: The least clear space between one line's ink and the next line's, mm at scale 1.
LINE_GAP_MM = 0.8


class InkStream:
    """One answer's chunks, written in order into the block at ``(x, y)`` (module docstring)."""

    def __init__(
        self,
        agent: Agentd,
        rec: Record,
        run: str,
        x: float,
        y: float,
        width_mm: float,
        scale: float,
        metrics: handmod.Metrics,
        since,
        page_bottom: float,
    ) -> None:
        self.agent = agent
        self.rec = rec
        self.run = run
        self.x = x
        self.baseline = y - metrics.ascent * scale / placement.MM_PER_PU  # page units
        self.width_mm = width_mm
        self.scale = scale
        self.metrics = metrics  # pitch: the line spacing setting's (service.py effective_metrics)
        self.bottom: float | None = None  # page units: the ink bottom of the last chunk written
        self.since = since
        self.page_bottom = page_bottom
        self.consumed = 0
        self.fed = ""
        self.budget = prompt.MAX_ANSWER_CHARS
        self.written: list[str] = []
        self.stopped = False
        self._queue: asyncio.Queue[str | None] = asyncio.Queue()
        self._task = asyncio.ensure_future(self._run())

    # ── input: the streaming text ───────────────────────────────────────────────────────────

    def feed(self, text: str) -> None:
        """The answer so far (terminal.py ``on_text``): queue the sentences now complete."""
        self.fed = text
        chunks, self.consumed = prompt.ready_sentences(text, self.consumed)
        for c in chunks:
            self._put(c)

    def _put(self, raw: str) -> None:
        text = prompt.clean_answer(raw, limit=self.budget)
        if text and self.budget > 0:
            self.budget -= len(text) + 1
            self._queue.put_nowait(text)

    async def finish(self, final: str) -> None:
        """The turn ended with ``final``: queue what was not written yet, and wait for the hand."""
        done, f = self.fed[: self.consumed].strip(), final.strip()
        # the final text is the streamed segment; if it is not (a later segment replaced it),
        # write nothing more rather than repeat or contradict what is on the page
        rest = (f[len(done) :] if f.startswith(done) else ("" if done else f)).strip()
        if rest:
            # still sentence by sentence; a short tail ("What next?") joins the sentence before it
            parts, used = prompt.ready_sentences(rest + " ", 0)
            tail = (rest + " ")[used:].strip()
            if tail and parts and len(tail) < 25:
                parts[-1] = f"{parts[-1]} {tail}"
            elif tail:
                parts.append(tail)
            for p in parts:
                self._put(p)
        self._queue.put_nowait(None)
        await self._task

    def stop(self) -> None:
        """Stop now (a newer ask replaced this one): nothing more is written."""
        self.stopped = True
        self._task.cancel()

    # ── output: the hand ────────────────────────────────────────────────────────────────────

    async def _run(self) -> None:
        a, rec, m = self.agent, self.rec, self.agent.model
        k = 0
        while True:
            chunk = await self._queue.get()
            if chunk is None or self.stopped:
                if chunk is None:
                    return
                continue
            try:
                lay = (
                    await a.hand.layouts(
                        chunk, a.cfg.persona, (self.width_mm,), seed=7 + k, pitch=self.metrics.pitch
                    )
                )[0]
                # a compact pitch must never let one line's descenders touch the next's ascenders
                lay = handmod.separate_lines(lay, LINE_GAP_MM)
            except handmod.HandUnavailable as e:
                rec.note = f"no handwriting ({e}); glasses only"
                self.stopped = True
                continue
            s, mm = self.scale, placement.MM_PER_PU
            x0, y0, x1, y1 = lay.bbox_mm
            if self.bottom is not None:  # nor the first line of this chunk the last one's
                clash = self.bottom + LINE_GAP_MM * s / mm - (self.baseline + y0 * s / mm)
                if clash > 0:
                    self.baseline += clash
            rect = (
                self.x + min(x0, 0.0) * s / mm,
                self.baseline + y0 * s / mm,
                self.x + x1 * s / mm,
                self.baseline + y1 * s / mm,
            )
            if not self._fits(rect):
                rec.note = f"no room for chunk {k + 1}; the rest is on the glasses only"
                self.stopped = True
                continue
            origin = (self.x / m.w, self.baseline / m.h)
            msgs = handmod.to_messages(
                lay,
                origin,
                s,
                time.time() * 1000 + 30,
                speed=a.cfg.speed,
                run=f"{self.run}c{k}",
                color=a.cfg.color,
                author=f"agentd:{a.cfg.persona}",
            )
            if k == 0:
                await a._status(rec, "writing", rec.status_box or rect)
            ok = await a._play(msgs, on_first=self._first, rec=rec)
            rec.last_stroke_at = self.since()
            rec.strokes += len(lay.strokes)
            for sid, pts in _strokes(msgs):
                m.add_own(sid, pts)
            self.written.append(chunk)
            rec.chunks.append({"text": chunk, "rect_pu": [round(v, 1) for v in rect]})
            if not ok:
                rec.note = "link dropped while writing"
                self.stopped = True
            self.bottom = rect[3]
            lines = handmod.lines_in(lay, self.metrics.pitch)
            self.baseline += (lines * self.metrics.pitch + lay.shift_mm) * s / mm
            k += 1

    def _first(self) -> None:
        if self.rec.first_stroke_at is None:
            self.rec.first_stroke_at = self.since()

    def _fits(self, rect: tuple[float, float, float, float]) -> bool:
        m = self.agent.model
        if rect[3] > self.page_bottom - 40 or rect[2] > m.w - 30:
            return False
        mine = f"agentd_{self.run}c"
        ink = [st.pts for st in m.ink() if not st.id.startswith(mine)]
        ink += self.agent.others_blocks(self.rec.n)  # answers still being thought out elsewhere
        occ = placement.Occupancy(ink, m.w, m.h, height=max(m.h, self.page_bottom) + 400)
        return occ.free(rect, 24.0)


def _strokes(msgs: list[tuple[float, dict]]) -> list[tuple[str, list[list[float]]]]:
    pts: dict[str, list[list[float]]] = {}
    for _, msg in msgs:
        if msg["t"] == "stroke_pts":
            pts.setdefault(msg["id"], []).extend([p[0], p[1], p[2]] for p in msg["pts"])
    return list(pts.items())
