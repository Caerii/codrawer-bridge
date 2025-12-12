from __future__ import annotations

from typing import Annotated, Literal, Optional, TypeAlias, Union

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
    color: Optional[str] = None
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
    who: Optional[str] = None


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


InboundMsg: TypeAlias = Union[StrokeBegin, StrokePts, StrokeEnd, Cursor]
OutboundMsg: TypeAlias = Union[
    Hello,
    StrokeBegin,
    StrokePts,
    StrokeEnd,
    Cursor,
    AIStrokeBegin,
    AIStrokePts,
    AIStrokeEnd,
]


