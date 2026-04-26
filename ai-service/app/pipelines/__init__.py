"""Video verification pipelines (canonical Stage 1 + Stage 2).

Stage 1 (no LLM, posting time):

* ``spec_pipeline`` -- runs broad-prompt Grounding DINO + the IoU tracker on a
  requester's reference video to produce a :class:`SpecCandidateSet`. The
  requester reviews + corrects, and ``build_ground_truth_spec`` converts the
  edits into a :class:`GroundTruthSpec` persisted on the bounty.

Stage 2 (submission time):

* ``submission_pipeline`` -- runs DINO with the spec-derived prompt on the
  submission video, IoU-tracks into unique objects, crops evidence per object,
  validates each via LLM, and matches validated objects back to the spec.

Legacy (pre-Stage-2):

* ``cleanup_pipeline``  -- Person B. Compares a reference video to the
  cleaner's submission video plus DINO outputs and produces a
  :class:`CleanupVerdict`.
* ``disposal_pipeline`` -- standalone LLM check that the cleaner actually
  deposited trash into a bin. Produces a :class:`DisposalVerdict`.

"""

from app.pipelines.cleanup_pipeline import CleanupVerdict, ItemResolution, run_cleanup_pipeline
from app.pipelines.dino_adapter import build_dino_output_from_video
from app.pipelines.dino_types import Bbox, Detection, DinoOutput, FrameDetections
from app.pipelines.disposal_pipeline import DisposalVerdict, run_disposal_pipeline
from app.pipelines.spec_pipeline import (
    GroundTruthSpec,
    ManualSpecItemDraft,
    SpecBbox,
    SpecCandidate,
    SpecCandidateSet,
    SpecConfirmRequest,
    SpecItem,
    SpecPreviewFrame,
    build_ground_truth_spec,
    extract_spec_candidates,
)
from app.pipelines.submission_pipeline import (
    LLMObjectVerdict,
    ObjectCrop,
    SpecMatchResult,
    Stage2FinalVerdict,
    Stage2Result,
    SubmissionObject,
    run_stage2_pipeline,
)

__all__ = [
    "Bbox",
    "CleanupVerdict",
    "Detection",
    "DinoOutput",
    "DisposalVerdict",
    "FrameDetections",
    "GroundTruthSpec",
    "ItemResolution",
    "LLMObjectVerdict",
    "ManualSpecItemDraft",
    "ObjectCrop",
    "SpecBbox",
    "SpecCandidate",
    "SpecCandidateSet",
    "SpecConfirmRequest",
    "SpecItem",
    "SpecMatchResult",
    "SpecPreviewFrame",
    "Stage2FinalVerdict",
    "Stage2Result",
    "SubmissionObject",
    "build_dino_output_from_video",
    "build_ground_truth_spec",
    "extract_spec_candidates",
    "run_cleanup_pipeline",
    "run_disposal_pipeline",
    "run_stage2_pipeline",
]
