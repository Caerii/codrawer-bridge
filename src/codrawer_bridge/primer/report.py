"""
The weekly progress report: her mirror as a PDF she can annotate, collected into a portfolio.

**What it is.** Once a week (and on demand: the dock's "My progress", ``primer_request`` ``report``,
or the CLI) the Primer typesets what the reflective layer found (reflect.py) with the same LaTeX
pipeline as the proofs (latex.py; Tectonic or pdfLaTeX when installed): goals against progress,
mastery by area and the calibration curve as charts (TikZ), weaknesses with their trend, the
approach profile, blind-spot insights with thumbnails of her own ink as evidence, the error
journal, the next problems with the reason for each, and a page of reflective prompts with room to
answer by hand on the tablet. Reports accumulate under ``<state>/primer/reports/<learner>/`` as a
portfolio she can flip through over the two months.

**Delivery.** The PDF goes to the phone and desktop first (the desktop router serves it, and the
``primer`` message names it). Putting it on the tablet as a document is a write into xochitl's
documented format (a PDF plus ``.metadata``/``.content`` under ``xochitl/``, then a restart or the
sync path): designed in ADR 010, left for the extension and automation work, and only with her OK.

**Tone.** It is her mirror, not a surveillance log: it says only what the features she turned on
recorded, it is specific and kind, and every heuristic says what it rests on.
"""

from __future__ import annotations

# ruff: noqa: E501  (LaTeX templates read better unwrapped)
import datetime as dt
import json
from pathlib import Path
from typing import Any

from .concepts import AREA_LABELS, AREAS, CONCEPTS
from .latex import compile_tex, escape_text
from .learner import Learner, state_dir
from .metacog import REFLECTION_PROMPTS
from .practice import BANK, EXAM_DATE, choose_queue
from .reflect import activity_review, blind_spots

e = escape_text


def _area_mastery(lr: Learner) -> list[tuple[str, float, int]]:
    out = []
    for a in AREAS:
        cs = [c for c in CONCEPTS.values() if c.area == a]
        seen = [
            lr.concepts[c.id] for c in cs if c.id in lr.concepts and lr.concepts[c.id].opportunities
        ]
        if seen:
            out.append((AREA_LABELS[a], sum(s.p for s in seen) / len(seen), len(seen)))
    return out


def _bars(rows: list[tuple[str, float, int]]) -> str:
    """Horizontal mastery bars (TikZ), one row per area with evidence."""
    if not rows:
        return r"\emph{No evidence yet.}"
    lines = [r"\begin{tikzpicture}[x=6cm,y=0.55cm]"]
    for i, (label, p, n) in enumerate(rows):
        y = -i
        lines.append(rf"\node[anchor=east,font=\small] at (-0.02,{y}) {{{e(label)}}};")
        lines.append(rf"\fill[black!10] (0,{y - 0.3}) rectangle (1,{y + 0.3});")
        lines.append(rf"\fill[black!60] (0,{y - 0.3}) rectangle ({p:.3f},{y + 0.3});")
        lines.append(
            rf"\node[anchor=west,font=\scriptsize] at (1.02,{y}) {{{round(p * 100)}\% ({n} concepts)}};"
        )
    lines.append(r"\end{tikzpicture}")
    return "\n".join(lines)


def _calibration_plot(cal: dict[str, Any]) -> str:
    """Confidence against outcome per bin (TikZ), with the diagonal of perfect calibration."""
    if not cal.get("curve"):
        return r"\emph{No confidence ratings yet. Rate how sure you are before asking the Primer to read a proof.}"
    lines = [
        r"\begin{tikzpicture}[x=5cm,y=5cm]",
        r"\draw[black!30] (0,0) rectangle (1,1);",
        r"\draw[black!30,dashed] (0,0) -- (1,1);",
        r"\node[font=\scriptsize,below] at (0.5,0) {how sure you were};",
        r"\node[font=\scriptsize,rotate=90,above] at (0,0.5) {how it was graded};",
    ]
    pts = []
    for b in cal["curve"]:
        x, y = b["confidence"], b["outcome"]
        pts.append(f"({x:.3f},{y:.3f})")
        lines.append(rf"\fill[black] ({x:.3f},{y:.3f}) circle (0.018);")
        lines.append(rf"\node[font=\tiny,right] at ({x:.3f},{y:.3f}) {{{b['n']}}};")
    if len(pts) > 1:
        lines.append(r"\draw[black] " + " -- ".join(pts) + ";")
    lines.append(r"\end{tikzpicture}")
    return "\n".join(lines)


def build_tex(lr: Learner, now_ms: float, sample_note: str = "") -> tuple[str, dict[str, bytes]]:
    """The report's LaTeX and the image files it includes (thumbnails of her ink)."""
    review = activity_review(lr, now_ms)
    insights = blind_spots(lr, now_ms)
    today = dt.datetime.fromtimestamp(now_ms / 1000).date()
    exam = dt.date.fromisoformat(lr.exam_date or EXAM_DATE)
    files: dict[str, bytes] = {}

    def thumb(path: str) -> str:
        if not path or not Path(path).exists():
            return ""
        name = f"thumb{len(files)}.png"
        files[name] = Path(path).read_bytes()
        return rf"\includegraphics[height=2.4cm]{{{name}}}"

    g = lr.goals
    mocks = [s for s in lr.sessions if s.kind == "mock"]
    L: list[str] = [
        r"\documentclass[11pt]{article}",
        r"\usepackage[margin=0.9in]{geometry}",
        r"\usepackage{amsmath,amssymb,graphicx,tikz,enumitem}",
        r"\usepackage[hidelinks]{hyperref}",
        r"\setlength{\parindent}{0pt}\setlength{\parskip}{4pt}",
        r"\begin{document}",
        rf"{{\LARGE Progress report}}\hfill {e(lr.name)} \textperiodcentered{{}} {today.isoformat()}\par",
        r"\textit{Your mirror, not a grade. Everything here comes from the work you chose to share; scores are the Primer's estimates.}\par",
    ]
    if sample_note:
        L.append(rf"\fbox{{\parbox{{0.95\linewidth}}{{\small {e(sample_note)}}}}}\par")
    L += [r"\section*{Goals and progress}", r"\begin{itemize}[leftmargin=1.2em]"]
    L.append(
        rf"\item Exam: {exam.isoformat()}, {(exam - today).days} days away (four 90-minute sessions of three problems)."
    )
    L.append(
        rf"\item Your goal: {e(g.target) if g.target else 'not set yet (it is yours to set, in the Learner tab)'}"
        + (
            rf" (about {g.target_score}/120)"
            if g.target_score and f"{g.target_score}/120" not in g.target
            else ""
        )
        + "."
    )
    if g.weekly_hours:
        mins = sum(a.minutes for a in lr.attempts if now_ms - a.ts <= 7 * 86_400_000)
        L.append(
            rf"\item This week: {mins / 60:.1f} h of problems against {g.weekly_hours:g} h planned."
        )
    if mocks:
        L.append(
            r"\item Mock exams: "
            + ", ".join(f"{sum(m.scores)}/120" for m in mocks[-4:])
            + " (estimates)."
        )
    L.append(rf"\item Problems attempted: {len(lr.attempts)}; reviews scheduled: {len(lr.items)}.")
    L += [r"\end{itemize}", r"\section*{Mastery by area}", _bars(_area_mastery(lr))]
    cal = review["calibration"]
    L += [r"\section*{Calibration}", _calibration_plot(cal), r"\par"]
    if cal.get("n"):
        L.append(
            rf"Over {cal['n']} rated proofs your average gap between confidence and grade is {round((cal['gap'] or 0) * 100):+d} points (positive: more sure than the grades). Brier score {cal['brier']} (0 is perfect)."
        )
        for f in cal["flags"]:
            name = CONCEPTS[f["technique"]].label if f["technique"] in CONCEPTS else f["technique"]
            L.append(
                rf"\par\textbullet\ {e(name)}: {'more' if f['kind'] == 'over' else 'less'} sure than the grades by {abs(round(f['gap'] * 100))} points ({f['n']} proofs)."
            )
    L += [r"\section*{Weak spots}"]
    if review["weaknesses"]:
        L.append(r"\begin{itemize}[leftmargin=1.2em]")
        for w in review["weaknesses"]:
            detail = (
                f"seen {w['count']} times" if w["kind"] == "mistake" else f"mastery {w['mastery']}"
            )
            probs = ", ".join(sorted({x["title"] for x in w["evidence"]}))
            L.append(rf"\item {e(w['label'])} ({detail}){': ' + e(probs) if probs else ''}.")
        L.append(r"\end{itemize}")
    else:
        L.append(r"\emph{Nothing stands out yet.}")
    trend = [t for t in review["topics"] if t["attempts"] or t["trend"]]
    if trend:
        L.append(
            r"\par\textbf{Topics this week:} "
            + "; ".join(
                f"{e(t['label'])} {t['attempts']} attempts, {t['minutes']:g} min, trend {'+' if t['trend'] >= 0 else ''}{t['trend']:.2f}"
                for t in trend[:6]
            )
            + "."
        )
    L += [r"\section*{How you approach problems}"]
    if review["approach"]:
        L.append(r"\begin{itemize}[leftmargin=1.2em]")
        for a in review["approach"]:
            L.append(rf"\item {e(a['text'])} \hfill{{\small\textit{{{e(a['basis'])}}}}}")
        L.append(r"\end{itemize}")
    else:
        L.append(r"\emph{A few more attempts and a picture will form.}")
    L += [r"\section*{Things you might not see from inside}"]
    if insights:
        for i in insights[:5]:
            L.append(
                rf"\textbf{{{e(i.text)}}}\par {e(i.suggestion)} \hfill{{\small\textit{{confidence {round(i.confidence * 100)}\%}}}}\par"
            )
            thumbs = [thumb(x.get("thumb", "")) for x in i.evidence[:3]]
            thumbs = [t for t in thumbs if t]
            if thumbs:
                L.append(r"\par " + r"\hspace{0.5em}".join(thumbs) + r"\par")
            refs = ", ".join(sorted({x["title"] for x in i.evidence}))
            if refs:
                L.append(rf"{{\small Evidence: {e(refs)} (replay each page from the panel).}}\par")
            L.append(r"\medskip")
        L.append(
            r"{\small Confirm or dismiss each one in the Learner tab: your verdict teaches the Primer.}"
        )
    else:
        L.append(r"\emph{No blind spots found this week, or activity review is off.}")
    journal = [it for it in lr.items if it.kind == "mistake"]
    L += [r"\section*{Error journal}"]
    if journal:
        L.append(r"\begin{itemize}[leftmargin=1.2em]")
        for it in journal:
            seen = f"reviewed {it.reps} times, {it.lapses} lapses" if it.reps else "new"
            L.append(rf"\item {e(it.prompt)} \hfill{{\small {seen}}}")
        L.append(r"\end{itemize}")
    else:
        L.append(
            r"\emph{Empty: mistakes the Primer marks will appear here, and you decide what they mean.}"
        )
    L += [r"\section*{Next problems}", r"\begin{enumerate}[leftmargin=1.5em]"]
    for p in choose_queue(lr, now_ms, n=5):
        L.append(
            rf"\item {e(p.title)}: {e(BANK[p.problem].statement if p.problem in BANK else '')}\par{{\small\textit{{Why: {e(p.why)}}}}}"
        )
    L += [
        r"\end{enumerate}",
        r"\newpage",
        r"\section*{Your reflection}",
        r"\textit{Answer by hand. The Primer reads these only if you ask it to.}\par",
    ]
    for q in REFLECTION_PROMPTS:
        L.append(
            rf"\textbf{{{e(q)}}}\par"
            + r"\vspace{0.3em}"
            + "".join(r"\rule{\linewidth}{0.2pt}\par\vspace{1.1em}" for _ in range(5))
        )
    L.append(r"\end{document}")
    return "\n".join(L) + "\n", files


def report_dir(learner: str, root: Path | None = None) -> Path:
    return (root or state_dir()) / "primer" / "reports" / learner


def build_pdf(
    lr: Learner, now_ms: float, root: Path | None = None, sample_note: str = ""
) -> tuple[Path | None, str]:
    """Typeset the report into the learner's portfolio; returns (pdf path or None, log line)."""
    tex, files = build_tex(lr, now_ms, sample_note)
    folder = report_dir(lr.name, root)
    folder.mkdir(parents=True, exist_ok=True)
    stem = "report-" + dt.datetime.fromtimestamp(now_ms / 1000).date().isoformat()
    (folder / f"{stem}.tex").write_text(tex, encoding="utf-8")
    pdf, log = compile_tex(tex, files=files)
    if pdf is None:
        return None, log
    out = folder / f"{stem}.pdf"
    out.write_bytes(pdf)
    index = folder / "portfolio.json"
    entries = json.loads(index.read_text(encoding="utf-8")) if index.exists() else []
    entries = [x for x in entries if x.get("file") != out.name] + [{"file": out.name, "ts": now_ms}]
    index.write_text(json.dumps(sorted(entries, key=lambda x: x["ts"]), indent=1), encoding="utf-8")
    return out, log


def portfolio(learner: str, root: Path | None = None) -> list[dict[str, Any]]:
    """Her reports, oldest first."""
    index = report_dir(learner, root) / "portfolio.json"
    return json.loads(index.read_text(encoding="utf-8")) if index.exists() else []
