# Message type constants (stringly-typed protocol; canonical list lives here)

T_HELLO = "hello"

# user/bridge -> server (and broadcast to clients)
T_STROKE_BEGIN = "stroke_begin"
T_STROKE_PTS = "stroke_pts"
T_STROKE_END = "stroke_end"
T_CURSOR = "cursor"

# server -> clients (AI layer)
T_AI_STROKE_BEGIN = "ai_stroke_begin"
T_AI_STROKE_PTS = "ai_stroke_pts"
T_AI_STROKE_END = "ai_stroke_end"


