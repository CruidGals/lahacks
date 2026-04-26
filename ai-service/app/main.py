"""FastAPI entrypoint for the verification service."""

from __future__ import annotations

import logging
import os
import shutil
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import BackgroundTasks, Depends, FastAPI, File, Form, HTTPException, UploadFile, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from app.api.routes import router as pipelines_router
from app.config import Settings, get_settings
from app.models import VerifyAccepted, VerifyRequest
from app.pipelines.fixture_verify import fixture_paths, run_fixture_verification
from app.verification_progress import get_verification_progress
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

_cors_origins_env = os.environ.get("CORS_ALLOW_ORIGINS", "*").strip()
_cors_origins = (
    ["*"]
    if _cors_origins_env in ("", "*")
    else [o.strip() for o in _cors_origins_env.split(",") if o.strip()]
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["*"],
)

app.include_router(pipelines_router)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


def _media_type_for_video_path(path: Path) -> str:
    ext = path.suffix.lower()
    if ext in (".mp4", ".m4v"):
        return "video/mp4"
    if ext in (".mov",):
        return "video/quicktime"
    if ext in (".webm",):
        return "video/webm"
    return "application/octet-stream"


@app.get("/request-fixture")
async def stream_request_fixture() -> FileResponse:
    """Serve the poster reference video (``FIXTURE_REQUEST_VIDEO`` / last ``upload-fixture`` ``kind=request``).

    This URL can be stored as ``bounties.reference_video_url`` so claimers can replay
    the *before* clip. One file per deployment is shared; production should use
    per-bounty object storage instead.
    """

    request_path, _ = fixture_paths()
    if not request_path.is_file():
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Request fixture not found on disk. Post a reference clip (upload kind=request) first.",
        )
    return FileResponse(
        str(request_path),
        media_type=_media_type_for_video_path(request_path),
        filename=request_path.name,
    )


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


class VerificationProgressResponse(BaseModel):
    """Snapshot for ``GET /verify-progress/{cleanup_id}`` (in-process, mirrors pipeline logs)."""

    cleanup_id: str
    phase: str
    percent: int
    detail: str
    updated_at: float | None = None


@app.get(
    "/verify-progress/{cleanup_id}",
    response_model=VerificationProgressResponse,
    status_code=status.HTTP_200_OK,
)
async def verify_progress(cleanup_id: str) -> VerificationProgressResponse:
    """Poll Stage 1+2 fixture job progress; ``detail`` strings align with uvicorn log lines."""

    data = await get_verification_progress(cleanup_id.strip())
    return VerificationProgressResponse(**data)


_UPLOAD_MAX_BYTES = int(os.environ.get("FIXTURE_UPLOAD_MAX_BYTES", str(200 * 1024 * 1024)))


class FixtureUploadResponse(BaseModel):
    """Response from ``POST /upload-fixture``."""

    kind: str
    saved_path: str
    bytes_written: int
    content_type: str | None = None


_VALID_FIXTURE_KINDS = {"submission", "request"}


@app.post(
    "/upload-fixture",
    response_model=FixtureUploadResponse,
    status_code=status.HTTP_200_OK,
)
async def upload_fixture(
    file: UploadFile = File(...),
    kind: str = Form("submission"),
) -> FixtureUploadResponse:
    """Replace one of the fixtures used by ``/verify-fixture``.

    The mobile client records a short clip via ``MediaRecorder`` and POSTs
    the resulting blob here as ``multipart/form-data`` (field name
    ``file``). The ``kind`` field selects which fixture to overwrite:

    * ``"submission"`` (default) — the claimer's "after" clip; consumed by
      Stage 2 on the next ``/verify-fixture`` call.
    * ``"request"`` — the poster's "before" clip; consumed by Stage 1.
      Overwriting it bumps the file's mtime, which invalidates the in-process
      ``GroundTruthSpec`` cache so the next verification re-extracts the
      spec from the new video.
    """

    kind = (kind or "submission").strip().lower()
    if kind not in _VALID_FIXTURE_KINDS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                f"Unknown kind={kind!r}; expected one of "
                f"{sorted(_VALID_FIXTURE_KINDS)}"
            ),
        )

    content_type = (file.content_type or "").lower()
    if content_type and not content_type.startswith("video/"):
        raise HTTPException(
            status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            detail=f"Expected a video upload, got content-type={content_type!r}",
        )

    request_path, submission_path = fixture_paths()
    target_path = Path(request_path if kind == "request" else submission_path)
    target_path.parent.mkdir(parents=True, exist_ok=True)

    bytes_written = 0
    tmp_path = target_path.with_suffix(target_path.suffix + ".part")
    try:
        with tmp_path.open("wb") as out:
            while True:
                chunk = await file.read(1024 * 1024)
                if not chunk:
                    break
                bytes_written += len(chunk)
                if bytes_written > _UPLOAD_MAX_BYTES:
                    raise HTTPException(
                        status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                        detail=(
                            f"Upload exceeded {_UPLOAD_MAX_BYTES} bytes; "
                            "shorten the clip or raise FIXTURE_UPLOAD_MAX_BYTES."
                        ),
                    )
                out.write(chunk)
        if bytes_written == 0:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Empty upload; recording produced no bytes.",
            )
        shutil.move(str(tmp_path), str(target_path))
    except HTTPException:
        if tmp_path.exists():
            tmp_path.unlink(missing_ok=True)
        raise
    except Exception as exc:  # pragma: no cover - defensive
        if tmp_path.exists():
            tmp_path.unlink(missing_ok=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to write fixture: {exc}",
        ) from exc
    finally:
        await file.close()

    return FixtureUploadResponse(
        kind=kind,
        saved_path=str(target_path),
        bytes_written=bytes_written,
        content_type=file.content_type,
    )
