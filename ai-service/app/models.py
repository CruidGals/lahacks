"""Pydantic data contracts for the verification service."""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field, HttpUrl


class GpsPing(BaseModel):
    """A single GPS ping captured during a task session."""

    lat: float = Field(..., ge=-90.0, le=90.0)
    lng: float = Field(..., ge=-180.0, le=180.0)
    accuracy: float | None = Field(default=None, ge=0.0)
    timestamp: float = Field(..., description="Unix epoch seconds (server-stamped).")


class VerifyRequest(BaseModel):
    """Payload accepted by `POST /verify` from the backend (Person 2)."""

    cleanup_id: str = Field(..., min_length=1)
    submission_video_url: HttpUrl
    reference_video_url: HttpUrl
    bounty_lat: float = Field(..., ge=-90.0, le=90.0)
    bounty_lng: float = Field(..., ge=-180.0, le=180.0)
    gps_trajectory: list[GpsPing] = Field(default_factory=list)
    issued_nonce: str = Field(..., min_length=1)
    session_duration_s: int = Field(..., ge=0)


class VerifyAccepted(BaseModel):
    """Synchronous response from `POST /verify`."""

    cleanup_id: str
    status: str = "accepted"


class SceneMatchResult(BaseModel):
    """Person 3A's scene-match output."""

    same_location: bool
    matching_features: list[str] = Field(default_factory=list)
    confidence: float = Field(..., ge=0.0, le=1.0)


class TaskCompleteItem(BaseModel):
    description: str
    still_present: bool


class TaskCompleteResult(BaseModel):
    """Person 3A's task-complete output."""

    task_complete: bool
    items: list[TaskCompleteItem] = Field(default_factory=list)
    confidence: float = Field(..., ge=0.0, le=1.0)


class VerificationResult(BaseModel):
    """Final payload posted back to the backend webhook."""

    verified: bool
    confidence: float = Field(..., ge=0.0, le=1.0)
    scene_match: bool
    task_complete: bool
    fraud_flags: list[str] = Field(default_factory=list)
    reasoning: str

    def to_callback_dict(self) -> dict[str, Any]:
        return self.model_dump(mode="json")
