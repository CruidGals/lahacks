"""LLM-powered video verification pipelines.

Three standalone pipelines, each callable in isolation for testing:

* ``reference_pipeline``  -- Person A. Annotates a posted bounty video with the
  detected trash items and asks the LLM to write a parseable
  :class:`~app.pipelines.reference_pipeline.ReferenceSpec`.
* ``cleanup_pipeline``    -- Person B. Compares a "before" reference video to
  the cleaner's "after" submission video plus both DINO outputs and produces a
  :class:`~app.pipelines.cleanup_pipeline.CleanupVerdict`.
* ``disposal_pipeline``   -- LLM-only sanity check that the cleaner actually
  deposited trash into a bin. Produces a
  :class:`~app.pipelines.disposal_pipeline.DisposalVerdict`.

All three share :mod:`app.pipelines.llm_client` so swapping models or running
in offline ``PIPELINE_USE_STUB=true`` mode is a single-flag change.
"""

from app.pipelines.cleanup_pipeline import CleanupVerdict, ItemResolution, run_cleanup_pipeline
from app.pipelines.dino_types import Bbox, Detection, DinoOutput, FrameDetections
from app.pipelines.disposal_pipeline import DisposalVerdict, run_disposal_pipeline
from app.pipelines.reference_pipeline import ReferenceSpec, TrashItem, run_reference_pipeline

__all__ = [
    "Bbox",
    "CleanupVerdict",
    "Detection",
    "DinoOutput",
    "DisposalVerdict",
    "FrameDetections",
    "ItemResolution",
    "ReferenceSpec",
    "TrashItem",
    "run_cleanup_pipeline",
    "run_disposal_pipeline",
    "run_reference_pipeline",
]
