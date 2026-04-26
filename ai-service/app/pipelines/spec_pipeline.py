"""Stage 1 (posting time): candidate proposals + requester confirmation.

Pipeline behavior:
1. Requester uploads a reference video.
2. Grounding DINO runs per sampled frame with a broad trash prompt.
3. IoU tracker groups detections into unique object candidates.
4. API returns candidate list + numbered overlay preview frames.
5. Requester removes false positives and adds missed items.
6. Confirmation endpoint returns persisted GroundTruthSpec.
"""

from __future__ import annotations

import asyncio
import base64
import io
import logging
from collections import defaultdict
from dataclasses import dataclass
from typing import Iterable

from PIL import Image, ImageDraw, ImageFont
from pydantic import BaseModel, Field

import cv2

from app.config import Settings, get_settings
from app.object_detection import (
    TrackedObject,
    parse_grounding_dino_output,
    track_objects_with_metadata,
)
from app.pipelines.dino_adapter import _normalize_to_local_file, _sample_frames_sync

logger = logging.getLogger(__name__)


class SpecBbox(BaseModel):
    x: float = Field(ge=0.0)
    y: float = Field(ge=0.0)
    w: float = Field(gt=0.0)
    h: float = Field(gt=0.0)


class SpecCandidate(BaseModel):
    candidate_id: str = Field(min_length=1)
    label: str = Field(min_length=1)
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
    image_b64: str = Field(min_length=1)
    annotated_b64: str = Field(min_length=1)
    candidate_ids: list[str] = Field(default_factory=list)


class SpecCandidateSet(BaseModel):
    video_url: str = Field(min_length=1)
    duration_s: float = Field(ge=0.0)
    width: int = Field(gt=0)
    height: int = Field(gt=0)
    broad_prompt: str = Field(min_length=1)
    sample_every_n_frames: int = Field(ge=1)
    samples_taken: int = Field(ge=0)
    candidates: list[SpecCandidate] = Field(default_factory=list)
    preview_frames: list[SpecPreviewFrame] = Field(default_factory=list)


class ManualSpecItemDraft(BaseModel):
    label: str = Field(min_length=1)
    bbox: SpecBbox | None = None
    source_frame_index: int | None = Field(default=None, ge=0)
    note: str = ""


class SpecConfirmRequest(BaseModel):
    candidate_set: SpecCandidateSet
    removed_candidate_ids: list[str] = Field(default_factory=list)
    manual_items: list[ManualSpecItemDraft] = Field(default_factory=list)


class SpecItem(BaseModel):
    item_id: str = Field(min_length=1)
    label: str = Field(min_length=1)
    source: str = Field(pattern="^(dino|manual)$")
    confidence: float | None = Field(default=None, ge=0.0, le=1.0)
    bbox: SpecBbox | None = None
    source_frame_index: int | None = Field(default=None, ge=0)
    source_timestamp_s: float | None = Field(default=None, ge=0.0)
    note: str = ""


class GroundTruthSpec(BaseModel):
    broad_prompt: str = Field(min_length=1)
    items: list[SpecItem] = Field(default_factory=list)
    categories: list[str] = Field(default_factory=list)

    def stage2_dino_prompt(self) -> str:
        return " . ".join(self.categories)


@dataclass
class _SampledFrame:
    sample_index: int
    original_frame_index: int
    timestamp_s: float
    image_bgr: object


def _normalize_label(label: str) -> str:
    return " ".join(label.lower().strip().split())


def _dedupe_categories(labels: Iterable[str]) -> list[str]:
    out: list[str] = []
    seen: set[str] = set()
    for label in labels:
        normalized = _normalize_label(label)
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        out.append(normalized)
    return out


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


def _color_for_slot(slot: int) -> tuple[int, int, int]:
    palette = [
        (255, 99, 71),
        (60, 179, 113),
        (65, 105, 225),
        (255, 165, 0),
        (218, 112, 214),
        (32, 178, 170),
        (255, 215, 0),
        (199, 21, 133),
    ]
    return palette[slot % len(palette)]


def _load_font() -> ImageFont.ImageFont:
    try:
        return ImageFont.truetype("arial.ttf", 16)
    except OSError:
        return ImageFont.load_default()


def _bgr_to_jpeg_b64(image_bgr) -> str:
    from cv2 import IMWRITE_JPEG_QUALITY, imencode

    ok, encoded = imencode(".jpg", image_bgr, [int(IMWRITE_JPEG_QUALITY), 85])
    if not ok:
        raise RuntimeError("cv2.imencode failed")
    return base64.b64encode(encoded.tobytes()).decode("ascii")


def _draw_overlay_b64(
    image_bgr,
    boxes: list[tuple[int, str, str, SpecBbox]],
) -> str:
    image = Image.fromarray(image_bgr[:, :, ::-1]).copy()
    draw = ImageDraw.Draw(image)
    font = _load_font()

    for slot, (display_idx, candidate_id, label, bbox) in enumerate(boxes):
        x1 = max(0, int(bbox.x))
        y1 = max(0, int(bbox.y))
        x2 = min(image.width, int(bbox.x + bbox.w))
        y2 = min(image.height, int(bbox.y + bbox.h))
        if x2 <= x1 or y2 <= y1:
            continue
        color = _color_for_slot(slot)
        draw.rectangle([(x1, y1), (x2, y2)], outline=color, width=3)

        caption = f"#{display_idx} {label} [{candidate_id}]"
        text_y = max(0, y1 - 18)
        text_box = draw.textbbox((x1, text_y), caption, font=font)
        draw.rectangle(text_box, fill=color)
        draw.text((x1, text_y), caption, fill=(255, 255, 255), font=font)

    buffer = io.BytesIO()
    image.convert("RGB").save(buffer, format="JPEG", quality=85)
    return base64.b64encode(buffer.getvalue()).decode("ascii")


def _choose_preview_indices(
    tracks: list[TrackedObject],
    sample_count: int,
    *,
    max_preview_frames: int,
) -> list[int]:
    if sample_count <= 0:
        return []

    peak_idxs = {
        max(0, min(sample_count - 1, track.peak_frame_index))
        for track in tracks
    }

    if len(peak_idxs) >= max_preview_frames:
        return sorted(peak_idxs)[:max_preview_frames]

    chosen = set(peak_idxs)
    if max_preview_frames == 1:
        chosen.add(sample_count // 2)
    else:
        step = (sample_count - 1) / max(1, max_preview_frames - 1)
        for i in range(max_preview_frames):
            chosen.add(int(round(i * step)))
    return sorted(chosen)[:max_preview_frames]


async def _detect_one_frame(
    frame_bgr,
    *,
    settings: Settings,
) -> list[tuple[str, float, tuple[int, int, int, int]]]:
    """Run Grounding DINO on one frame with a tight timeout + minimal retries.

    This is Stage 1's own detector call — separate from the shared
    ``_detect_objects_grounding_dino`` which has a heavy 5-retry loop
    designed for Stage 2. Here we fail fast so the posting UX stays snappy.
    """

    from app.object_detection import _ensure_replicate_token_loaded

    _ensure_replicate_token_loaded()
    try:
        import replicate
    except Exception as exc:
        raise RuntimeError("replicate package required for grounding_dino") from exc

    ok, encoded = cv2.imencode(".jpg", frame_bgr)
    if not ok:
        return []

    from tempfile import NamedTemporaryFile
    from pathlib import Path

    with NamedTemporaryFile(suffix=".jpg", delete=False) as tmp:
        frame_path = Path(tmp.name)
        frame_path.write_bytes(encoded.tobytes())

    spec_retries = int(getattr(settings, "spec_dino_max_retries", 1))
    spec_timeout = float(getattr(settings, "spec_dino_timeout_seconds", 15.0))
    spec_prompt = getattr(
        settings,
        "spec_broad_prompt",
        "trash bag . bottle . tire . cardboard . mattress . debris . litter",
    )
    try:
        for attempt in range(spec_retries + 1):
            try:
                with frame_path.open("rb") as fh:
                    output = await asyncio.wait_for(
                        replicate.async_run(
                            settings.grounding_dino_model,
                            input={
                                "image": fh,
                                "query": spec_prompt,
                                "box_threshold": settings.grounding_dino_box_threshold,
                                "text_threshold": settings.grounding_dino_text_threshold,
                            },
                        ),
                        timeout=spec_timeout,
                    )
                return parse_grounding_dino_output(output)
            except asyncio.TimeoutError:
                logger.warning("stage1_dino_timeout attempt=%d", attempt)
                return []
            except Exception as exc:
                err_str = str(exc).lower()
                if "429" in err_str or "throttle" in err_str or "rate" in err_str:
                    if attempt < spec_retries:
                        await asyncio.sleep(2.0)
                        continue
                logger.warning("stage1_dino_error attempt=%d err=%s", attempt, exc)
                return []
    finally:
        frame_path.unlink(missing_ok=True)

    return []


async def _sample_and_detect(
    video: str | bytes,
    settings: Settings,
) -> tuple[
    list[_SampledFrame],
    list[list[tuple[str, float, tuple[int, int, int, int]]]],
    int,
    int,
    float,
    str,
]:
    path, cleanup = await _normalize_to_local_file(video)
    sample_every = int(getattr(settings, "spec_sample_every_n_frames", 120))
    max_samples = int(getattr(settings, "spec_max_samples", 100000))
    try:
        samples_raw, width, height, _fps, duration = await asyncio.to_thread(
            _sample_frames_sync,
            path,
            sample_every,
            max_samples,
        )
        sampled = [
            _SampledFrame(
                sample_index=i,
                original_frame_index=frame_idx,
                timestamp_s=ts,
                image_bgr=frame,
            )
            for i, (frame_idx, ts, frame) in enumerate(samples_raw)
        ]
        if not sampled:
            source = str(video) if not isinstance(video, bytes) else "<bytes>"
            return [], [], max(1, width), max(1, height), duration, source

        per_frame: list[list[tuple[str, float, tuple[int, int, int, int]]]] = []
        for sample in sampled:
            dets = await _detect_one_frame(sample.image_bgr, settings=settings)
            per_frame.append(dets)

        source = str(video) if not isinstance(video, bytes) else "<bytes>"
        return sampled, per_frame, max(1, width), max(1, height), duration, source
    finally:
        if cleanup:
            path.unlink(missing_ok=True)


async def extract_spec_candidates(
    video: str | bytes,
    *,
    settings: Settings | None = None,
) -> SpecCandidateSet:
    settings = settings or get_settings()
    spec_prompt = getattr(
        settings,
        "spec_broad_prompt",
        "trash bag . bottle . tire . cardboard . mattress . debris . litter",
    )
    sample_every = int(getattr(settings, "spec_sample_every_n_frames", 20))
    spec_iou = float(getattr(settings, "spec_iou_threshold", 0.25))
    min_hits = int(getattr(settings, "spec_min_track_hits", 1))
    preview_frames = int(getattr(settings, "spec_preview_frames", 4))
    sampled, per_frame_dets, width, height, duration, source = await _sample_and_detect(
        video,
        settings,
    )
    if not sampled:
        return SpecCandidateSet(
            video_url=source,
            duration_s=duration,
            width=width,
            height=height,
            broad_prompt=spec_prompt,
            sample_every_n_frames=sample_every,
            samples_taken=0,
            candidates=[],
            preview_frames=[],
        )

    tracks = track_objects_with_metadata(
        per_frame_dets,
        timestamps=[frame.timestamp_s for frame in sampled],
        iou_threshold=spec_iou,
        max_missed_frames=3,
        min_confidence=settings.grounding_dino_box_threshold,
        min_hits=min_hits,
    )

    preview_sample_idxs = _choose_preview_indices(
        tracks,
        len(sampled),
        max_preview_frames=preview_frames,
    )
    sample_to_preview_idx = {
        sample_idx: preview_idx for preview_idx, sample_idx in enumerate(preview_sample_idxs)
    }

    overlay_entries: dict[int, list[tuple[int, str, str, SpecBbox]]] = defaultdict(list)
    candidates: list[SpecCandidate] = []

    for display_idx, track in enumerate(tracks, start=1):
        bbox = _xyxy_to_bbox(track.peak_bbox, width, height)
        if bbox is None:
            continue
        peak_sample_idx = max(0, min(len(sampled) - 1, track.peak_frame_index))
        preview_idx = sample_to_preview_idx.get(peak_sample_idx)
        if preview_idx is None:
            preview_idx = min(
                range(len(preview_sample_idxs)),
                key=lambda i: abs(preview_sample_idxs[i] - peak_sample_idx),
            )

        candidate_id = f"cand_{display_idx}"
        candidates.append(
            SpecCandidate(
                candidate_id=candidate_id,
                label=track.label,
                confidence=round(track.peak_confidence, 4),
                bbox=bbox,
                source_frame_index=preview_idx,
                source_timestamp_s=round(track.peak_timestamp_s, 3),
                hit_count=track.hit_count,
            )
        )
        overlay_entries[preview_idx].append((display_idx, candidate_id, track.label, bbox))

    previews: list[SpecPreviewFrame] = []
    for preview_idx, sample_idx in enumerate(preview_sample_idxs):
        frame = sampled[sample_idx]
        raw_b64 = _bgr_to_jpeg_b64(frame.image_bgr)
        annotated_b64 = _draw_overlay_b64(
            frame.image_bgr,
            overlay_entries.get(preview_idx, []),
        )
        previews.append(
            SpecPreviewFrame(
                frame_index=preview_idx,
                sample_index=frame.sample_index,
                timestamp_s=round(frame.timestamp_s, 3),
                width=width,
                height=height,
                image_b64=raw_b64,
                annotated_b64=annotated_b64,
                candidate_ids=[cand_id for _, cand_id, _, _ in overlay_entries.get(preview_idx, [])],
            )
        )

    return SpecCandidateSet(
        video_url=source,
        duration_s=duration,
        width=width,
        height=height,
        broad_prompt=spec_prompt,
        sample_every_n_frames=sample_every,
        samples_taken=len(sampled),
        candidates=candidates,
        preview_frames=previews,
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
                confidence=None,
                bbox=manual.bbox,
                source_frame_index=manual.source_frame_index,
                source_timestamp_s=None,
                note=manual.note,
            )
        )
        next_idx += 1

    return GroundTruthSpec(
        broad_prompt=request.candidate_set.broad_prompt,
        items=items,
        categories=_dedupe_categories(item.label for item in items),
    )
