from fastapi.testclient import TestClient

from app.main import app


def test_health():
    client = TestClient(app)
    r = client.get("/health")
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert body["service"] == "ai-verifier"
    assert "timestamp" in body


def test_verify_returns_202_and_accepts_payload(monkeypatch):
    captured = {}

    async def fake_run(req, settings, callback=None):
        captured["cleanup_id"] = req.cleanup_id
        return None

    from app.api import routes as routes_module

    monkeypatch.setattr(routes_module, "run_verification", fake_run)

    payload = {
        "cleanup_id": "demo-1",
        "submission_video_url": "https://example.com/sub.mp4",
        "reference_video_url": "https://example.com/ref.mp4",
        "bounty_lat": 34.0689,
        "bounty_lng": -118.4452,
        "gps_trajectory": [
            {"lat": 34.0689, "lng": -118.4452, "accuracy": 5, "timestamp": 1700000000}
        ],
        "issued_nonce": "abc123",
        "session_duration_s": 600,
    }

    with TestClient(app) as client:
        r = client.post("/verify", json=payload)

    assert r.status_code == 202
    assert r.json() == {"cleanup_id": "demo-1", "status": "accepted"}
    assert captured.get("cleanup_id") == "demo-1"


def test_verify_rejects_invalid_payload():
    client = TestClient(app)
    r = client.post("/verify", json={"cleanup_id": ""})
    assert r.status_code == 422
