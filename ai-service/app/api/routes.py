"""Standalone HTTP endpoints for cleanup + Stage 1 spec pipelines.

The existing ``/verify`` endpoint stays in :mod:`app.main` and is unaffected.
Endpoints here always return the pipeline's Pydantic model directly so the
JSON schema FastAPI serves under ``/docs`` matches the in-process types.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel

from app.config import Settings, get_settings
from app.pipelines.cleanup_pipeline import CleanupVerdict, run_cleanup_pipeline
from app.pipelines.dino_types import DinoOutput
from app.pipelines.disposal_pipeline import DisposalVerdict, run_disposal_pipeline
from app.pipelines.llm_client import LLMConfigError, LLMResponseError
from app.pipelines.reference_pipeline import ReferenceSpec
from app.pipelines.spec_pipeline import (
    GroundTruthSpec,
    SpecCandidateSet,
    SpecConfirmRequest,
    build_ground_truth_spec,
    extract_spec_candidates,
)
from app.pipelines.submission_pipeline import Stage2Result, run_stage2_pipeline
from app.pipelines.xp_pipeline import XpReward, run_xp_pipeline

router = APIRouter(prefix="/pipelines", tags=["pipelines"])


# --- Request models ------------------------------------------------------- #


class CleanupPipelineRequest(BaseModel):
    """Body for ``POST /pipelines/cleanup``.

    The reference spec must come from a prior ``/pipelines/reference`` run --
    we don't recompute it here so the caller controls when it's regenerated.
    Both DINO payloads are optional and auto-computed when missing.
    """

    reference_video_url: str
    submission_video_url: str
    reference_spec: ReferenceSpec
    reference_dino: DinoOutput | None = None
    submission_dino: DinoOutput | None = None


class DisposalPipelineRequest(BaseModel):
    """Body for ``POST /pipelines/disposal``."""

    video_url: str


class SpecCandidatesRequest(BaseModel):
    """Body for ``POST /pipelines/spec/candidates``.

    Stage 1 entry point. The requester (Person A) hands us their reference
    video and we return a :class:`SpecCandidateSet` for review. The reference
    video is consumed *only* here -- after the requester confirms via
    ``/pipelines/spec/confirm`` it can be discarded.
    """

    video_url: str


class Stage2Request(BaseModel):
    """Body for ``POST /pipelines/submission/verify``.

    Stage 2 entry point. The submission video is analysed against the
    confirmed :class:`GroundTruthSpec` to produce a :class:`Stage2Result`.
    """

    submission_video_url: str
    spec: GroundTruthSpec


class XpPipelineRequest(BaseModel):
    """Body for ``POST /pipelines/xp``.

    All fields besides ``description`` are optional but help the LLM ground
    its difficulty/importance reasoning.
    """

    title: str = ""
    description: str
    category: str | None = None
    reward_sol: float | None = None
    lat: float | None = None
    lng: float | None = None


# --- Endpoints ------------------------------------------------------------ #


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


# --- Stage 1 (posting time) -------------------------------------------- #


@router.post(
    "/spec/candidates",
    response_model=SpecCandidateSet,
    status_code=status.HTTP_200_OK,
    summary="Stage 1: reference video -> tracked candidate list with overlays",
)
async def run_spec_candidates(
    body: SpecCandidatesRequest,
    settings: Settings = Depends(get_settings),
) -> SpecCandidateSet:
    """Run the broad-prompt DINO + IoU tracker over the reference video.

    Returns the candidate list plus preview frames with numbered overlay
    boxes burned in so the UI can render the review screen directly.
    """

    try:
        return await extract_spec_candidates(
            body.video_url,
            settings=settings,
        )
    except FileNotFoundError as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc


@router.post(
    "/spec/confirm",
    response_model=GroundTruthSpec,
    status_code=status.HTTP_200_OK,
    summary="Stage 1: confirm + correct -> persisted GroundTruthSpec",
)
async def run_spec_confirm(
    body: SpecConfirmRequest,
    _settings: Settings = Depends(get_settings),
) -> GroundTruthSpec:
    """Apply the requester's deletes/additions and finalize the ground truth.

    The returned :class:`GroundTruthSpec` is what the backend persists on the
    bounty record. After this call, the reference video is no longer needed.
    """

    return build_ground_truth_spec(body)


# --- Stage 2 (submission time) ----------------------------------------- #


@router.post(
    "/submission/verify",
    response_model=Stage2Result,
    status_code=status.HTTP_200_OK,
    summary="Stage 2: submission video + spec -> object grouping + LLM validation + matching",
)
async def run_submission_verify(
    body: Stage2Request,
    settings: Settings = Depends(get_settings),
) -> Stage2Result:
    """Run the Stage 2 pipeline: DINO detection on the submission video with
    the spec-derived prompt, IoU object tracking, per-object crop extraction,
    LLM validation, and greedy matching against spec items.
    """

    try:
        return await run_stage2_pipeline(
            body.submission_video_url,
            body.spec,
            settings=settings,
        )
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    except FileNotFoundError as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc


@router.post(
    "/xp",
    response_model=XpReward,
    status_code=status.HTTP_200_OK,
    summary="Estimate XP reward for a bounty from its title/description.",
)
async def run_xp(
    body: XpPipelineRequest,
    settings: Settings = Depends(get_settings),
) -> XpReward:
    try:
        return await run_xp_pipeline(
            title=body.title,
            description=body.description,
            category=body.category,
            reward_sol=body.reward_sol,
            lat=body.lat,
            lng=body.lng,
            settings=settings,
        )
    except LLMConfigError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    except LLMResponseError as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, detail=str(exc)) from exc
