from __future__ import annotations

from typing import Annotated, Literal, TypeAlias

from pydantic import BaseModel, Field

# Normalized points:
# - x,y in [0,1]
# - p (pressure) in [0,1]
# - t is ms timestamp (unix epoch ms OR monotonic mapped to ms; doc decides)
Point4: TypeAlias = list[float]  # [x, y, p, t]
Point3: TypeAlias = list[float]  # [x, y, p]


class Hello(BaseModel):
    t: Literal["hello"]
    session: str


class StrokeBegin(BaseModel):
    t: Literal["stroke_begin"]
    id: str
    layer: Literal["user", "ai"] = "user"
    brush: str = "pen"
    color: str | None = None
    ts: Annotated[int, Field(description="ms timestamp")]


class StrokePts(BaseModel):
    t: Literal["stroke_pts"]
    id: str
    pts: list[Point4]


class StrokeEnd(BaseModel):
    t: Literal["stroke_end"]
    id: str
    ts: int


class Cursor(BaseModel):
    t: Literal["cursor"]
    x: float
    y: float
    ts: int
    who: str | None = None


class Prompt(BaseModel):
    """
    Optional: Ask the AI to do something (draw or handwrite) on the AI layer.
    Clients may send this; the server does not broadcast it by default.
    """

    t: Literal["prompt"]
    text: str
    mode: Literal["draw", "handwriting"] = "draw"
    x: float | None = None
    y: float | None = None
    ts: int | None = None


class AIStrokeBegin(BaseModel):
    t: Literal["ai_stroke_begin"]
    id: str
    layer: Literal["ai"] = "ai"
    brush: str = "ghost"


class AIStrokePts(BaseModel):
    t: Literal["ai_stroke_pts"]
    id: str
    pts: list[Point3]


class AIStrokeEnd(BaseModel):
    t: Literal["ai_stroke_end"]
    id: str


class AIIntent(BaseModel):
    """
    Optional: model "plan" for what it is about to do, for UI/telemetry.
    """

    t: Literal["ai_intent"]
    plan: str
    mode: Literal["auto", "draw", "handwriting"] = "auto"
    prompt_text: str | None = None
    anchor_xy: list[float] | None = None


class AISay(BaseModel):
    """
    Optional: short text from the agent (personality / narration).
    """

    t: Literal["ai_say"]
    text: str


InboundMsg: TypeAlias = StrokeBegin | StrokePts | StrokeEnd | Cursor
OutboundMsg: TypeAlias = (
    Hello
    | StrokeBegin
    | StrokePts
    | StrokeEnd
    | Cursor
    | Prompt
    | AIIntent
    | AISay
    | AIStrokeBegin
    | AIStrokePts
    | AIStrokeEnd
)


