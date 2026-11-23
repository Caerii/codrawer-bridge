#!/usr/bin/env python3
"""Generate shared Python, TypeScript, and QML/JS types from ``protocol/spec.json``.

Run:
    uv run python scripts/gen_types.py          # write generated files
    uv run python scripts/gen_types.py --check  # fail if any generated file is out of date
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
SPEC_PATH = ROOT / "src" / "codrawer_bridge" / "protocol" / "spec.json"
PY_OUT = ROOT / "src" / "codrawer_bridge" / "protocol" / "generated.py"
TS_OUT = ROOT / "packages" / "hand" / "src" / "generated.ts"
QML_OUT = ROOT / "bridge" / "remarkable" / "xovi" / "codrawer-layer" / "qml" / "generated_types.js"


def _lit(items: list[str] | tuple[str, ...]) -> str:
    return ", ".join(json.dumps(x) for x in items)


def _py_tuple(items: list[str]) -> str:
    body = ", ".join(json.dumps(x) for x in items)
    return f"({body},)" if len(items) == 1 else f"({body})"


def render_python(spec: dict[str, Any]) -> str:
    personas = list(spec["personas"].keys())
    styles = list(spec["thinking_styles"])
    colors = list(spec["ink_colors"].keys())
    ink_hex = {k: v for k, v in spec["ink_colors"].items() if v is not None}
    persona_colors = {k: v["color"] for k, v in spec["personas"].items()}
    persona_voices = {k: v["voice"] for k, v in spec["personas"].items()}
    sizes = list(spec["text_sizes"].keys())
    spacings = list(spec["spacings"])
    speeds = list(spec["writing_speeds"].keys())
    models = list(spec["model_speeds"])
    marks = list(spec["mark_kinds"])
    sketches = list(spec["sketch_kinds"])
    dock_ids: dict[str, str] = spec["dock_entry_ids"]
    defaults: dict[str, str] = spec["defaults"]

    lines = [
        '"""AUTO-GENERATED from ``protocol/spec.json`` via ``scripts/gen_types.py``.',
        "",
        "Do not edit by hand.",
        '"""',
        "# ruff: noqa: E501",
        "",
        "from __future__ import annotations",
        "",
        "from typing import Literal, TypedDict",
        "",
        f"PersonaId = Literal[{_lit(personas)}]",
        f"ThinkingStyle = Literal[{_lit(styles)}]",
        f"ColorName = Literal[{_lit(colors)}]",
        f"TextSize = Literal[{_lit(sizes)}]",
        f"Spacing = Literal[{_lit(spacings)}]",
        f"WritingSpeed = Literal[{_lit(speeds)}]",
        f"ModelSpeed = Literal[{_lit(models)}]",
        f"MarkKind = Literal[{_lit(marks)}]",
        f"SketchKind = Literal[{_lit(sketches)}]",
        f"DockEntryId = Literal[{_lit(list(dock_ids.values()))}]",
        "",
        f"PERSONAS: tuple[PersonaId, ...] = {_py_tuple(personas)}",
        f"THINKING_STYLES: tuple[ThinkingStyle, ...] = {_py_tuple(styles)}",
        f"COLORS: tuple[ColorName, ...] = {_py_tuple(colors)}",
        f"SIZES: tuple[TextSize, ...] = {_py_tuple(sizes)}",
        f"SPACINGS: tuple[Spacing, ...] = {_py_tuple(spacings)}",
        f"SPEEDS: tuple[WritingSpeed, ...] = {_py_tuple(speeds)}",
        f"MODEL_SPEEDS: tuple[ModelSpeed, ...] = {_py_tuple(models)}",
        f"MARK_KINDS: tuple[MarkKind, ...] = {_py_tuple(marks)}",
        f"SKETCH_KINDS: tuple[SketchKind, ...] = {_py_tuple(sketches)}",
        "",
        f"INK_COLORS: dict[str, str] = {json.dumps(ink_hex, indent=4)}",
        f"PERSONA_COLORS: dict[str, str] = {json.dumps(persona_colors, indent=4)}",
        f"PERSONA_VOICES: dict[str, str] = {json.dumps(persona_voices, indent=4)}",
        f"TEXT_SIZE: dict[str, float] = {json.dumps(spec['text_sizes'], indent=4)}",
        "WRITING_SPEED: dict[str, tuple[float, float]] = {",
    ]
    for k, (h, p) in spec["writing_speeds"].items():
        lines.append(f"    {json.dumps(k)}: ({h}, {p}),")
    lines.extend([
        "}",
        f"DOCK_IDS: dict[str, str] = {json.dumps(dock_ids, indent=4)}",
        "",
        "SETTINGS: dict[str, tuple[tuple[str, ...], str]] = {",
        f'    "text_size": (SIZES, {json.dumps(defaults["text_size"])}),',
        f'    "spacing": (SPACINGS, {json.dumps(defaults["spacing"])}),',
        f'    "writing_speed": (SPEEDS, {json.dumps(defaults["writing_speed"])}),',
        f'    "autopilot": (("off", "on"), {json.dumps(defaults["autopilot"])}),',
        f'    "persona": (PERSONAS, {json.dumps(defaults["persona"])}),',
        f'    "thinking_style": (THINKING_STYLES, {json.dumps(defaults["thinking_style"])}),',
        f'    "color": (COLORS, {json.dumps(defaults["color"])}),',
        "}",
        "",
        "",
        "class PlacementInfo(TypedDict):",
        '    """Serialized placement metadata stored on ``Record.placement``."""',
        "",
        "    reserved_pu: list[float]",
        "    reserved_norm: list[float]",
        "    side: str",
        "    scale: float",
        "    width_mm: float",
        "    anchor_norm: list[float]",
        "",
        "",
        "class DockEntry(TypedDict, total=False):",
        '    """One entry in ``dock_entries``."""',
        "",
        "    id: str",
        "    label: str",
        "    badge: str",
        "    hint: str",
        "",
    ])
    return "\n".join(lines)


def render_ts(spec: dict[str, Any]) -> str:
    personas = list(spec["personas"].keys())
    styles = list(spec["thinking_styles"])
    colors = list(spec["ink_colors"].keys())
    sizes = list(spec["text_sizes"].keys())
    spacings = list(spec["spacings"])
    speeds = list(spec["writing_speeds"].keys())
    marks = list(spec["mark_kinds"])
    sketches = list(spec["sketch_kinds"])
    dock_ids = spec["dock_entry_ids"]

    return "\n".join([
        "// AUTO-GENERATED from src/codrawer_bridge/protocol/spec.json via scripts/gen_types.py.",
        "// Do not edit by hand.",
        "",
        f"export const PERSONA_IDS = {json.dumps(personas)} as const",
        "export type PersonaId = (typeof PERSONA_IDS)[number]",
        "",
        f"export const THINKING_STYLES = {json.dumps(styles)} as const",
        "export type ThinkingStyle = (typeof THINKING_STYLES)[number]",
        "",
        f"export const INK_COLOR_NAMES = {json.dumps(colors)} as const",
        "export type InkColorName = (typeof INK_COLOR_NAMES)[number]",
        "",
        f"export const TEXT_SIZES = {json.dumps(sizes)} as const",
        "export type TextSize = (typeof TEXT_SIZES)[number]",
        "",
        f"export const SPACINGS = {json.dumps(spacings)} as const",
        "export type Spacing = (typeof SPACINGS)[number]",
        "",
        f"export const WRITING_SPEEDS = {json.dumps(speeds)} as const",
        "export type WritingSpeed = (typeof WRITING_SPEEDS)[number]",
        "",
        f"export const MARK_KINDS = {json.dumps(marks)} as const",
        "export type MarkKind = (typeof MARK_KINDS)[number]",
        "",
        f"export const SKETCH_KINDS = {json.dumps(sketches)} as const",
        "export type SketchKind = (typeof SKETCH_KINDS)[number]",
        "",
        f"export const DOCK_ENTRY_IDS = {json.dumps(dock_ids, indent=2)} as const",
        "export type DockEntryId = (typeof DOCK_ENTRY_IDS)[keyof typeof DOCK_ENTRY_IDS]",
        "",
    ])


def render_qml_js(spec: dict[str, Any]) -> str:
    styles = list(spec["thinking_styles"])
    personas = list(spec["personas"].keys())
    colors = list(spec["ink_colors"].keys())
    dock_ids = spec["dock_entry_ids"]
    return "\n".join([
        ".pragma library",
        "// AUTO-GENERATED from src/codrawer_bridge/protocol/spec.json via scripts/gen_types.py.",
        "// Do not edit by hand.",
        "",
        f"var THINKING_STYLES = {json.dumps(styles)};",
        f"var PERSONAS = {json.dumps(personas)};",
        f"var COLORS = {json.dumps(colors)};",
        f"var DOCK_IDS = {json.dumps(dock_ids, indent=2)};",
        "",
    ])


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--check", action="store_true", help="Exit non-zero if any output differs.")
    args = ap.parse_args()

    spec = json.loads(SPEC_PATH.read_text(encoding="utf-8"))
    targets = [
        (PY_OUT, render_python(spec)),
        (TS_OUT, render_ts(spec)),
        (QML_OUT, render_qml_js(spec)),
    ]

    stale: list[Path] = []
    for path, content in targets:
        existing = path.read_text(encoding="utf-8") if path.exists() else None
        if existing != content:
            if args.check:
                stale.append(path)
            else:
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(content, encoding="utf-8")
                print(f"wrote {path.relative_to(ROOT)}")

    if stale:
        for p in stale:
            print(f"stale: {p.relative_to(ROOT)}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
