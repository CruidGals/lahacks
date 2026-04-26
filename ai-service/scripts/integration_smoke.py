"""End-to-end smoke runner for the three LLM video-verification pipelines.

Runs each pipeline against the local fixture videos in
``data/videos/fixtures/`` and prints a compact verdict per stage so you can
eyeball whether the integration is healthy without staring at base64 blobs.

Defaults are wired for the merged repo:

* requester / reference -> ``egRequest.MOV``
* cleaner final / submission -> ``egUserPost.MOV``
* cleaner disposal -> ``testing.MOV`` (acts as a stand-in until you record one)

Usage::

    # Uses .env's OPENAI_API_KEY + VISION_DETECTOR_BACKEND
    python scripts/integration_smoke.py

    # Skip the OpenAI call entirely (deterministic stub mode)
    python scripts/integration_smoke.py --stub

    # Override individual videos
    python scripts/integration_smoke.py --reference path\\to\\before.mov ^
        --submission path\\to\\after.mov --disposal path\\to\\disposal.mov
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, TypeVar

# Make `app.*` importable when this script is run from anywhere.
_SCRIPT_DIR = Path(__file__).resolve().parent
_REPO_AI_DIR = _SCRIPT_DIR.parent
if str(_REPO_AI_DIR) not in sys.path:
    sys.path.insert(0, str(_REPO_AI_DIR))

from app.config import Settings, get_settings  # noqa: E402
from app.pipelines.cleanup_pipeline import (  # noqa: E402
    CleanupVerdict,
    run_cleanup_pipeline,
)
from app.pipelines.disposal_pipeline import (  # noqa: E402
    DisposalVerdict,
    run_disposal_pipeline,
)
from app.pipelines.reference_pipeline import (  # noqa: E402
    ReferenceSpec,
    run_reference_pipeline,
)

T = TypeVar("T")

DEFAULT_FIXTURES = _REPO_AI_DIR.parent / "data" / "videos" / "fixtures"


# ---- helpers ----------------------------------------------------------- #


@dataclass
class StageResult:
    name: str
    ok: bool
    elapsed_s: float
    detail: str
    payload: dict | None = None


def _truncate_b64(payload):
    """Recursively replace giant base64 strings so the terminal stays readable."""
    if isinstance(payload, dict):
        return {
            k: (
                [f"<{len(s)} chars JPEG b64>" for s in v]
                if k == "annotated_frames_b64" and isinstance(v, list)
                else _truncate_b64(v)
            )
            for k, v in payload.items()
        }
    if isinstance(payload, list):
        return [_truncate_b64(x) for x in payload]
    return payload


def _print_section(title: str) -> None:
    bar = "=" * len(title)
    print(f"\n{bar}\n{title}\n{bar}")


def _print_payload(label: str, model_or_dict) -> None:
    payload = (
        json.loads(model_or_dict.model_dump_json())
        if hasattr(model_or_dict, "model_dump_json")
        else model_or_dict
    )
    print(f"\n--- {label} ---")
    print(json.dumps(_truncate_b64(payload), indent=2, sort_keys=True))


async def _timed(name: str, fn: Callable[[], "asyncio.Future[T]"]) -> tuple[T | None, StageResult]:
    print(f"\n[{name}] starting...")
    start = time.perf_counter()
    try:
        result = await fn()
        elapsed = time.perf_counter() - start
        print(f"[{name}] OK in {elapsed:.1f}s")
        return result, StageResult(name, True, elapsed, "ok")
    except Exception as exc:  # noqa: BLE001
        elapsed = time.perf_counter() - start
        print(f"[{name}] FAILED in {elapsed:.1f}s: {type(exc).__name__}: {exc}")
        return None, StageResult(name, False, elapsed, f"{type(exc).__name__}: {exc}")


# ---- runner ------------------------------------------------------------ #


async def run_all(
    *,
    reference_video: Path,
    submission_video: Path,
    disposal_video: Path,
    settings: Settings,
) -> tuple[ReferenceSpec | None, CleanupVerdict | None, DisposalVerdict | None, list[StageResult]]:
    stages: list[StageResult] = []

    _print_section("Stage 1/3: requester reference video (Person A)")
    print(f"video: {reference_video}")
    spec, stage = await _timed(
        "reference",
        lambda: run_reference_pipeline(video=reference_video, settings=settings),
    )
    stages.append(stage)
    if spec is not None:
        _print_payload("ReferenceSpec", spec)

    _print_section("Stage 2/3: cleaner disposal proof video")
    print(f"video: {disposal_video}")
    disposal, stage = await _timed(
        "disposal",
        lambda: run_disposal_pipeline(video=disposal_video, settings=settings),
    )
    stages.append(stage)
    if disposal is not None:
        _print_payload("DisposalVerdict", disposal)

    _print_section("Stage 3/3: cleaner final-product video (Person B)")
    print(f"reference: {reference_video}")
    print(f"submission: {submission_video}")
    if spec is None:
        print("[cleanup] SKIPPED (reference stage failed; no spec available)")
        stages.append(
            StageResult("cleanup", False, 0.0, "skipped: no reference spec")
        )
        cleanup = None
    else:
        cleanup, stage = await _timed(
            "cleanup",
            lambda: run_cleanup_pipeline(
                reference_video=reference_video,
                submission_video=submission_video,
                reference_spec=spec,
                settings=settings,
            ),
        )
        stages.append(stage)
        if cleanup is not None:
            _print_payload("CleanupVerdict", cleanup)

    return spec, cleanup, disposal, stages


def _print_verdict_line(label: str, ok: bool, summary: str) -> None:
    marker = "PASS" if ok else "FAIL"
    print(f"  [{marker}] {label}: {summary}")


def _summarize_pipelines(
    spec: ReferenceSpec | None,
    cleanup: CleanupVerdict | None,
    disposal: DisposalVerdict | None,
    stages: list[StageResult],
) -> None:
    _print_section("SUMMARY")
    for stage in stages:
        marker = "PASS" if stage.ok else "FAIL"
        print(f"  [{marker}] {stage.name:<10} {stage.elapsed_s:6.1f}s  {stage.detail}")

    print("\nDoes each pipeline work end-to-end?")
    if spec is not None:
        items = ", ".join(f"{i.label}x{i.estimated_count}" for i in spec.items[:5]) or "no items"
        _print_verdict_line(
            "Requester video (reference_pipeline)", True,
            f"{len(spec.items)} items found ({items})",
        )
    else:
        _print_verdict_line("Requester video (reference_pipeline)", False, "see error above")

    if disposal is not None:
        _print_verdict_line(
            "Cleaner trash-disposal video (disposal_pipeline)", True,
            f"deposited_into_bin={disposal.deposited_into_bin} confidence={disposal.confidence:.2f}",
        )
    else:
        _print_verdict_line(
            "Cleaner trash-disposal video (disposal_pipeline)", False, "see error above",
        )

    if cleanup is not None:
        _print_verdict_line(
            "Cleaner final video (cleanup_pipeline)", True,
            f"cleanup_complete={cleanup.cleanup_complete} leftover={cleanup.leftover_count}",
        )
    else:
        _print_verdict_line("Cleaner final video (cleanup_pipeline)", False, "see error above")


def _settings_for_run(stub: bool) -> Settings:
    """Build settings using the ai-service/.env file, regardless of CWD.

    Without this the script silently misses ``OPENAI_API_KEY`` when invoked
    from the repo root because pydantic-settings resolves the env file
    relative to the current working directory.
    """

    get_settings.cache_clear()
    env_path = _REPO_AI_DIR / ".env"
    if env_path.exists():
        settings = Settings(_env_file=str(env_path))  # type: ignore[call-arg]
    else:
        settings = Settings()
    if stub:
        return settings.model_copy(update={"pipeline_use_stub": True})
    return settings


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Run all three pipelines against local fixture videos.",
    )
    parser.add_argument(
        "--reference",
        type=Path,
        default=DEFAULT_FIXTURES / "egRequest.MOV",
        help="Requester / 'before' video (Person A).",
    )
    parser.add_argument(
        "--submission",
        type=Path,
        default=DEFAULT_FIXTURES / "egUserPost.MOV",
        help="Cleaner / 'after' video (Person B).",
    )
    parser.add_argument(
        "--disposal",
        type=Path,
        default=DEFAULT_FIXTURES / "testing.MOV",
        help="Cleaner disposal-proof video.",
    )
    parser.add_argument(
        "--stub",
        action="store_true",
        help="Force PIPELINE_USE_STUB=true (skip OpenAI + DINO heavy lifting).",
    )
    args = parser.parse_args(argv)

    for label, path in (
        ("--reference", args.reference),
        ("--submission", args.submission),
        ("--disposal", args.disposal),
    ):
        if not path.exists():
            print(f"ERROR: {label} video does not exist: {path}", file=sys.stderr)
            return 2

    settings = _settings_for_run(stub=args.stub)
    print(
        "settings: "
        f"backend={settings.vision_detector_backend} "
        f"openai_model={settings.openai_model} "
        f"frames_per_video={settings.pipeline_frames_per_video} "
        f"stub={settings.pipeline_use_stub}"
    )

    spec, cleanup, disposal, stages = asyncio.run(
        run_all(
            reference_video=args.reference,
            submission_video=args.submission,
            disposal_video=args.disposal,
            settings=settings,
        )
    )
    _summarize_pipelines(spec, cleanup, disposal, stages)
    return 0 if all(s.ok for s in stages) else 1


if __name__ == "__main__":
    sys.exit(main())
