"""Adapter that runs the merged detector and produces a :class:`DinoOutput`.

Person 3A's ``app.object_detection`` exposes high-level helpers that return
aggregate ``DetectionSummary`` objects (counts only). The LLM pipelines need
per-frame bounding boxes, so this adapter goes one level deeper: it samples
frames itself and calls the per-frame detection primitives (
``_detect_objects_grounding_dino`` for Grounding DINO via Replicate) and
packs the result into the :class:`DinoOutput` contract every pipeline expects.

This way the pipelines stay backend-agnostic: pass ``dino`` directly if you
already have a payload, otherwise pass a video and let
:func:`build_dino_output_from_video` produce one.
"""

from __future__ import annotations

import asyncio
import logging
from collections import Counter
from pathlib import Path
from tempfile import NamedTemporaryFile
from typing import TypeAlias
from urllib.parse import urlparse

import cv2
import httpx

from app.config import Settings, get_settings
from app.object_detection import (
    _detect_objects_grounding_dino,
)
from app.pipelines.dino_types import (
    Bbox,
    Detection,
    DinoOutput,
    FrameDetections,
)

logger = logging.getLogger(__name__)

VideoSource: TypeAlias = "str | Path | bytes"

# Lower-level sampling default: detect on every Nth frame so we get a handful
# of detections per video without paying for a per-frame inference pass. The
# pipelines later down-sample to ``PIPELINE_FRAMES_PER_VIDEO`` for the LLM call.
DEFAULT_SAMPLE_EVERY = 30
DEFAULT_MAX_SAMPLES = 12


def _looks_like_url(value: str) -> bool:
    parsed = urlparse(value)
    return parsed.scheme in {"http", "https"} and bool(parsed.netloc)


async def _download_to_tempfile(url: str) -> Path:
    parsed = urlparse(url)
    name = Path(parsed.path).name or "remote_video"
    suffix = Path(name).suffix or ".mp4"
    with NamedTemporaryFile(delete=False, suffix=suffix, prefix="dino-") as tmp:
        temp_path = Path(tmp.name)
    try:
        async with httpx.AsyncClient(timeout=60.0, follow_redirects=True) as client:
            response = await client.get(url)
            response.raise_for_status()
            temp_path.write_bytes(response.content)
    except Exception:
        logger.warning("dino_adapter_download_failed url=%s", url)
        temp_path.write_bytes(b"")
    return temp_path


async def _normalize_to_local_file(video: VideoSource) -> tuple[Path, bool]:
    """Return (local path, caller_should_delete)."""
    if isinstance(video, bytes):
        with NamedTemporaryFile(delete=False, suffix=".mp4", prefix="dino-") as tmp:
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


def _xyxy_to_bbox(box: tuple[int, int, int, int], width: int, height: int) -> Bbox | None:
    """Convert a (x1,y1,x2,y2) tuple to a clamped :class:`Bbox`.

    Returns ``None`` for degenerate boxes; the pipelines tolerate empty
    detections, so dropping them is safer than fabricating zero-size shapes.
    """

    x1, y1, x2, y2 = box
    x1 = max(0, min(width, int(x1)))
    y1 = max(0, min(height, int(y1)))
    x2 = max(0, min(width, int(x2)))
    y2 = max(0, min(height, int(y2)))
    w = x2 - x1
    h = y2 - y1
    if w <= 0 or h <= 0:
        return None
    return Bbox(x=float(x1), y=float(y1), w=float(w), h=float(h))


def _sample_frames_sync(
    video_path: Path,
    sample_every: int,
    max_samples: int,
) -> tuple[list[tuple[int, float, "cv2.Mat"]], int, int, float, float]:
    """Pull (frame_idx, timestamp_s, frame_bgr) tuples from the video.

    Returns the samples plus video metadata (width, height, fps, duration_s).
    """

    cap = cv2.VideoCapture(str(video_path))
    if not cap.isOpened():
        raise ValueError(f"cv2 could not open video: {video_path}")
    try:
        fps = cap.get(cv2.CAP_PROP_FPS) or 0.0
        width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
        height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
        total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
        duration = total / fps if fps > 0 else 0.0
        samples: list[tuple[int, float, "cv2.Mat"]] = []
        frame_idx = 0
        while cap.isOpened() and len(samples) < max_samples:
            ok, frame = cap.read()
            if not ok:
                break
            if frame_idx % max(1, sample_every) == 0:
                ts = frame_idx / fps if fps > 0 else float(len(samples))
                if width == 0 or height == 0:
                    h, w = frame.shape[:2]
                    width, height = w, h
                samples.append((frame_idx, ts, frame))
            frame_idx += 1
        return samples, width, height, fps, duration
    finally:
        cap.release()


async def _detect_with_grounding_dino(
    samples: list[tuple[int, float, "cv2.Mat"]],
    *,
    width: int,
    height: int,
    settings: Settings,
) -> list[FrameDetections]:
    """Grounding DINO per-frame detection via Replicate."""

    out: list[FrameDetections] = []
    for sampled_idx, (_orig_idx, ts, frame) in enumerate(samples):
        try:
            raw = await _detect_objects_grounding_dino(
                frame,
                query=settings.cleanup_target_query,
                model=settings.grounding_dino_model,
                box_threshold=settings.grounding_dino_box_threshold,
                text_threshold=settings.grounding_dino_text_threshold,
            )
        except Exception:
            logger.warning("grounding_dino_failed sampled_idx=%d", sampled_idx)
            raw = []
        detections: list[Detection] = []
        for label, conf, box in raw:
            bbox = _xyxy_to_bbox(box, width, height)
            if bbox is None:
                continue
            detections.append(
                Detection(label=label, confidence=float(conf), bbox=bbox)
            )
        out.append(
            FrameDetections(
                timestamp_s=round(ts, 3),
                frame_index=sampled_idx,
                detections=detections,
            )
        )
    return out


async def build_dino_output_from_video(
    video: VideoSource,
    *,
    settings: Settings | None = None,
    sample_every: int = DEFAULT_SAMPLE_EVERY,
    max_samples: int = DEFAULT_MAX_SAMPLES,
) -> DinoOutput:
    """Run object detection on a video and return a :class:`DinoOutput`.

    This adapter is Grounding-DINO only.
    """

    settings = settings or get_settings()
    backend = settings.vision_detector_backend.lower().strip()
    if backend != "grounding_dino":
        logger.warning(
            "dino_adapter_forcing_grounding_dino configured_backend=%s", backend
        )

    path, cleanup = await _normalize_to_local_file(video)
    try:
        samples, width, height, _fps, duration = await asyncio.to_thread(
            _sample_frames_sync, path, sample_every, max_samples
        )
        if not samples:
            return DinoOutput(
                video_url=str(video) if not isinstance(video, bytes) else "<bytes>",
                duration_s=duration,
                width=max(1, width),
                height=max(1, height),
                frames=[],
                summary={},
            )

        frames = await _detect_with_grounding_dino(
            samples, width=width, height=height, settings=settings
        )

        summary: Counter[str] = Counter()
        for frame in frames:
            for det in frame.detections:
                summary[det.label] += 1

        return DinoOutput(
            video_url=str(video) if not isinstance(video, bytes) else "<bytes>",
            duration_s=duration,
            width=max(1, width),
            height=max(1, height),
            frames=frames,
            summary=dict(summary),
        )
    finally:
        if cleanup:
            try:
                path.unlink(missing_ok=True)
            except OSError:
                logger.warning("dino_adapter_temp_cleanup_failed path=%s", path)
