// AUTO-GENERATED from src/codrawer_bridge/protocol/spec.json via scripts/gen_types.py.
// Do not edit by hand.

export const PERSONA_IDS = ["archivist", "sketcher", "elder", "mathematician", "calligrapher"] as const
export type PersonaId = (typeof PERSONA_IDS)[number]

export const THINKING_STYLES = ["navi", "pen", "glyph", "orbit", "spark"] as const
export type ThinkingStyle = (typeof THINKING_STYLES)[number]

export const INK_COLOR_NAMES = ["auto", "blue", "red", "green", "purple", "gold", "black"] as const
export type InkColorName = (typeof INK_COLOR_NAMES)[number]

export const TEXT_SIZES = ["micro", "tiny", "small", "medium", "large"] as const
export type TextSize = (typeof TEXT_SIZES)[number]

export const SPACINGS = ["compact", "normal", "airy"] as const
export type Spacing = (typeof SPACINGS)[number]

export const WRITING_SPEEDS = ["calm", "fast", "very_fast"] as const
export type WritingSpeed = (typeof WRITING_SPEEDS)[number]

export const MARK_KINDS = ["circle", "underline", "arrow", "bracket", "star"] as const
export type MarkKind = (typeof MARK_KINDS)[number]

export const SKETCH_KINDS = ["box", "rect", "circle", "ellipse", "line", "arrow", "arc", "dot", "star", "curve", "poly"] as const
export type SketchKind = (typeof SKETCH_KINDS)[number]

export const DOCK_ENTRY_IDS = {
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
} as const
export type DockEntryId = (typeof DOCK_ENTRY_IDS)[keyof typeof DOCK_ENTRY_IDS]
