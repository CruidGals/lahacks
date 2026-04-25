import pytest

from app import fraud, vision
from app.models import GpsPing


@pytest.mark.asyncio
async def test_no_flags_for_healthy_request(make_request, settings):
    req = make_request()
    report = await fraud.aggregate_fraud_signals(req, settings)
    assert report.flags == []


@pytest.mark.asyncio
async def test_short_session_flagged(make_request, settings):
    req = make_request(duration_s=30)
    report = await fraud.aggregate_fraud_signals(req, settings)
    assert fraud.FLAG_SESSION_TOO_SHORT in report.flags


@pytest.mark.asyncio
async def test_empty_trajectory_flagged(make_request, settings):
    req = make_request(trajectory=[])
    report = await fraud.aggregate_fraud_signals(req, settings)
    assert fraud.FLAG_NO_GPS_DATA in report.flags


@pytest.mark.asyncio
async def test_trajectory_outside_radius_flagged(make_request, settings):
    far = [
        GpsPing(lat=40.0, lng=-100.0, accuracy=5.0, timestamp=1.0),
        GpsPing(lat=40.0001, lng=-100.0001, accuracy=5.0, timestamp=2.0),
    ]
    req = make_request(trajectory=far)
    report = await fraud.aggregate_fraud_signals(req, settings)
    assert fraud.FLAG_TRAJECTORY_OUTSIDE_RADIUS in report.flags


@pytest.mark.asyncio
async def test_nonce_mismatch_flagged(monkeypatch, make_request, settings):
    async def fake_extract(_url):
        return "different-nonce"

    monkeypatch.setattr(vision, "extract_nonce_from_video", fake_extract)
    req = make_request(nonce="expected-nonce")
    report = await fraud.aggregate_fraud_signals(req, settings)
    assert fraud.FLAG_NONCE_MISMATCH in report.flags


@pytest.mark.asyncio
async def test_nonce_match_not_flagged(monkeypatch, make_request, settings):
    async def fake_extract(_url):
        return "matching-nonce"

    monkeypatch.setattr(vision, "extract_nonce_from_video", fake_extract)
    req = make_request(nonce="matching-nonce")
    report = await fraud.aggregate_fraud_signals(req, settings)
    assert fraud.FLAG_NONCE_MISMATCH not in report.flags


@pytest.mark.asyncio
async def test_nonce_unknown_skipped(make_request, settings):
    # Default vision.extract_nonce_from_video returns None.
    req = make_request()
    report = await fraud.aggregate_fraud_signals(req, settings)
    assert fraud.FLAG_NONCE_MISMATCH not in report.flags


@pytest.mark.asyncio
async def test_static_video_flagged(monkeypatch, make_request, settings):
    async def fake_static(_url):
        return True

    monkeypatch.setattr(vision, "is_static_video", fake_static)
    req = make_request()
    report = await fraud.aggregate_fraud_signals(req, settings)
    assert fraud.FLAG_STATIC_FRAME_SUSPECTED in report.flags


@pytest.mark.asyncio
async def test_replay_flagged(monkeypatch, make_request, settings):
    async def fake_replay(_ref, _sub):
        return True

    monkeypatch.setattr(vision, "looks_like_replay", fake_replay)
    req = make_request()
    report = await fraud.aggregate_fraud_signals(req, settings)
    assert fraud.FLAG_REPLAY_SUSPECTED in report.flags


@pytest.mark.asyncio
async def test_optional_helper_error_does_not_raise(monkeypatch, make_request, settings):
    async def boom(_url):
        raise RuntimeError("vision broke")

    monkeypatch.setattr(vision, "is_static_video", boom)
    req = make_request()
    report = await fraud.aggregate_fraud_signals(req, settings)
    assert fraud.FLAG_STATIC_FRAME_SUSPECTED not in report.flags
