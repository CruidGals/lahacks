"""In-process verification progress for fixture jobs (keyed by ``cleanup_id``).

The frontend polls :func:`get_verification_progress` via ``GET /verify-progress/{id}`` so
the submitted screen can mirror log phases from ``run_fixture_verification`` (same steps
as uvicorn / ``logger`` output, e.g. ``fixture_verification_start``, ``fixture_stage1_*``,
``stage2_*``, ``fixture_callback_delivered``).
"""

from __future__ import annotations

import asyncio
import time
from typing import Any

_lock = asyncio.Lock()
_store: dict[str, dict[str, Any]] = {}
_PRUNE_EVERY = 32
_ticker = 0


async def set_verification_progress(
    cleanup_id: str,
    *,
    phase: str,
    percent: int,
    detail: str,
) -> None:
    """Update progress for a running (or just-finished) fixture verification."""

    p = min(100, max(0, int(percent)))
    now = time.time()
    async with _lock:
        global _ticker
        _ticker += 1
        _store[cleanup_id] = {
            "phase": phase,
            "percent": p,
            "detail": detail,
            "updated_at": now,
        }
        if _ticker % _PRUNE_EVERY == 0:
            _prune_unlocked(now)


def _prune_unlocked(now: float) -> None:
    """Drop stale entries to cap memory (best-effort)."""

    cutoff = now - 3600.0
    if len(_store) <= 200:
        stale = [k for k, v in _store.items() if (v.get("updated_at") or 0) < cutoff]
        for k in stale:
            del _store[k]
    else:
        by_age = sorted(
            _store.items(), key=lambda kv: kv[1].get("updated_at") or 0.0, reverse=True
        )
        for k, _ in by_age[200:]:
            _store.pop(k, None)


async def get_verification_progress(cleanup_id: str) -> dict[str, Any]:
    """Return the latest row for ``cleanup_id``, or a neutral placeholder."""

    async with _lock:
        row = _store.get(cleanup_id)
        if row is not None:
            return {
                "cleanup_id": cleanup_id,
                "phase": row["phase"],
                "percent": row["percent"],
                "detail": row["detail"],
                "updated_at": row.get("updated_at"),
            }
    return {
        "cleanup_id": cleanup_id,
        "phase": "unknown",
        "percent": 0,
        "detail": (
            "No progress snapshot yet (job not started, AI process restarted, or "
            "cleanup_id mismatch). Polling will pick up once fixture_verification_start runs."
        ),
        "updated_at": None,
    }
