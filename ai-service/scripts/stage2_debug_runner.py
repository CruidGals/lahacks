"""Run Stage 2 debug flow: spec-prompted DINO + IoU tracking + crop + LLM validation.

Assumes Stage 1 has already been run and a GroundTruthSpec can be derived from
the request video.  This script runs both Stage 1 (to get the spec) and then
Stage 2 (against the submission video) so you get an end-to-end local debug
loop with a single invocation.

All output goes to artifacts/video-debug-runs/<timestamp>/.
"""

from __future__ import annotations

import asyncio
import base64
import time
from datetime import datetime
from pathlib import Path

from app.config import Settings
from app.object_detection import annotate_video_grounding_dino
from app.pipelines.spec_pipeline import (
    SpecConfirmRequest,
    build_ground_truth_spec,
    extract_spec_candidates,
)
from app.pipelines.submission_pipeline import run_stage2_pipeline

REQUEST_VIDEO = Path("/Users/kylechiem/Documents/lahacks/data/videos/fixtures/egRequest.MOV")
SUBMISSION_VIDEO = Path("/Users/kylechiem/Documents/lahacks/data/videos/fixtures/egUserPost.MOV")

SAMPLE_EVERY_N_FRAMES = 120
MAX_SAMPLES = 100000


def _save_crops(run_dir: Path, result) -> None:
    """Write crop JPEGs to disk for visual inspection."""
    crops_dir = run_dir / "crops"
    crops_dir.mkdir(exist_ok=True)
    for obj in result.objects:
        for crop in obj.crops:
            filename = f"{obj.object_id}_frame{crop.frame_index}.jpg"
            (crops_dir / filename).write_bytes(base64.b64decode(crop.jpeg_b64))


async def main() -> None:
    settings = Settings(vision_detector_backend="grounding_dino", pipeline_use_stub=False)

    if not REQUEST_VIDEO.exists():
        raise FileNotFoundError(f"Missing request video: {REQUEST_VIDEO}")
    if not SUBMISSION_VIDEO.exists():
        raise FileNotFoundError(f"Missing submission video: {SUBMISSION_VIDEO}")
    if not settings.openai_api_key:
        raise RuntimeError(
            "OPENAI_API_KEY is required for Stage 2 real-data mode. "
            "Set it in ai-service/.env or your environment."
        )

    run_stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    run_dir = Path("/Users/leolu/Desktop/VScode/lahacks/artifacts/video-debug-runs") / run_stamp
    run_dir.mkdir(parents=True, exist_ok=True)

    # --- Stage 1: derive spec from request video ---
    print("=" * 60)
    print("STAGE 1: Deriving GroundTruthSpec from request video")
    print("=" * 60)

    stage1_start = time.perf_counter()
    candidate_set = await extract_spec_candidates(str(REQUEST_VIDEO), settings=settings)
    stage1_elapsed = time.perf_counter() - stage1_start

    confirm_request = SpecConfirmRequest(
        candidate_set=candidate_set,
        removed_candidate_ids=[],
        manual_items=[],
    )
    spec = build_ground_truth_spec(confirm_request)

    print(f"stage1_elapsed_seconds={stage1_elapsed:.3f}")
    print(f"spec_items={len(spec.items)}")
    print(f"spec_categories={spec.categories}")
    print(f"stage2_dino_prompt={spec.stage2_dino_prompt()!r}")
    for item in spec.items:
        print(f"  {item.item_id}: {item.label} (conf={item.confidence}, source={item.source})")

    spec_path = run_dir / "ground_truth_spec.json"
    spec_path.write_text(spec.model_dump_json(indent=2))
    print(f"spec_saved={spec_path}")

    # DINO overlays for both request + submission videos (real detections only).
    print()
    print("Generating request/submission DINO overlay videos...")
    request_overlay_path = run_dir / "request_stage1_dino_overlay.mp4"
    submission_overlay_path = run_dir / "submission_stage2_dino_overlay.mp4"
    await annotate_video_grounding_dino(
        REQUEST_VIDEO,
        request_overlay_path,
        query=candidate_set.broad_prompt.replace(" . ", ", "),
        model=settings.grounding_dino_model,
        box_threshold=settings.grounding_dino_box_threshold,
        text_threshold=settings.grounding_dino_text_threshold,
        sample_every_n_frames=SAMPLE_EVERY_N_FRAMES,
        max_frames=MAX_SAMPLES,
        persist_frames=SAMPLE_EVERY_N_FRAMES,
    )
    await annotate_video_grounding_dino(
        SUBMISSION_VIDEO,
        submission_overlay_path,
        query=spec.stage2_dino_prompt(),
        model=settings.grounding_dino_model,
        box_threshold=settings.grounding_dino_box_threshold,
        text_threshold=settings.grounding_dino_text_threshold,
        sample_every_n_frames=SAMPLE_EVERY_N_FRAMES,
        max_frames=MAX_SAMPLES,
        persist_frames=SAMPLE_EVERY_N_FRAMES,
    )
    print(f"request_overlay_video_path={request_overlay_path}")
    print(f"submission_overlay_video_path={submission_overlay_path}")

    # --- Stage 2: run submission pipeline ---
    print()
    print("=" * 60)
    print("STAGE 2: Running submission pipeline")
    print("=" * 60)

    stage2_start = time.perf_counter()
    result = await run_stage2_pipeline(
        str(SUBMISSION_VIDEO),
        spec,
        settings=settings,
    )
    stage2_elapsed = time.perf_counter() - stage2_start

    # Save result JSON
    result_path = run_dir / "stage2_result.json"
    result_no_crops = result.model_copy(deep=True)
    for obj in result_no_crops.objects:
        for crop in obj.crops:
            crop.jpeg_b64 = f"<{len(crop.jpeg_b64)} chars>"
    result_path.write_text(result_no_crops.model_dump_json(indent=2))

    # Save crop images
    _save_crops(run_dir, result)

    # Print summary
    print(f"samples_taken={result.samples_taken}")
    print(f"objects_tracked={result.objects_tracked}")
    print(f"objects_validated={result.objects_validated}")

    print()
    print("--- Tracked Objects ---")
    for obj in result.objects:
        verdict = obj.llm_verdict
        verdict_str = f"is_real={verdict.is_real}, reasoning={verdict.reasoning!r}" if verdict else "no_verdict"
        print(
            f"  {obj.object_id}: {obj.label} "
            f"(frames={obj.frames_detected}, peak_conf={obj.peak_confidence:.4f}, "
            f"crops={len(obj.crops)}, {verdict_str})"
        )

    print()
    print("--- Spec Matching ---")
    for m in result.match_results:
        status = f"MATCHED -> {m.matched_object_id} (conf={m.matched_confidence:.4f})" if m.matched else "UNMATCHED"
        print(f"  {m.item_id}: {m.label} => {status}")

    print()
    print(f"items_matched={result.items_matched}/{result.items_total}")
    print(
        "final_verdict="
        f"approved={result.final_verdict.approved}, "
        f"score={result.final_verdict.score:.4f}, "
        f"reason={result.final_verdict.reason!r}, "
        f"missing_labels={result.final_verdict.missing_labels}"
    )
    print(f"stage2_elapsed_seconds={stage2_elapsed:.3f}")
    print(f"total_elapsed_seconds={stage1_elapsed + stage2_elapsed:.3f}")
    print(f"artifacts_dir={run_dir}")


if __name__ == "__main__":
    asyncio.run(main())
