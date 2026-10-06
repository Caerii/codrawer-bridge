"""
The optional formal check: run a formalization of the learner's steps through a local prover.

**The problem.** A model's judgment that a proof is sound is an opinion; a proof assistant's is
not. When a formalization of the learner's own steps exists (a Lean 4 file the model wrote with
its reading, or the hand-written one that comes with a fixture) and a prover is installed, the
Primer runs it and reports exactly what happened:

- ``checked``: the prover exited 0 on a file with no ``sorry``, ``admit`` or ``axiom``;
- ``failed``: it ran and rejected the file (``detail`` holds the first error and, when the file
  marks steps with ``-- step N`` comments as ours do, the step the error falls in), or the file
  contained ``sorry``/``admit``/``axiom`` and so proves nothing;
- ``not_checked``: no prover, no formalization, or the prover timed out.

It never claims verification without a run. A check verifies the *formalization*: whether that
file faithfully says what the learner wrote is a separate question, and the detail line names
the formalization's source (``fixture`` or ``model``) so the panel can say so.

**Provers.** Lean 4 (``lean`` on PATH, e.g. from elan; core Lean only, since a learner's machine
will rarely have Mathlib built) and Rocq/Coq (``rocq compile`` or ``coqc``), detected with
``shutil.which``; nothing is installed. The iPad app's Rocq pane (codrawer-ipad
``RocqEditor.swift``) is an editor without a prover process, so the desktop is where checks run.
A run is capped at 120 s.
"""

from __future__ import annotations

import re
import shutil
import subprocess
import tempfile
from pathlib import Path

from .proofdoc import Check

TIMEOUT_S = 120
_FORBIDDEN = re.compile(r"\b(sorry|admit|axiom|Admitted)\b")


def provers() -> dict[str, str]:
    """Installed provers by language: ``{"lean": path, "rocq": path}`` (either may be absent)."""
    out = {}
    lean = shutil.which("lean")
    if lean:
        out["lean"] = lean
    rocq = shutil.which("rocq") or shutil.which("coqc")
    if rocq:
        out["rocq"] = rocq
    return out


def language(source: str) -> str:
    """``rocq`` for Coq/Rocq vernacular (``Proof.`` … ``Qed.``), else ``lean``."""
    return "rocq" if re.search(r"^\s*Proof\.", source, re.M) and "Qed." in source else "lean"


def _step_at(source: str, line: int) -> int | None:
    """The ``-- step N`` (or ``(* step N *)``) comment nearest above ``line`` (1-based)."""
    step = None
    for i, text in enumerate(source.splitlines(), start=1):
        if i > line:
            break
        m = re.search(r"(?:--|\(\*)\s*step\s+(\d+)", text)
        if m:
            step = int(m.group(1))
    return step


def run(source: str | None, origin: str | None = None) -> Check:
    """Check ``source`` with the matching local prover; see the module docstring for outcomes."""
    if not source or not source.strip():
        return Check(
            prover=None,
            status="not_checked",
            detail="no formalization of these steps",
            source=origin,
        )
    lang = language(source)
    found = provers()
    if lang not in found:
        return Check(
            prover=lang,
            status="not_checked",
            detail=f"{lang} is not installed on this computer",
            source=origin,
        )
    if _FORBIDDEN.search(source):
        return Check(
            prover=lang,
            status="failed",
            detail="the formalization uses sorry/admit/axiom, so it proves nothing",
            source=origin,
        )
    with tempfile.TemporaryDirectory(prefix="primer-check-") as d:
        path = Path(d) / ("Proof.lean" if lang == "lean" else "Proof.v")
        path.write_text(source, encoding="utf-8")
        cmd = [found[lang], str(path)]
        if lang == "rocq" and Path(found[lang]).stem == "rocq":
            cmd = [found[lang], "compile", str(path)]
        try:
            proc = subprocess.run(cmd, capture_output=True, text=True, timeout=TIMEOUT_S, cwd=d)
        except subprocess.TimeoutExpired:
            return Check(
                prover=lang,
                status="not_checked",
                detail=f"{lang} timed out after {TIMEOUT_S} s",
                source=origin,
            )
    out = (proc.stdout or "") + (proc.stderr or "")
    if proc.returncode == 0 and "error" not in out.lower():
        return Check(
            prover=lang,
            status="checked",
            detail=f"{lang} accepted the formalization ({origin or 'unknown'} source)",
            source=origin,
        )
    m = re.search(r":(\d+):\d+:\s*error:?\s*(.*)", out) or re.search(
        r"line (\d+).*\n(?:.*\n)*?Error:\s*(.*)", out
    )
    if m:
        line, msg = int(m.group(1)), m.group(2).strip().rstrip(":")
        step = _step_at(source, line)
        where = f"step {step}" if step else f"line {line}"
        return Check(
            prover=lang,
            status="failed",
            detail=f"{lang} rejects {where}: {msg[:160]}",
            source=origin,
        )
    return Check(
        prover=lang,
        status="failed",
        detail=f"{lang} rejected the file: {out.strip()[:160]}",
        source=origin,
    )
