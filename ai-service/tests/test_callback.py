import httpx
import pytest
import respx

from app.callback import callback_url, post_verification_result
from app.models import VerificationResult


def _result() -> VerificationResult:
    return VerificationResult(
        verified=True,
        confidence=0.9,
        scene_match=True,
        task_complete=True,
        fraud_flags=[],
        reasoning="ok",
    )


def test_callback_url_format(settings):
    assert callback_url(settings, "abc") == "http://backend.test/cleanups/abc/verification-result"


@pytest.mark.asyncio
async def test_post_succeeds_on_first_try(settings):
    url = callback_url(settings, "abc")
    with respx.mock(assert_all_called=True) as router:
        router.post(url).mock(return_value=httpx.Response(200, json={"ok": True}))
        ok = await post_verification_result("abc", _result(), settings)
    assert ok is True


@pytest.mark.asyncio
async def test_post_retries_then_succeeds(settings):
    url = callback_url(settings, "abc")
    with respx.mock(assert_all_called=True) as router:
        route = router.post(url)
        route.side_effect = [
            httpx.Response(500),
            httpx.Response(200, json={"ok": True}),
        ]
        ok = await post_verification_result("abc", _result(), settings)
    assert ok is True


@pytest.mark.asyncio
async def test_post_exhausts_retries_returns_false(settings):
    url = callback_url(settings, "abc")
    with respx.mock(assert_all_called=True) as router:
        router.post(url).mock(return_value=httpx.Response(500))
        ok = await post_verification_result("abc", _result(), settings)
    assert ok is False


@pytest.mark.asyncio
async def test_post_includes_bearer_when_configured(settings):
    settings.backend_internal_token = "secret-token"
    url = callback_url(settings, "abc")
    with respx.mock(assert_all_called=True) as router:
        route = router.post(url).mock(return_value=httpx.Response(200))
        await post_verification_result("abc", _result(), settings)
        assert route.calls.last.request.headers["Authorization"] == "Bearer secret-token"
