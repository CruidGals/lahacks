"""Unit + endpoint tests for the three LLM pipelines.

Every test runs in stub mode (``pipeline_use_stub=True``) by default so the
suite never hits the network or burns OpenAI credits. The few tests that
exercise the *non*-stub code path either monkeypatch the LLM client directly
or stub out frame extraction so OpenCV doesn't try to download a URL.
"""

from __future__ import annotations

import asyncio
import json

import pytest
from fastapi.testclient import TestClient

from app.config import Settings, get_settings
from app.main import app
from app.pipelines.annotator import annotate_frame, annotate_frames
from app.pipelines.cleanup_pipeline import (
    CleanupVerdict,
    ItemResolution,
    run_cleanup_pipeline,
)
from app.pipelines.dino_adapter import (
    _xyxy_to_bbox,
    build_dino_output_from_video,
)
from app.pipelines.dino_types import (
    Bbox,
    Detection,
    DinoOutput,
    FrameDetections,
)
from app.pipelines.disposal_pipeline import DisposalVerdict, run_disposal_pipeline
from app.pipelines.frame_extractor import (
    _evenly_spaced_indices,
    make_placeholder_frames,
)
from app.pipelines.llm_client import (
    LLMConfigError,
    LLMRequest,
    LLMResponseError,
    OpenAIPipelineClient,
    join_text_blocks,
    render_json_block,
)
from app.pipelines.reference_pipeline import (
    ReferenceSpec,
    TrashItem,
    run_reference_pipeline,
)
from app.pipelines.spec_pipeline import SpecBbox, SpecCandidate, SpecCandidateSet, SpecPreviewFrame
from tests.fixtures import (
    load_dino_clean_submission,
    load_dino_reference,
    load_dino_submission,
)


# ---- helpers ------------------------------------------------------------ #


def _build_settings(**overrides) -> Settings:
    """Build a Settings tuned for pipeline tests.

    Defaults to stub mode + a fake API key so direct pipeline calls never try
    to reach OpenAI. Tests that want to exercise the real call path pass
    ``pipeline_use_stub=False`` and monkeypatch the LLM client.
    """

    base = dict(
        backend_base_url="http://backend.test",
        backend_internal_token=None,
        verification_confidence_threshold=0.85,
        bounty_radius_meters=75.0,
        min_session_duration_seconds=120,
        callback_max_retries=2,
        callback_initial_backoff_seconds=0.01,
        openai_api_key="test-key",
        openai_model="gpt-stub-test",
        openai_max_tokens=200,
        pipeline_frames_per_video=3,
        pipeline_use_stub=True,
    )
    base.update(overrides)
    return Settings(**base)


@pytest.fixture()
def stub_settings() -> Settings:
    return _build_settings()


def _override_endpoint_settings(settings: Settings):
    """Helper to swap FastAPI's get_settings dependency for endpoint tests."""

    app.dependency_overrides[get_settings] = lambda: settings


def _clear_endpoint_settings():
    app.dependency_overrides.pop(get_settings, None)


# ---- DINO contract ------------------------------------------------------ #


def test_fixtures_validate_into_dino_output():
    ref = DinoOutput.model_validate(load_dino_reference())
    sub = DinoOutput.model_validate(load_dino_submission())
    assert ref.summary["plastic_bottle"] == 5
    assert sum(sub.summary.values()) == 1
    assert ref.total_detections() > sub.total_detections()


def test_dino_output_recomputes_summary_from_frames():
    raw = load_dino_reference()
    raw["summary"] = {}
    dino = DinoOutput.model_validate(raw).with_recomputed_summary()
    assert sum(dino.summary.values()) == dino.total_detections()
    assert dino.summary["plastic_bottle"] == 5


def test_dino_bbox_rejects_non_positive_size():
    with pytest.raises(ValueError):
        Detection(label="bottle", confidence=0.5, bbox=Bbox(x=0, y=0, w=0, h=10))


# ---- Frame extractor helpers ------------------------------------------- #


def test_evenly_spaced_indices_picks_endpoints():
    # With banker's rounding round(1 * 4.5) == 4, so the middle is 4 (not 5).
    assert _evenly_spaced_indices(10, 3) == [0, 4, 9]
    assert _evenly_spaced_indices(5, 5) == [0, 1, 2, 3, 4]
    assert _evenly_spaced_indices(0, 3) == []
    assert _evenly_spaced_indices(10, 0) == []
    assert _evenly_spaced_indices(10, 1) == [5]
    # n > total_frames returns every index.
    assert _evenly_spaced_indices(3, 10) == [0, 1, 2]


def test_placeholder_frames_have_expected_shape():
    frames = make_placeholder_frames(4, width=64, height=48, label="t")
    assert len(frames) == 4
    for idx, frame in enumerate(frames):
        assert frame.frame_index == idx
        assert frame.width == 64
        assert frame.height == 48
        # JPEG b64 header is "/9j/" so a quick sanity check is enough.
        assert frame.jpeg_b64.startswith("/9j/")


# ---- Annotator ---------------------------------------------------------- #


def test_annotate_frame_with_no_detections_produces_clean_copy():
    frame = make_placeholder_frames(1)[0]
    annotated = annotate_frame(frame, [])
    assert annotated.image_bgr.shape == frame.image_bgr.shape
    assert annotated.width == frame.width
    assert annotated.jpeg_b64.startswith("/9j/")


def test_annotate_frames_uses_nearest_dino_frame_by_timestamp():
    frames = make_placeholder_frames(2)
    dino_frames = [
        FrameDetections(
            timestamp_s=0.0,
            frame_index=0,
            detections=[
                Detection(label="bottle", confidence=0.9, bbox=Bbox(x=5, y=5, w=20, h=20))
            ],
        )
    ]
    annotated = annotate_frames(frames, dino_frames)
    assert len(annotated) == 2
    # Both placeholders should still be valid JPEGs after annotation.
    for frame in annotated:
        assert frame.jpeg_b64.startswith("/9j/")


# ---- LLM client --------------------------------------------------------- #


def test_render_json_block_includes_label_and_payload():
    block = render_json_block("Foo", {"a": 1})
    assert "Foo:" in block
    assert '"a": 1' in block


def test_join_text_blocks_skips_empty():
    assert join_text_blocks(["a", "", "b"]) == "a\n\nb"


def test_llm_client_returns_stub_factory_when_stub_enabled(stub_settings):
    client = OpenAIPipelineClient(stub_settings)

    async def _run():
        return await client.call_json(
            LLMRequest(system_prompt="x", user_text="x", images=[]),
            DisposalVerdict,
            stub_factory=lambda: DisposalVerdict(
                deposited_into_bin=True,
                confidence=0.5,
                container_type=None,
                reasoning="manual stub",
            ),
        )

    result = asyncio.run(_run())
    assert result.deposited_into_bin is True
    assert result.reasoning == "manual stub"


def test_llm_client_raises_config_error_when_no_key_and_no_stub():
    settings = _build_settings(pipeline_use_stub=False, openai_api_key=None)
    client = OpenAIPipelineClient(settings)

    async def _run():
        return await client.call_json(
            LLMRequest(system_prompt="x", user_text="x", images=[]),
            DisposalVerdict,
            stub_factory=lambda: DisposalVerdict(
                deposited_into_bin=False,
                confidence=0.0,
                container_type=None,
                reasoning="x",
            ),
        )

    with pytest.raises(LLMConfigError):
        asyncio.run(_run())


def test_llm_client_retries_on_invalid_json(monkeypatch):
    settings = _build_settings(pipeline_use_stub=False)
    client = OpenAIPipelineClient(settings)
    valid = (
        '{"deposited_into_bin": true, "confidence": 0.9, '
        '"container_type": "trash can", "reasoning": "ok"}'
    )
    calls = {"n": 0}

    async def fake_call_once(_request):
        calls["n"] += 1
        if calls["n"] == 1:
            return "definitely-not-json"
        return valid

    monkeypatch.setattr(client, "_call_once", fake_call_once)

    async def _run():
        return await client.call_json(
            LLMRequest(system_prompt="x", user_text="x", images=[]),
            DisposalVerdict,
            stub_factory=lambda: DisposalVerdict(
                deposited_into_bin=False,
                confidence=0.0,
                container_type=None,
                reasoning="stub",
            ),
        )

    result = asyncio.run(_run())
    assert result.deposited_into_bin is True
    assert calls["n"] == 2


def test_llm_client_raises_after_repeated_invalid_json(monkeypatch):
    settings = _build_settings(pipeline_use_stub=False)
    client = OpenAIPipelineClient(settings)

    async def always_bad(_request):
        return "not-json"

    monkeypatch.setattr(client, "_call_once", always_bad)

    async def _run():
        return await client.call_json(
            LLMRequest(system_prompt="x", user_text="x", images=[]),
            DisposalVerdict,
            stub_factory=lambda: DisposalVerdict(
                deposited_into_bin=False,
                confidence=0.0,
                container_type=None,
                reasoning="stub",
            ),
            max_retries=1,
        )

    with pytest.raises(LLMResponseError):
        asyncio.run(_run())


# ---- Reference pipeline ------------------------------------------------ #


async def test_reference_pipeline_stub_skips_video_io_and_returns_spec(stub_settings):
    dino = DinoOutput.model_validate(load_dino_reference())
    spec = await run_reference_pipeline(
        video="https://example.com/anything.mp4",
        dino=dino,
        settings=stub_settings,
    )
    assert isinstance(spec, ReferenceSpec)
    assert spec.items
    # raw_dino_summary mirrors the input; annotated frames are placeholder JPEGs.
    assert spec.raw_dino_summary == dino.summary
    assert all(f.startswith("/9j/") for f in spec.annotated_frames_b64)
    # All stub items must use real DINO labels.
    for item in spec.items:
        assert item.label in dino.summary


async def test_reference_pipeline_stub_handles_empty_dino(stub_settings):
    dino = DinoOutput(
        video_url="https://example.com/v.mp4",
        duration_s=1.0,
        width=10,
        height=10,
        frames=[],
        summary={},
    )
    spec = await run_reference_pipeline(
        video="https://example.com/v.mp4",
        dino=dino,
        settings=stub_settings,
    )
    assert spec.items  # falls back to a single "unknown" item
    assert spec.items[0].label == "unknown"


async def test_reference_pipeline_real_path_uses_llm_client(monkeypatch):
    """When stub mode is off the pipeline must call the LLM client and merge results."""

    settings = _build_settings(pipeline_use_stub=False)
    canned = ReferenceSpec(
        site_summary="LLM-authored summary",
        items=[
            TrashItem(
                item_id="bottle_1",
                description="a bottle near the bench",
                label="plastic_bottle",
                location_hint="near the bench",
                estimated_count=2,
            )
        ],
        cleanup_success_criteria="Remove every bottle.",
    )

    class _FakeClient:
        async def call_json(self, _request, _schema, *, stub_factory, max_retries=1):
            return canned

    # Avoid hitting OpenCV/network for frame extraction.
    from app.pipelines import reference_pipeline

    async def fake_extract(_video, *, frames_per_video):
        return make_placeholder_frames(frames_per_video, label="ref")

    monkeypatch.setattr(reference_pipeline, "extract_frames", fake_extract)

    dino = DinoOutput.model_validate(load_dino_reference())
    spec = await run_reference_pipeline(
        video="https://example.com/whatever.mp4",
        dino=dino,
        settings=settings,
        client=_FakeClient(),  # type: ignore[arg-type]
    )
    assert spec.site_summary == "LLM-authored summary"
    assert spec.annotated_frames_b64  # attached after LLM call
    assert spec.raw_dino_summary == dino.summary


# ---- Cleanup pipeline -------------------------------------------------- #


async def test_cleanup_pipeline_stub_flags_remaining_items(stub_settings):
    ref_dino = DinoOutput.model_validate(load_dino_reference())
    sub_dino = DinoOutput.model_validate(load_dino_submission())
    spec = await run_reference_pipeline(
        video="https://example.com/ref.mp4",
        dino=ref_dino,
        settings=stub_settings,
    )
    verdict = await run_cleanup_pipeline(
        reference_video="https://example.com/ref.mp4",
        submission_video="https://example.com/sub.mp4",
        reference_dino=ref_dino,
        submission_dino=sub_dino,
        reference_spec=spec,
        settings=stub_settings,
    )
    assert isinstance(verdict, CleanupVerdict)
    # Submission DINO still has 1 plastic_bottle so cleanup should not be complete.
    assert verdict.cleanup_complete is False
    assert verdict.leftover_count >= 1
    bottle_item = next(item for item in verdict.items if item.item_id.endswith("plastic_bottle"))
    assert bottle_item.still_present is True


async def test_cleanup_pipeline_stub_passes_when_submission_empty(stub_settings):
    ref_dino = DinoOutput.model_validate(load_dino_reference())
    sub_dino = DinoOutput.model_validate(load_dino_clean_submission())
    spec = await run_reference_pipeline(
        video="https://example.com/ref.mp4",
        dino=ref_dino,
        settings=stub_settings,
    )
    verdict = await run_cleanup_pipeline(
        reference_video="https://example.com/ref.mp4",
        submission_video="https://example.com/clean.mp4",
        reference_dino=ref_dino,
        submission_dino=sub_dino,
        reference_spec=spec,
        settings=stub_settings,
    )
    assert verdict.cleanup_complete is True
    assert verdict.leftover_count == 0
    assert all(not item.still_present for item in verdict.items)


def test_cleanup_verdict_validator_corrects_inconsistent_llm_output():
    """If the LLM says complete=True but lists leftovers, validator fixes it."""

    verdict = CleanupVerdict(
        cleanup_complete=True,
        confidence=0.9,
        items=[
            ItemResolution(item_id="x", still_present=True, confidence=0.9, notes="seen"),
        ],
        leftover_count=0,
        reasoning="LLM disagreed with itself; validator should fix.",
    )
    assert verdict.cleanup_complete is False
    assert verdict.leftover_count == 1


# ---- Disposal pipeline ------------------------------------------------- #


async def test_disposal_pipeline_stub_returns_default_verdict(stub_settings):
    verdict = await run_disposal_pipeline(
        video="https://example.com/disposal.mp4",
        settings=stub_settings,
    )
    assert isinstance(verdict, DisposalVerdict)
    assert verdict.deposited_into_bin is True
    assert "[STUB]" in verdict.reasoning


# ---- Endpoints --------------------------------------------------------- #


def test_spec_candidates_endpoint_returns_stage1_candidates(monkeypatch):
    settings = _build_settings()
    _override_endpoint_settings(settings)

    async def fake_extract(_video, *, settings):
        return SpecCandidateSet(
            video_url="https://example.com/site.mp4",
            duration_s=2.0,
            width=640,
            height=480,
            broad_prompt="trash bag . bottle . tire",
            sample_every_n_frames=10,
            samples_taken=3,
            candidates=[
                SpecCandidate(
                    candidate_id="cand_1",
                    label="trash bag",
                    confidence=0.91,
                    bbox=SpecBbox(x=10, y=20, w=80, h=100),
                    source_frame_index=0,
                    source_timestamp_s=0.5,
                    hit_count=2,
                )
            ],
            preview_frames=[
                SpecPreviewFrame(
                    frame_index=0,
                    sample_index=1,
                    timestamp_s=0.5,
                    width=640,
                    height=480,
                    image_b64="/9j/abc",
                    annotated_b64="/9j/def",
                    candidate_ids=["cand_1"],
                )
            ],
        )

    monkeypatch.setattr("app.api.routes.extract_spec_candidates", fake_extract)
    try:
        with TestClient(app) as client:
            response = client.post(
                "/pipelines/spec/candidates",
                json={"video_url": "https://example.com/site.mp4"},
            )
        assert response.status_code == 200, response.text
        data = response.json()
        assert data["candidates"]
        assert data["candidates"][0]["label"] == "trash bag"
        assert data["preview_frames"][0]["candidate_ids"] == ["cand_1"]
    finally:
        _clear_endpoint_settings()


def test_disposal_endpoint_returns_verdict():
    settings = _build_settings()
    _override_endpoint_settings(settings)
    try:
        with TestClient(app) as client:
            response = client.post(
                "/pipelines/disposal",
                json={"video_url": "https://example.com/disposal.mp4"},
            )
        assert response.status_code == 200, response.text
        data = response.json()
        assert data["deposited_into_bin"] is True
        assert "reasoning" in data
    finally:
        _clear_endpoint_settings()


def test_cleanup_endpoint_returns_verdict():
    settings = _build_settings()
    _override_endpoint_settings(settings)
    try:
        spec = ReferenceSpec(
            site_summary="x",
            items=[
                TrashItem(
                    item_id="bottle_1",
                    description="bottle",
                    label="plastic_bottle",
                    location_hint="x",
                    estimated_count=2,
                )
            ],
            cleanup_success_criteria="x",
        )
        body = {
            "reference_video_url": "https://example.com/ref.mp4",
            "submission_video_url": "https://example.com/sub.mp4",
            "reference_dino": load_dino_reference(),
            "submission_dino": load_dino_submission(),
            "reference_spec": json.loads(spec.model_dump_json()),
        }
        with TestClient(app) as client:
            response = client.post("/pipelines/cleanup", json=body)
        assert response.status_code == 200, response.text
        data = response.json()
        assert "cleanup_complete" in data
        assert data["leftover_count"] >= 0
    finally:
        _clear_endpoint_settings()


def test_spec_candidates_endpoint_does_not_require_openai_api_key(monkeypatch):
    settings = _build_settings(pipeline_use_stub=False, openai_api_key=None)
    _override_endpoint_settings(settings)

    async def fake_extract(_video, *, settings):
        return SpecCandidateSet(
            video_url="https://example.com/x.mp4",
            duration_s=1.0,
            width=320,
            height=240,
            broad_prompt="trash bag . bottle",
            sample_every_n_frames=10,
            samples_taken=2,
            candidates=[],
            preview_frames=[],
        )

    monkeypatch.setattr("app.api.routes.extract_spec_candidates", fake_extract)

    try:
        with TestClient(app) as client:
            response = client.post(
                "/pipelines/spec/candidates",
                json={"video_url": "https://example.com/x.mp4"},
            )
        assert response.status_code == 200
        assert response.json()["candidates"] == []
    finally:
        _clear_endpoint_settings()
