"""Deliver verification results back to the Node backend (Person 2)."""

from __future__ import annotations

import asyncio
import logging

import httpx

from app.config import Settings
from app.models import VerificationResult

logger = logging.getLogger(__name__)


def callback_url(settings: Settings, cleanup_id: str) -> str:
    base = settings.backend_base_url.rstrip("/")
    return f"{base}/cleanups/{cleanup_id}/verification-result"


async def post_verification_result(
    cleanup_id: str,
    result: VerificationResult,
    settings: Settings,
    client: httpx.AsyncClient | None = None,
) -> bool:
    """POST the verification result with retry + exponential backoff.

    Returns True on success, False if all retries are exhausted. We log loudly
    on failure so the operator can replay manually; we never lose a result
    silently.
    """

    url = callback_url(settings, cleanup_id)
    headers = {"Content-Type": "application/json"}
    if settings.backend_internal_token:
        headers["Authorization"] = f"Bearer {settings.backend_internal_token}"

    payload = result.to_callback_dict()
    owns_client = client is None
    if owns_client:
        client = httpx.AsyncClient(timeout=10.0)

    try:
        backoff = settings.callback_initial_backoff_seconds
        for attempt in range(1, settings.callback_max_retries + 1):
            try:
                response = await client.post(url, json=payload, headers=headers)
                response.raise_for_status()
                logger.info(
                    "Callback delivered cleanup_id=%s attempt=%d status=%d",
                    cleanup_id,
                    attempt,
                    response.status_code,
                )
                return True
            except httpx.HTTPError as exc:
                logger.warning(
                    "Callback failed cleanup_id=%s attempt=%d/%d error=%s",
                    cleanup_id,
                    attempt,
                    settings.callback_max_retries,
                    exc,
                )
                if attempt == settings.callback_max_retries:
                    logger.error(
                        "Callback exhausted retries cleanup_id=%s payload=%s",
                        cleanup_id,
                        payload,
                    )
                    return False
                await asyncio.sleep(backoff)
                backoff *= 2
        return False
    finally:
        if owns_client:
            await client.aclose()
