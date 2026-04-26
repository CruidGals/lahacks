"""FastAPI entrypoint for the verification service."""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import BackgroundTasks, Depends, FastAPI, status
from pydantic import BaseModel, Field

from app.api.routes import router as pipelines_router
from app.config import Settings, get_settings
from app.models import VerifyAccepted, VerifyRequest
from app.pipelines.fixture_verify import run_fixture_verification
from app.verify_pipeline import run_verification


@asynccontextmanager
async def lifespan(_app: FastAPI):
    settings = get_settings()
    logging.basicConfig(
        level=settings.log_level.upper(),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    yield


app = FastAPI(
    title="Civic Bounty Verification Service",
    version="0.1.0",
    description=(
        "Person 3B service. Receives /verify requests from the Node backend, "
        "runs Person 3A vision checks + fraud aggregation, scores the result, "
        "and POSTs back to /cleanups/:id/verification-result. Also exposes "
        "three standalone /pipelines/* endpoints for OpenAI vision experiments."
    ),
    lifespan=lifespan,
)

app.include_router(pipelines_router)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post(
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

    The backend (Person 2) calls this after a claimer submits a cleanup video.
    We respond `202 Accepted` immediately and POST the final result to
    `BACKEND_BASE_URL/cleanups/{cleanup_id}/verification-result` once finished.
    """

    background_tasks.add_task(run_verification, req, settings)
    return VerifyAccepted(cleanup_id=req.cleanup_id)


class FixtureVerifyRequest(BaseModel):
    """Body for ``POST /verify-fixture``.

    The backend only needs to identify which cleanup record the verdict
    belongs to -- the reference + submission videos are hardcoded fixtures
    on the AI service side.
    """

    cleanup_id: str = Field(..., min_length=1)


@app.post(
    "/verify-fixture",
    response_model=VerifyAccepted,
    status_code=status.HTTP_202_ACCEPTED,
)
async def verify_fixture(
    req: FixtureVerifyRequest,
    background_tasks: BackgroundTasks,
    settings: Settings = Depends(get_settings),
) -> VerifyAccepted:
    """Run the Stage 2 fixture pipeline and post the verdict back.

    GPS / scene-match / fraud signals are intentionally bypassed. The
    boolean ``Stage2FinalVerdict.approved`` is the sole input to whether
    the claimer is paid out: the callback to
    ``BACKEND_BASE_URL/api/cleanups/{cleanup_id}/verification-result``
    forwards it as ``verified``.
    """

    background_tasks.add_task(
        run_fixture_verification,
        req.cleanup_id,
        settings=settings,
    )
    return VerifyAccepted(cleanup_id=req.cleanup_id)
