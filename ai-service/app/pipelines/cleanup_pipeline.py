"""Person B pipeline: compare reference vs submission video to verify cleanup.

Inputs (per the demo flow):

* Reference video URL + reference DINO output + the persisted ``ReferenceSpec``
  produced by :mod:`app.pipelines.reference_pipeline` when Person A posted.
* Submission video URL + submission DINO output (re-run of the detector on
  the cleaner's after-video).

The LLM is given annotated frames from both videos plus the spec items; it
must mark each item as still present or resolved and produce a final
``cleanup_complete`` verdict with a short reasoning string. The output maps
cleanly onto :class:`app.models.TaskCompleteResult` when this pipeline is
later wired into ``/verify``.
"""

from __future__ import annotations

import logging

from pydantic import BaseModel, Field, model_validator

from app.config import Settings, get_settings
from app.pipelines.annotator import annotate_frames
from app.pipelines.dino_adapter import build_dino_output_from_video
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
from app.pipelines.reference_pipeline import ReferenceSpec

logger = logging.getLogger(__name__)


# --- Output schema -------------------------------------------------------- #


class ItemResolution(BaseModel):
    """Per-item verdict from the LLM."""

    item_id: str = Field(min_length=1)
    still_present: bool
    confidence: float = Field(ge=0.0, le=1.0)
    notes: str = Field(default="")


class CleanupVerdict(BaseModel):
    """Final verdict for the comparison."""

    cleanup_complete: bool
    confidence: float = Field(ge=0.0, le=1.0)
    items: list[ItemResolution]
    leftover_count: int = Field(ge=0)
    reasoning: str = Field(min_length=1)

    @model_validator(mode="after")
    def _enforce_count_consistency(self) -> "CleanupVerdict":
        # Defensive: if the model says cleanup_complete but lists leftovers,
        # trust the leftovers and flip the verdict. Cheaper than a retry.
        leftovers_in_items = sum(1 for item in self.items if item.still_present)
        if leftovers_in_items > 0 and self.cleanup_complete:
            object.__setattr__(self, "cleanup_complete", False)
            object.__setattr__(self, "leftover_count", max(self.leftover_count, leftovers_in_items))
        return self


# --- Prompt --------------------------------------------------------------- #


SYSTEM_PROMPT = (
    "You are a strict computer-vision verifier for a civic cleanup bounty. "
    "You receive: a list of items the cleaner was supposed to resolve, "
    "annotated 'before' frames showing the original mess, annotated 'after' "
    "frames from the cleaner's submission, and DINO summaries for both videos. "
    "Decide for each item whether it is still present in the after-frames, "
    "then produce a final verdict.\n\n"
    "Return STRICT JSON matching this schema -- no prose, no markdown:\n"
    "{\n"
    "  \"cleanup_complete\": bool,\n"
    "  \"confidence\": float in [0,1],\n"
    "  \"items\": [{\n"
    "    \"item_id\": str,         // must match an item from the spec\n"
    "    \"still_present\": bool,\n"
    "    \"confidence\": float in [0,1],\n"
    "    \"notes\": str\n"
    "  }],\n"
    "  \"leftover_count\": int,    // number of items still present\n"
    "  \"reasoning\": str          // 1-3 sentences\n"
    "}\n"
    "Rules: cleanup_complete is true only if no spec items remain present "
    "AND the after-frames don't show new trash that should also have been "
    "cleared. If after-frames are too dark/blurry to judge, set "
    "still_present=true with confidence < 0.5 and explain in notes."
)


def _frames_block(label: str, frames: list[ExtractedFrame], dino: DinoOutput) -> str:
    overview = [
        {
            "frame_index": frame.frame_index,
            "timestamp_s": frame.timestamp_s,
            "detections": [
                {
                    "label": det.label,
                    "confidence": round(det.confidence, 3),
                    "bbox": det.bbox.model_dump(),
                }
                for det in (
                    min(dino.frames, key=lambda d: abs(d.timestamp_s - frame.timestamp_s)).detections
                    if dino.frames
                    else []
                )
            ],
        }
        for frame in frames
    ]
    return render_json_block(f"{label} detections per extracted frame", overview)


def _build_request(
    *,
    spec: ReferenceSpec,
    ref_frames: list[ExtractedFrame],
    sub_frames: list[ExtractedFrame],
    ref_dino: DinoOutput,
    sub_dino: DinoOutput,
) -> LLMRequest:
    user_text = join_text_blocks(
        [
            (
                f"Compare {len(ref_frames)} 'before' frames against "
                f"{len(sub_frames)} 'after' frames. Both sets are listed below "
                "in the same order they appear as image attachments: BEFORE first, "
                "then AFTER."
            ),
            render_json_block(
                "ReferenceSpec items the cleaner was supposed to resolve",
                [item.model_dump() for item in spec.items],
            ),
            render_json_block("Reference DINO summary", ref_dino.summary),
            render_json_block("Submission DINO summary", sub_dino.summary),
            _frames_block("Reference (BEFORE)", ref_frames, ref_dino),
            _frames_block("Submission (AFTER)", sub_frames, sub_dino),
            "Reply with JSON only matching the schema in the system prompt.",
        ]
    )
    images = [VisionImage(data_b64=f.jpeg_b64) for f in ref_frames] + [
        VisionImage(data_b64=f.jpeg_b64) for f in sub_frames
    ]
    return LLMRequest(
        system_prompt=SYSTEM_PROMPT,
        user_text=user_text,
        images=images,
    )


def _stub_verdict(spec: ReferenceSpec, sub_dino: DinoOutput) -> CleanupVerdict:
    """Heuristic stub: an item is 'cleared' if its label dropped to 0 in the after-DINO."""
    items: list[ItemResolution] = []
    sub_summary = sub_dino.summary
    for spec_item in spec.items:
        sub_count = sub_summary.get(spec_item.label, 0)
        still_present = sub_count > 0
        items.append(
            ItemResolution(
                item_id=spec_item.item_id,
                still_present=still_present,
                confidence=0.85,
                notes=f"[STUB] sub_count={sub_count}, ref_estimate={spec_item.estimated_count}",
            )
        )
    leftover = sum(1 for item in items if item.still_present)
    return CleanupVerdict(
        cleanup_complete=leftover == 0,
        confidence=0.85 if leftover == 0 else 0.6,
        items=items or [
            ItemResolution(
                item_id="stub_no_items",
                still_present=False,
                confidence=0.5,
                notes="[STUB] spec had no items to verify",
            )
        ],
        leftover_count=leftover,
        reasoning=(
            f"[STUB] Heuristic comparison: {leftover} of {len(items) or 1} items "
            "appear to still be present based on DINO label drop."
        ),
    )


# --- Public entrypoint ---------------------------------------------------- #


async def run_cleanup_pipeline(
    *,
    reference_video: VideoSource,
    submission_video: VideoSource,
    reference_spec: ReferenceSpec,
    reference_dino: DinoOutput | None = None,
    submission_dino: DinoOutput | None = None,
    settings: Settings | None = None,
    client: OpenAIPipelineClient | None = None,
) -> CleanupVerdict:
    """Run the Person B cleanup comparison pipeline.

    DINO outputs are optional: if missing, the adapter runs the configured
    detector on each video. Pass them when you've already computed them
    upstream and want to avoid the second pass.
    """

    settings = settings or get_settings()
    client = client or OpenAIPipelineClient(settings)

    if not settings.pipeline_use_stub:
        if reference_dino is None:
            reference_dino = await build_dino_output_from_video(
                reference_video, settings=settings
            )
        if submission_dino is None:
            submission_dino = await build_dino_output_from_video(
                submission_video, settings=settings
            )

    if settings.pipeline_use_stub:
        # Stub mode is offline -- fall back to empty DINO so the heuristic still runs.
        empty = DinoOutput(
            video_url="<stub>",
            duration_s=0.0,
            width=1,
            height=1,
            frames=[],
            summary={},
        )
        return _stub_verdict(reference_spec, submission_dino or empty)

    assert reference_dino is not None and submission_dino is not None
    ref_frames_raw = await extract_frames(
        reference_video, frames_per_video=settings.pipeline_frames_per_video
    )
    sub_frames_raw = await extract_frames(
        submission_video, frames_per_video=settings.pipeline_frames_per_video
    )
    ref_frames = annotate_frames(ref_frames_raw, reference_dino.frames)
    sub_frames = annotate_frames(sub_frames_raw, submission_dino.frames)

    request = _build_request(
        spec=reference_spec,
        ref_frames=ref_frames,
        sub_frames=sub_frames,
        ref_dino=reference_dino,
        sub_dino=submission_dino,
    )
    return await client.call_json(
        request,
        CleanupVerdict,
        stub_factory=lambda: _stub_verdict(reference_spec, submission_dino),
    )
