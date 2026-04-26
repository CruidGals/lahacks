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
        default="opencv",
        description="Detector backend: `opencv` or `grounding_dino`.",
    )
    cleanup_target_query: str = Field(
        default="bag, bottle, can, trash, litter, garbage",
        description="Comma-separated categories used by Grounding DINO.",
    )
    spec_broad_prompt: str = Field(
        default="trash bag . bottle . tire . cardboard . mattress . debris . litter",
        description=(
            "Stage 1 broad DINO prompt used when building the candidate list "
            "from a requester's reference video. Dot-separated terms, the "
            "format Grounding DINO expects."
        ),
    )
    spec_sample_every_n_frames: int = Field(
        default=20,
        ge=1,
        le=600,
        description="Stage 1: run DINO on every Nth frame of the reference video.",
    )
    spec_max_samples: int = Field(
        default=20,
        ge=1,
        le=120,
        description="Stage 1: hard cap on how many frames feed into DINO + tracker.",
    )
    spec_preview_frames: int = Field(
        default=4,
        ge=1,
        le=12,
        description=(
            "Stage 1: how many representative frames to return for the UI to "
            "draw the numbered candidate overlays on."
        ),
    )
    spec_iou_threshold: float = Field(
        default=0.25,
        ge=0.0,
        le=1.0,
        description="IoU threshold used by the Stage 1 tracker.",
    )
    spec_min_track_hits: int = Field(
        default=1,
        ge=1,
        le=20,
        description=(
            "Minimum number of frames a track must persist for it to count as "
            "a candidate. Set >1 to suppress single-frame false positives."
        ),
    )
    grounding_dino_model: str = Field(
        default="adirik/grounding-dino:efd10a8ddc57ea28773327e881ce95e20cc1d734c589f7dd01d2036921ed78aa",
        description="Replicate model slug/version for Grounding DINO.",
    )
    grounding_dino_box_threshold: float = Field(default=0.40, ge=0.0, le=1.0)
    grounding_dino_text_threshold: float = Field(default=0.30, ge=0.0, le=1.0)

    log_level: str = Field(default="INFO")

    openai_api_key: str | None = Field(
        default=None,
        description="API key for the OpenAI vision pipelines (Person A, B, disposal).",
    )
    openai_model: str = Field(
        default="gpt-5.4-mini",
        description="OpenAI model name for all three new pipelines.",
    )
    openai_max_tokens: int = Field(
        default=2000,
        ge=128,
        le=16000,
        description="Max tokens cap for each pipeline LLM call.",
    )
    pipeline_frames_per_video: int = Field(
        default=5,
        ge=1,
        le=30,
        description="How many evenly-spaced frames to extract per video.",
    )
    pipeline_use_stub: bool = Field(
        default=False,
        description=(
            "When true, the LLM client returns deterministic dummy JSON for "
            "every pipeline so tests + offline development never burn credits."
        ),
    )


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Return a process-wide cached Settings instance."""

    return Settings()
