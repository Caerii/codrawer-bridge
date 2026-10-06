# Message type constants (stringly-typed protocol; canonical list lives here)

T_HELLO = "hello"

# user/bridge -> server (and broadcast to clients)
T_STROKE_BEGIN = "stroke_begin"
T_STROKE_PTS = "stroke_pts"
T_STROKE_END = "stroke_end"
T_CURSOR = "cursor"
T_PROMPT = "prompt"
T_CLEAR = "clear"  # any client -> server -> broadcast: start a new drawing
T_KEY = "key"  # keyboard bridge -> server -> broadcast: one key-down (char + mods)

# terminal bridge (server/term_bridge.py)
T_TERM_PROMPT = "term_prompt"  # client -> server: instruction for the even-terminal session
T_TERM_ANSWER = "term_answer"  # client -> server: reply to a pending permission/question (else prompt)
T_TERM = "term"  # server -> clients: {kind: text|note|permission|question|status, text}

# document (ADR 001/005): a participant shares its edited text with the session
T_DOC = "doc"  # client -> server -> broadcast: {text, cursor:{line,col}, reason}

# personal marks (packages/marks, ADR 013): relayed like a key; the recogniser host is a client
MARK_TYPES = frozenset(
    {"mark_seen", "mark_ask", "mark_define", "mark_invoke", "mark_feedback", "mark_query", "marks"}
)

# server -> clients (AI layer)
T_AI_INTENT = "ai_intent"
T_AI_SAY = "ai_say"
T_AI_STROKE_BEGIN = "ai_stroke_begin"
T_AI_STROKE_PTS = "ai_stroke_pts"
T_AI_STROKE_END = "ai_stroke_end"


