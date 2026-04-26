"""Person A pipeline: bounty poster's video + DINO output -> ReferenceSpec.

The poster (Person A) records a video of the trashed site. A DINO/OpenCV
object detector emits per-frame detections. This pipeline:

1. Extracts a small set of frames from the original video.
2. Draws DINO bounding boxes on each frame (also returned for the demo UI).
3. Asks the LLM to enumerate the discrete trash items the cleaner must
   resolve, plus a clear ``cleanup_success_criteria`` string.

Output is a :class:`ReferenceSpec` -- JSON-friendly so the backend can persist
it on the bounty record. Pipeline 2 (cleanup) consumes the ``items`` list to
verify each one was resolved.
"""

from __future__ import annotations

import logging

from pydantic import BaseModel, Field

from app.config import Settings, get_settings
from app.pipelines.annotator import annotate_frames
from app.pipelines.dino_types import DinoOutput
from app.pipelines.frame_extractor import (
    ExtractedFrame,
    VideoSource,
    extract_frames,
    make_placeholder_frames,
)
from app.pipelines.llm_client import (
    LLMRequest,
    OpenAIPipelineClient,
    VisionImage,
    join_text_blocks,
    render_json_block,
)

logger = logging.getLogger(__name__)


# --- Output schema -------------------------------------------------------- #


class TrashItem(BaseModel):
    """One discrete item the cleaner must resolve."""

    item_id: str = Field(min_length=1, description="Stable id reused by cleanup_pipeline.")
    description: str = Field(min_length=1)
    label: str = Field(min_length=1, description="Mirrors a DINO label when possible.")
    location_hint: str = Field(default="", description="Plain-language placement, e.g. 'near the bench'.")
    estimated_count: int = Field(ge=0)


class ReferenceSpec(BaseModel):
    """LLM-authored cleanup spec for one bounty.

    The hackathon demo persists this on the bounty record and renders
    ``annotated_frames_b64`` on the site detail page so the cleaner sees what
    was detected.
    """

    site_summary: str = Field(min_length=1)
    items: list[TrashItem]
    cleanup_success_criteria: str = Field(min_length=1)
    annotated_frames_b64: list[str] = Field(default_factory=list)
    raw_dino_summary: dict[str, int] = Field(default_factory=dict)


# --- Prompt --------------------------------------------------------------- #


SYSTEM_PROMPT = (
    "You are a strict computer-vision verifier for a civic cleanup bounty "
    "marketplace. You receive: (a) several frames of a trashed site already "
    "annotated with object-detector bounding boxes, and (b) a JSON summary "
    "of what the detector found. Your job is to consolidate detections into "
    "the discrete cleanup items a human cleaner must resolve, then write a "
    "ReferenceSpec for the cleaner to follow. "
    "Return STRICT JSON matching this schema -- no prose, no markdown:\n"
    "{\n"
    "  \"site_summary\": str,\n"
    "  \"items\": [{\n"
    "    \"item_id\": str,        // stable, lower_snake_case, unique\n"
    "    \"description\": str,\n"
    "    \"label\": str,          // mirror the detector label when possible\n"
    "    \"location_hint\": str,  // plain English placement\n"
    "    \"estimated_count\": int\n"
    "  }],\n"
    "  \"cleanup_success_criteria\": str\n"
    "}\n"
    "Rules: dedupe duplicate detections of the same physical object across "
    "frames. Group nearby small items into one entry with a count. Skip "
    "objects that aren't trash (people, vehicles, fixtures). Do not invent "
    "items the detector did not flag."
)


def _build_request(
    annotated_frames: list[ExtractedFrame],
    dino: DinoOutput,
) -> LLMRequest:
    detection_overview = [
        {
            "frame_index": frame.frame_index,
            "timestamp_s": frame.timestamp_s,
            "detections": [
                {
                    "label": det.label,
                    "confidence": round(det.confidence, 3),
                    "bbox": det.bbox.model_dump(),
                }
                for det in _detections_for_frame(frame, dino)
            ],
        }
        for frame in annotated_frames
    ]

    user_text = join_text_blocks(
        [
            (
                "Build the ReferenceSpec for this site. Each frame is "
                f"{annotated_frames[0].width}x{annotated_frames[0].height} "
                "with detector boxes already drawn."
            ),
            render_json_block(
                "DINO summary (label -> total detections across frames)",
                dino.summary,
            ),
            render_json_block(
                "Detections per extracted frame (timestamps in seconds)",
                detection_overview,
            ),
            "Respond with JSON only, matching the schema in the system prompt.",
        ]
    )

    images = [VisionImage(data_b64=frame.jpeg_b64) for frame in annotated_frames]
    return LLMRequest(
        system_prompt=SYSTEM_PROMPT,
        user_text=user_text,
        images=images,
    )


def _detections_for_frame(frame: ExtractedFrame, dino: DinoOutput):
    """Mirror annotator's nearest-timestamp matching for prompt metadata."""
    if not dino.frames:
        return []
    nearest = min(dino.frames, key=lambda d: abs(d.timestamp_s - frame.timestamp_s))
    return nearest.detections


def _stub_spec(dino: DinoOutput, annotated_frames: list[ExtractedFrame]) -> ReferenceSpec:
    """Deterministic ReferenceSpec used when ``PIPELINE_USE_STUB=true``.

    The stub only invents items when DINO actually saw something. An empty
    summary produces a single ``unknown`` placeholder so downstream pipelines
    still have *some* item to compare against and tests can assert on it.
    """

    summary = dino.summary
    items = [
        TrashItem(
            item_id=f"stub_{label}",
            description=f"Stub item for label {label}",
            label=label,
            location_hint="stubbed location",
            estimated_count=count,
        )
        for label, count in sorted(summary.items())
    ]
    if not items:
        items = [
            TrashItem(
                item_id="stub_unknown",
                description="No detections; stub default item",
                label="unknown",
                location_hint="stubbed location",
                estimated_count=0,
            )
        ]
    return ReferenceSpec(
        site_summary=f"[STUB] Site has {sum(summary.values())} detections",
        items=items,
        cleanup_success_criteria=(
            "Remove every item listed and confirm none remain in the after-video."
        ),
        annotated_frames_b64=[frame.jpeg_b64 for frame in annotated_frames],
        raw_dino_summary=dict(summary),
    )


# --- Public entrypoint ---------------------------------------------------- #


async def run_reference_pipeline(
    *,
    video: VideoSource,
    dino: DinoOutput,
    settings: Settings | None = None,
    client: OpenAIPipelineClient | None = None,
) -> ReferenceSpec:
    """Run the Person A pipeline end-to-end.

    ``video`` may be a URL, local Path, or raw bytes. ``dino`` is the
    structured detector output for the same video. The returned spec already
    has ``annotated_frames_b64`` populated for the demo UI.
    """

    settings = settings or get_settings()
    client = client or OpenAIPipelineClient(settings)

    if settings.pipeline_use_stub:
        # Stub mode: skip OpenCV + LLM entirely so tests + offline dev are fast.
        annotated = make_placeholder_frames(
            settings.pipeline_frames_per_video, label="ref"
        )
        return _stub_spec(dino, annotated)

    raw_frames = await extract_frames(
        video, frames_per_video=settings.pipeline_frames_per_video
    )
    annotated = annotate_frames(raw_frames, dino.frames)

    request = _build_request(annotated, dino)
    spec = await client.call_json(
        request,
        ReferenceSpec,
        stub_factory=lambda: _stub_spec(dino, annotated),
    )

    # The model never sees the b64 frames as fields, so we attach them after.
    return spec.model_copy(
        update={
            "annotated_frames_b64": [frame.jpeg_b64 for frame in annotated],
            "raw_dino_summary": dict(dino.summary),
        }
    )
