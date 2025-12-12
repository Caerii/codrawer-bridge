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

    # Debugging
    debug_log_msgs: bool = False

    # Reserved for future model integration
    glm_api_key: str | None = None
    glm_base_url: str | None = None


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()


