"""Person B pipeline: compare reference vs submission video to verify cleanup.

The full demo flow is:

1. Run DINO on the cleaner's submission video (independently of the
   requester's data) and feed it through the SAME LLM analysis pipeline
   used by Person A to produce a *submission spec* that describes what
   the LLM thinks is in the cleaner's video.
2. Hand the comparison LLM both videos (annotated frames), both DINO
   outputs, and both pipeline specs (Person A's ``ReferenceSpec`` plus
   the cleaner's submission spec) and ask whether each spec item has
   actually been resolved.

This isolates the two analyses so the cleaner's spec is never biased by
the reference data, then merges them at the comparison step. The output
maps cleanly onto :class:`app.models.TaskCompleteResult` when this
pipeline is wired into ``/verify``.
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
from app.pipelines.reference_pipeline import ReferenceSpec, run_reference_pipeline

logger = logging.getLogger(__name__)


# --- Output schema -------------------------------------------------------- #


class ItemResolution(BaseModel):
    """Per-item verdict from the LLM."""

    item_id: str = Field(min_length=1)
    still_present: bool
    confidence: float = Field(ge=0.0, le=1.0)
    notes: str = Field(default="")


class CleanupVerdict(BaseModel):
    """Final verdict for the comparison.

    ``submission_spec`` is the cleaner's *independent* pipeline output --
    the LLM's analysis of the after-video as if it were a fresh bounty.
    The comparison LLM saw both this and Person A's ``ReferenceSpec``.
    It is attached post-call (the LLM never produces it directly) so the
    caller can inspect what the cleaner's pipeline detected without a
    second round-trip.
    """

    cleanup_complete: bool
    confidence: float = Field(ge=0.0, le=1.0)
    items: list[ItemResolution]
    leftover_count: int = Field(ge=0)
    reasoning: str = Field(min_length=1)
    submission_spec: ReferenceSpec | None = Field(
        default=None,
        description="Cleaner's independent pipeline output (DINO + LLM, no reference data).",
    )

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
    "You receive TWO independent analyses of the same site:\n\n"
    "  - REFERENCE pipeline output: DINO detections + LLM-authored spec for "
    "the requester's BEFORE video. This is the ground truth list of items "
    "the cleaner was supposed to resolve.\n"
    "  - SUBMISSION pipeline output: DINO detections + LLM-authored spec "
    "for the cleaner's AFTER video. This was produced by the SAME pipeline "
    "with no knowledge of the reference -- it is the cleaner's video "
    "described on its own terms.\n\n"
    "You also receive annotated frames from both videos. Use the two "
    "pipeline outputs as your primary structured signal and the frames as "
    "visual evidence. For each item in the REFERENCE spec, decide whether "
    "it is still present in the AFTER video, then produce a final verdict.\n\n"
    "Return STRICT JSON matching this schema -- no prose, no markdown:\n"
    "{\n"
    "  \"cleanup_complete\": bool,\n"
    "  \"confidence\": float in [0,1],\n"
    "  \"items\": [{\n"
    "    \"item_id\": str,         // must match an item_id from REFERENCE spec\n"
    "    \"still_present\": bool,\n"
    "    \"confidence\": float in [0,1],\n"
    "    \"notes\": str            // cite which pipeline output / frame supports the call\n"
    "  }],\n"
    "  \"leftover_count\": int,    // number of items still present\n"
    "  \"reasoning\": str          // 1-3 sentences referencing both pipeline outputs\n"
    "}\n"
    "Rules: cleanup_complete is true only if no REFERENCE spec items remain "
    "present in the AFTER video AND the SUBMISSION spec does not list new "
    "trash items that should also have been cleared. If after-frames are too "
    "dark/blurry to judge, set still_present=true with confidence < 0.5 and "
    "explain in notes. Do NOT include a submission_spec field in your output."
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


def _spec_payload_for_prompt(spec: ReferenceSpec) -> dict:
    """Strip annotated_frames_b64 (huge) before sending the spec into the prompt."""

    return {
        "site_summary": spec.site_summary,
        "items": [item.model_dump() for item in spec.items],
        "cleanup_success_criteria": spec.cleanup_success_criteria,
        "raw_dino_summary": spec.raw_dino_summary,
    }


def _build_request(
    *,
    reference_spec: ReferenceSpec,
    submission_spec: ReferenceSpec,
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
                "REFERENCE pipeline output (Person A) -- ground-truth spec",
                _spec_payload_for_prompt(reference_spec),
            ),
            render_json_block(
                "SUBMISSION pipeline output (cleaner) -- independent analysis of AFTER video",
                _spec_payload_for_prompt(submission_spec),
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
    submission_spec: ReferenceSpec | None = None,
    settings: Settings | None = None,
    client: OpenAIPipelineClient | None = None,
) -> CleanupVerdict:
    """Run the full Person B verification flow.

    Steps:

    1. Run the configured detector on each video (reference + submission)
       independently if a ``DinoOutput`` was not supplied.
    2. Run the SAME analysis pipeline used by Person A on the cleaner's
       submission video (with the cleaner's own DINO output and no
       reference data) to produce a *submission spec*. This is the
       cleaner's video described on its own terms.
    3. Hand the comparison LLM both videos (annotated frames), both DINO
       outputs, and BOTH pipeline specs. The LLM compares the two and
       decides whether each ``ReferenceSpec`` item has been resolved.

    Pre-computed values are accepted to avoid recompute when the caller
    already has them.
    """

    settings = settings or get_settings()
    client = client or OpenAIPipelineClient(settings)
    pipeline_use_stub = getattr(settings, "pipeline_use_stub", False)
    pipeline_frames = getattr(settings, "pipeline_frames_per_video", 5)

    # 1) DINO on each video, INDEPENDENTLY.
    if not pipeline_use_stub:
        if reference_dino is None:
            reference_dino = await build_dino_output_from_video(
                reference_video, settings=settings
            )
        if submission_dino is None:
            submission_dino = await build_dino_output_from_video(
                submission_video, settings=settings
            )

    # 2) Submission goes through the SAME analysis pipeline as Person A,
    #    using only its own video + DINO. No reference leakage here.
    if submission_spec is None:
        submission_spec = await run_reference_pipeline(
            video=submission_video,
            dino=submission_dino,
            settings=settings,
            client=client,
        )

    if pipeline_use_stub:
        # Stub mode is offline -- fall back to empty DINO so the heuristic still runs.
        empty = DinoOutput(
            video_url="<stub>",
            duration_s=0.0,
            width=1,
            height=1,
            frames=[],
            summary={},
        )
        verdict = _stub_verdict(reference_spec, submission_dino or empty)
        return verdict.model_copy(update={"submission_spec": submission_spec})

    assert reference_dino is not None and submission_dino is not None

    # 3) Comparison LLM call. Sees both videos + both DINOs + both specs.
    ref_frames_raw = await extract_frames(
        reference_video, frames_per_video=pipeline_frames
    )
    sub_frames_raw = await extract_frames(
        submission_video, frames_per_video=pipeline_frames
    )
    ref_frames = annotate_frames(ref_frames_raw, reference_dino.frames)
    sub_frames = annotate_frames(sub_frames_raw, submission_dino.frames)

    request = _build_request(
        reference_spec=reference_spec,
        submission_spec=submission_spec,
        ref_frames=ref_frames,
        sub_frames=sub_frames,
        ref_dino=reference_dino,
        sub_dino=submission_dino,
    )
    verdict = await client.call_json(
        request,
        CleanupVerdict,
        stub_factory=lambda: _stub_verdict(reference_spec, submission_dino),
    )
    # Attach the cleaner's pipeline output post-hoc; the LLM never produces it.
    return verdict.model_copy(update={"submission_spec": submission_spec})
