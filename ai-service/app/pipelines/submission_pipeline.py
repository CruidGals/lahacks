"""Stage 2 (submission time): object grouping + LLM validation + spec matching.

Pipeline behavior:
1. Person B submits a cleanup video.
2. Grounding DINO runs per sampled frame with a prompt derived from the
   confirmed GroundTruthSpec categories.
3. IoU tracker groups per-frame detections into unique physical objects,
   retaining *every* frame appearance (not just the peak).
4. For each tracked object, up to 3 representative crops are extracted
   (bbox + 20 % padding, minimum 200×200, upscaled if needed).
5. The LLM receives the crops and decides whether each object is a real
   instance of its labelled category.
6. Validated objects are matched back against spec items to produce the
   final submission verdict.
"""

from __future__ import annotations

import asyncio
import base64
import io
import logging
from dataclasses import dataclass, field

import cv2
import numpy as np
from PIL import Image
from pydantic import BaseModel, Field

from app.config import Settings, get_settings
from app.object_detection import parse_grounding_dino_output, _iou
from app.pipelines.dino_adapter import _normalize_to_local_file, _sample_frames_sync
from app.pipelines.llm_client import (
    LLMRequest,
    OpenAIPipelineClient,
    VisionImage,
    render_json_block,
)
from app.pipelines.spec_pipeline import GroundTruthSpec, _normalize_label

logger = logging.getLogger(__name__)

MIN_CROP_SIZE = 200
CROP_PADDING_RATIO = 0.20
MAX_CROPS_PER_OBJECT = 3


# ---------------------------------------------------------------------------
# Data models
# ---------------------------------------------------------------------------

class ObjectCrop(BaseModel):
    """One cropped view of a tracked object."""

    frame_index: int = Field(ge=0)
    timestamp_s: float = Field(ge=0.0)
    confidence: float = Field(ge=0.0, le=1.0)
    bbox_xyxy: list[int] = Field(min_length=4, max_length=4)
    jpeg_b64: str = Field(min_length=1)


class LLMObjectVerdict(BaseModel):
    """LLM's per-object validation response."""

    is_real: bool
    reasoning: str = ""


class SubmissionObject(BaseModel):
    """A single tracked + validated object from the submission video."""

    object_id: str = Field(min_length=1)
    label: str = Field(min_length=1)
    frames_detected: int = Field(ge=1)
    confidences: list[float] = Field(default_factory=list)
    peak_confidence: float = Field(ge=0.0, le=1.0)
    peak_bbox_xyxy: list[int] = Field(min_length=4, max_length=4)
    crops: list[ObjectCrop] = Field(default_factory=list)
    llm_verdict: LLMObjectVerdict | None = None


class SpecMatchResult(BaseModel):
    """How one spec item was resolved against the *after* (submission) video.

    For cleanup, Stage 1 spec items are trash / debris that should be **gone** in
    the submission. So ``matched=True`` means we still see a *validated real*
    instance of that label — i.e. cleanup incomplete. ``matched=False`` means we
    did not confirm that category as still present (scene clear for that item).
    """

    item_id: str = Field(min_length=1)
    label: str = Field(min_length=1)
    matched: bool = False
    matched_object_id: str | None = None
    matched_confidence: float | None = None


class Stage2FinalVerdict(BaseModel):
    """Final submission decision for Stage 2 (cleanup: trash should *not* remain)."""

    approved: bool
    score: float = Field(ge=0.0, le=1.0)
    reason: str = ""
    # NOTE: name kept for API stability — values are spec labels *still* detected
    # as real in the after video, not "missing" from the spec list.
    missing_labels: list[str] = Field(default_factory=list)
    matched_count: int = Field(ge=0)  # count of spec items still found (see SpecMatchResult)
    required_count: int = Field(ge=0)


class Stage2Result(BaseModel):
    """Complete Stage 2 output."""

    spec_prompt: str = Field(min_length=1)
    submission_video: str = ""
    samples_taken: int = Field(ge=0)
    objects_tracked: int = Field(ge=0)
    objects_validated: int = Field(ge=0)
    objects: list[SubmissionObject] = Field(default_factory=list)
    match_results: list[SpecMatchResult] = Field(default_factory=list)
    # Count of spec items still found as real in the after video (same as
    # ``final_verdict.matched_count``).
    items_matched: int = Field(ge=0, default=0)
    items_total: int = Field(ge=0, default=0)
    final_verdict: Stage2FinalVerdict


# ---------------------------------------------------------------------------
# Internal: extended tracker that stores every frame appearance
# ---------------------------------------------------------------------------

@dataclass
class _FrameAppearance:
    frame_index: int
    timestamp_s: float
    confidence: float
    bbox_xyxy: tuple[int, int, int, int]


@dataclass
class _Stage2Track:
    track_id: int
    label: str
    appearances: list[_FrameAppearance] = field(default_factory=list)
    bbox: tuple[int, int, int, int] = (0, 0, 0, 0)
    missed: int = 0

    @property
    def peak(self) -> _FrameAppearance:
        return max(self.appearances, key=lambda a: a.confidence)

    @property
    def hit_count(self) -> int:
        return len(self.appearances)


def _track_objects_stage2(
    frames_detections: list[list[tuple[str, float, tuple[int, int, int, int]]]],
    *,
    timestamps: list[float],
    iou_threshold: float = 0.5,
    max_missed_frames: int = 3,
    min_confidence: float = 0.0,
    min_hits: int = 1,
) -> list[_Stage2Track]:
    """IoU tracker that preserves every frame appearance per track."""

    active: dict[str, dict[int, _Stage2Track]] = {}
    finalized: dict[int, _Stage2Track] = {}
    next_id = 1

    for frame_idx, frame_dets in enumerate(frames_detections):
        ts = timestamps[frame_idx] if frame_idx < len(timestamps) else float(frame_idx)

        for tracks in active.values():
            for track in tracks.values():
                track.missed += 1

        for label, conf, box in frame_dets:
            if conf < min_confidence:
                continue

            label_tracks = active.setdefault(label, {})
            best_id: int | None = None
            best_iou = 0.0
            for tid, track in label_tracks.items():
                score = _iou(box, track.bbox)
                if score > best_iou:
                    best_iou = score
                    best_id = tid

            appearance = _FrameAppearance(
                frame_index=frame_idx,
                timestamp_s=ts,
                confidence=conf,
                bbox_xyxy=box,
            )

            if best_id is not None and best_iou >= iou_threshold:
                track = label_tracks[best_id]
                track.bbox = box
                track.missed = 0
                track.appearances.append(appearance)
            else:
                tid = next_id
                next_id += 1
                label_tracks[tid] = _Stage2Track(
                    track_id=tid,
                    label=label,
                    appearances=[appearance],
                    bbox=box,
                    missed=0,
                )

        for label, tracks in list(active.items()):
            stale = [tid for tid, t in tracks.items() if t.missed > max_missed_frames]
            for tid in stale:
                finalized[tid] = tracks.pop(tid)
            if not tracks:
                del active[label]

    for tracks in active.values():
        for tid, track in tracks.items():
            finalized[tid] = track

    return [t for t in sorted(finalized.values(), key=lambda t: t.track_id) if t.hit_count >= min_hits]


# ---------------------------------------------------------------------------
# Internal: per-frame DINO detection (mirrors Stage 1's _detect_one_frame)
# ---------------------------------------------------------------------------

async def _detect_one_frame_stage2(
    frame_bgr: np.ndarray,
    *,
    query: str,
    settings: Settings,
) -> list[tuple[str, float, tuple[int, int, int, int]]]:
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

    max_retries = int(getattr(settings, "stage2_dino_max_retries", 3))
    timeout_s = float(getattr(settings, "stage2_dino_timeout_seconds", 30.0))
    try:
        for attempt in range(max_retries + 1):
            try:
                with frame_path.open("rb") as fh:
                    output = await asyncio.wait_for(
                        replicate.async_run(
                            settings.grounding_dino_model,
                            input={
                                "image": fh,
                                "query": query,
                                "box_threshold": settings.grounding_dino_box_threshold,
                                "text_threshold": settings.grounding_dino_text_threshold,
                            },
                        ),
                        timeout=timeout_s,
                    )
                return parse_grounding_dino_output(output)
            except asyncio.TimeoutError:
                logger.warning("stage2_dino_timeout attempt=%d", attempt)
                if attempt == max_retries:
                    return []
            except Exception as exc:
                err_str = str(exc).lower()
                if "429" in err_str or "throttle" in err_str or "rate" in err_str:
                    if attempt < max_retries:
                        await asyncio.sleep(2.0 * (2 ** attempt))
                        continue
                logger.warning("stage2_dino_error attempt=%d err=%s", attempt, exc)
                if attempt == max_retries:
                    return []
    finally:
        frame_path.unlink(missing_ok=True)

    return []


# ---------------------------------------------------------------------------
# Internal: sample + detect all frames from submission video
# ---------------------------------------------------------------------------

@dataclass
class _SampledFrame:
    sample_index: int
    original_frame_index: int
    timestamp_s: float
    image_bgr: np.ndarray


async def _sample_and_detect_submission(
    video: str | bytes,
    *,
    query: str,
    settings: Settings,
) -> tuple[list[_SampledFrame], list[list[tuple[str, float, tuple[int, int, int, int]]]], int, int]:
    """Sample frames from submission video and run DINO with the spec prompt."""

    path, cleanup = await _normalize_to_local_file(video)
    sample_every = int(getattr(settings, "stage2_sample_every_n_frames", 120))
    max_samples = int(getattr(settings, "stage2_max_samples", 100000))
    try:
        samples_raw, width, height, _fps, _duration = await asyncio.to_thread(
            _sample_frames_sync, path, sample_every, max_samples,
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
            return [], [], max(1, width), max(1, height)

        per_frame: list[list[tuple[str, float, tuple[int, int, int, int]]]] = []
        for sample in sampled:
            dets = await _detect_one_frame_stage2(
                sample.image_bgr, query=query, settings=settings,
            )
            per_frame.append(dets)

        return sampled, per_frame, max(1, width), max(1, height)
    finally:
        if cleanup:
            path.unlink(missing_ok=True)


# ---------------------------------------------------------------------------
# Internal: crop extraction
# ---------------------------------------------------------------------------

def _crop_with_padding(
    image_bgr: np.ndarray,
    bbox_xyxy: tuple[int, int, int, int],
    *,
    padding_ratio: float = CROP_PADDING_RATIO,
    min_size: int = MIN_CROP_SIZE,
) -> str:
    """Crop image to bbox with padding, enforce minimum size, return JPEG b64."""

    img_h, img_w = image_bgr.shape[:2]
    x1, y1, x2, y2 = bbox_xyxy
    box_w = x2 - x1
    box_h = y2 - y1

    pad_x = int(box_w * padding_ratio)
    pad_y = int(box_h * padding_ratio)

    cx1 = max(0, x1 - pad_x)
    cy1 = max(0, y1 - pad_y)
    cx2 = min(img_w, x2 + pad_x)
    cy2 = min(img_h, y2 + pad_y)

    crop_bgr = image_bgr[cy1:cy2, cx1:cx2]
    if crop_bgr.size == 0:
        crop_bgr = image_bgr

    pil_img = Image.fromarray(crop_bgr[:, :, ::-1])

    if pil_img.width < min_size or pil_img.height < min_size:
        scale = max(min_size / max(1, pil_img.width), min_size / max(1, pil_img.height))
        new_w = max(min_size, int(pil_img.width * scale))
        new_h = max(min_size, int(pil_img.height * scale))
        pil_img = pil_img.resize((new_w, new_h), Image.LANCZOS)

    buf = io.BytesIO()
    pil_img.convert("RGB").save(buf, format="JPEG", quality=85)
    return base64.b64encode(buf.getvalue()).decode("ascii")


def _pick_representative_frames(
    appearances: list[_FrameAppearance],
    max_crops: int = MAX_CROPS_PER_OBJECT,
) -> list[_FrameAppearance]:
    """Pick the best frames for crop evidence.

    Strategy: sort by confidence descending, then space out across the
    appearance list to maximise view diversity.
    """
    if len(appearances) <= max_crops:
        return list(appearances)

    first = max(appearances, key=lambda a: a.confidence)
    chosen = [first]

    remaining = [a for a in appearances if a is not first]
    remaining.sort(key=lambda a: a.frame_index)

    while len(chosen) < max_crops and remaining:
        best_gap = -1
        best_candidate = None
        best_idx = 0
        for i, cand in enumerate(remaining):
            min_dist = min(abs(cand.frame_index - c.frame_index) for c in chosen)
            if min_dist > best_gap:
                best_gap = min_dist
                best_candidate = cand
                best_idx = i
        if best_candidate is not None:
            chosen.append(best_candidate)
            remaining.pop(best_idx)

    chosen.sort(key=lambda a: a.frame_index)
    return chosen


def _extract_crops_for_object(
    track: _Stage2Track,
    sampled_frames: list[_SampledFrame],
) -> list[ObjectCrop]:
    """Build crop evidence for a tracked object."""

    reps = _pick_representative_frames(track.appearances)
    crops: list[ObjectCrop] = []
    frame_lookup = {sf.sample_index: sf for sf in sampled_frames}

    for appearance in reps:
        sf = frame_lookup.get(appearance.frame_index)
        if sf is None:
            continue
        jpeg_b64 = _crop_with_padding(sf.image_bgr, appearance.bbox_xyxy)
        crops.append(ObjectCrop(
            frame_index=appearance.frame_index,
            timestamp_s=round(appearance.timestamp_s, 3),
            confidence=round(appearance.confidence, 4),
            bbox_xyxy=list(appearance.bbox_xyxy),
            jpeg_b64=jpeg_b64,
        ))
    return crops


# ---------------------------------------------------------------------------
# Internal: per-object LLM validation
# ---------------------------------------------------------------------------

_SYSTEM_PROMPT = """\
You are an object verification assistant for a cleanup bounty platform.

You will receive multiple cropped views of the same physical object detected
in a video submission.  Each crop is centred on the object's bounding box
with some surrounding context.

Your task: decide whether these crops show a REAL instance of the labelled
category.  Multiple views may show the object from different angles, under
different lighting, or with partial occlusion -- synthesise across all crops.

Respond with JSON only (no markdown, no prose outside the JSON):
{
  "is_real": true | false,
  "reasoning": "<1-2 sentence explanation>"
}
"""


async def _validate_object_with_llm(
    obj: SubmissionObject,
    *,
    settings: Settings,
) -> LLMObjectVerdict:
    """Ask the LLM whether this tracked object is real."""

    client = OpenAIPipelineClient(settings)

    images = [VisionImage(data_b64=crop.jpeg_b64) for crop in obj.crops]

    metadata = {
        "dino_predicted_label": obj.label,
        "detection_confidences": obj.confidences,
        "frames_detected": obj.frames_detected,
        "num_crops": len(obj.crops),
    }

    user_text = (
        render_json_block("OBJECT METADATA", metadata)
        + "\n\n"
        + f'Question: Is this a real instance of "{obj.label}"? '
        + "Use the crops together as multiple views of the same physical object."
    )

    request = LLMRequest(
        system_prompt=_SYSTEM_PROMPT,
        user_text=user_text,
        images=images,
    )

    def _stub_factory() -> LLMObjectVerdict:
        raise RuntimeError("Stage 2 does not allow stub LLM responses.")

    return await client.call_json(
        request,
        LLMObjectVerdict,
        stub_factory=_stub_factory,
        max_retries=1,
    )


# ---------------------------------------------------------------------------
# Internal: match validated objects to spec items
# ---------------------------------------------------------------------------

def _match_objects_to_spec(
    spec: GroundTruthSpec,
    objects: list[SubmissionObject],
) -> list[SpecMatchResult]:
    """Greedy label-match: each spec item is resolved by the highest-confidence
    validated object of the same category that hasn't already been claimed."""

    available = [
        obj for obj in objects
        if obj.llm_verdict is not None and obj.llm_verdict.is_real
    ]
    available.sort(key=lambda o: o.peak_confidence, reverse=True)
    claimed: set[str] = set()

    results: list[SpecMatchResult] = []
    for item in spec.items:
        norm = _normalize_label(item.label)
        match_obj: SubmissionObject | None = None
        for obj in available:
            if obj.object_id in claimed:
                continue
            if _normalize_label(obj.label) == norm:
                match_obj = obj
                break
        if match_obj is not None:
            claimed.add(match_obj.object_id)
            results.append(SpecMatchResult(
                item_id=item.item_id,
                label=item.label,
                matched=True,
                matched_object_id=match_obj.object_id,
                matched_confidence=match_obj.peak_confidence,
            ))
        else:
            results.append(SpecMatchResult(
                item_id=item.item_id,
                label=item.label,
                matched=False,
            ))
    return results


def _build_final_verdict(
    match_results: list[SpecMatchResult],
    *,
    items_total: int,
) -> Stage2FinalVerdict:
    # ``matched`` = spec trash category still has a *real* detection in the after
    # video. Approval = none of the required categories are still present.
    spec_still_present = sum(1 for result in match_results if result.matched)
    required_count = max(0, items_total)
    still_labels = [result.label for result in match_results if result.matched]
    if required_count == 0:
        return Stage2FinalVerdict(
            approved=True,
            score=1.0,
            reason="No required spec items; auto-approved.",
            missing_labels=[],
            matched_count=0,
            required_count=0,
        )
    # Score rises as the scene is clearer: 0 of N categories still there → 1.0
    score = 1.0 - (spec_still_present / required_count)
    approved = spec_still_present == 0
    if approved:
        reason = (
            "No Stage 1 spec categories still have verified real detections in the "
            "after video; scene is clear for all required items."
        )
    else:
        labels_str = ", ".join(still_labels)
        reason = (
            f"After video still shows {spec_still_present}/{required_count} required "
            f"debris type(s) as real ({labels_str}). Remove before payout can apply."
        )
    return Stage2FinalVerdict(
        approved=approved,
        score=round(max(0.0, min(1.0, score)), 4),
        reason=reason,
        missing_labels=still_labels,
        matched_count=spec_still_present,
        required_count=required_count,
    )


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

async def run_stage2_pipeline(
    submission_video: str | bytes,
    spec: GroundTruthSpec,
    *,
    settings: Settings | None = None,
) -> Stage2Result:
    """Run the full Stage 2 pipeline on a submission video.

    1. DINO detection with spec-derived prompt
    2. IoU tracking → unique objects
    3. Crop extraction (up to 3 per object)
    4. Per-object LLM validation
    5. Greedy matching against spec items
    """

    settings = settings or get_settings()
    if getattr(settings, "pipeline_use_stub", False):
        raise ValueError("Stage 2 requires real data: set PIPELINE_USE_STUB=false.")
    dino_prompt = spec.stage2_dino_prompt()
    iou_thresh = float(getattr(settings, "stage2_iou_threshold", 0.5))
    min_hits = int(getattr(settings, "stage2_min_track_hits", 1))

    logger.info("stage2_start prompt=%r", dino_prompt)

    # Step 1 + 2: detect + track
    sampled, per_frame, _width, _height = await _sample_and_detect_submission(
        submission_video, query=dino_prompt, settings=settings,
    )

    if not sampled:
        source = str(submission_video) if not isinstance(submission_video, bytes) else "<bytes>"
        return Stage2Result(
            spec_prompt=dino_prompt,
            submission_video=source,
            samples_taken=0,
            objects_tracked=0,
            objects_validated=0,
            items_total=len(spec.items),
            final_verdict=Stage2FinalVerdict(
                approved=(len(spec.items) == 0),
                score=1.0 if len(spec.items) == 0 else 0.0,
                reason=(
                    "No required spec items; auto-approved."
                    if len(spec.items) == 0
                    else "No submission frames were sampled; cannot verify required items."
                ),
                # Nothing verified as "still present" (pipeline did not run).
                missing_labels=[],
                matched_count=0,
                required_count=len(spec.items),
            ),
        )

    tracks = _track_objects_stage2(
        per_frame,
        timestamps=[sf.timestamp_s for sf in sampled],
        iou_threshold=iou_thresh,
        max_missed_frames=3,
        min_confidence=settings.grounding_dino_box_threshold,
        min_hits=min_hits,
    )

    logger.info("stage2_tracked objects=%d", len(tracks))

    # Step 3: build SubmissionObjects with crops
    objects: list[SubmissionObject] = []
    for track in tracks:
        peak = track.peak
        confs = [round(a.confidence, 4) for a in track.appearances]
        crops = _extract_crops_for_object(track, sampled)
        obj = SubmissionObject(
            object_id=f"obj_{track.track_id}",
            label=track.label,
            frames_detected=track.hit_count,
            confidences=confs,
            peak_confidence=round(peak.confidence, 4),
            peak_bbox_xyxy=list(peak.bbox_xyxy),
            crops=crops,
        )
        objects.append(obj)

    # Step 4: LLM validation per object
    for obj in objects:
        if not obj.crops:
            raise RuntimeError(f"Object {obj.object_id} has no crops; cannot validate.")
        obj.llm_verdict = await _validate_object_with_llm(obj, settings=settings)

    validated_count = sum(
        1 for obj in objects
        if obj.llm_verdict is not None and obj.llm_verdict.is_real
    )
    logger.info("stage2_validated count=%d/%d", validated_count, len(objects))

    # Step 5: match to spec
    match_results = _match_objects_to_spec(spec, objects)
    items_matched = sum(1 for m in match_results if m.matched)
    final_verdict = _build_final_verdict(match_results, items_total=len(spec.items))

    source = str(submission_video) if not isinstance(submission_video, bytes) else "<bytes>"
    return Stage2Result(
        spec_prompt=dino_prompt,
        submission_video=source,
        samples_taken=len(sampled),
        objects_tracked=len(tracks),
        objects_validated=validated_count,
        objects=objects,
        match_results=match_results,
        items_matched=items_matched,
        items_total=len(spec.items),
        final_verdict=final_verdict,
    )
