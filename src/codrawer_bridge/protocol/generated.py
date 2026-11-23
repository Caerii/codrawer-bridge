"""AUTO-GENERATED from ``protocol/spec.json`` via ``scripts/gen_types.py``.

Do not edit by hand.
"""
# ruff: noqa: E501

from __future__ import annotations

from typing import Literal, TypedDict

PersonaId = Literal["archivist", "sketcher", "elder", "mathematician", "calligrapher"]
ThinkingStyle = Literal["navi", "pen", "glyph", "orbit", "spark"]
ColorName = Literal["auto", "blue", "red", "green", "purple", "gold", "black"]
TextSize = Literal["micro", "tiny", "small", "medium", "large"]
Spacing = Literal["compact", "normal", "airy"]
WritingSpeed = Literal["calm", "fast", "very_fast"]
ModelSpeed = Literal["fast", "careful"]
MarkKind = Literal["circle", "underline", "arrow", "bracket", "star"]
SketchKind = Literal["box", "rect", "circle", "ellipse", "line", "arrow", "arc", "dot", "star", "curve", "poly"]
DockEntryId = Literal["agentd_memory", "agentd_autopilot", "agentd_forget", "agentd_persona", "agentd_thinking_style", "agentd_color", "agentd_model", "agentd_text_size", "agentd_spacing", "agentd_writing_speed"]

PERSONAS: tuple[PersonaId, ...] = ("archivist", "sketcher", "elder", "mathematician", "calligrapher")
THINKING_STYLES: tuple[ThinkingStyle, ...] = ("navi", "pen", "glyph", "orbit", "spark")
COLORS: tuple[ColorName, ...] = ("auto", "blue", "red", "green", "purple", "gold", "black")
SIZES: tuple[TextSize, ...] = ("micro", "tiny", "small", "medium", "large")
SPACINGS: tuple[Spacing, ...] = ("compact", "normal", "airy")
SPEEDS: tuple[WritingSpeed, ...] = ("calm", "fast", "very_fast")
MODEL_SPEEDS: tuple[ModelSpeed, ...] = ("fast", "careful")
MARK_KINDS: tuple[MarkKind, ...] = ("circle", "underline", "arrow", "bracket", "star")
SKETCH_KINDS: tuple[SketchKind, ...] = ("box", "rect", "circle", "ellipse", "line", "arrow", "arc", "dot", "star", "curve", "poly")

INK_COLORS: dict[str, str] = {
    "blue": "#1f6fe0",
    "red": "#d93025",
    "green": "#188038",
    "purple": "#7b2cbf",
    "gold": "#c26401",
    "black": "#141414"
}
PERSONA_COLORS: dict[str, str] = {
    "archivist": "#1f6fe0",
    "sketcher": "#7b2cbf",
    "elder": "#188038",
    "mathematician": "#1558b0",
    "calligrapher": "#b3261e"
}
PERSONA_VOICES: dict[str, str] = {
    "archivist": "Persona \u2014 Archivist: precise, observant, synthesizing across notes, sources, and structure; favor `MARK: underline` or `bracket` on key passages.",
    "sketcher": "Persona \u2014 Sketcher: visual, spatial, associative\u2014great for diagrams, systems, flows, and ideation; use `MARK: circle`, `arrow`, and `star` freely.",
    "elder": "Persona \u2014 Elder: warm, unhurried, Socratic. Zoom out to intent, framing, and core principles with thoughtful perspective and guiding questions.",
    "mathematician": "Persona \u2014 Mathematician: analytical, rigorous, step-aware\u2014great for models, tradeoffs, code, and derivations; check assumptions and offer the sharpest next step.",
    "calligrapher": "Persona \u2014 Calligrapher: poised, distilled, expressive. Craft concise, rhythmic prose and sharp phrasing where every word earns its place."
}
TEXT_SIZE: dict[str, float] = {
    "micro": 0.42,
    "tiny": 0.55,
    "small": 0.7,
    "medium": 1.0,
    "large": 1.3
}
WRITING_SPEED: dict[str, tuple[float, float]] = {
    "calm": (1.5, 2.0),
    "fast": (2.0, 2.2),
    "very_fast": (2.0, 3.6),
}
DOCK_IDS: dict[str, str] = {
    "memory": "agentd_memory",
    "autopilot": "agentd_autopilot",
    "forget": "agentd_forget",
    "persona": "agentd_persona",
    "thinking_style": "agentd_thinking_style",
    "color": "agentd_color",
    "model": "agentd_model",
    "text_size": "agentd_text_size",
    "spacing": "agentd_spacing",
    "writing_speed": "agentd_writing_speed"
}

SETTINGS: dict[str, tuple[tuple[str, ...], str]] = {
    "text_size": (SIZES, "medium"),
    "spacing": (SPACINGS, "compact"),
    "writing_speed": (SPEEDS, "fast"),
    "autopilot": (("off", "on"), "on"),
    "persona": (PERSONAS, "archivist"),
    "thinking_style": (THINKING_STYLES, "navi"),
    "color": (COLORS, "auto"),
}


class PlacementInfo(TypedDict):
    """Serialized placement metadata stored on ``Record.placement``."""

    reserved_pu: list[float]
    reserved_norm: list[float]
    side: str
    scale: float
    width_mm: float
    anchor_norm: list[float]


class DockEntry(TypedDict, total=False):
    """One entry in ``dock_entries``."""

    id: str
    label: str
    badge: str
    hint: str
