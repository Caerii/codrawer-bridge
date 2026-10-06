"""
Spike: TeX math typeset by MathJax inside Qt's own JavaScript engine, drawn by QtSvg.

**The question.** Can xochitl render LaTeX math offline with only what it already loads? It maps
libQt6Qml (the V4 engine behind QJSEngine and WorkerScript) and libQt6Svg plus the qsvg image
plugin (docs/investigations/latex-on-tablet.md, spike 1). If MathJax runs in V4 and QtSvg draws
its SVG faithfully, a QML panel injected by codrawer-layer can typeset math with no native
renderer at all.

**What it measures** (on the desktop, with PySide6's Qt, the same V4 and QtSvg code as the
tablet's 6.10.3): the bundle's load time, per-formula TeX→SVG time on first and warm calls, SVG
size, and QSvgRenderer's draw time at 120 px tall; then whether KaTeX's output is something Qt can
draw (it is HTML positioned by CSS, so no). PNGs are written next to the script for inspection.

**How to run**::

    cd scripts/dev/latex_spikes
    pnpm add mathjax-full@3 katex esbuild     # scratch install, not committed
    npx esbuild mathjax_entry.js --bundle --format=iife --minify --target=es2016 --outfile=mathjax-v4.js
    uv run --with pyside6 python -u qjs_mathjax.py

Desktop numbers translate to the Paper Pro's Cortex-A53 by roughly ×7 (single-thread), an
estimate, not a measurement; the doc says how it was derived.
"""

from __future__ import annotations

import sys
import time

from PySide6.QtCore import QByteArray, QSize, Qt, qVersion
from PySide6.QtGui import QGuiApplication, QImage, QPainter
from PySide6.QtQml import QJSEngine
from PySide6.QtSvg import QSvgRenderer

# Six formulas of the Primer's kind: inline fractions, integrals, sums, aligned, cases, matrices.
BS = chr(92)
FORMULAS = [
    f"{BS}sqrt{{2}}={BS}tfrac{{p}}{{q}},{BS} p,q{BS}in{BS}mathbb{{Z}},{BS} q{BS}neq 0",
    f"{BS}int_0^1 x^2{BS},dx={BS}frac13",
    f"{BS}sum_{{n{BS}ge1}}{BS}frac{{1}}{{n^2}}={BS}frac{{{BS}pi^2}}{{6}}",
    f"{BS}begin{{aligned}}2q^2 &= p^2 {BS}implies 2 {BS}mid p{BS}{BS} q^2 &= 2k^2{BS}end{{aligned}}",
    f"f(x)={BS}begin{{cases}}x^2 & x{BS}ge 0{BS}{BS} -x & x<0{BS}end{{cases}}",
    f"{BS}left({BS}begin{{matrix}}a&b{BS}{BS}c&d{BS}end{{matrix}}{BS}right)^{{-1}}"
    f"={BS}frac{{1}}{{ad-bc}}{BS}left({BS}begin{{matrix}}d&-b{BS}{BS}-c&a{BS}end{{matrix}}{BS}right)",
]


def load(engine: QJSEngine, path: str) -> float:
    """Evaluate a bundle in ``engine``; V4 lacks ``globalThis``, so alias it first. Returns ms."""
    src = "var globalThis = this;" + open(path, encoding="utf-8").read()
    t = time.perf_counter()
    r = engine.evaluate(src, path)
    if r.isError():
        raise RuntimeError(f"{path}: {r.toString()}")
    return (time.perf_counter() - t) * 1000


def main() -> None:
    app = QGuiApplication(sys.argv)  # QtSvg's renderer needs a GUI application
    print("Qt", qVersion())
    eng = QJSEngine()
    print(f"mathjax bundle evaluate: {load(eng, 'mathjax-v4.js'):.0f} ms")
    tex2svg = eng.globalObject().property("tex2svg")
    svgs = []
    for rnd in ("first", "warm"):
        total = 0.0
        for i, tex in enumerate(FORMULAS):
            t = time.perf_counter()
            r = tex2svg.call([tex, True])
            dt = (time.perf_counter() - t) * 1000
            total += dt
            if rnd == "first":
                svgs.append(r.toString())
                print(f"  [{i}] {dt:6.1f} ms  svg {len(svgs[-1])} B")
        print(f"mathjax {rnd}: {total:.0f} ms for {len(FORMULAS)} formulas")

    for i, svg in enumerate(svgs):
        rr = QSvgRenderer(QByteArray(svg.encode()))
        ds = rr.defaultSize()
        h = 120
        w = max(1, round(ds.width() * h / max(1, ds.height())))
        img = QImage(QSize(w, h), QImage.Format_Grayscale8)
        img.fill(Qt.white)
        t = time.perf_counter()
        p = QPainter(img)
        rr.render(p)
        p.end()
        print(f"  qsvg [{i}] valid={rr.isValid()} draw {(time.perf_counter() - t) * 1000:.1f} ms at {w}x{h}")
        img.save(f"mathjax_{i}.png")
    del app


if __name__ == "__main__":
    main()
