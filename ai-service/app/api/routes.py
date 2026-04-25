from datetime import UTC, datetime

from fastapi import APIRouter
from pydantic import BaseModel

router = APIRouter()


class VerificationRequest(BaseModel):
    bounty_id: str
    claim_id: str
    reference_video_url: str
    submission_video_url: str
    gps_points: list[dict]


@router.get("/health")
def health():
    return {
        "ok": True,
        "service": "ai-verifier",
        "timestamp": datetime.now(UTC).isoformat(),
    }


@router.post("/verify")
def verify(request: VerificationRequest):
    # TODO: call Claude vision + GPS and geo checks.
    return {
        "status": "pending_implementation",
        "claim_id": request.claim_id,
        "reason": "Scaffold endpoint created",
    }
