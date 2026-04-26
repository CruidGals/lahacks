"""Standalone HTTP endpoints for the three LLM pipelines.

These let any caller exercise each pipeline in isolation while DINO and
backend integration are still in progress, e.g.::

    curl -X POST http://localhost:8001/pipelines/reference -d @body.json

The existing ``/verify`` endpoint stays in :mod:`app.main` and is unaffected.
Endpoints here always return the pipeline's Pydantic model directly so the
JSON schema FastAPI serves under ``/docs`` matches the in-process types.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel

from app.config import Settings, get_settings
from app.pipelines.cleanup_pipeline import CleanupVerdict, run_cleanup_pipeline
from app.pipelines.dino_types import DinoOutput
from app.pipelines.disposal_pipeline import DisposalVerdict, run_disposal_pipeline
from app.pipelines.llm_client import LLMConfigError, LLMResponseError
from app.pipelines.reference_pipeline import ReferenceSpec, run_reference_pipeline

router = APIRouter(prefix="/pipelines", tags=["pipelines"])
logger = logging.getLogger(__name__)


# --- Request models ------------------------------------------------------- #


class ReferencePipelineRequest(BaseModel):
    """Body for ``POST /pipelines/reference``."""

    video_url: str
    dino: DinoOutput


class CleanupPipelineRequest(BaseModel):
    """Body for ``POST /pipelines/cleanup``.

    The reference spec must come from a prior ``/pipelines/reference`` run --
    we don't recompute it here so the caller controls when it's regenerated.
    """

    reference_video_url: str
    submission_video_url: str
    reference_dino: DinoOutput
    submission_dino: DinoOutput
    reference_spec: ReferenceSpec


class DisposalPipelineRequest(BaseModel):
    """Body for ``POST /pipelines/disposal``."""

    video_url: str


# --- Endpoints ------------------------------------------------------------ #


@router.post(
    "/reference",
    response_model=ReferenceSpec,
    status_code=status.HTTP_200_OK,
    summary="Person A: video + DINO -> ReferenceSpec",
)
async def run_reference(
    body: ReferencePipelineRequest,
    settings: Settings = Depends(get_settings),
) -> ReferenceSpec:
    try:
        return await run_reference_pipeline(
            video=body.video_url,
            dino=body.dino,
            settings=settings,
        )
    except LLMConfigError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    except LLMResponseError as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, detail=str(exc)) from exc


@router.post(
    "/cleanup",
    response_model=CleanupVerdict,
    status_code=status.HTTP_200_OK,
    summary="Person B: ref+sub video + both DINOs + spec -> CleanupVerdict",
)
async def run_cleanup(
    body: CleanupPipelineRequest,
    settings: Settings = Depends(get_settings),
) -> CleanupVerdict:
    try:
        return await run_cleanup_pipeline(
            reference_video=body.reference_video_url,
            submission_video=body.submission_video_url,
            reference_dino=body.reference_dino,
            submission_dino=body.submission_dino,
            reference_spec=body.reference_spec,
            settings=settings,
        )
    except LLMConfigError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    except LLMResponseError as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, detail=str(exc)) from exc


@router.post(
    "/disposal",
    response_model=DisposalVerdict,
    status_code=status.HTTP_200_OK,
    summary="Disposal proof: short video -> DisposalVerdict (no DINO)",
)
async def run_disposal(
    body: DisposalPipelineRequest,
    settings: Settings = Depends(get_settings),
) -> DisposalVerdict:
    try:
        return await run_disposal_pipeline(
            video=body.video_url,
            settings=settings,
        )
    except LLMConfigError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    except LLMResponseError as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, detail=str(exc)) from exc
