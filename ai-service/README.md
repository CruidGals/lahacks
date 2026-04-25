# Civic Bounty Verification Service (Person 3B)

FastAPI service that orchestrates AI verification for completed cleanup bounties.

## What it does

`POST /verify` is called by the Node backend (Person 2) after a claimer submits a cleanup video. The service:

1. Validates the request and returns `202 Accepted` immediately (verification runs in the background).
2. Calls Person 3A's vision functions:
   - `check_scene_match(ref_url, sub_url, lat, lng)`
   - `check_task_complete(ref_url, sub_url)`
3. Aggregates fraud signals (nonce, GPS radius, session duration, static-frame, replay).
4. Computes a final verification decision (weighted confidence + gates).
5. Posts the result to the backend at `POST /cleanups/:cleanup_id/verification-result`.

## Local run

```bash
python -m venv .venv
. .venv/Scripts/Activate.ps1   # on Windows PowerShell
pip install -r requirements.txt
copy .env.example .env
uvicorn app.main:app --reload --port 8000
```

Health check:

```bash
curl http://localhost:8000/health
```

Trigger a verification (stub vision will return success by default):

```bash
curl -X POST http://localhost:8000/verify \
  -H "Content-Type: application/json" \
  -d '{
    "cleanup_id": "demo-1",
    "submission_video_url": "https://example.com/sub.mp4",
    "reference_video_url": "https://example.com/ref.mp4",
    "bounty_lat": 34.0689,
    "bounty_lng": -118.4452,
    "gps_trajectory": [
      {"lat": 34.0689, "lng": -118.4452, "accuracy": 5, "timestamp": 1700000000},
      {"lat": 34.06891, "lng": -118.44521, "accuracy": 5, "timestamp": 1700000200}
    ],
    "issued_nonce": "abc123",
    "session_duration_s": 600
  }'
```

## Run tests

```bash
pytest -q
```

## Object detection demo (with boxes)

Run a quick detection pass on a local video and generate an annotated preview:

```bash
PYTHONPATH=. python scripts/object_detection_demo.py ../data/videos/fixtures/270video.MOV
```

This writes `artifacts/annotated_preview.mp4` and prints top detected objects.

## Deployment

A `Dockerfile` is provided for Render / Fly / Railway. Set the env vars from `.env.example` in your deploy target.

## Contracts

See [`DESIGN_SPEC.md`](../DESIGN_SPEC.md) at the repo root for the locked request/response contracts and team-wide architecture.
