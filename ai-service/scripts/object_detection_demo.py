"""Run object detection and generate an annotated preview video."""

from __future__ import annotations

import argparse
from pathlib import Path

from app.object_detection import annotate_video, most_common_labels, summarize_video_objects


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("video_path", type=Path, help="Input video file path")
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("artifacts") / "annotated_preview.mp4",
        help="Output annotated video file path",
    )
    args = parser.parse_args()

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
