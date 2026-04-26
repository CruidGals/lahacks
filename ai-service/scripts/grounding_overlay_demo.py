"""Generate a Grounding DINO overlay video for manual review."""

from __future__ import annotations

import argparse
import asyncio
from pathlib import Path

from app.object_detection import annotate_video_grounding_dino


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

    output = asyncio.run(
        annotate_video_grounding_dino(
            args.video_path,
            args.output,
            query=args.query,
            max_frames=args.max_frames,
            sample_every_n_frames=args.sample_every,
            persist_frames=args.persist_frames,
        )
    )
    print(f"annotated_video={output.resolve()}")


if __name__ == "__main__":
    main()
