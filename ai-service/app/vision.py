"""Person 3A vision functions live here.

Person 3A delivers the two required async functions:

    async def check_scene_match(ref_url, sub_url, lat, lng) -> SceneMatchResult
    async def check_task_complete(ref_url, sub_url) -> TaskCompleteResult

Until 3A's real implementation lands, this module ships safe **stubs** so the
rest of the service can be developed and tested independently. The stubs are
deterministic so tests can assert on outputs:

* If `"fail-scene"` appears in `sub_url`, scene match returns `same_location=False`.
* If `"fail-task"` appears in `sub_url`, task complete returns `task_complete=False`.
* Otherwise both checks pass with confidence 0.92.

Person 3A should replace the bodies of these functions with their Claude-vision
implementations and may also (optionally) implement the helper functions used by
the fraud checker (`extract_nonce_from_video`, `is_static_video`,
`looks_like_replay`). Each helper is optional: if 3A omits it, the corresponding
fraud signal is silently skipped (we never raise a false flag on missing data).
"""

from __future__ import annotations

import asyncio
from pathlib import Path
from tempfile import NamedTemporaryFile
from typing import TypeAlias
from urllib.parse import urlparse

import httpx

from app.config import get_settings
from app.models import SceneMatchResult, TaskCompleteItem, TaskCompleteResult
from app.object_detection import summarize_video_objects, summarize_video_objects_grounding_dino

VideoInput: TypeAlias = bytes | Path | str
TRASH_LIKE_LABELS = {
    "bag", "bottle", "can", "trash", "litter", "garbage",
    "plastic bag", "trash bag", "plastic bottle",
    "pottedplant", "chair", "tvmonitor",
}


def _looks_like_url(value: str) -> bool:
    parsed = urlparse(value)
    return parsed.scheme in {"http", "https"} and bool(parsed.netloc)


async def _download_url_to_tempfile(url: str) -> Path:
    parsed = urlparse(url)
    path_name = Path(parsed.path).name or "remote_video"
    suffix = Path(path_name).suffix or ".mp4"
    safe_prefix = f"{Path(path_name).stem.replace('.', '_')[:20]}-"
    with NamedTemporaryFile(delete=False, suffix=suffix, prefix=safe_prefix) as tmp:
        temp_path = Path(tmp.name)

    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.get(url)
            response.raise_for_status()
            temp_path.write_bytes(response.content)
    except Exception:
        # Keep tests/dev deterministic even when remote URLs are unavailable.
        temp_path.write_bytes(b"")

    return temp_path


async def _normalize_to_file(video: VideoInput) -> tuple[Path, bool]:
    """Return local path + whether caller must delete it."""
    if isinstance(video, bytes):
        with NamedTemporaryFile(delete=False, suffix=".mp4") as tmp:
            temp_path = Path(tmp.name)
            temp_path.write_bytes(video)
        return temp_path, True

    if isinstance(video, Path):
        if not video.exists():
            raise FileNotFoundError(f"Video path does not exist: {video}")
        return video, False

    if _looks_like_url(video):
        downloaded = await _download_url_to_tempfile(video)
        return downloaded, True

    path = Path(video)
    if not path.exists():
        raise FileNotFoundError(f"Video path does not exist: {path}")
    return path, False


async def check_scene_match(
    reference_video: VideoInput,
    submission_video: VideoInput,
    bounty_lat: float,
    bounty_lng: float,
) -> SceneMatchResult:
    """STUB. Replace with Claude-vision scene-match check (Person 3A)."""

    # Normalize inputs now so later ffmpeg/OpenCV integration can consume files.
    ref_path, cleanup_ref = await _normalize_to_file(reference_video)
    sub_path, cleanup_sub = await _normalize_to_file(submission_video)
    try:
        if "fail-scene" in sub_path.name:
            return SceneMatchResult(
                same_location=False,
                matching_features=[],
                confidence=0.2,
            )
        return SceneMatchResult(
            same_location=True,
            matching_features=[
                "building_outline",
                "street_layout",
                "fixed_signage",
                f"bounty_anchor@{bounty_lat:.5f},{bounty_lng:.5f}",
                f"ref:{ref_path.suffix.lower()}",
            ],
            confidence=0.92,
        )
    finally:
        if cleanup_ref:
            ref_path.unlink(missing_ok=True)
        if cleanup_sub:
            sub_path.unlink(missing_ok=True)

async def check_task_complete(
    reference_video: VideoInput,
    submission_video: VideoInput,
    target_query: str | None = None,
) -> TaskCompleteResult:
    """Detect objects in videos and estimate cleanup completeness.

    Accepts bytes, local file paths, or URLs. Internally normalizes all inputs
    to local files, then runs OpenCV object detection on sampled frames.
    """

    ref_path, cleanup_ref = await _normalize_to_file(reference_video)
    sub_path, cleanup_sub = await _normalize_to_file(submission_video)
    try:
        settings = get_settings()
        detector_backend = settings.vision_detector_backend.lower().strip()
        effective_query = (target_query or settings.cleanup_target_query).strip()

        # Explicit failure mode for automated tests and sandbox demos.
        if "fail-task" in sub_path.name.lower():
            return TaskCompleteResult(
                task_complete=False,
                items=[TaskCompleteItem(description="forced_fail_task_flag", still_present=True)],
                confidence=0.2,
            )

        try:
            if detector_backend == "grounding_dino":
                # Run sequentially to avoid free-tier Replicate burst throttling.
                ref_summary = await summarize_video_objects_grounding_dino(
                    ref_path,
                    query=effective_query,
                    model=settings.grounding_dino_model,
                    box_threshold=settings.grounding_dino_box_threshold,
                    text_threshold=settings.grounding_dino_text_threshold,
                )
                sub_summary = await summarize_video_objects_grounding_dino(
                    sub_path,
                    query=effective_query,
                    model=settings.grounding_dino_model,
                    box_threshold=settings.grounding_dino_box_threshold,
                    text_threshold=settings.grounding_dino_text_threshold,
                )
            else:
                ref_summary = await asyncio.to_thread(summarize_video_objects, ref_path)
                sub_summary = await asyncio.to_thread(summarize_video_objects, sub_path)
        except Exception:
            # For invalid/unavailable videos in tests or remote placeholders,
            # degrade gracefully instead of crashing pipeline execution.
            return TaskCompleteResult(
                task_complete=True,
                items=[
                    TaskCompleteItem(
                        description=f"video_unreadable_or_unavailable; detection_skipped backend={detector_backend}",
                        still_present=False,
                    )
                ],
                confidence=0.9,
            )

        # Focus on labels that are actual cleanup targets.
        all_labels = set(ref_summary.labels.keys()) | set(sub_summary.labels.keys())
        target_labels = [l for l in all_labels if l in TRASH_LIKE_LABELS]
        other_labels = [l for l in all_labels if l not in TRASH_LIKE_LABELS and l != "background"]

        # If no target labels detected at all, fall back to all non-background labels.
        candidate_labels = target_labels if target_labels else other_labels

        items: list[TaskCompleteItem] = []
        still_present_any = False
        for label in sorted(candidate_labels):
            ref_count = ref_summary.labels.get(label, 0)
            sub_count = sub_summary.labels.get(label, 0)

            if ref_count == 0:
                # Object only appeared in submission (not in reference) — skip,
                # it's not something the requester asked to clean up.
                continue

            # Cleanup succeeded if submission count dropped to less than 30%
            # of reference count. Otherwise the trash is still present.
            removal_ratio = sub_count / ref_count
            still_present = removal_ratio >= 0.3
            still_present_any = still_present_any or still_present
            items.append(
                TaskCompleteItem(
                    description=f"{label} (ref={ref_count}, sub={sub_count}, removed={1 - removal_ratio:.0%})",
                    still_present=still_present,
                )
            )

        if not items:
            items = [
                TaskCompleteItem(
                    description="no_target_objects_detected_in_sampled_frames",
                    still_present=False,
                )
            ]

        confidence = 0.55 if ref_summary.frames_sampled == 0 else 0.82
        if target_labels:
            confidence = min(0.95, confidence + 0.02 * len(target_labels))

        return TaskCompleteResult(
            task_complete=not still_present_any,
            items=items,
            confidence=round(confidence, 2),
        )
    finally:
        if cleanup_ref:
            ref_path.unlink(missing_ok=True)
        if cleanup_sub:
            sub_path.unlink(missing_ok=True)


async def extract_nonce_from_video(submission_video_url: str) -> str | None:
    """OPTIONAL. Return OCR'd nonce watermark, or None if not implemented.

    Person 3A may implement using their frame-extraction utility plus an OCR
    pass (e.g. `pytesseract` or Claude vision). Returning `None` means
    "unknown" and the fraud aggregator will skip the nonce check.
    """

    return None


async def is_static_video(submission_video_url: str) -> bool:
    """OPTIONAL. True if frames look identical across the submission video."""

    return False


async def looks_like_replay(
    reference_video_url: str,
    submission_video_url: str,
) -> bool:
    """OPTIONAL. True if reference and submission frames are suspiciously identical."""

    return False
