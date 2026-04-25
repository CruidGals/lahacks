import pytest

from app import vision
from app.verify_pipeline import run_verification


async def _noop_callback(_cleanup_id, _result, _settings):
    return True


@pytest.mark.asyncio
async def test_pipeline_happy_path(make_request, settings):
    req = make_request()
    result = await run_verification(req, settings, callback=_noop_callback)
    assert result.verified is True
    assert result.fraud_flags == []
    assert result.scene_match is True
    assert result.task_complete is True


@pytest.mark.asyncio
async def test_pipeline_scene_failure(make_request, settings):
    req = make_request(sub_url="https://example.com/fail-scene.mp4")
    result = await run_verification(req, settings, callback=_noop_callback)
    assert result.verified is False
    assert result.scene_match is False


@pytest.mark.asyncio
async def test_pipeline_task_failure(make_request, settings):
    req = make_request(sub_url="https://example.com/fail-task.mp4")
    result = await run_verification(req, settings, callback=_noop_callback)
    assert result.verified is False
    assert result.task_complete is False


@pytest.mark.asyncio
async def test_pipeline_fraud_blocks_verification(make_request, settings):
    req = make_request(duration_s=10)  # too short
    result = await run_verification(req, settings, callback=_noop_callback)
    assert result.verified is False
    assert "session_too_short" in result.fraud_flags


@pytest.mark.asyncio
async def test_pipeline_callback_failure_does_not_raise(make_request, settings):
    async def bad_cb(_cid, _r, _s):
        return False

    req = make_request()
    result = await run_verification(req, settings, callback=bad_cb)
    assert result.verified is True


@pytest.mark.asyncio
async def test_pipeline_callback_exception_does_not_raise(make_request, settings):
    async def boom(_cid, _r, _s):
        raise RuntimeError("backend down")

    req = make_request()
    result = await run_verification(req, settings, callback=boom)
    assert result.verified is True
