"""Run object detection and generate an annotated preview video."""

from __future__ import annotations

import asyncio
import argparse
from pathlib import Path

from app.object_detection import (
    annotate_video,
    most_common_labels,
    summarize_video_objects,
    summarize_video_objects_grounding_dino,
)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("video_path", type=Path, help="Input video file path")
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("artifacts") / "annotated_preview.mp4",
        help="Output annotated video file path",
    )
    parser.add_argument(
        "--backend",
        choices=["opencv", "grounding_dino"],
        default="opencv",
        help="Detector backend to use for summaries",
    )
    parser.add_argument(
        "--query",
        type=str,
        default="trash . litter . garbage . bottle . can . bag",
        help="Grounding DINO dot-separated category query.",
    )
    args = parser.parse_args()

    if args.backend == "grounding_dino":
        summary = asyncio.run(
            summarize_video_objects_grounding_dino(args.video_path, query=args.query)
        )
    else:
        summary = summarize_video_objects(args.video_path)
    output = annotate_video(args.video_path, args.output)

    print(f"frames_sampled={summary.frames_sampled}")
    print("unique_tracked_objects:")
    for label, count in most_common_labels(summary.labels):
        print(f"- {label}: {count}")
    print("per_frame_detections:")
    for label, count in most_common_labels(summary.frame_detection_labels):
        print(f"- {label}: {count}")
    print(f"annotated_video={output.resolve()}")


if __name__ == "__main__":
    main()
