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
        default="http://localhost:3000",
        description="Base URL of the Node/Express backend (Person 2).",
    )
    backend_internal_token: str | None = Field(
        default=None,
        description="Optional bearer token sent to the backend on callbacks.",
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

    vision_detector_backend: str = Field(
        default="grounding_dino",
        description="Detector backend. This service uses `grounding_dino`.",
    )
    cleanup_target_query: str = Field(
        default="bag, bottle, can, trash, litter, garbage",
        description="Comma-separated categories used by Grounding DINO.",
    )
    grounding_dino_model: str = Field(
        default="adirik/grounding-dino:efd10a8ddc57ea28773327e881ce95e20cc1d734c589f7dd01d2036921ed78aa",
        description="Replicate model slug/version for Grounding DINO.",
    )
    grounding_dino_box_threshold: float = Field(default=0.40, ge=0.0, le=1.0)
    grounding_dino_text_threshold: float = Field(default=0.30, ge=0.0, le=1.0)

    log_level: str = Field(default="INFO")


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Return a process-wide cached Settings instance."""

    return Settings()
