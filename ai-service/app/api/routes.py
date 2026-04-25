"""HTTP routes for the verification service.

This is the single source of truth for /health and /verify. The locked
verification contract lives in `app.models` (Person 3B owns it; agreed with
Person 2 in hour 1). Person 3A's vision functions are invoked from
`app.verify_pipeline.run_verification`.
"""

from __future__ import annotations

from datetime import UTC, datetime

from fastapi import APIRouter, BackgroundTasks, Depends, status

from app.config import Settings, get_settings
from app.models import VerifyAccepted, VerifyRequest
from app.verify_pipeline import run_verification

router = APIRouter()


@router.get("/health")
def health() -> dict[str, object]:
    """Liveness probe consumed by the backend and deployment platforms.

    Shape kept compatible with `tests/test_health.py` and the rest of the
    monorepo (`backend/src/routes/health.ts` returns the same shape).
    """

    return {
        "ok": True,
        "service": "ai-verifier",
        "timestamp": datetime.now(UTC).isoformat(),
    }


@router.post(
    "/verify",
    response_model=VerifyAccepted,
    status_code=status.HTTP_202_ACCEPTED,
)
async def verify(
    req: VerifyRequest,
    background_tasks: BackgroundTasks,
    settings: Settings = Depends(get_settings),
) -> VerifyAccepted:
    """Accept a verification job and run it in the background.

    Person 2's backend calls this after a claimer submits a cleanup video.
    We respond `202 Accepted` immediately and POST the final result to
    `BACKEND_BASE_URL/cleanups/{cleanup_id}/verification-result` once finished.
    """

    background_tasks.add_task(run_verification, req, settings)
    return VerifyAccepted(cleanup_id=req.cleanup_id)
