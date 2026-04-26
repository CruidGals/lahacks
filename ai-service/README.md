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
# create ai-service/.env with at least OPENAI_API_KEY (see app/config.py for all knobs)
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

## Stage 1: posting-time spec extraction

`POST /pipelines/spec/candidates` runs broad-prompt Grounding DINO + an IoU
tracker on the requester's reference video and returns a list of unique
*candidate* objects (label, peak bbox, peak confidence, hit count) plus
preview frames with numbered overlay boxes burned in.

```bash
curl -X POST http://localhost:8000/pipelines/spec/candidates \
  -H "Content-Type: application/json" \
  -d '{ "video_url": "https://example.com/reference.mp4" }'
```

The requester reviews the candidates in the UI:

* Tap a numbered box -> add its `candidate_id` to `removed_candidate_ids`.
* Tap an empty area -> append a `manual_items` entry (rough box + label).

`POST /pipelines/spec/confirm` then materializes the final
`GroundTruthSpec` (one entry per confirmed item, even if labels repeat) and
returns the deduped `categories` list — that's the prompt Stage 2 hands to
Grounding DINO at submission time. After this call the reference video is no
longer needed.

```bash
PYTHONPATH=. python3 scripts/spec_demo.py ../data/videos/fixtures/egRequest.MOV
```

The demo writes a timestamped `artifacts/spec-runs/<ts>/` folder with
`candidates.json`, the raw + annotated preview JPEGs, and a
`ground_truth.json` that approves every candidate (handy smoke test).

Tunables (see `app/config.py`): `SPEC_BROAD_PROMPT`,
`SPEC_SAMPLE_EVERY_N_FRAMES`, `SPEC_MAX_SAMPLES`, `SPEC_PREVIEW_FRAMES`,
`SPEC_IOU_THRESHOLD`, `SPEC_MIN_TRACK_HITS`.

## Object detection demo (with boxes)

Run a quick detection pass on a local video and generate an annotated preview:

```bash
PYTHONPATH=. python scripts/object_detection_demo.py ../data/videos/fixtures/270video.MOV
```

This writes `artifacts/annotated_preview.mp4` and prints top detected objects.

To run Grounding DINO via Replicate for comparison logic:

```bash
pip install replicate
export REPLICATE_API_TOKEN=...
export VISION_DETECTOR_BACKEND=grounding_dino
PYTHONPATH=. python scripts/object_detection_demo.py ../data/videos/fixtures/egRequest.MOV --backend grounding_dino --query "trash . litter . garbage . bottle . can . bag"
```

## Deployment

A `Dockerfile` is provided for Render / Fly / Railway. Set the env vars defined in `app/config.py` (`OPENAI_API_KEY`, `BACKEND_BASE_URL`, `VISION_DETECTOR_BACKEND`, etc.) in your deploy target.

## Contracts

See [`DESIGN_SPEC.md`](../DESIGN_SPEC.md) at the repo root for the locked request/response contracts and team-wide architecture.
