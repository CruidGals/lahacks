"""Generate a Grounding DINO overlay video for manual review."""

from __future__ import annotations

import argparse
import asyncio
from datetime import datetime
from pathlib import Path

from app.config import get_settings
from app.object_detection import (
    annotate_video_grounding_dino,
    most_common_labels,
    summarize_video_objects_grounding_dino,
)


def _timestamped_output_path(requested_output: Path) -> tuple[Path, Path]:
    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    run_dir = Path("artifacts") / "video-debug-runs" / timestamp
    output_path = run_dir / requested_output.name
    return run_dir, output_path


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("video_path", type=Path, help="Input video file path")
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("artifacts") / "grounding_overlay.mp4",
        help="Output annotated video path",
    )
    parser.add_argument(
        "--query",
        type=str,
        default="bag, bottle, can, trash, litter, garbage",
        help="Grounding DINO comma-separated query terms",
    )
    parser.add_argument("--max-frames", type=int, default=100000, help="Max video frames to render")
    parser.add_argument(
        "--sample-every",
        type=int,
        default=180,
        help="Run Grounding DINO every N frames (~3s at 60fps)",
    )
    parser.add_argument(
        "--persist-frames",
        type=int,
        default=180,
        help="How long to persist box overlays between samples",
    )
    args = parser.parse_args()
    run_dir, resolved_output = _timestamped_output_path(args.output)

    settings = get_settings()

    async def _run():
        summary = await summarize_video_objects_grounding_dino(
            args.video_path,
            query=args.query,
            model=settings.grounding_dino_model,
            box_threshold=settings.grounding_dino_box_threshold,
            text_threshold=settings.grounding_dino_text_threshold,
            sample_every_n_frames=args.sample_every,
            max_frames=max(1, args.max_frames // max(1, args.sample_every)),
        )
        output = await annotate_video_grounding_dino(
            args.video_path,
            resolved_output,
            query=args.query,
            model=settings.grounding_dino_model,
            box_threshold=settings.grounding_dino_box_threshold,
            text_threshold=settings.grounding_dino_text_threshold,
            max_frames=args.max_frames,
            sample_every_n_frames=args.sample_every,
            persist_frames=args.persist_frames,
        )
        return summary, output

    summary, output = asyncio.run(_run())
    print(f"output_dir={run_dir.resolve()}")
    print(f"frames_sampled={summary.frames_sampled}")
    print("unique_detected_items:")
    for label, count in most_common_labels(summary.unique_labels):
        print(f"- {label}: {count}")
    print("per_frame_detections:")
    for label, count in most_common_labels(summary.frame_detection_labels):
        print(f"- {label}: {count}")
    print(f"annotated_video={output.resolve()}")


if __name__ == "__main__":
    main()
