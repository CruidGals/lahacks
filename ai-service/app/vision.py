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

from app.models import SceneMatchResult, TaskCompleteItem, TaskCompleteResult


async def check_scene_match(
    reference_video_url: str,
    submission_video_url: str,
    bounty_lat: float,
    bounty_lng: float,
) -> SceneMatchResult:
    """STUB. Replace with Claude-vision scene-match check (Person 3A)."""

    if "fail-scene" in submission_video_url:
        return SceneMatchResult(
            same_location=False,
            matching_features=[],
            confidence=0.2,
        )
    return SceneMatchResult(
        same_location=True,
        matching_features=["building_outline", "street_layout", "fixed_signage"],
        confidence=0.92,
    )


async def check_task_complete(
    reference_video_url: str,
    submission_video_url: str,
) -> TaskCompleteResult:
    """STUB. Replace with Claude-vision task-complete check (Person 3A)."""

    if "fail-task" in submission_video_url:
        return TaskCompleteResult(
            task_complete=False,
            items=[
                TaskCompleteItem(description="plastic bottles", still_present=True),
                TaskCompleteItem(description="cardboard pile", still_present=True),
            ],
            confidence=0.3,
        )
    return TaskCompleteResult(
        task_complete=True,
        items=[
            TaskCompleteItem(description="plastic bottles", still_present=False),
            TaskCompleteItem(description="cardboard pile", still_present=False),
        ],
        confidence=0.93,
    )


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
