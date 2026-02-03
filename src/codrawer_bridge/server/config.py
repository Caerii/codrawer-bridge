from __future__ import annotations

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """
    Runtime config (desktop).

    - Loaded from environment variables
    - Also reads `.env` if present (via pydantic-settings + python-dotenv)
    """

    model_config = SettingsConfigDict(env_file=".env", env_prefix="CODRAWER_", extra="ignore")

    # AI throttling knobs (50 RPM constraint)
    ai_min_model_interval_s: float = 1.3
    ai_debounce_s: float = 0.25

    # Optional: external model server (Node / Vercel AI SDK gateway).
    # If set, the AI worker will call `{model_server_url}/v1/chat/completions`.
    model_server_url: str | None = None
    model_server_model: str = "blazing_fast"
    model_server_timeout_s: float = 20.0
    model_server_temperature: float = 0.4

    # Optional: include a small rendered PNG patch of the local drawing near the stroke end.
    # This is only useful if your model supports vision / multimodal inputs.
    model_server_use_context_image: bool = False
    model_server_context_image_px: int = 256
    model_server_context_image_window: float = 0.22  # normalized width/height of the patch region

    # Optional: "auto" AI behavior (AI responds without explicit prompt).
    # If enabled, the AI worker waits for the user to pause before responding.
    ai_auto_enabled: bool = False
    ai_auto_delay_s: float = 0.9

    # Co-creative agent persona knobs (used only when calling model-server).
    agent_persona: str = "Codrawer"
    agent_personality: str = (
        "Playful, curious, collaborative. Adds tasteful details, small surprises, and helpful "
        "structure. Never hijacks the drawing; waits for openings and complements the user's "
        "intent."
    )
    agent_creativity: float = 0.7  # 0..1
    agent_chattiness: float = 0.25  # 0..1 (how often to emit ai_say text)

    # Optional: agent initiative (the agent starts drawing sometimes when you're idle).
    agentic_enabled: bool = False
    agentic_idle_s: float = 1.4
    agentic_min_interval_s: float = 10.0
    agentic_probability: float = 0.35
    agentic_prompt: str = (
        "Co-create: add a small complementary doodle or augmentation that weaves with the current "
        "sketch. Be subtle, playful, and leave space. Prefer 1-3 strokes."
    )

    # Debugging
    debug_log_msgs: bool = False

    # Reserved for future model integration
    glm_api_key: str | None = None
    glm_base_url: str | None = None


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()


