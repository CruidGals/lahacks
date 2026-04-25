"""End-to-end tests for the verification service.

This file is the single comprehensive driver for Person 3's task. It exercises
the **entire** pipeline through the public HTTP surface:

    HTTP /verify -> FastAPI background task -> vision (Person 3A stubs) ->
        fraud aggregator -> scoring -> HTTP callback to Person 2 backend

It uses:
* Pytest fixtures with **dummy data** for every scenario (happy path, scene
  failure, task failure, fraud paths, callback retries, callback exhaustion,
  bearer-token forwarding, validation errors).
* `respx` to mock Person 2's backend webhook URL so we can assert on the exact
  JSON payload Person 3B delivers.
* `monkeypatch` to swap Person 3A's optional helpers (`extract_nonce_from_video`,
  `is_static_video`, `looks_like_replay`) on a per-scenario basis.

You can also run this file as a script for an **interactive demo**:

    python tests/test_end_to_end.py             # menu of preset scenarios
    python tests/test_end_to_end.py all         # run every preset
    python tests/test_end_to_end.py --json      # paste a custom payload from stdin

The interactive runner spins up the service in-process and prints the request,
the captured callback payload, and the verdict for each scenario.
"""

from __future__ import annotations

import asyncio
import json
import sys
import textwrap
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

# When this file is executed as a script (`python tests/test_end_to_end.py`)
# pytest's conftest is NOT loaded, so we need to put the package root on sys.path
# ourselves so `from app import ...` works.
_ROOT = Path(__file__).resolve().parent.parent
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

import httpx  # noqa: E402
import pytest  # noqa: E402
import respx  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app import vision  # noqa: E402
from app.config import Settings  # noqa: E402
from app.main import app  # noqa: E402
from app.models import GpsPing, VerifyRequest  # noqa: E402


# ---------------------------------------------------------------------------
# Helpers / fixtures
# ---------------------------------------------------------------------------


CALLBACK_PATH_TEMPLATE = "/cleanups/{cleanup_id}/verification-result"


def _callback_url(settings: Settings, cleanup_id: str) -> str:
    return f"{settings.backend_base_url.rstrip('/')}{CALLBACK_PATH_TEMPLATE.format(cleanup_id=cleanup_id)}"


def _payload(req: VerifyRequest) -> dict[str, Any]:
    """Build the JSON dict TestClient should send for a `VerifyRequest`."""

    return {
        "cleanup_id": req.cleanup_id,
        "submission_video_url": str(req.submission_video_url),
        "reference_video_url": str(req.reference_video_url),
        "bounty_lat": req.bounty_lat,
        "bounty_lng": req.bounty_lng,
        "gps_trajectory": [
            {
                "lat": p.lat,
                "lng": p.lng,
                "accuracy": p.accuracy,
                "timestamp": p.timestamp,
            }
            for p in req.gps_trajectory
        ],
        "issued_nonce": req.issued_nonce,
        "session_duration_s": req.session_duration_s,
    }


@pytest.fixture()
def client() -> TestClient:
    return TestClient(app)


# ---------------------------------------------------------------------------
# Scenario catalogue (also reused by the interactive CLI runner below)
# ---------------------------------------------------------------------------


@dataclass
class Scenario:
    """A single end-to-end scenario."""

    name: str
    summary: str
    request_kwargs: dict[str, Any] = field(default_factory=dict)
    vision_overrides: dict[str, Callable[..., Any]] = field(default_factory=dict)
    expected_verified: bool = True
    expected_flags: tuple[str, ...] = ()
    expect_scene_match: bool = True
    expect_task_complete: bool = True


HAPPY_TRAJECTORY = [
    {"lat": 34.0689, "lng": -118.4452, "accuracy": 5, "timestamp": 1700000000},
    {"lat": 34.06893, "lng": -118.44525, "accuracy": 5, "timestamp": 1700000200},
    {"lat": 34.06887, "lng": -118.44515, "accuracy": 5, "timestamp": 1700000400},
]
FAR_TRAJECTORY = [
    {"lat": 40.0, "lng": -100.0, "accuracy": 5, "timestamp": 1700000000},
    {"lat": 40.0001, "lng": -100.0001, "accuracy": 5, "timestamp": 1700000200},
]


async def _nonce_returns(value: str | None):
    async def _impl(_url: str) -> str | None:
        return value

    return _impl


def _patched_nonce(value: str | None) -> Callable[[str], Any]:
    async def _impl(_url: str) -> str | None:
        return value

    return _impl


def _patched_static(is_static: bool) -> Callable[[str], Any]:
    async def _impl(_url: str) -> bool:
        return is_static

    return _impl


def _patched_replay(is_replay: bool) -> Callable[[str, str], Any]:
    async def _impl(_ref: str, _sub: str) -> bool:
        return is_replay

    return _impl


SCENARIOS: list[Scenario] = [
    Scenario(
        name="happy_path",
        summary="Healthy submission near bounty pin, full session, clean vision.",
        request_kwargs={
            "cleanup_id": "demo-happy",
            "trajectory": HAPPY_TRAJECTORY,
            "duration_s": 600,
        },
        expected_verified=True,
        expected_flags=(),
    ),
    Scenario(
        name="scene_mismatch",
        summary="Submission video is at the wrong location (vision flags).",
        request_kwargs={
            "cleanup_id": "demo-scene-fail",
            "sub_url": "https://example.com/fail-scene.mp4",
            "trajectory": HAPPY_TRAJECTORY,
            "duration_s": 600,
        },
        expected_verified=False,
        expect_scene_match=False,
    ),
    Scenario(
        name="task_incomplete",
        summary="Trash still present in submission video.",
        request_kwargs={
            "cleanup_id": "demo-task-fail",
            "sub_url": "https://example.com/fail-task.mp4",
            "trajectory": HAPPY_TRAJECTORY,
            "duration_s": 600,
        },
        expected_verified=False,
        expect_task_complete=False,
    ),
    Scenario(
        name="session_too_short",
        summary="Claimer submitted after only 30s on site.",
        request_kwargs={
            "cleanup_id": "demo-short",
            "trajectory": HAPPY_TRAJECTORY,
            "duration_s": 30,
        },
        expected_verified=False,
        expected_flags=("session_too_short",),
    ),
    Scenario(
        name="empty_gps",
        summary="Frontend never sent any GPS pings.",
        request_kwargs={
            "cleanup_id": "demo-no-gps",
            "trajectory": [],
            "duration_s": 600,
        },
        expected_verified=False,
        expected_flags=("no_gps_data",),
    ),
    Scenario(
        name="trajectory_far_away",
        summary="GPS trajectory is in the wrong city.",
        request_kwargs={
            "cleanup_id": "demo-far",
            "trajectory": FAR_TRAJECTORY,
            "duration_s": 600,
        },
        expected_verified=False,
        expected_flags=("trajectory_outside_radius",),
    ),
    Scenario(
        name="nonce_mismatch",
        summary="Vision OCR'd a different nonce than the one the server issued.",
        request_kwargs={
            "cleanup_id": "demo-nonce",
            "nonce": "issued-nonce-A",
            "trajectory": HAPPY_TRAJECTORY,
            "duration_s": 600,
        },
        vision_overrides={"extract_nonce_from_video": _patched_nonce("watermark-B")},
        expected_verified=False,
        expected_flags=("nonce_mismatch",),
    ),
    Scenario(
        name="static_video_detected",
        summary="Submission video looks like a static / looped frame.",
        request_kwargs={
            "cleanup_id": "demo-static",
            "trajectory": HAPPY_TRAJECTORY,
            "duration_s": 600,
        },
        vision_overrides={"is_static_video": _patched_static(True)},
        expected_verified=False,
        expected_flags=("static_frame_suspected",),
    ),
    Scenario(
        name="replay_attack",
        summary="Submission frames suspiciously identical to reference frames.",
        request_kwargs={
            "cleanup_id": "demo-replay",
            "trajectory": HAPPY_TRAJECTORY,
            "duration_s": 600,
        },
        vision_overrides={"looks_like_replay": _patched_replay(True)},
        expected_verified=False,
        expected_flags=("replay_similarity_suspected",),
    ),
    Scenario(
        name="multiple_fraud_signals",
        summary="Stacked failures: short session AND wrong location AND replay.",
        request_kwargs={
            "cleanup_id": "demo-stacked",
            "trajectory": FAR_TRAJECTORY,
            "duration_s": 30,
        },
        vision_overrides={"looks_like_replay": _patched_replay(True)},
        expected_verified=False,
        expected_flags=(
            "session_too_short",
            "trajectory_outside_radius",
            "replay_similarity_suspected",
        ),
    ),
]


# ---------------------------------------------------------------------------
# Pytest cases
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("scenario", SCENARIOS, ids=lambda s: s.name)
def test_scenario_runs_end_to_end(
    scenario: Scenario,
    client: TestClient,
    settings: Settings,
    make_request,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Drive each scenario through HTTP and assert on the callback payload."""

    for attr, fn in scenario.vision_overrides.items():
        monkeypatch.setattr(vision, attr, fn)

    req = make_request(**scenario.request_kwargs)
    body = _payload(req)
    url = _callback_url(settings, req.cleanup_id)

    with respx.mock(assert_all_called=True) as router:
        route = router.post(url).mock(return_value=httpx.Response(200))
        response = client.post("/verify", json=body)
        assert response.status_code == 202
        assert response.json() == {"cleanup_id": req.cleanup_id, "status": "accepted"}

    assert route.called, "AI service never POSTed result to backend"
    callback_body = json.loads(route.calls.last.request.content)

    assert callback_body["verified"] is scenario.expected_verified
    assert callback_body["scene_match"] is scenario.expect_scene_match
    assert callback_body["task_complete"] is scenario.expect_task_complete
    assert sorted(callback_body["fraud_flags"]) == sorted(scenario.expected_flags)
    assert 0.0 <= callback_body["confidence"] <= 1.0
    assert isinstance(callback_body["reasoning"], str) and callback_body["reasoning"]


def test_callback_exhausts_retries_marks_failure(
    client: TestClient,
    settings: Settings,
    make_request,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Pipeline must not crash if backend is permanently down."""

    req = make_request(cleanup_id="callback-down")
    url = _callback_url(settings, req.cleanup_id)

    with respx.mock() as router:
        router.post(url).mock(return_value=httpx.Response(500))
        with caplog.at_level("WARNING", logger="app.callback"):
            response = client.post("/verify", json=_payload(req))
        assert response.status_code == 202

    assert any(
        "Callback exhausted retries" in rec.message and "callback-down" in rec.message
        for rec in caplog.records
    ), "Expected loud failure log when retries exhausted"


def test_callback_retries_then_succeeds(
    client: TestClient,
    settings: Settings,
    make_request,
) -> None:
    req = make_request(cleanup_id="retry-ok")
    url = _callback_url(settings, req.cleanup_id)

    with respx.mock(assert_all_called=True) as router:
        route = router.post(url)
        route.side_effect = [httpx.Response(503), httpx.Response(200)]
        response = client.post("/verify", json=_payload(req))
        assert response.status_code == 202

    assert route.call_count == 2


def test_callback_forwards_bearer_token(
    client: TestClient,
    settings: Settings,
    make_request,
) -> None:
    settings.backend_internal_token = "secret-token"
    req = make_request(cleanup_id="auth-check")
    url = _callback_url(settings, req.cleanup_id)

    with respx.mock(assert_all_called=True) as router:
        route = router.post(url).mock(return_value=httpx.Response(200))
        response = client.post("/verify", json=_payload(req))
        assert response.status_code == 202

    auth_header = route.calls.last.request.headers.get("authorization")
    assert auth_header == "Bearer secret-token"


@pytest.mark.parametrize(
    "broken_payload, missing_field",
    [
        ({}, "cleanup_id"),
        (
            {
                "cleanup_id": "",
                "submission_video_url": "https://x/y",
                "reference_video_url": "https://x/y",
                "bounty_lat": 0,
                "bounty_lng": 0,
                "gps_trajectory": [],
                "issued_nonce": "n",
                "session_duration_s": 1,
            },
            "cleanup_id",
        ),
        (
            {
                "cleanup_id": "ok",
                "submission_video_url": "not-a-url",
                "reference_video_url": "https://x/y",
                "bounty_lat": 0,
                "bounty_lng": 0,
                "gps_trajectory": [],
                "issued_nonce": "n",
                "session_duration_s": 1,
            },
            "submission_video_url",
        ),
        (
            {
                "cleanup_id": "ok",
                "submission_video_url": "https://x/y",
                "reference_video_url": "https://x/y",
                "bounty_lat": 999,
                "bounty_lng": 0,
                "gps_trajectory": [],
                "issued_nonce": "n",
                "session_duration_s": 1,
            },
            "bounty_lat",
        ),
    ],
    ids=["missing_all", "blank_cleanup_id", "bad_url", "bad_lat"],
)
def test_invalid_payload_returns_422(
    client: TestClient,
    broken_payload: dict[str, Any],
    missing_field: str,
) -> None:
    response = client.post("/verify", json=broken_payload)
    assert response.status_code == 422
    detail = json.dumps(response.json())
    assert missing_field in detail


def test_health_returns_richer_shape(client: TestClient) -> None:
    response = client.get("/health")
    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is True
    assert body["service"] == "ai-verifier"
    assert "timestamp" in body and "T" in body["timestamp"]


def test_health_does_not_require_backend(client: TestClient) -> None:
    """Health probe MUST NOT depend on backend reachability."""

    with respx.mock(assert_all_called=False) as router:
        # Any outbound call to the backend during /health would route through
        # respx and raise a "no matching route" assertion. Health is local-only.
        router.get("http://backend.test/").mock(return_value=httpx.Response(200))
        response = client.get("/health")
        assert router.calls.call_count == 0

    assert response.status_code == 200


# ---------------------------------------------------------------------------
# Interactive CLI runner
# ---------------------------------------------------------------------------


def _make_request_from_kwargs(kwargs: dict[str, Any]) -> VerifyRequest:
    """Materialize a VerifyRequest from scenario kwargs (CLI-side)."""

    bounty_lat = kwargs.get("bounty_lat", 34.0689)
    bounty_lng = kwargs.get("bounty_lng", -118.4452)
    raw_traj = kwargs.get("trajectory")
    if raw_traj is None:
        raw_traj = HAPPY_TRAJECTORY
    trajectory = [
        GpsPing(
            lat=p["lat"],
            lng=p["lng"],
            accuracy=p.get("accuracy"),
            timestamp=p["timestamp"],
        )
        for p in raw_traj
    ]
    return VerifyRequest(
        cleanup_id=kwargs.get("cleanup_id", "cli-cleanup"),
        submission_video_url=kwargs.get("sub_url", "https://example.com/sub.mp4"),
        reference_video_url=kwargs.get("ref_url", "https://example.com/ref.mp4"),
        bounty_lat=bounty_lat,
        bounty_lng=bounty_lng,
        gps_trajectory=trajectory,
        issued_nonce=kwargs.get("nonce", "cli-nonce"),
        session_duration_s=kwargs.get("duration_s", 600),
    )


def _run_one_cli(scenario: Scenario) -> dict[str, Any]:
    """Execute a single scenario in-process and return the captured callback body."""

    settings = Settings(
        backend_base_url="http://backend.cli",
        backend_internal_token=None,
        verification_confidence_threshold=0.85,
        bounty_radius_meters=75.0,
        min_session_duration_seconds=120,
        callback_max_retries=2,
        callback_initial_backoff_seconds=0.0,
    )

    from app import config as config_module

    original = config_module.get_settings
    config_module.get_settings = lambda: settings  # type: ignore[assignment]
    app.dependency_overrides[original] = lambda: settings

    saved_overrides: dict[str, Any] = {}
    for attr, fn in scenario.vision_overrides.items():
        saved_overrides[attr] = getattr(vision, attr)
        setattr(vision, attr, fn)

    try:
        req = _make_request_from_kwargs(scenario.request_kwargs)
        url = _callback_url(settings, req.cleanup_id)
        with respx.mock(assert_all_called=False) as router:
            route = router.post(url).mock(return_value=httpx.Response(200))
            with TestClient(app) as client:
                response = client.post("/verify", json=_payload(req))
            response.raise_for_status()
            if route.calls.last is None:
                return {"error": "no callback was sent"}
            return json.loads(route.calls.last.request.content)
    finally:
        for attr, original_fn in saved_overrides.items():
            setattr(vision, attr, original_fn)
        app.dependency_overrides.pop(original, None)
        config_module.get_settings = original  # type: ignore[assignment]


def _print_scenario(scenario: Scenario, body: dict[str, Any]) -> None:
    print(f"\n=== {scenario.name} ===")
    print(textwrap.fill(scenario.summary, width=88))
    print("Result:")
    print(json.dumps(body, indent=2))


def _cli_run_all() -> None:
    for scenario in SCENARIOS:
        body = _run_one_cli(scenario)
        _print_scenario(scenario, body)


def _cli_menu() -> None:
    print("Civic Bounty Verification Service – interactive demo")
    print("Pick a scenario by number, 'a' to run all, or 'q' to quit:\n")
    while True:
        for i, scenario in enumerate(SCENARIOS, start=1):
            print(f"  {i:2d}) {scenario.name:30s} {scenario.summary}")
        print("   a) all")
        print("   q) quit")
        choice = input("> ").strip().lower()
        if choice in {"q", "quit", "exit"}:
            return
        if choice in {"a", "all"}:
            _cli_run_all()
            continue
        try:
            idx = int(choice) - 1
            scenario = SCENARIOS[idx]
        except (ValueError, IndexError):
            print("Invalid choice. Try again.\n")
            continue
        body = _run_one_cli(scenario)
        _print_scenario(scenario, body)
        print()


def _cli_from_stdin() -> None:
    print("Paste a /verify JSON payload then press Ctrl+Z (Windows) / Ctrl+D and Enter:")
    raw = sys.stdin.read()
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as exc:
        print(f"Invalid JSON: {exc}", file=sys.stderr)
        sys.exit(2)
    cleanup_id = payload.get("cleanup_id", "cli-stdin")
    scenario = Scenario(
        name="stdin",
        summary="Custom payload from stdin",
        request_kwargs={
            "cleanup_id": cleanup_id,
            "sub_url": payload.get("submission_video_url", "https://example.com/sub.mp4"),
            "ref_url": payload.get("reference_video_url", "https://example.com/ref.mp4"),
            "bounty_lat": payload.get("bounty_lat", 34.0689),
            "bounty_lng": payload.get("bounty_lng", -118.4452),
            "trajectory": payload.get("gps_trajectory", HAPPY_TRAJECTORY),
            "nonce": payload.get("issued_nonce", "cli-nonce"),
            "duration_s": payload.get("session_duration_s", 600),
        },
    )
    body = _run_one_cli(scenario)
    _print_scenario(scenario, body)


def _entrypoint(argv: Iterable[str]) -> None:
    args = list(argv)
    if args == ["all"]:
        _cli_run_all()
    elif args and args[0] in {"--json", "-j", "stdin"}:
        _cli_from_stdin()
    elif not args:
        _cli_menu()
    else:
        print("Usage: python tests/test_end_to_end.py [all|--json]")
        sys.exit(2)


if __name__ == "__main__":
    asyncio.set_event_loop(asyncio.new_event_loop())
    _entrypoint(sys.argv[1:])
