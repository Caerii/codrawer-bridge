"""
LaTeX: the learner's proof re-typeset as a document, and compiled when a TeX engine is installed.

**The problem.** Part of the Primer's answer is the proof itself, clean: the learner's own steps,
in her order, with her reasons, typeset. Not a corrected proof: the Primer's notes go in a
separate, clearly headed section, so the document stays hers (ADR 010, "Output in the medium").

**Shape.** ``article`` with amsmath, amssymb and amsthm: the claim as a theorem (from
``ProofDoc.goal``), then a ``proof`` environment with one numbered item per step: the step's
mathematics displayed, her reading of it, and her justification in parentheses. With
``annotate=True`` a final section "Notes from the Primer" lists the findings, the formal check's
outcome and the grade estimate, labelled as an estimate.

**Text versus math.** Step ``latex`` is already math (KaTeX-safe, no ``$``) and goes in as is;
plain text (titles, readings, reasons, notes) is escaped for LaTeX's special characters, and the
handful of Unicode symbols handwriting transcriptions contain (√ ² ⇒ ≠ ≤ ≥ ∈ ℚ ∎ …) become math
macros, so the file compiles under pdfLaTeX as well as XeLaTeX/Tectonic.

**Compiling.** :func:`compile_tex` uses ``pdflatex``, else ``tectonic``, else ``xelatex``, if one is
on PATH, in a temporary directory with a 180 s cap, and returns the PDF bytes or the log tail. With
none, the app's KaTeX rendering of the same step LaTeX is the only rendering (the panel).
"""

from __future__ import annotations

# ruff: noqa: E501  (command lines and LaTeX templates read better unwrapped)
import shutil
import subprocess
import tempfile
from pathlib import Path

from .concepts import CONCEPTS, MISCONCEPTIONS
from .proofdoc import ProofDoc

_UNICODE = {
    "√": r"$\surd$",
    "²": r"$^{2}$",
    "³": r"$^{3}$",
    "⇒": r"$\Rightarrow$",
    "⇔": r"$\Leftrightarrow$",
    "→": r"$\to$",
    "≠": r"$\neq$",
    "≤": r"$\leq$",
    "≥": r"$\geq$",
    "∈": r"$\in$",
    "∉": r"$\notin$",
    "ℚ": r"$\mathbb{Q}$",
    "ℤ": r"$\mathbb{Z}$",
    "ℕ": r"$\mathbb{N}$",
    "ℝ": r"$\mathbb{R}$",
    "∎": r"$\blacksquare$",
    "−": "-",
    "×": r"$\times$",
    "·": r"$\cdot$",
    "…": r"\ldots{}",
    "—": "---",
    "–": "--",
    "’": "'",
    "“": "``",
    "”": "''",
    "∀": r"$\forall$",
    "∃": r"$\exists$",
    "¬": r"$\neg$",
    "∧": r"$\wedge$",
    "∨": r"$\vee$",
    "≡": r"$\equiv$",
    "∣": r"$\mid$",
}
_SPECIAL = {
    "\\": r"\textbackslash{}",
    "&": r"\&",
    "%": r"\%",
    "$": r"\$",
    "#": r"\#",
    "_": r"\_",
    "{": r"\{",
    "}": r"\}",
    "~": r"\textasciitilde{}",
    "^": r"\textasciicircum{}",
}


def escape_text(s: str) -> str:
    """Plain text → LaTeX: special characters escaped, known Unicode symbols as macros, others dropped."""
    out = []
    for ch in s:
        if ch in _SPECIAL:
            out.append(_SPECIAL[ch])
        elif ch in _UNICODE:
            out.append(_UNICODE[ch])
        elif ord(ch) < 128:
            out.append(ch)
        else:
            out.append("?")
    return "".join(out)


def to_tex(doc: ProofDoc, *, annotate: bool = True, author: str | None = None) -> str:
    """The complete ``.tex`` document for ``doc`` (module docstring)."""
    title = escape_text(doc.title or "Proof")
    lines = [
        r"\documentclass[11pt]{article}",
        r"\usepackage{amsmath,amssymb,amsthm}",
        r"\usepackage[margin=1in]{geometry}",
        r"\usepackage{enumitem}",
        r"\newtheorem*{claim}{Claim}",
        rf"\title{{{title}}}",
        rf"\author{{{escape_text(author) if author else 'Handwritten, re-typeset by the Primer'}}}",
        r"\date{}",
        r"\begin{document}",
        r"\maketitle",
        "",
    ]
    if doc.goal:
        lines += [r"\begin{claim}", rf"$\displaystyle {doc.goal}$", r"\end{claim}", ""]
    technique = CONCEPTS[doc.technique].label if doc.technique in CONCEPTS else doc.technique
    if technique:
        lines.append(rf"\noindent\textit{{Technique: {escape_text(technique)}.}}")
        lines.append("")
    lines += [r"\begin{proof}", r"\begin{enumerate}[label=\textbf{\arabic*.}, leftmargin=2em]"]
    for s in doc.steps:
        item = [r"\item"]
        if s.latex.strip():
            item.append(rf"$\displaystyle {s.latex}$\\")
        reading = escape_text(s.text)
        if s.justification:
            reading += rf" \emph{{({escape_text(s.justification)})}}"
        item.append(reading)
        lines.append(" ".join(item))
    lines += [r"\end{enumerate}", r"\end{proof}", ""]
    if annotate and (doc.findings or doc.grade or doc.check):
        lines += [r"\section*{Notes from the Primer}", r"\begin{itemize}"]
        steps_by_id: dict[str, list[int]] = {}
        for f in doc.findings:
            steps_by_id.setdefault(f.id, []).append(f.step)
        for fid, steps in steps_by_id.items():
            m = MISCONCEPTIONS.get(fid)
            nums = sorted({s for s in steps if s})
            where = (
                ("Step " if len(nums) == 1 else "Steps ") + ", ".join(map(str, nums))
                if nums
                else "Whole proof"
            )
            lines.append(rf"\item {where}: {escape_text(m.label if m else fid)}.")
        if doc.check:
            lines.append(
                rf"\item Formal check ({escape_text(doc.check.prover or 'none')}): {escape_text(doc.check.status.replace('_', ' '))}. {escape_text(doc.check.detail)}"
            )
        if doc.grade:
            g = doc.grade
            lines.append(
                rf"\item Estimated Putnam-style score: {g.score}/{g.max} ({escape_text(g.band.replace('_', ' '))}). An estimate, not a grader's mark."
            )
            if g.rigor:
                lines.append(rf"\item Rigor: {escape_text(g.rigor)}")
            if g.exposition:
                lines.append(rf"\item Exposition: {escape_text(g.exposition)}")
        lines += [r"\end{itemize}", ""]
    lines.append(r"\end{document}")
    return "\n".join(lines) + "\n"


def tex_engine() -> str | None:
    """The first TeX engine on PATH: pdflatex, tectonic, xelatex."""
    for name in ("pdflatex", "tectonic", "xelatex"):
        if shutil.which(name):
            return name
    return None


def compile_tex(tex: str, timeout_s: int = 180) -> tuple[bytes | None, str]:
    """Compile ``tex``; returns ``(pdf, log tail)``, ``pdf`` None on failure or with no engine."""
    engine = tex_engine()
    if engine is None:
        return None, "no TeX engine installed (pdflatex, tectonic or xelatex); KaTeX rendering only"
    with tempfile.TemporaryDirectory(prefix="primer-tex-") as d:
        src = Path(d) / "proof.tex"
        src.write_text(tex, encoding="utf-8")
        cmd = (
            [engine, "proof.tex"]
            if engine == "tectonic"
            else [engine, "-interaction=nonstopmode", "-halt-on-error", "proof.tex"]
        )
        try:
            proc = subprocess.run(cmd, cwd=d, capture_output=True, text=True, timeout=timeout_s)
        except subprocess.TimeoutExpired:
            return None, f"{engine} timed out after {timeout_s} s"
        pdf = Path(d) / "proof.pdf"
        log = ((proc.stdout or "") + (proc.stderr or ""))[-1500:]
        if proc.returncode == 0 and pdf.exists():
            return pdf.read_bytes(), f"{engine}: ok"
        return None, f"{engine} failed: {log}"


def syntax_problems(tex: str) -> list[str]:
    """
    A sanity check for when no engine is installed: balanced braces (ignoring escaped ones),
    matched ``\\begin``/``\\end`` pairs in order, and an even number of unescaped ``$``.
    """
    problems = []
    depth = 0
    i = 0
    while i < len(tex):
        c = tex[i]
        if c == "\\":
            i += 2
            continue
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth < 0:
                problems.append(f"unbalanced '}}' at {i}")
                depth = 0
        i += 1
    if depth:
        problems.append(f"{depth} unclosed '{{'")
    import re

    stack = []
    for m in re.finditer(r"\\(begin|end)\{([^}]*)\}", tex):
        if m.group(1) == "begin":
            stack.append(m.group(2))
        elif not stack or stack.pop() != m.group(2):
            problems.append(f"\\end{{{m.group(2)}}} does not match")
    if stack:
        problems.append(f"unclosed environments: {stack}")
    dollars = len(re.findall(r"(?<!\\)\$", tex))
    if dollars % 2:
        problems.append("odd number of $")
    return problems
