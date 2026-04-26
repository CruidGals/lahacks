"""Disposal proof pipeline: did the cleaner actually put trash into a bin?

Unlike the other two pipelines, this one does not consume DINO output. It is
deliberately small and fast: the cleaner records a short clip of themselves
depositing collected trash, and the LLM tells us whether they actually did so.
The flow:

1. Pull a few frames from the disposal video (default 3, capped at the global
   ``PIPELINE_FRAMES_PER_VIDEO`` so cost stays bounded).
2. Single OpenAI vision call with a tight prompt.
3. Validate the response into :class:`DisposalVerdict`.
"""

from __future__ import annotations

import logging

from pydantic import BaseModel, Field

from app.config import Settings, get_settings
from app.pipelines.frame_extractor import (
    VideoSource,
    extract_frames,
    make_placeholder_frames,
)
from app.pipelines.llm_client import (
    LLMRequest,
    OpenAIPipelineClient,
    VisionImage,
    join_text_blocks,
)

logger = logging.getLogger(__name__)


class DisposalVerdict(BaseModel):
    """LLM verdict for the disposal-proof video."""

    deposited_into_bin: bool
    confidence: float = Field(ge=0.0, le=1.0)
    container_type: str | None = Field(
        default=None,
        description="'trash can', 'dumpster', 'recycling bin', or null if uncertain.",
    )
    reasoning: str = Field(min_length=1)


SYSTEM_PROMPT = (
    "You are verifying a short proof-of-disposal video for a civic cleanup "
    "bounty. The cleaner is supposed to be visibly depositing the bag of "
    "collected trash into a public waste container (trash can, dumpster, "
    "recycling bin, etc.).\n\n"
    "You receive a few sequential frames from that clip. Decide whether the "
    "deposit actually happened. Be skeptical of staged/edited footage but do "
    "not require a perfect view -- partial occlusion is normal.\n\n"
    "Return STRICT JSON matching this schema -- no prose, no markdown:\n"
    "{\n"
    "  \"deposited_into_bin\": bool,\n"
    "  \"confidence\": float in [0,1],\n"
    "  \"container_type\": str | null,  // 'trash can' | 'dumpster' | 'recycling bin' | null\n"
    "  \"reasoning\": str               // 1-2 sentences\n"
    "}\n"
    "Set deposited_into_bin=false if no container is visible, or if the "
    "person never appears to release the bag/object into one."
)


def _disposal_frame_count(settings: Settings) -> int:
    # The disposal clip is short; clamp to a maximum of 3 frames to control cost.
    return max(1, min(3, getattr(settings, "pipeline_frames_per_video", 5)))


def _stub_verdict() -> DisposalVerdict:
    """Deterministic stub used in offline / test mode."""
    return DisposalVerdict(
        deposited_into_bin=True,
        confidence=0.8,
        container_type="trash can",
        reasoning="[STUB] Stub disposal verdict; LLM call skipped.",
    )


async def run_disposal_pipeline(
    *,
    video: VideoSource,
    settings: Settings | None = None,
    client: OpenAIPipelineClient | None = None,
) -> DisposalVerdict:
    """Verify disposal proof for a short video clip."""

    settings = settings or get_settings()
    client = client or OpenAIPipelineClient(settings)
    pipeline_use_stub = getattr(settings, "pipeline_use_stub", False)

    frame_count = _disposal_frame_count(settings)

    if pipeline_use_stub:
        # Touch the placeholder helper so import errors surface in tests too.
        _ = make_placeholder_frames(frame_count, label="disposal")
        return _stub_verdict()

    frames = await extract_frames(video, frames_per_video=frame_count)
    user_text = join_text_blocks(
        [
            (
                f"Here are {len(frames)} sequential frames of the cleaner's "
                "disposal clip. Decide whether the bag was deposited into a bin."
            ),
            "Reply with JSON only matching the schema in the system prompt.",
        ]
    )
    request = LLMRequest(
        system_prompt=SYSTEM_PROMPT,
        user_text=user_text,
        images=[VisionImage(data_b64=frame.jpeg_b64) for frame in frames],
    )
    return await client.call_json(
        request,
        DisposalVerdict,
        stub_factory=_stub_verdict,
    )
