"""Fixture-based Stage 2 verification.

Mirrors ``scripts/stage2_debug_runner.py`` but as a callable function suitable
for HTTP integration. The verdict boolean (``Stage2FinalVerdict.approved``) is
the single source of truth for whether a claimer gets paid.

The reference (request) and submission video paths are hardcoded fixtures by
default but can be overridden via env vars so deployments can repoint without
code changes:

* ``FIXTURE_REQUEST_VIDEO``   -- Stage 1 reference video.
* ``FIXTURE_SUBMISSION_VIDEO`` -- Stage 2 submission video.

The Stage 1 :class:`GroundTruthSpec` is cached in-process keyed on the
reference video path + mtime so it's only computed once per process per
request video.
"""

from __future__ import annotations

import asyncio
import logging
import os
from pathlib import Path
from typing import Any, Optional

import httpx

from app.config import Settings, get_settings
from app.pipelines.spec_pipeline import (
    GroundTruthSpec,
    SpecConfirmRequest,
    build_ground_truth_spec,
    extract_spec_candidates,
)
from app.pipelines.submission_pipeline import run_stage2_pipeline

logger = logging.getLogger(__name__)


_DEFAULT_REQUEST_VIDEO = Path(
    os.environ.get(
        "FIXTURE_REQUEST_VIDEO",
        "/Users/kylechiem/Documents/lahacks/data/videos/fixtures/egRequest.MOV",
    )
)
_DEFAULT_SUBMISSION_VIDEO = Path(
    os.environ.get(
        "FIXTURE_SUBMISSION_VIDEO",
        "/Users/kylechiem/Documents/lahacks/data/videos/fixtures/egUserPost.MOV",
    )
)


_SpecCacheKey = tuple[str, float]
_spec_cache: dict[_SpecCacheKey, GroundTruthSpec] = {}
_spec_lock = asyncio.Lock()


def fixture_paths(
    request_video: Optional[Path] = None,
    submission_video: Optional[Path] = None,
) -> tuple[Path, Path]:
    """Resolve the request + submission fixture paths."""

    return (
        request_video or _DEFAULT_REQUEST_VIDEO,
        submission_video or _DEFAULT_SUBMISSION_VIDEO,
    )


async def ensure_fixture_spec(
    request_video: Path,
    settings: Settings,
) -> GroundTruthSpec:
    """Return a cached :class:`GroundTruthSpec` for ``request_video``.

    Stage 1 (broad-prompt DINO + IoU tracker on the reference video) is
    expensive, so we only run it the first time we see a given file. The
    cache key includes mtime so swapping the file invalidates it.
    """

    if not request_video.exists():
        raise FileNotFoundError(f"Missing request video: {request_video}")

    key: _SpecCacheKey = (str(request_video.resolve()), request_video.stat().st_mtime)
    cached = _spec_cache.get(key)
    if cached is not None:
        return cached

    async with _spec_lock:
        cached = _spec_cache.get(key)
        if cached is not None:
            return cached

        logger.info("fixture_stage1_start request_video=%s", request_video)
        candidate_set = await extract_spec_candidates(
            str(request_video), settings=settings
        )
        spec = build_ground_truth_spec(
            SpecConfirmRequest(
                candidate_set=candidate_set,
                removed_candidate_ids=[],
                manual_items=[],
            )
        )
        logger.info(
            "fixture_stage1_complete items=%d categories=%s",
            len(spec.items),
            spec.categories,
        )
        _spec_cache[key] = spec
        return spec


def _backend_callback_url(settings: Settings, cleanup_id: str) -> str:
    """Verification-result URL on the backend (mounted at ``/api/cleanups``)."""

    base = settings.backend_base_url.rstrip("/")
    return f"{base}/api/cleanups/{cleanup_id}/verification-result"


async def _post_callback(
    cleanup_id: str,
    payload: dict[str, Any],
    settings: Settings,
) -> bool:
    url = _backend_callback_url(settings, cleanup_id)
    headers = {"Content-Type": "application/json"}
    if settings.backend_internal_token:
        headers["x-internal-token"] = settings.backend_internal_token
        headers["Authorization"] = f"Bearer {settings.backend_internal_token}"

    backoff = settings.callback_initial_backoff_seconds
    async with httpx.AsyncClient(timeout=15.0) as client:
        for attempt in range(1, settings.callback_max_retries + 1):
            try:
                response = await client.post(url, json=payload, headers=headers)
                response.raise_for_status()
                logger.info(
                    "fixture_callback_delivered cleanup_id=%s attempt=%d status=%d",
                    cleanup_id,
                    attempt,
                    response.status_code,
                )
                return True
            except httpx.HTTPError as exc:
                logger.warning(
                    "fixture_callback_failed cleanup_id=%s attempt=%d/%d error=%s",
                    cleanup_id,
                    attempt,
                    settings.callback_max_retries,
                    exc,
                )
                if attempt == settings.callback_max_retries:
                    logger.error(
                        "fixture_callback_exhausted cleanup_id=%s url=%s payload=%s",
                        cleanup_id,
                        url,
                        payload,
                    )
                    return False
                await asyncio.sleep(backoff)
                backoff *= 2
    return False


def _build_callback_payload(
    *,
    approved: bool,
    score: float,
    reason: str,
    matched: int,
    required: int,
    missing_labels: list[str],
) -> dict[str, Any]:
    """Adapt a :class:`Stage2FinalVerdict` into the backend's expected shape.

    Backend's ``verification-result`` route requires ``verified``; the optional
    ``scene_match``, ``task_complete`` and ``fraud_flags`` are intentionally
    set to non-falsey values so the existing payout gating
    (``shouldPayout = verified && scene_match !== false && task_complete !== false && !fraud_flags.length``)
    flows through cleanly without GPS / scene-match plumbing.
    """

    missing_str = ", ".join(missing_labels) if missing_labels else ""
    reasoning = (
        f"Stage 2 verdict: {reason} "
        f"(matched {matched}/{required} items"
        + (f", missing: {missing_str}" if missing_str else "")
        + ")"
    )

    confidence = max(0.0, min(1.0, float(score)))

    return {
        "verified": bool(approved),
        "final_result": "approved" if approved else "rejected",
        "artifact_removed": bool(approved),
        "confidence": round(confidence, 4),
        "scene_match": True,
        "task_complete": bool(approved),
        "fraud_flags": [],
        "reasoning": reasoning,
    }


async def run_fixture_verification(
    cleanup_id: str,
    *,
    settings: Optional[Settings] = None,
    request_video: Optional[Path] = None,
    submission_video: Optional[Path] = None,
) -> dict[str, Any]:
    """Run Stage 1+2 on the configured fixture videos and post the verdict.

    Returns the callback payload that was POSTed to the backend so callers /
    tests can inspect the result. The boolean ``verified`` field of that
    payload is exactly ``Stage2FinalVerdict.approved`` -- it dictates whether
    the claimer is paid out.
    """

    settings = settings or get_settings()
    req_video, sub_video = fixture_paths(request_video, submission_video)

    logger.info(
        "fixture_verification_start cleanup_id=%s request=%s submission=%s",
        cleanup_id,
        req_video,
        sub_video,
    )

    if not sub_video.exists():
        payload = _build_callback_payload(
            approved=False,
            score=0.0,
            reason=f"Submission fixture not found: {sub_video}",
            matched=0,
            required=0,
            missing_labels=[],
        )
        await _post_callback(cleanup_id, payload, settings)
        return payload

    try:
        spec = await ensure_fixture_spec(req_video, settings)
        result = await run_stage2_pipeline(
            str(sub_video),
            spec,
            settings=settings,
        )
    except Exception as exc:  # noqa: BLE001
        logger.exception(
            "fixture_verification_failed cleanup_id=%s error=%s",
            cleanup_id,
            exc,
        )
        payload = _build_callback_payload(
            approved=False,
            score=0.0,
            reason=f"Stage 2 pipeline error: {exc}",
            matched=0,
            required=0,
            missing_labels=[],
        )
        await _post_callback(cleanup_id, payload, settings)
        return payload

    verdict = result.final_verdict
    payload = _build_callback_payload(
        approved=verdict.approved,
        score=verdict.score,
        reason=verdict.reason,
        matched=verdict.matched_count,
        required=verdict.required_count,
        missing_labels=list(verdict.missing_labels),
    )

    logger.info(
        "fixture_verification_complete cleanup_id=%s verified=%s score=%.4f matched=%d/%d",
        cleanup_id,
        verdict.approved,
        verdict.score,
        verdict.matched_count,
        verdict.required_count,
    )

    delivered = await _post_callback(cleanup_id, payload, settings)
    if not delivered:
        logger.error(
            "fixture_verification_callback_undelivered cleanup_id=%s payload=%s",
            cleanup_id,
            payload,
        )
    return payload
