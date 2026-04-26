"""Run Stage 1 debug flow with consistent output + overlay video.

This script is intentionally hardcoded for local debug iteration so you don't
have to keep asking for the same checks in chat.
"""

from __future__ import annotations

import asyncio
import time
from collections import Counter
from datetime import datetime
from pathlib import Path

from app.config import Settings
from app.object_detection import annotate_video_grounding_dino
from app.object_detection import summarize_video_objects_grounding_dino
from app.pipelines.spec_pipeline import _sample_and_detect, extract_spec_candidates

# Hardcoded local inputs for repeatable debug runs.
REQUEST_VIDEO = Path("/Users/kylechiem/Documents/lahacks/data/videos/fixtures/egRequest.MOV")
SUBMISSION_VIDEO = Path("/Users/kylechiem/Documents/lahacks/data/videos/fixtures/egUserPost.MOV")

# Keep these aligned with overlay cadence so Stage 1 + overlay are comparable.
SAMPLE_EVERY_N_FRAMES = 120
MAX_SAMPLES = 100000


def _format_label_counts(counter: Counter[str]) -> str:
    if not counter:
        return ""
    return ", ".join(f"{label}:{count}" for label, count in counter.items())


def _format_candidate_labels(labels: list[str]) -> str:
    return ", ".join(labels)


async def main() -> None:
    settings = Settings(vision_detector_backend="grounding_dino")

    if not REQUEST_VIDEO.exists():
        raise FileNotFoundError(f"Missing request video: {REQUEST_VIDEO}")

    # Stage 1 candidates timing + fields.
    stage1_start = time.perf_counter()
    sampled, per_frame, *_ = await _sample_and_detect(str(REQUEST_VIDEO), settings)

    raw_label_counts: Counter[str] = Counter()
    for detections in per_frame:
        for label, confidence, _bbox in detections:
            if confidence >= settings.grounding_dino_box_threshold:
                raw_label_counts[label] += 1

    candidate_set = await extract_spec_candidates(str(REQUEST_VIDEO), settings=settings)
    stage1_elapsed = time.perf_counter() - stage1_start

    # Overlay generation timing + path.
    run_stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    run_dir = Path("/Users/leolu/Desktop/VScode/lahacks/artifacts/video-debug-runs") / run_stamp
    run_dir.mkdir(parents=True, exist_ok=True)
    overlay_path = run_dir / "egRequest_stage1_overlay_debug.mp4"

    overlay_start = time.perf_counter()
    overlay_summary = await summarize_video_objects_grounding_dino(
        REQUEST_VIDEO,
        query="trash bag, bottle, tire, cardboard, mattress, debris, litter",
        model=settings.grounding_dino_model,
        box_threshold=settings.grounding_dino_box_threshold,
        text_threshold=settings.grounding_dino_text_threshold,
        sample_every_n_frames=SAMPLE_EVERY_N_FRAMES,
        max_frames=max(1, 100000 // max(1, SAMPLE_EVERY_N_FRAMES)),
    )
    await annotate_video_grounding_dino(
        REQUEST_VIDEO,
        overlay_path,
        query="trash bag, bottle, tire, cardboard, mattress, debris, litter",
        model=settings.grounding_dino_model,
        box_threshold=settings.grounding_dino_box_threshold,
        text_threshold=settings.grounding_dino_text_threshold,
        sample_every_n_frames=SAMPLE_EVERY_N_FRAMES,
        max_frames=100000,
        persist_frames=SAMPLE_EVERY_N_FRAMES,
    )
    overlay_elapsed = time.perf_counter() - overlay_start
    total_elapsed = stage1_elapsed + overlay_elapsed

    # Stable output format for copy/paste + comparison between runs.
    print(f"samples_taken={len(sampled)}")
    print("sample_timestamps_s=" + ", ".join(f"{frame.timestamp_s:.3f}" for frame in sampled))
    # Keep `labels_seen` aligned with overlay "unique_detected_items".
    print("labels_seen=" + _format_label_counts(overlay_summary.unique_labels))
    print("labels_seen_raw_per_frame=" + _format_label_counts(raw_label_counts))
    print(f"elapsed_seconds={stage1_elapsed:.3f}")
    print("candidate_labels=" + _format_candidate_labels([c.label for c in candidate_set.candidates]))
    print(f"overlay_video_path={overlay_path}")
    print(f"overlay_elapsed_seconds={overlay_elapsed:.3f}")
    print(f"total_elapsed_seconds={total_elapsed:.3f}")
    print(f"submission_video_path={SUBMISSION_VIDEO}")


if __name__ == "__main__":
    asyncio.run(main())

