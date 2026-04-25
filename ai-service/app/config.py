"""Runtime configuration loaded from environment variables."""

from __future__ import annotations

from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Service configuration. Override any field via environment variable."""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    backend_base_url: str = Field(
        default="http://localhost:8080",
        description="Base URL of the Node/Express backend (Person 2).",
    )
    backend_internal_token: str | None = Field(
        default=None,
        description="Optional bearer token sent to the backend on callbacks.",
    )

    ai_service_port: int = Field(
        default=8001,
        ge=1,
        le=65535,
        description="Port this FastAPI service binds to (used by deploy scripts).",
    )
    claude_api_key: str | None = Field(
        default=None,
        description="API key forwarded to Person 3A's vision module when implemented.",
    )

    verification_confidence_threshold: float = Field(
        default=0.85,
        ge=0.0,
        le=1.0,
        description="Combined confidence required for `verified=true`.",
    )
    bounty_radius_meters: float = Field(
        default=75.0,
        gt=0.0,
        description="Max distance from bounty pin considered on-site.",
    )
    min_session_duration_seconds: int = Field(
        default=120,
        ge=0,
        description="Minimum plausible session duration before flagging.",
    )

    callback_max_retries: int = Field(default=3, ge=1, le=10)
    callback_initial_backoff_seconds: float = Field(default=1.0, ge=0.0)

    log_level: str = Field(default="INFO")


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Return a process-wide cached Settings instance."""

    return Settings()
