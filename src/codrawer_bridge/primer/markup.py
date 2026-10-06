"""
Teacher's markup: the Primer's grading drawn onto the page in red pen, like a teacher marking a
proof.

**The problem.** The first learner asked for feedback that looks like a teacher marking up her
document: circles around gaps, a line through a wrong step, a "?" beside a leap, ticks on the key
steps, short comments in the margin with an arrow to the spot, and the score circled in the
corner. A panel full of text is a report; marks on her own page are feedback she reads where the
thinking happened. The marks are agent ink on their own layer (ADR 003, ADR 009), never on hers:
hideable as one layer, undoable, and on the tablet itself when native agent ink is on.

**The vocabulary** (:func:`select_marks`), from the assessed ProofDoc (assess.py) and each step's
ink bounds (recognize.link_ink):

| finding or step | mark | comment (short, on the page) |
| --- | --- | --- |
| a wrong belief at a step (``misconception``) | strike-through | what is wrong, not the fix |
| a gap that bites (fatal ``missing_rigor`` where it fails) | circle and "?" | the question to ask |
| a gap where it opens (it bites later) | caret where the assumption belongs | e.g. "lowest terms?" |
| any other major gap | circle | "justify …", "… ?" |
| a minor gap | underline | e.g. "why? justify p² even ⇒ p even" |
| a whole-proof finding (step 0) | comment by the first step, with an arrow | e.g. "base case?" |
| an ``exposition`` finding | underline | e.g. "say what you proved" |
| a step read with low confidence or ``unclear`` | circle | "can't read: rewrite?" |
| sound key steps (most cited by later steps) | tick | none |
| the grade | score circled top right, "est." | and a one-line summary under the proof |

Comments are at most eight words and point at the problem without writing the fix (the hint
ladder's first rung, policy.py): the fix comes only if she asks. The phone carries the long
version of each mark (the probe, the finding, the step's LaTeX).

**Placement** (:func:`place`). Every comment, "?", tick and the score must land on free paper: the
occupied regions are the page's user strokes (their boxes, padded), plus marks already placed.
For a comment the candidates are, in order: right of the step, in the left margin, in the gap just
above or below the step's line (scanning left to right), then a scan of the page nearest the step.
A comment that is not beside its step gets an arrow to it. A circle around a step wider than 0.4
page widths hugs the end of the line instead (its last strokes, where a claimed conclusion
usually sits), as a teacher circles a word, not a paragraph. Circles, underlines and strikes are
drawn over and around her ink on purpose; they never hide it (they are thin, red, on another
layer). Coordinates are normalized page coordinates (x of the width, y of the height; the page is
1620 × 2160, so a unit of y is 4/3 of a unit of x).

**Ink.** Text and shapes are written by the ``teacher`` persona of ``packages/hand`` (quick,
confident, slightly slanted; shapes go through the same simulated hand as raw paths), in one batch
(scripts/dev/hand_batch.ts), red (#d03030), brush ``fineliner``, on the ``ai`` layer with
``author: "primer:teacher"`` and ``ink_layer: "codrawer: teacher"`` (the native layer the
tablet bridge should commit them to; ADR 010). Without the hand (no Node), shapes are timed here
and comments stay on the phone. :func:`perform` plays the strokes at their own timing and yields
while the learner's pen is down.
"""

from __future__ import annotations

# ruff: noqa: E501  (comment strings read better unwrapped)
import asyncio
import json
import math
import shutil
import subprocess
from collections.abc import Awaitable, Callable
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

from .concepts import MISCONCEPTIONS
from .proofdoc import ProofDoc

TEACHER_RED = "#d03030"
AUTHOR = "primer:teacher"
INK_LAYER = "codrawer: teacher"
PAGE_MM = (179.6, 239.5)  # packages/hand PAPER_PRO_MM
REPO = Path(__file__).resolve().parents[3]

#: Short margin comments per catalog entry: where the gap opens, and where it bites. At most eight
#: words; they point, they do not fix.
COMMENTS: dict[str, tuple[str, str]] = {
    "sqrt2_no_lowest_terms": ("lowest terms?", "contradicts what?"),
    "square_parity_unproved": ("why? justify p² even ⇒ p even", "why?"),
    "induction_no_hypothesis": ("where is the hypothesis used?", "where is the hypothesis used?"),
    "induction_no_base": ("base case?", "base case?"),
    "induction_wrong_target": ("is this P(k+1)?", "is this P(k+1)?"),
    "assumes_conclusion": ("assumes the goal", "assumes the goal"),
    "converse_confusion": ("converse?", "converse?"),
    "equivalence_one_way": ("other direction?", "other direction?"),
    "quantifier_swap": ("order of ∀ and ∃?", "order of ∀ and ∃?"),
    "example_as_proof": ("examples aren't a proof", "examples aren't a proof"),
    "negation_error": ("check the negation", "check the negation"),
    "division_by_zero": ("could this be 0?", "could this be 0?"),
    "inequality_sign_flip": ("sign of the factor?", "sign of the factor?"),
    "pigeonhole_boxes_unclear": ("what are the boxes?", "what are the boxes?"),
    "cases_not_exhaustive": ("all cases?", "all cases?"),
    "theorem_hypotheses_unchecked": ("hypotheses checked?", "hypotheses checked?"),
    "equality_case_missing": ("when is it equal?", "when is it equal?"),
    "limit_interchange": ("why can the limit move?", "why can the limit move?"),
    "termination_unproved": ("why does it stop?", "why does it stop?"),
    "bijection_unverified": ("why a bijection?", "why a bijection?"),
    "functional_eq_no_verification": ("does it satisfy it?", "does it satisfy it?"),
    "wlog_unjustified": ("why no loss?", "why no loss?"),
    "undefined_variable": ("define this", "define this"),
    "no_conclusion": ("say what you proved", "say what you proved"),
    "unjustified_step": ("why?", "why?"),
}
UNREADABLE = "can't read: rewrite?"


def short(text: str, words: int = 8) -> str:
    """At most ``words`` words."""
    w = text.split()
    return " ".join(w[:words])


# =============================================================================================
# Choosing the marks
# =============================================================================================


@dataclass
class MarkSpec:
    """
    A mark before placement: its ``kind`` (``circle``, ``underline``, ``strike``, ``question``,
    ``check``, ``comment``, ``score``, ``summary``), the step (0 = the whole proof), the catalog
    finding, the short text for the page and the long one for the phone.
    """

    kind: str
    step: int
    finding: str | None = None
    short: str = ""
    long: str = ""


def select_marks(doc: ProofDoc, max_checks: int = 2) -> list[MarkSpec]:
    """The marks for an assessed proof (module docstring's table)."""
    specs: list[MarkSpec] = []
    seen: set[tuple[str, int]] = set()
    opens: dict[str, int] = {}
    for f in doc.findings:
        opens.setdefault(f.id, f.step)
    marked_steps: set[int] = set()
    for f in doc.findings:
        if (f.id, f.step) in seen or f.id not in MISCONCEPTIONS:
            continue
        seen.add((f.id, f.step))
        m = MISCONCEPTIONS[f.id]
        open_c, bite_c = COMMENTS.get(f.id, (short(m.label.lower()), short(m.label.lower())))
        probe = m.probe.replace("{step}", str(f.step or 1))
        long = f"{m.label}. {probe}"
        bites = m.kind == "missing_rigor" and m.severity == "fatal" and f.step != opens[f.id]
        if f.step == 0:
            specs.append(MarkSpec("comment", 0, f.id, open_c, long))
            continue
        marked_steps.add(f.step)
        if m.kind == "misconception":
            specs += [
                MarkSpec("strike", f.step, f.id, "", long),
                MarkSpec("comment", f.step, f.id, open_c, long),
            ]
        elif bites:
            specs += [
                MarkSpec("circle", f.step, f.id, "", long),
                MarkSpec("question", f.step, f.id, "?", long),
                MarkSpec("comment", f.step, f.id, bite_c, long),
            ]
        elif m.kind == "missing_rigor" and any(
            g.id == f.id and g.step != f.step for g in doc.findings
        ):
            # the gap opens here and bites later: a caret where the missing assumption belongs
            specs += [
                MarkSpec("caret", f.step, f.id, "", long),
                MarkSpec("comment", f.step, f.id, open_c, long),
            ]
        elif m.kind == "exposition" or m.severity == "minor":
            specs += [
                MarkSpec("underline", f.step, f.id, "", long),
                MarkSpec("comment", f.step, f.id, open_c, long),
            ]
        else:
            specs += [
                MarkSpec("circle", f.step, f.id, "", long),
                MarkSpec("comment", f.step, f.id, open_c, long),
            ]
    for s in doc.steps:
        if s.n not in marked_steps and (s.status == "unclear" or s.confidence < 0.5):
            marked_steps.add(s.n)
            specs += [
                MarkSpec(
                    "circle",
                    s.n,
                    None,
                    "",
                    f"Step {s.n} was hard to read ({round(s.confidence * 100)}% sure of: {s.text}). Rewrite it more clearly?",
                ),
                MarkSpec("comment", s.n, None, UNREADABLE, "Rewrite this step so it can be read."),
            ]
    cited = {s.n: 0 for s in doc.steps}
    for s in doc.steps:
        for r in s.refs:
            if r in cited:
                cited[r] += 1
    key = sorted(
        (
            n
            for n, c in cited.items()
            if c and n not in marked_steps and (st := doc.step(n)) and st.status == "ok"
        ),
        key=lambda n: (-cited[n], n),
    )
    if doc.grade is not None and doc.grade.score >= 10 and doc.steps and doc.steps[-1].n not in key:
        key = [doc.steps[-1].n, *key]
    for n in key[:max_checks]:
        specs.append(MarkSpec("check", n, None, "", f"Step {n} is a key step, and it is right."))
    if doc.grade is not None:
        g = doc.grade
        specs.append(
            MarkSpec(
                "score",
                0,
                None,
                f"{g.score}/{g.max}",
                f"Estimated Putnam score {g.score}/{g.max} ({g.band.replace('_', ' ')}). An estimate, not an official grade. {g.rigor}",
            )
        )
        specs.append(
            MarkSpec("summary", 0, None, summary_line(doc), f"{g.rigor} {g.exposition}".strip())
        )
    return specs


def summary_line(doc: ProofDoc) -> str:
    """One line under the proof: what is good, then what to look at (a pointer, not the fix)."""
    from .policy import target_finding

    if doc.grade is not None and doc.grade.score >= 10:
        return "Complete and clear. Well done."
    t = target_finding(doc.findings)
    if t is None:
        return "Sound argument; tidy the write-up."
    from .policy import GLANCES

    open_c, _ = COMMENTS.get(t.id, ("look again", "look again"))
    ok = sum(1 for s in doc.steps if s.status == "ok")
    good = "Good idea" if ok >= len(doc.steps) / 2 else "Good start"
    pointer = GLANCES.get(t.id, open_c).replace("{step}", str(t.step or 1))
    return short(f"{good}; {pointer}", 10)


# =============================================================================================
# Placement
# =============================================================================================

Box = tuple[float, float, float, float]


def _hit(a: Box, b: Box) -> bool:
    return not (a[2] <= b[0] or b[2] <= a[0] or a[3] <= b[1] or b[3] <= a[1])


def _pad(b: Box, px: float, py: float) -> Box:
    return (b[0] - px, b[1] - py, b[2] + px, b[3] + py)


def _free(r: Box, occupied: list[Box]) -> bool:
    return (
        0.01 <= r[0]
        and r[2] <= 0.99
        and 0.01 <= r[1]
        and r[3] <= 0.99
        and not any(_hit(r, o) for o in occupied)
    )


@dataclass
class Mark:
    """A placed mark: its spec, its box on the page, its drawing (paths or text origin), stroke ids."""

    id: str
    kind: str
    step: int
    finding: str | None
    short: str
    long: str
    latex: str = ""
    bbox: list[float] = field(default_factory=list)
    anchor: list[float] = field(default_factory=list)
    paths: list[list[list[float]]] = field(default_factory=list)  # normalized polylines (shapes)
    text_origin: list[float] | None = None  # where the renderer's text starts (normalized)
    strokes: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        d.pop("paths")
        d.pop("text_origin")
        return d


def _ellipse(b: Box, wobble_seed: int) -> list[list[float]]:
    """A hand-drawn loop around ``b``: starts at about 200°, goes round once and overshoots."""
    cx, cy = (b[0] + b[2]) / 2, (b[1] + b[3]) / 2
    rx, ry = (b[2] - b[0]) / 2 + 0.014, (b[3] - b[1]) / 2 + 0.012
    pts = []
    n = 48
    for i in range(n + 1):
        a = math.radians(200 + 385 * i / n)
        r = 1 + 0.04 * math.sin(3 * a + wobble_seed) + 0.03 * i / n
        pts.append([cx + rx * r * math.cos(a), cy + ry * r * math.sin(a)])
    return pts


def _arrow(frm: tuple[float, float], to: tuple[float, float]) -> list[list[list[float]]]:
    """A shaft from ``frm`` to ``to`` and a two-stroke head at ``to`` (in page-aspect space)."""
    k = 2160 / 1620
    dx, dy = to[0] - frm[0], (to[1] - frm[1]) * k
    ang = math.atan2(dy, dx)
    head = 0.014
    ends = []
    for s in (+1, -1):
        a = ang + math.pi - s * 0.45
        ends.append([to[0] + head * math.cos(a), to[1] + head * math.sin(a) / k])
    return [[list(frm), list(to)], [ends[0], list(to), ends[1]]]


def _nearest_edge(b: Box, p: tuple[float, float]) -> tuple[float, float]:
    return (min(max(p[0], b[0]), b[2]), min(max(p[1], b[1]), b[3]))


def _arrow_ends(r: Box, a: Box) -> tuple[tuple[float, float], tuple[float, float]]:
    """
    Where an arrow from comment box ``r`` to anchor ``a`` starts and ends: straight down or up
    when the comment is above or below the anchor, else across from the facing side.
    """
    if r[3] <= a[1] or r[1] >= a[3]:
        above = r[3] <= a[1]
        x = min(max((r[0] + r[2]) / 2, a[0] + 0.006), a[2] - 0.006)
        fx = min(max(x, r[0]), r[2])
        return ((fx, r[3] + 0.003) if above else (fx, r[1] - 0.003)), (
            (x, a[1] - 0.003) if above else (x, a[3] + 0.003)
        )
    y = (a[1] + a[3]) / 2
    if r[2] <= a[0]:
        return (r[2] + 0.004, (r[1] + r[3]) / 2), (a[0] - 0.004, y)
    return (r[0] - 0.004, (r[1] + r[3]) / 2), (a[2] + 0.004, y)


def place(
    specs: list[MarkSpec],
    doc: ProofDoc,
    ink: list[Box],
    sizes: dict[str, tuple[float, float]],
    stroke_boxes: dict[str, Box] | None = None,
) -> list[Mark]:
    """
    Place every spec (module docstring). ``ink`` are the page's user stroke boxes; ``sizes`` maps a
    text (comment, "?", score, summary) to its rendered (width, height). Returns the marks, with
    shape paths and text boxes; comments away from their step get an arrow (its own mark).
    """
    occupied: list[Box] = [_pad(b, 0.004, 0.003) for b in ink]
    steps = {s.n: tuple(s.bbox) for s in doc.steps if s.bbox}
    all_ink = (
        (
            min(b[0] for b in ink),
            min(b[1] for b in ink),
            max(b[2] for b in ink),
            max(b[3] for b in ink),
        )
        if ink
        else (0.1, 0.1, 0.9, 0.5)
    )
    first = steps[min(steps)] if steps else all_ink
    last = steps[max(steps)] if steps else all_ink
    marks: list[Mark] = []
    latex = {s.n: s.latex for s in doc.steps}
    shape_at: dict[
        tuple[int, str | None], Box
    ] = {}  # a comment points at its shape when there is one

    def add(spec: MarkSpec, bbox: Box, anchor: Box, paths=None, origin=None) -> Mark:
        m = Mark(
            id=f"mk{len(marks) + 1}",
            kind=spec.kind,
            step=spec.step,
            finding=spec.finding,
            short=spec.short,
            long=spec.long,
            latex=latex.get(spec.step, ""),
            bbox=[round(v, 5) for v in bbox],
            anchor=[round(v, 5) for v in anchor],
            paths=paths or [],
            text_origin=origin,
        )
        marks.append(m)
        if spec.kind in ("comment", "question", "check", "score", "summary"):
            occupied.append(_pad(bbox, 0.006, 0.004))
        return m

    def find_spot(w: float, h: float, a: Box, prefer: str = "comment") -> tuple[Box, bool]:
        """A free box of size (w, h) near anchor ``a``; the bool says it is beside the anchor."""
        yc = (a[1] + a[3]) / 2
        beside = [(a[2] + 0.02, yc - h / 2), (a[0] - 0.02 - w, yc - h / 2)]
        for x, y in beside:
            r = (x, y, x + w, y + h)
            if _free(r, occupied):
                return r, True
        acx = (a[0] + a[2]) / 2
        for y in (a[1] - 0.006 - h, a[3] + 0.006):
            # just above, then just below the anchor, as close to it as the paper allows
            xs = sorted(
                (i / 100 for i in range(1, 100 - int(w * 100))), key=lambda x: abs(x + w / 2 - acx)
            )
            for x in xs:
                r = (x, y, x + w, y + h)
                if _free(r, occupied):
                    return r, False
        best = None
        for gy in range(1, 98, 2):
            for gx in range(1, 98, 2):
                r = (gx / 100, gy / 100, gx / 100 + w, gy / 100 + h)
                if _free(r, occupied):
                    d = math.dist(
                        ((r[0] + r[2]) / 2, (r[1] + r[3]) / 2),
                        ((a[0] + a[2]) / 2, (a[1] + a[3]) / 2),
                    )
                    if best is None or d < best[0]:
                        best = (d, r)
        return (best[1] if best else (0.02, 0.95 - h, 0.02 + w, 0.95)), False

    # Shapes first (they do not claim space), then the texts in reading order.
    for sp in specs:
        a = steps.get(sp.step)
        if a is None:
            continue
        if sp.kind == "circle":
            target = a
            st = doc.step(sp.step)
            if a[2] - a[0] > 0.4 and stroke_boxes and st is not None:
                tail = [
                    stroke_boxes[i]
                    for i in st.strokes
                    if i in stroke_boxes
                    and (stroke_boxes[i][0] + stroke_boxes[i][2]) / 2 >= a[0] + 0.62 * (a[2] - a[0])
                ]
                if tail:
                    target = (
                        min(b[0] for b in tail),
                        min(b[1] for b in tail),
                        max(b[2] for b in tail),
                        max(b[3] for b in tail),
                    )
            add(sp, _pad(target, 0.014, 0.012), target, [_ellipse(target, sp.step)])
            shape_at[(sp.step, sp.finding)] = _pad(target, 0.014, 0.012)
        elif sp.kind == "caret":
            x, y = a[2] + 0.014, a[3] + 0.004
            add(
                sp,
                (x - 0.012, a[3] - 0.012, x + 0.012, y + 0.014),
                a,
                [[[x - 0.011, y + 0.012], [x, a[3] - 0.01], [x + 0.011, y + 0.012]]],
            )
            shape_at[(sp.step, sp.finding)] = (x - 0.012, a[3] - 0.012, x + 0.012, y + 0.014)
        elif sp.kind == "underline":
            y = a[3] + 0.005
            add(
                sp,
                (a[0], y - 0.002, a[2], y + 0.002),
                a,
                [[[a[0], y], [(a[0] + a[2]) / 2, y + 0.002], [a[2], y - 0.001]]],
            )
            shape_at[(sp.step, sp.finding)] = (a[0], a[1], a[2], y + 0.002)
        elif sp.kind == "strike":
            ym = (a[1] + a[3]) / 2
            add(
                sp,
                (a[0] - 0.008, ym - 0.003, a[2] + 0.008, ym + 0.003),
                a,
                [[[a[0] - 0.008, ym + 0.003], [a[2] + 0.008, ym - 0.003]]],
            )
    for sp in specs:
        a = steps.get(sp.step, first if sp.kind == "comment" else all_ink)
        if sp.kind == "check":
            w, h = 0.03, 0.022
            r, _ = find_spot(w, h, a)
            x0, y0, x1, y1 = r
            add(sp, r, a, [[[x0, y0 + 0.55 * h], [x0 + 0.35 * w, y1], [x1, y0]]])
        elif sp.kind in ("question", "comment"):
            if sp.kind == "question" and (sp.step, sp.finding) in shape_at:
                a = shape_at[(sp.step, sp.finding)]  # the "?" sits by the circled words
            if sp.kind == "comment":
                a = shape_at.get((sp.step, sp.finding), a)
            w, h = sizes.get(sp.short, (0.012 * max(1, len(sp.short)), 0.02))
            r, beside = find_spot(w, h, a)
            add(sp, r, a, origin=[r[0], r[1]])
            if sp.kind == "comment" and (not beside or sp.step == 0):
                frm, to = _arrow_ends(r, a)
                if math.dist(frm, to) > 0.02:
                    add(
                        MarkSpec("arrow", sp.step, sp.finding, "", sp.long),
                        (
                            min(frm[0], to[0]),
                            min(frm[1], to[1]),
                            max(frm[0], to[0]),
                            max(frm[1], to[1]),
                        ),
                        a,
                        _arrow(frm, to),
                    )
        elif sp.kind == "score":
            w, h = sizes.get(sp.short, (0.06, 0.025))
            spot = None
            for gy in (0.03, 0.05, 0.07, 0.09, 0.11, 0.13):
                for gx in (0.86, 0.82, 0.78, 0.74):
                    r = (gx, gy, gx + w, gy + h)
                    if _free(_pad(r, 0.02, 0.018), occupied):
                        spot = r
                        break
                if spot:
                    break
            r = spot or find_spot(w, h, (0.8, 0.02, 0.98, 0.1))[0]
            add(sp, r, r, [_ellipse(r, 7)], origin=[r[0], r[1]])
            est = MarkSpec("comment", 0, None, "est.", sp.long)
            ew, eh = sizes.get("est.", (0.04, 0.018))
            er = (r[0] + (w - ew) / 2, r[3] + 0.018, r[0] + (w + ew) / 2, r[3] + 0.018 + eh)
            if not _free(er, occupied):
                er, _ = find_spot(ew, eh, r)
            add(est, er, r, origin=[er[0], er[1]])
        elif sp.kind == "summary":
            w, h = sizes.get(sp.short, (0.012 * len(sp.short), 0.02))
            y = last[3] + 0.03
            r = (first[0], y, first[0] + w, y + h)
            if not _free(r, occupied):
                r, _ = find_spot(w, h, (first[0], last[3], first[2], last[3] + 0.05))
            add(sp, r, last, origin=[r[0], r[1]])
    return marks


# =============================================================================================
# Ink: the teacher's hand
# =============================================================================================


class Renderer:
    """
    Turns texts and shapes into protocol strokes. ``measure`` gives each text's (width, height)
    and the offset from its origin to its box's top-left; ``render`` returns each item's messages.
    This base class times shapes itself (an even, quick pen) and draws no text: the fallback when
    ``packages/hand`` is not available, and the deterministic renderer the tests use.
    """

    text_ink = False

    def measure(self, texts: list[str]) -> dict[str, tuple[float, float, float, float]]:
        return {t: (0.011 * max(1, len(t)), 0.02, 0.0, 0.0) for t in texts}

    def render(self, items: list[dict], start_ts: int) -> dict[str, list[dict]]:
        out: dict[str, list[dict]] = {}
        t = start_ts
        for it in items:
            msgs = shape_strokes(it["key"], it.get("paths") or [], t)
            out[it["key"]] = msgs
            t = (msgs[-1]["ts"] if msgs else t) + 200
        return out


def shape_strokes(key: str, paths: list[list[list[float]]], t0: int) -> list[dict]:
    """
    A shape's strokes timed like a quick, confident pen: resampled every ~2 px, eased in and out
    (a smoothstep along the arc length, so the pen accelerates and settles), pressure ramping at
    the ends, at about 0.8 page widths a second, 70 ms between strokes. The simulated arm of
    ``packages/hand`` smooths a loop the size of a line of writing into a blob, so the Primer draws
    its circles and strikes here and leaves the letters to the hand.
    """
    k = 2160 / 1620
    msgs: list[dict] = []
    t = t0
    for n, path in enumerate(paths):
        if len(path) < 2:
            continue
        cum = [0.0]
        for i in range(1, len(path)):
            cum.append(
                cum[-1] + math.hypot(path[i][0] - path[i - 1][0], (path[i][1] - path[i - 1][1]) * k)
            )
        total = cum[-1] or 1e-6
        dur = max(110, int(total / 0.8 * 1000))
        steps = max(2, int(total / 0.0013))
        pts = []
        j = 0
        for q in range(steps + 1):
            u = q / steps
            target = (u * u * (3 - 2 * u)) * total
            while j < len(cum) - 2 and cum[j + 1] < target:
                j += 1
            f = (target - cum[j]) / ((cum[j + 1] - cum[j]) or 1e-9)
            x = path[j][0] + (path[j + 1][0] - path[j][0]) * f
            y = path[j][1] + (path[j + 1][1] - path[j][1]) * f
            p = 0.62 * min(1.0, 0.45 + 4 * min(u, 1 - u))
            pts.append([round(x, 5), round(y, 5), round(p, 3), t + int(dur * u)])
        sid = f"ai_teacher_{key}_{n}"
        msgs += [{"t": "stroke_begin", "id": sid, "layer": "ai", "brush": "pen", "ts": t}]
        for b in range(0, len(pts), 4):
            msgs.append({"t": "stroke_pts", "id": sid, "pts": pts[b : b + 4]})
        msgs.append({"t": "stroke_end", "id": sid, "ts": t + dur})
        t += dur + 70
    return msgs


def retime(msgs: list[dict], t: int) -> tuple[list[dict], int]:
    """Shift ``msgs`` so the first starts at ``t``; returns them and when the last one ends."""
    if not msgs:
        return msgs, t
    t0 = msgs[0]["ts"] if "ts" in msgs[0] else msgs[0]["pts"][0][3]
    out, end = [], t
    for m in msgs:
        m = dict(m)
        if "ts" in m:
            m["ts"] = int(m["ts"] - t0 + t)
            end = max(end, m["ts"])
        if m.get("t") == "stroke_pts":
            m["pts"] = [[*p[:3], int(p[3] - t0 + t)] for p in m["pts"]]
            end = max(end, m["pts"][-1][3])
        out.append(m)
    return out, end


class HandRenderer(Renderer):
    """The ``teacher`` persona of ``packages/hand`` through scripts/dev/hand_batch.ts (one run per call)."""

    text_ink = True
    SCRIPT = REPO / "scripts" / "dev" / "hand_batch.ts"

    @staticmethod
    def available() -> bool:
        return (
            bool(shutil.which("pnpm"))
            and (REPO / "packages" / "hand" / "package.json").exists()
            and HandRenderer.SCRIPT.exists()
        )

    def _run(self, job: dict) -> dict:
        proc = subprocess.run(
            [shutil.which("pnpm") or "pnpm", "--filter", "hand", "exec", "tsx", str(self.SCRIPT)],
            cwd=REPO,
            input=json.dumps(job),
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=120,
            check=True,
        )
        return json.loads(proc.stdout)["items"]

    def measure(self, texts: list[str]) -> dict[str, tuple[float, float, float, float]]:
        if not texts:
            return {}
        items = [
            {"key": f"t{i}", "text": t, "origin": [0.5, 0.5], "seed": 7 + i}
            for i, t in enumerate(texts)
        ]
        got = self._run({"persona": "teacher", "startTs": 0, "items": items})
        out = {}
        for i, t in enumerate(texts):
            b = got[f"t{i}"]["bbox"]
            out[t] = (b[2] - b[0], b[3] - b[1], b[0] - 0.5, b[1] - 0.5)
        return out

    def render(self, items: list[dict], start_ts: int) -> dict[str, list[dict]]:
        """Texts through the hand (one batch), shapes timed here, then one continuous timeline."""
        texts = [
            {
                "key": it["key"],
                "text": it["text"],
                "origin": it["origin"],
                "seed": 7 + it.get("seed", i),
            }
            for i, it in enumerate(items)
            if it.get("text")
        ]
        written = (
            {
                k: v["messages"]
                for k, v in self._run({"persona": "teacher", "startTs": 0, "items": texts}).items()
            }
            if texts
            else {}
        )
        out: dict[str, list[dict]] = {}
        t = start_ts
        for it in items:
            msgs = (
                written.get(it["key"])
                if it.get("text")
                else shape_strokes(it["key"], it.get("paths") or [], 0)
            )
            out[it["key"]], end = retime(msgs or [], t)
            t = end + 220
        return out


def default_renderer() -> Renderer:
    return HandRenderer() if HandRenderer.available() else Renderer()


@dataclass
class Markup:
    """A proof's markup: the placed marks and every stroke message, in performance order."""

    marks: list[Mark]
    messages: list[dict]

    def block(self) -> dict[str, Any]:
        """The ``markup`` block of a ``primer`` message (docs/protocol.md)."""
        return {
            "layer": INK_LAYER,
            "author": AUTHOR,
            "color": TEACHER_RED,
            "marks": [m.to_dict() for m in self.marks],
        }

    def stroke_ids(self) -> list[str]:
        return [m["id"] for m in self.messages if m.get("t") == "stroke_begin"]


def build(
    doc: ProofDoc,
    ink: list[Box],
    renderer: Renderer | None = None,
    start_ts: int = 0,
    stroke_boxes: dict[str, Box] | None = None,
) -> Markup:
    """
    Select, measure, place and render the marks for ``doc`` over page ink ``ink`` (the user
    strokes' boxes; ``stroke_boxes`` by id, to circle the end of a long line).
    """
    renderer = renderer or default_renderer()
    specs = select_marks(doc)
    texts = sorted(
        {
            s.short
            for s in specs
            if s.kind in ("comment", "question", "score", "summary") and s.short
        }
        | {"est."}
    )
    measured = renderer.measure(texts)
    sizes = {t: (v[0], v[1]) for t, v in measured.items()}
    marks = place(specs, doc, ink, sizes, stroke_boxes)
    items = []
    for i, m in enumerate(marks):
        if m.paths:
            items.append({"key": f"{m.id}s", "paths": m.paths, "mark": m.id})
        if m.text_origin is not None and m.short and renderer.text_ink:
            w, h, dx, dy = measured.get(m.short, (0, 0, 0, 0))
            origin = [m.text_origin[0] - dx, m.text_origin[1] - dy]
            items.append(
                {"key": f"{m.id}t", "text": m.short, "origin": origin, "mark": m.id, "seed": i}
            )
    rendered = renderer.render(items, start_ts) if items else {}
    messages: list[dict] = []
    by_mark = {m.id: m for m in marks}
    for it in items:
        for msg in rendered.get(it["key"], []):
            msg = dict(msg)
            if msg.get("t") == "stroke_begin":
                msg.update(
                    layer="ai",
                    brush="fineliner",
                    color=TEACHER_RED,
                    author=AUTHOR,
                    ink_layer=INK_LAYER,
                )
                by_mark[it["mark"]].strokes.append(msg["id"])
            messages.append(msg)
    return Markup(marks, messages)


async def perform(
    messages: list[dict],
    send: Callable[[dict], Awaitable[None]],
    *,
    user_active: Callable[[], bool] = lambda: False,
    speed: float = 1.0,
) -> None:
    """
    Send ``messages`` at their own timing (each message's ``ts``, or its last point's), relative to
    the first; waits while ``user_active()`` (her pen is down), so the teacher never writes over
    her moving pen. ``speed`` 0 sends at once (tests).
    """

    def due(m: dict) -> float:
        if m.get("t") == "stroke_pts" and m.get("pts"):
            return float(m["pts"][-1][3])
        return float(m.get("ts") or 0)

    if not messages:
        return
    t0 = due(messages[0])
    loop = asyncio.get_running_loop()
    start = loop.time()
    paused = 0.0
    for m in messages:
        if speed > 0:
            while user_active():
                await asyncio.sleep(0.25)
                paused += 0.25
            wait = (due(m) - t0) / 1000 / speed - (loop.time() - start - paused)
            if wait > 0:
                await asyncio.sleep(wait)
        await send(m)
