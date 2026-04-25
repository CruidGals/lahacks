"""Shared test fixtures."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

# Ensure `app` package is importable when running `pytest` from repo root.
ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.config import Settings, get_settings  # noqa: E402
from app.models import GpsPing, VerifyRequest  # noqa: E402


@pytest.fixture()
def settings() -> Settings:
    return Settings(
        backend_base_url="http://backend.test",
        backend_internal_token=None,
        verification_confidence_threshold=0.85,
        bounty_radius_meters=75.0,
        min_session_duration_seconds=120,
        callback_max_retries=2,
        callback_initial_backoff_seconds=0.01,
    )


@pytest.fixture(autouse=True)
def _override_settings(settings: Settings):
    """Make `app.config.get_settings()` (and FastAPI Depends) return the test settings."""

    from app import config as config_module
    from app.main import app

    get_settings.cache_clear()
    original = config_module.get_settings

    def _factory() -> Settings:
        return settings

    config_module.get_settings = _factory  # type: ignore[assignment]
    app.dependency_overrides[original] = _factory
    try:
        yield
    finally:
        config_module.get_settings = original  # type: ignore[assignment]
        app.dependency_overrides.pop(original, None)
        get_settings.cache_clear()


def _ping(lat: float, lng: float, ts: float = 1700000000.0) -> GpsPing:
    return GpsPing(lat=lat, lng=lng, accuracy=5.0, timestamp=ts)


@pytest.fixture()
def make_request():
    def _make(
        *,
        cleanup_id: str = "cleanup-1",
        sub_url: str = "https://example.com/sub.mp4",
        ref_url: str = "https://example.com/ref.mp4",
        bounty_lat: float = 34.0689,
        bounty_lng: float = -118.4452,
        trajectory: list[GpsPing] | None = None,
        nonce: str = "nonce-xyz",
        duration_s: int = 600,
    ) -> VerifyRequest:
        if trajectory is None:
            trajectory = [
                _ping(bounty_lat, bounty_lng, 1700000000.0),
                _ping(bounty_lat + 0.0001, bounty_lng + 0.0001, 1700000300.0),
                _ping(bounty_lat - 0.0001, bounty_lng - 0.0001, 1700000600.0),
            ]
        return VerifyRequest(
            cleanup_id=cleanup_id,
            submission_video_url=sub_url,
            reference_video_url=ref_url,
            bounty_lat=bounty_lat,
            bounty_lng=bounty_lng,
            gps_trajectory=trajectory,
            issued_nonce=nonce,
            session_duration_s=duration_s,
        )

    return _make
