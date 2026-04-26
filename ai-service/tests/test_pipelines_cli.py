"""Interactive CLI driver for the three LLM pipelines.

Usage::

    python tests/test_pipelines_cli.py            # interactive menu
    python tests/test_pipelines_cli.py reference  # run one demo non-interactively
    python tests/test_pipelines_cli.py cleanup    # ditto
    python tests/test_pipelines_cli.py disposal   # ditto
    python tests/test_pipelines_cli.py all        # run all three with sample data

The driver always runs in ``PIPELINE_USE_STUB=true`` mode unless you set
``OPENAI_API_KEY`` in the env AND export ``CLI_USE_REAL=1`` so we never burn
credits by mistake. Pytest discovers a couple of lightweight tests in here
that exercise the same demo functions.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from pathlib import Path

_ROOT = Path(__file__).resolve().parent.parent
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from app.config import Settings  # noqa: E402
from app.pipelines.cleanup_pipeline import (  # noqa: E402
    CleanupVerdict,
    run_cleanup_pipeline,
)
from app.pipelines.dino_types import DinoOutput  # noqa: E402
from app.pipelines.disposal_pipeline import (  # noqa: E402
    DisposalVerdict,
    run_disposal_pipeline,
)
from app.pipelines.reference_pipeline import (  # noqa: E402
    ReferenceSpec,
    run_reference_pipeline,
)
from tests.fixtures import (  # noqa: E402
    load_dino_clean_submission,
    load_dino_reference,
    load_dino_submission,
)


# ---- settings ----------------------------------------------------------- #


SAMPLE_REF_VIDEO = "https://example.com/sample-before-cleanup.mp4"
SAMPLE_SUB_VIDEO = "https://example.com/sample-after-cleanup.mp4"
SAMPLE_DISPOSAL_VIDEO = "https://example.com/sample-disposal.mp4"


def build_cli_settings(*, use_stub: bool) -> Settings:
    """Build a Settings instance tuned for the CLI.

    Default is stub mode -- safe + free. To exercise the real OpenAI path set
    ``CLI_USE_REAL=1`` AND export a working ``OPENAI_API_KEY``.
    """

    return Settings(
        backend_base_url="http://backend.test",
        backend_internal_token=None,
        verification_confidence_threshold=0.85,
        bounty_radius_meters=75.0,
        min_session_duration_seconds=120,
        callback_max_retries=2,
        callback_initial_backoff_seconds=0.01,
        openai_api_key=os.environ.get("OPENAI_API_KEY") or "cli-stub-key",
        openai_model=os.environ.get("OPENAI_MODEL", "gpt-stub-test"),
        openai_max_tokens=int(os.environ.get("OPENAI_MAX_TOKENS", "1000")),
        pipeline_frames_per_video=int(os.environ.get("PIPELINE_FRAMES_PER_VIDEO", "3")),
        pipeline_use_stub=use_stub,
    )


def stub_mode_default() -> bool:
    """The CLI runs stub-mode by default to avoid surprise API charges."""
    return os.environ.get("CLI_USE_REAL", "").strip() not in {"1", "true", "yes"}


# ---- pretty print ------------------------------------------------------- #


def _truncate_b64_in(payload):
    """Return a JSON-safe copy with annotated_frames_b64 truncated for terminal output."""
    if isinstance(payload, dict):
        out = {}
        for key, value in payload.items():
            if key == "annotated_frames_b64" and isinstance(value, list):
                out[key] = [f"<{len(s)} chars JPEG b64>" for s in value]
            else:
                out[key] = _truncate_b64_in(value)
        return out
    if isinstance(payload, list):
        return [_truncate_b64_in(item) for item in payload]
    return payload


def _print_json(label: str, model) -> None:
    payload = _truncate_b64_in(json.loads(model.model_dump_json()))
    print(f"\n=== {label} ===")
    print(json.dumps(payload, indent=2, sort_keys=True))


# ---- demo runners ------------------------------------------------------- #


async def run_reference_demo(
    *,
    video_url: str = SAMPLE_REF_VIDEO,
    use_stub: bool | None = None,
    dino_payload: dict | None = None,
) -> ReferenceSpec:
    """Run Person A's pipeline against the sample fixture (or your own URL)."""

    settings = build_cli_settings(
        use_stub=use_stub if use_stub is not None else stub_mode_default()
    )
    dino = DinoOutput.model_validate(dino_payload or load_dino_reference())
    spec = await run_reference_pipeline(video=video_url, dino=dino, settings=settings)
    _print_json("ReferenceSpec", spec)
    return spec


async def run_disposal_demo(
    *,
    video_url: str = SAMPLE_DISPOSAL_VIDEO,
    use_stub: bool | None = None,
) -> DisposalVerdict:
    """Run the disposal-proof pipeline (no DINO input required)."""

    settings = build_cli_settings(
        use_stub=use_stub if use_stub is not None else stub_mode_default()
    )
    verdict = await run_disposal_pipeline(video=video_url, settings=settings)
    _print_json("DisposalVerdict", verdict)
    return verdict


async def run_cleanup_demo(
    *,
    reference_video_url: str = SAMPLE_REF_VIDEO,
    submission_video_url: str = SAMPLE_SUB_VIDEO,
    use_stub: bool | None = None,
    submission_clean: bool = False,
) -> CleanupVerdict:
    """Run Person B's cleanup comparison.

    ``submission_clean=True`` swaps the messy submission fixture for the
    "everything resolved" fixture so you can sanity-check both branches.
    """

    settings = build_cli_settings(
        use_stub=use_stub if use_stub is not None else stub_mode_default()
    )
    ref_dino = DinoOutput.model_validate(load_dino_reference())
    sub_dino = DinoOutput.model_validate(
        load_dino_clean_submission() if submission_clean else load_dino_submission()
    )
    spec = await run_reference_pipeline(
        video=reference_video_url, dino=ref_dino, settings=settings
    )
    verdict = await run_cleanup_pipeline(
        reference_video=reference_video_url,
        submission_video=submission_video_url,
        reference_dino=ref_dino,
        submission_dino=sub_dino,
        reference_spec=spec,
        settings=settings,
    )
    _print_json("CleanupVerdict (input ReferenceSpec abbreviated)", spec)
    _print_json("CleanupVerdict (verdict)", verdict)
    return verdict


# ---- CLI menu ----------------------------------------------------------- #


MENU = """
Civic Bounty -- LLM pipeline demo
=================================
Stub mode is {stub}. Set CLI_USE_REAL=1 + OPENAI_API_KEY to hit the real API.

  1) Run reference pipeline (Person A) with sample fixture
  2) Run reference pipeline with a custom video URL
  3) Run cleanup pipeline (Person B) with sample fixtures (messy submission)
  4) Run cleanup pipeline with sample fixtures (CLEAN submission)
  5) Run disposal pipeline with sample URL
  6) Run disposal pipeline with a custom video URL
  7) Run all three pipelines with sample fixtures
  q) Quit
"""


def _prompt(prompt: str) -> str:
    try:
        return input(prompt).strip()
    except EOFError:
        return "q"


async def interactive_menu() -> None:
    while True:
        print(MENU.format(stub="ON" if stub_mode_default() else "OFF"))
        choice = _prompt("Choice: ").lower()
        if choice in {"q", "quit", "exit"}:
            return
        try:
            if choice == "1":
                await run_reference_demo()
            elif choice == "2":
                url = _prompt("Reference video URL: ") or SAMPLE_REF_VIDEO
                await run_reference_demo(video_url=url)
            elif choice == "3":
                await run_cleanup_demo(submission_clean=False)
            elif choice == "4":
                await run_cleanup_demo(submission_clean=True)
            elif choice == "5":
                await run_disposal_demo()
            elif choice == "6":
                url = _prompt("Disposal video URL: ") or SAMPLE_DISPOSAL_VIDEO
                await run_disposal_demo(video_url=url)
            elif choice == "7":
                await run_reference_demo()
                await run_cleanup_demo()
                await run_disposal_demo()
            else:
                print(f"Unknown choice: {choice!r}")
        except Exception as exc:  # noqa: BLE001 - CLI keeps going on errors.
            print(f"Pipeline raised: {type(exc).__name__}: {exc}")


def _main_async(args: argparse.Namespace) -> None:
    if args.command == "reference":
        asyncio.run(run_reference_demo())
    elif args.command == "disposal":
        asyncio.run(run_disposal_demo())
    elif args.command == "cleanup":
        asyncio.run(run_cleanup_demo(submission_clean=args.clean))
    elif args.command == "all":
        async def _all():
            await run_reference_demo()
            await run_cleanup_demo(submission_clean=args.clean)
            await run_disposal_demo()

        asyncio.run(_all())
    else:
        asyncio.run(interactive_menu())


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description="LLM pipeline demo driver")
    parser.add_argument(
        "command",
        nargs="?",
        choices=["reference", "cleanup", "disposal", "all"],
        help="Run one demo non-interactively. Omit for the menu.",
    )
    parser.add_argument(
        "--clean",
        action="store_true",
        help="For cleanup demos, use the 'cleaned up' submission fixture.",
    )
    args = parser.parse_args(argv)
    _main_async(args)


# ---- pytest --------------------------------------------------------------#
# These quick checks let pytest confirm the CLI imports cleanly and that the
# demo functions stay green in stub mode. They run in <1s and need no network.


async def test_cli_reference_demo_returns_spec(capsys):
    spec = await run_reference_demo(use_stub=True)
    assert spec.items
    captured = capsys.readouterr()
    assert "ReferenceSpec" in captured.out


async def test_cli_disposal_demo_returns_verdict(capsys):
    verdict = await run_disposal_demo(use_stub=True)
    assert verdict.deposited_into_bin is True
    captured = capsys.readouterr()
    assert "DisposalVerdict" in captured.out


async def test_cli_cleanup_demo_messy_submission(capsys):
    verdict = await run_cleanup_demo(use_stub=True, submission_clean=False)
    assert verdict.cleanup_complete is False
    assert verdict.leftover_count >= 1
    captured = capsys.readouterr()
    assert "CleanupVerdict" in captured.out


async def test_cli_cleanup_demo_clean_submission(capsys):
    verdict = await run_cleanup_demo(use_stub=True, submission_clean=True)
    assert verdict.cleanup_complete is True
    assert verdict.leftover_count == 0


def test_cli_menu_string_includes_all_options():
    rendered = MENU.format(stub="ON")
    for option in ("1)", "2)", "3)", "4)", "5)", "6)", "7)", "q)"):
        assert option in rendered


if __name__ == "__main__":
    main()
