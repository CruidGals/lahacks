"""Orchestrates a single /verify request end-to-end."""

from __future__ import annotations

import asyncio
import logging
from typing import Awaitable, Callable

from app import vision
from app.callback import post_verification_result
from app.config import Settings
from app.fraud import aggregate_fraud_signals
from app.models import VerificationResult, VerifyRequest
from app.scoring import decide

logger = logging.getLogger(__name__)

CallbackFn = Callable[[str, VerificationResult, Settings], Awaitable[bool]]


async def run_verification(
    req: VerifyRequest,
    settings: Settings,
    callback: CallbackFn = post_verification_result,
) -> VerificationResult:
    """Execute the full verification pipeline and POST the result to backend.

    Returns the computed `VerificationResult` even if the callback POST fails so
    callers (and tests) can introspect it.
    """

    logger.info("Verification started cleanup_id=%s", req.cleanup_id)

    scene_task = asyncio.create_task(
        vision.check_scene_match(
            str(req.reference_video_url),
            str(req.submission_video_url),
            req.bounty_lat,
            req.bounty_lng,
        )
    )
    task_task = asyncio.create_task(
        vision.check_task_complete(
            str(req.reference_video_url),
            str(req.submission_video_url),
        )
    )
    fraud_task = asyncio.create_task(aggregate_fraud_signals(req, settings))

    scene = await scene_task
    task = await task_task
    fraud = await fraud_task

    result = decide(scene, task, fraud, settings)

    logger.info(
        "Verification computed cleanup_id=%s verified=%s confidence=%.2f flags=%s",
        req.cleanup_id,
        result.verified,
        result.confidence,
        result.fraud_flags,
    )

    try:
        delivered = await callback(req.cleanup_id, result, settings)
        if not delivered:
            logger.error(
                "Verification result not delivered cleanup_id=%s; manual replay required",
                req.cleanup_id,
            )
    except Exception:  # noqa: BLE001 - we never want pipeline crash on callback path
        logger.exception("Callback raised cleanup_id=%s", req.cleanup_id)

    return result
