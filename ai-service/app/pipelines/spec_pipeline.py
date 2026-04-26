"""Stage 1 posting-time spec extraction pipeline."""

from __future__ import annotations

import asyncio
from collections import OrderedDict

from pydantic import BaseModel, Field

from app.config import Settings, get_settings
from app.object_detection import track_objects_with_metadata
from app.pipelines.dino_adapter import _normalize_to_local_file, _sample_frames_sync
from app.pipelines.frame_extractor import ExtractedFrame, make_placeholder_frames


class SpecBbox(BaseModel):
    x: float = Field(ge=0.0)
    y: float = Field(ge=0.0)
    w: float = Field(gt=0.0)
    h: float = Field(gt=0.0)


class SpecCandidate(BaseModel):
    candidate_id: str
    label: str
    confidence: float = Field(ge=0.0, le=1.0)
    bbox: SpecBbox
    source_frame_index: int = Field(ge=0)
    source_timestamp_s: float = Field(ge=0.0)
    hit_count: int = Field(ge=1)


class SpecPreviewFrame(BaseModel):
    frame_index: int = Field(ge=0)
    sample_index: int = Field(ge=0)
    timestamp_s: float = Field(ge=0.0)
    width: int = Field(gt=0)
    height: int = Field(gt=0)
    image_b64: str
    annotated_b64: str
    candidate_ids: list[str] = Field(default_factory=list)


class SpecCandidateSet(BaseModel):
    video_url: str
    duration_s: float = Field(ge=0.0)
    width: int = Field(gt=0)
    height: int = Field(gt=0)
    broad_prompt: str
    sample_every_n_frames: int = Field(ge=1)
    samples_taken: int = Field(ge=0)
    candidates: list[SpecCandidate] = Field(default_factory=list)
    preview_frames: list[SpecPreviewFrame] = Field(default_factory=list)


class ManualSpecItemDraft(BaseModel):
    label: str
    bbox: SpecBbox | None = None
    source_frame_index: int | None = Field(default=None, ge=0)
    note: str = ""


class SpecConfirmRequest(BaseModel):
    candidate_set: SpecCandidateSet
    removed_candidate_ids: list[str] = Field(default_factory=list)
    manual_items: list[ManualSpecItemDraft] = Field(default_factory=list)


class SpecItem(BaseModel):
    item_id: str
    label: str
    source: str
    confidence: float | None = Field(default=None, ge=0.0, le=1.0)
    bbox: SpecBbox | None = None
    source_frame_index: int | None = Field(default=None, ge=0)
    source_timestamp_s: float | None = Field(default=None, ge=0.0)
    note: str = ""


class GroundTruthSpec(BaseModel):
    broad_prompt: str
    items: list[SpecItem] = Field(default_factory=list)
    categories: list[str] = Field(default_factory=list)

    def stage2_dino_prompt(self) -> str:
        return " . ".join(self.categories)


def _normalize_label(label: str) -> str:
    return " ".join(label.lower().split())


def _xyxy_to_bbox(
    box: tuple[int, int, int, int], width: int, height: int
) -> SpecBbox | None:
    x1, y1, x2, y2 = box
    x1 = max(0, min(width, int(x1)))
    y1 = max(0, min(height, int(y1)))
    x2 = max(0, min(width, int(x2)))
    y2 = max(0, min(height, int(y2)))
    w = x2 - x1
    h = y2 - y1
    if w <= 0 or h <= 0:
        return None
    return SpecBbox(x=float(x1), y=float(y1), w=float(w), h=float(h))


def _dedupe_categories(labels: list[str]) -> list[str]:
    seen: OrderedDict[str, bool] = OrderedDict()
    for label in labels:
        norm = _normalize_label(label)
        if norm:
            seen.setdefault(norm, True)
    return list(seen.keys())


async def extract_spec_candidates(
    video: str | bytes,
    *,
    settings: Settings | None = None,
) -> SpecCandidateSet:
    settings = settings or get_settings()
    path, cleanup = await _normalize_to_local_file(video)
    try:
        samples, width, height, _fps, duration = await asyncio.to_thread(
            _sample_frames_sync,
            path,
            settings.spec_sample_every_n_frames,
            settings.spec_max_samples,
        )
    finally:
        if cleanup:
            path.unlink(missing_ok=True)

    if not samples:
        return SpecCandidateSet(
            video_url=str(video) if not isinstance(video, bytes) else "<bytes>",
            duration_s=0.0,
            width=1,
            height=1,
            broad_prompt=settings.spec_broad_prompt,
            sample_every_n_frames=settings.spec_sample_every_n_frames,
            samples_taken=0,
        )

    empty_detections: list[list[tuple[str, float, tuple[int, int, int, int]]]] = [
        [] for _ in samples
    ]
    timestamps = [float(ts) for _, ts, _ in samples]
    tracks = track_objects_with_metadata(
        empty_detections,
        timestamps=timestamps,
        iou_threshold=settings.spec_iou_threshold,
        min_hits=settings.spec_min_track_hits,
    )

    candidates: list[SpecCandidate] = []
    for idx, track in enumerate(tracks, start=1):
        bbox = _xyxy_to_bbox(track.peak_bbox, width, height)
        if bbox is None:
            continue
        candidates.append(
            SpecCandidate(
                candidate_id=f"cand_{idx}",
                label=track.label,
                confidence=track.peak_confidence,
                bbox=bbox,
                source_frame_index=0,
                source_timestamp_s=track.peak_timestamp_s,
                hit_count=track.hit_count,
            )
        )

    placeholders: list[ExtractedFrame] = make_placeholder_frames(
        settings.spec_preview_frames, width=max(width, 1), height=max(height, 1), label="spec"
    )
    preview_frames = [
        SpecPreviewFrame(
            frame_index=i,
            sample_index=i,
            timestamp_s=float(i),
            width=frame.width,
            height=frame.height,
            image_b64=frame.jpeg_b64,
            annotated_b64=frame.jpeg_b64,
            candidate_ids=[],
        )
        for i, frame in enumerate(placeholders)
    ]

    return SpecCandidateSet(
        video_url=str(video) if not isinstance(video, bytes) else "<bytes>",
        duration_s=float(duration),
        width=max(width, 1),
        height=max(height, 1),
        broad_prompt=settings.spec_broad_prompt,
        sample_every_n_frames=settings.spec_sample_every_n_frames,
        samples_taken=len(samples),
        candidates=candidates,
        preview_frames=preview_frames,
    )


def build_ground_truth_spec(request: SpecConfirmRequest) -> GroundTruthSpec:
    removed = set(request.removed_candidate_ids)

    items: list[SpecItem] = []
    next_idx = 1

    for candidate in request.candidate_set.candidates:
        if candidate.candidate_id in removed:
            continue
        items.append(
            SpecItem(
                item_id=f"item_{next_idx}",
                label=_normalize_label(candidate.label) or candidate.label,
                source="dino",
                confidence=candidate.confidence,
                bbox=candidate.bbox,
                source_frame_index=candidate.source_frame_index,
                source_timestamp_s=candidate.source_timestamp_s,
            )
        )
        next_idx += 1

    for manual in request.manual_items:
        items.append(
            SpecItem(
                item_id=f"item_{next_idx}",
                label=_normalize_label(manual.label) or manual.label,
                source="manual",
                bbox=manual.bbox,
                source_frame_index=manual.source_frame_index,
                note=manual.note,
            )
        )
        next_idx += 1

    categories = _dedupe_categories([item.label for item in items])
    return GroundTruthSpec(
        broad_prompt=request.candidate_set.broad_prompt,
        items=items,
        categories=categories,
    )
