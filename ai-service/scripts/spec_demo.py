#!/usr/bin/env python3
"""Quick CLI to run Stage 1 spec-pipeline on a local video and print timing."""
from __future__ import annotations

import asyncio
import sys
import time


async def main(video_path: str) -> None:
    from app.config import Settings

    settings = Settings(vision_detector_backend="grounding_dino")

    from app.pipelines.spec_pipeline import extract_spec_candidates

    t0 = time.perf_counter()
    result = await extract_spec_candidates(video_path, settings=settings)
    elapsed = time.perf_counter() - t0

    print(f"\n{'='*60}")
    print(f"elapsed_seconds: {elapsed:.2f}")
    print(f"candidates:      {len(result.candidates)}")
    print(f"preview_frames:  {len(result.preview_frames)}")
    for c in result.candidates:
        print(f"  #{c.candidate_id}: {c.label} (conf={c.confidence:.2f}, hits={c.hit_count})")
    print(f"{'='*60}\n")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python3 -m scripts.spec_demo <path/to/video>")
        sys.exit(1)
    asyncio.run(main(sys.argv[1]))
