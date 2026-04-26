"""Pydantic shape we accept as the DINO/object-detector output.

The DINO model itself is built outside this service; the pipelines only need
the structured detections it produces. Keeping the contract here means the
pipelines never reach into the detector implementation, and the moment the
real DINO emits a slightly different shape we adapt it in *one* place
(an adapter module that targets these classes) instead of touching every
pipeline.
"""

from __future__ import annotations

from collections import Counter

from pydantic import BaseModel, Field, field_validator


class Bbox(BaseModel):
    """Pixel-space bounding box (top-left origin)."""

    x: float = Field(ge=0.0, description="Top-left x in pixels.")
    y: float = Field(ge=0.0, description="Top-left y in pixels.")
    w: float = Field(gt=0.0, description="Box width in pixels.")
    h: float = Field(gt=0.0, description="Box height in pixels.")


class Detection(BaseModel):
    """One labelled object inside a single frame."""

    label: str = Field(min_length=1, description="Trash/object label, e.g. plastic_bottle.")
    confidence: float = Field(ge=0.0, le=1.0)
    bbox: Bbox


class FrameDetections(BaseModel):
    """Detections inside a specific sampled frame of the video."""

    timestamp_s: float = Field(ge=0.0, description="Seconds from video start.")
    frame_index: int = Field(ge=0, description="Index in the originally extracted frame list.")
    detections: list[Detection] = Field(default_factory=list)


class DinoOutput(BaseModel):
    """The complete DINO-style payload produced for one video.

    ``summary`` is a label -> count mapping aggregated across all frames; it is
    what the LLM prompts cite when describing "the site has 4 plastic bottles
    and 1 cardboard box". It is recomputed if missing.
    """

    video_url: str = Field(min_length=1)
    duration_s: float = Field(ge=0.0)
    width: int = Field(gt=0)
    height: int = Field(gt=0)
    frames: list[FrameDetections] = Field(default_factory=list)
    summary: dict[str, int] = Field(default_factory=dict)

    @field_validator("summary", mode="before")
    @classmethod
    def _coerce_summary(cls, value):
        # Pydantic JSON fields can come in as ``Counter`` objects -- make sure
        # we always store a plain dict to keep equality + serialization sane.
        if value is None:
            return {}
        if isinstance(value, Counter):
            return dict(value)
        return value

    def with_recomputed_summary(self) -> "DinoOutput":
        """Return a copy whose summary reflects the current ``frames`` list.

        Useful when adapting external detectors that don't ship a summary, or
        when tests build ``frames`` directly and want a sanity-checked summary.
        """

        counter: Counter[str] = Counter()
        for frame in self.frames:
            for detection in frame.detections:
                counter[detection.label] += 1
        data = self.model_dump()
        data["summary"] = dict(counter)
        return DinoOutput.model_validate(data)

    def total_detections(self) -> int:
        return sum(len(frame.detections) for frame in self.frames)
