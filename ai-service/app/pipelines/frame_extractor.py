"""Pull a small set of evenly-spaced frames from a video URL or local path.

The LLM only needs a handful of frames per video (cost knob =
``PIPELINE_FRAMES_PER_VIDEO``). We pick them deterministically: first, last,
and N-2 spaced through the middle. This keeps the prompt size predictable
and ensures the same input always yields the same frames -- handy for tests
and for matching back against DINO frames by index/timestamp.
"""

from __future__ import annotations

import asyncio
import base64
import logging
from dataclasses import dataclass
from pathlib import Path
from tempfile import NamedTemporaryFile
from typing import TypeAlias
from urllib.parse import urlparse

import cv2
import httpx
import numpy as np

logger = logging.getLogger(__name__)

VideoSource: TypeAlias = "str | Path | bytes"


@dataclass
class ExtractedFrame:
    """One frame plus metadata the pipelines need.

    * ``timestamp_s`` lines up with DINO's ``timestamp_s`` so we can match a
      detection's frame to the corresponding rendered preview.
    * ``frame_index`` is the index inside *this* extraction (0..N-1), not the
      raw video frame index.
    * ``image_bgr`` is the OpenCV array, kept around for the annotator (it
      mutates a copy, never the original).
    * ``jpeg_b64`` is the encoded JPEG (base64, no ``data:`` prefix) ready to
      hand to :class:`~app.pipelines.llm_client.OpenAIPipelineClient`.
    """

    timestamp_s: float
    frame_index: int
    image_bgr: np.ndarray
    jpeg_b64: str
    width: int
    height: int


# --- URL/path normalization ---------------------------------------------- #


def _looks_like_url(value: str) -> bool:
    parsed = urlparse(value)
    return parsed.scheme in {"http", "https"} and bool(parsed.netloc)


async def _download_to_tempfile(url: str) -> Path:
    parsed = urlparse(url)
    name = Path(parsed.path).name or "remote_video"
    suffix = Path(name).suffix or ".mp4"
    with NamedTemporaryFile(delete=False, suffix=suffix, prefix="pipeline-") as tmp:
        temp_path = Path(tmp.name)
    try:
        async with httpx.AsyncClient(timeout=60.0, follow_redirects=True) as client:
            response = await client.get(url)
            response.raise_for_status()
            temp_path.write_bytes(response.content)
    except Exception:
        # Tests/dev shouldn't blow up just because the URL is unreachable.
        # Downstream extraction will raise FrameExtractionError if needed.
        logger.warning("video_download_failed url=%s", url)
        temp_path.write_bytes(b"")
    return temp_path


async def _normalize_to_local_file(video: VideoSource) -> tuple[Path, bool]:
    """Return (local path, caller_should_delete)."""
    if isinstance(video, bytes):
        with NamedTemporaryFile(delete=False, suffix=".mp4", prefix="pipeline-") as tmp:
            tmp.write(video)
            return Path(tmp.name), True
    if isinstance(video, Path):
        if not video.exists():
            raise FileNotFoundError(f"video path does not exist: {video}")
        return video, False
    text = str(video)
    if _looks_like_url(text):
        return await _download_to_tempfile(text), True
    path = Path(text)
    if not path.exists():
        raise FileNotFoundError(f"video path does not exist: {path}")
    return path, False


# --- Frame extraction ---------------------------------------------------- #


class FrameExtractionError(RuntimeError):
    """Raised when OpenCV cannot read enough frames from the video."""


def _evenly_spaced_indices(total_frames: int, n: int) -> list[int]:
    """Pick ``n`` integer indices evenly spaced over ``[0, total_frames-1]``.

    For ``n == 1`` we return the middle frame; for ``n >= 2`` the first and
    last are always included so we have proper start/end coverage.
    """

    if total_frames <= 0:
        return []
    if n <= 0:
        return []
    if total_frames <= n:
        return list(range(total_frames))
    if n == 1:
        return [total_frames // 2]
    step = (total_frames - 1) / (n - 1)
    return [int(round(i * step)) for i in range(n)]


def _encode_jpeg_b64(image_bgr: np.ndarray) -> str:
    ok, buffer = cv2.imencode(".jpg", image_bgr, [int(cv2.IMWRITE_JPEG_QUALITY), 85])
    if not ok:
        raise FrameExtractionError("cv2.imencode failed for extracted frame")
    return base64.b64encode(buffer.tobytes()).decode("ascii")


def _extract_sync(video_path: Path, frames_per_video: int) -> list[ExtractedFrame]:
    cap = cv2.VideoCapture(str(video_path))
    if not cap.isOpened():
        raise FrameExtractionError(f"cv2 could not open video: {video_path}")
    try:
        total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
        fps = cap.get(cv2.CAP_PROP_FPS) or 0.0
        if total_frames <= 0:
            # Fall back to reading the stream until exhausted.
            frames: list[np.ndarray] = []
            while True:
                ok, frame = cap.read()
                if not ok:
                    break
                frames.append(frame)
            total_frames = len(frames)
            if total_frames == 0:
                raise FrameExtractionError(
                    f"video had zero readable frames: {video_path}"
                )
            indices = _evenly_spaced_indices(total_frames, frames_per_video)
            extracted = []
            for new_idx, src_idx in enumerate(indices):
                image = frames[src_idx]
                ts = src_idx / fps if fps > 0 else 0.0
                h, w = image.shape[:2]
                extracted.append(
                    ExtractedFrame(
                        timestamp_s=round(ts, 3),
                        frame_index=new_idx,
                        image_bgr=image,
                        jpeg_b64=_encode_jpeg_b64(image),
                        width=w,
                        height=h,
                    )
                )
            return extracted

        indices = _evenly_spaced_indices(total_frames, frames_per_video)
        extracted: list[ExtractedFrame] = []
        for new_idx, src_idx in enumerate(indices):
            cap.set(cv2.CAP_PROP_POS_FRAMES, float(src_idx))
            ok, frame = cap.read()
            if not ok or frame is None:
                continue
            ts = src_idx / fps if fps > 0 else 0.0
            h, w = frame.shape[:2]
            extracted.append(
                ExtractedFrame(
                    timestamp_s=round(ts, 3),
                    frame_index=new_idx,
                    image_bgr=frame,
                    jpeg_b64=_encode_jpeg_b64(frame),
                    width=w,
                    height=h,
                )
            )
        if not extracted:
            raise FrameExtractionError(f"no frames decoded from video: {video_path}")
        return extracted
    finally:
        cap.release()


async def extract_frames(
    video: VideoSource,
    *,
    frames_per_video: int,
) -> list[ExtractedFrame]:
    """Extract ``frames_per_video`` evenly-spaced frames from any video source."""

    path, cleanup = await _normalize_to_local_file(video)
    try:
        return await asyncio.to_thread(_extract_sync, path, frames_per_video)
    finally:
        if cleanup:
            try:
                path.unlink(missing_ok=True)
            except OSError:
                logger.warning("temp_video_cleanup_failed path=%s", path)


def make_placeholder_frames(
    frames_per_video: int,
    *,
    width: int = 320,
    height: int = 240,
    label: str = "stub",
) -> list[ExtractedFrame]:
    """Generate deterministic blank frames for stub mode + tests.

    The image is a solid mid-grey JPEG with the label burned in so a human
    eyeballing the prompt payload can tell it's a placeholder. We never use
    these in production -- only when ``PIPELINE_USE_STUB=true`` or in unit
    tests that want to skip OpenCV entirely.
    """

    extracted: list[ExtractedFrame] = []
    for i in range(max(1, frames_per_video)):
        image = np.full((height, width, 3), 128, dtype=np.uint8)
        cv2.putText(
            image,
            f"{label} #{i}",
            (10, height // 2),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.7,
            (255, 255, 255),
            2,
        )
        extracted.append(
            ExtractedFrame(
                timestamp_s=float(i),
                frame_index=i,
                image_bgr=image,
                jpeg_b64=_encode_jpeg_b64(image),
                width=width,
                height=height,
            )
        )
    return extracted
