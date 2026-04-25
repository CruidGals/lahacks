# Person 3B Action Log

A detailed record of every step taken to build the Civic Bounty Verification Service.
Newest entries at the bottom of each section.

## Scope summary

Person 3B owns:
- FastAPI service with `POST /verify` and `GET /health`.
- Async background orchestration of Person 3A's vision functions plus our fraud aggregator and scoring.
- Retrying webhook callback to the Node backend at `POST /cleanups/:cleanup_id/verification-result`.

Out of scope (owned by Person 3A): Claude vision, frame extraction, OCR for nonce, static-frame and replay detection. Person 3A's module lives at `app/vision.py`; we ship safe stubs so 3B can ship and demo independently.

---

## Step-by-step actions

### 1. Repo discovery
- Inspected repo root: only `frontend/` (Next.js scaffold) and `.git`.
- Confirmed no existing backend or AI service. Created a sibling `ai-service/` directory for Person 3B's work.

### 2. Project scaffolding
- Wrote `requirements.txt` pinning FastAPI 0.115, Uvicorn 0.30.6, Pydantic 2.9.2, pydantic-settings 2.5.2, httpx 0.27.2, pytest 8.3.3, pytest-asyncio 0.24.0, respx 0.21.1.
- Wrote `.env.example` documenting every tunable env var (backend URL, threshold, radius, retries, etc.).
- Wrote `.gitignore` for venv / pytest / dotenv noise.
- Wrote `Dockerfile` (Python 3.11-slim) so we can deploy to Render / Fly / Railway with one click.
- Wrote `README.md` with run + curl instructions and deployment notes.

### 3. Configuration layer
- `app/config.py` defines a `Settings` model using `pydantic-settings`.
- All values overridable from env: `BACKEND_BASE_URL`, `BACKEND_INTERNAL_TOKEN`, `VERIFICATION_CONFIDENCE_THRESHOLD` (0.85), `BOUNTY_RADIUS_METERS` (75), `MIN_SESSION_DURATION_SECONDS` (120), `CALLBACK_MAX_RETRIES` (3), `CALLBACK_INITIAL_BACKOFF_SECONDS` (1.0), `LOG_LEVEL`.
- Cached via `@lru_cache` so all callers share one instance.

### 4. Data contracts (locked with Person 2)
- `app/models.py` defines:
  - `GpsPing(lat, lng, accuracy?, timestamp)`
  - `VerifyRequest(cleanup_id, submission_video_url, reference_video_url, bounty_lat, bounty_lng, gps_trajectory, issued_nonce, session_duration_s)`
  - `VerifyAccepted(cleanup_id, status="accepted")` (sync 202 response)
  - `SceneMatchResult(same_location, matching_features, confidence)` matching Person 3A's signature
  - `TaskCompleteResult(task_complete, items, confidence)` matching Person 3A's signature
  - `VerificationResult(verified, confidence, scene_match, task_complete, fraud_flags, reasoning)` (final webhook payload)

### 5. Geospatial helpers
- `app/geo.py` ships `haversine_meters`, `trajectory_within_radius_pct`, `trajectory_avg_distance_m`. Used by fraud rules and could be reused by Person 2 for trajectory analysis at the backend.

### 6. Person 3A integration surface
- `app/vision.py` ships **stub** implementations of:
  - `check_scene_match(ref, sub, lat, lng) -> SceneMatchResult`
  - `check_task_complete(ref, sub) -> TaskCompleteResult`
  - Optional helpers Person 3A may implement later: `extract_nonce_from_video`, `is_static_video`, `looks_like_replay`. Each returns a "neutral" value by default; missing implementations never produce false positives.
- Stubs are deterministic: substring `fail-scene` in `submission_video_url` makes scene-match fail; `fail-task` makes task-complete fail. Lets us drive happy/sad paths in tests and demos without real vision.

### 7. Fraud aggregator
- `app/fraud.py` runs five independent rules and returns a `FraudReport(flags, notes)`:
  - `session_too_short` if `session_duration_s < MIN_SESSION_DURATION_SECONDS`.
  - `no_gps_data` if trajectory is empty.
  - `trajectory_outside_radius` if < 50% of pings are within `BOUNTY_RADIUS_METERS`.
  - `nonce_mismatch` only when `extract_nonce_from_video` returns a value AND it differs from the issued nonce (silent skip otherwise).
  - `static_frame_suspected` when `is_static_video` returns True.
  - `replay_similarity_suspected` when `looks_like_replay` returns True.
- Optional helpers are wrapped in `try/except` so a Person 3A bug never crashes verification — the failure is logged in `notes` instead.

### 8. Final scoring
- `app/scoring.py` computes `combined_confidence = 0.5*scene + 0.5*task` and returns `VerificationResult`.
- `verified = True` only when ALL hold:
  1. `combined_confidence > VERIFICATION_CONFIDENCE_THRESHOLD` (default 0.85)
  2. `scene.same_location is True`
  3. `task.task_complete is True`
  4. `fraud_flags` is empty
- Always emits a human-readable `reasoning` string for backend display and demo storytelling.

### 9. Backend callback
- `app/callback.py` POSTs the final result to `BACKEND_BASE_URL/cleanups/{id}/verification-result`.
- Adds `Authorization: Bearer ...` only when `BACKEND_INTERNAL_TOKEN` is set.
- Retries with exponential backoff (`CALLBACK_MAX_RETRIES`, base `CALLBACK_INITIAL_BACKOFF_SECONDS`).
- Returns `False` on exhaustion so the pipeline can log loudly; we never lose a result silently.
- Exposes `client: httpx.AsyncClient | None` so tests can inject a mock client; `respx` is used in tests.

### 10. Pipeline orchestration
- `app/verify_pipeline.py::run_verification` runs the two vision checks and the fraud aggregator concurrently with `asyncio.create_task`, then scores, then calls the injected callback (default = real backend webhook).
- Wraps callback in try/except so any backend hiccup is logged but never crashes the FastAPI background task worker.
- Returns the computed `VerificationResult` for tests.

### 11. FastAPI entrypoint
- `app/main.py` exposes:
  - `GET /health` → `{"status": "ok"}`.
  - `POST /verify` → 202 with `{cleanup_id, status: "accepted"}`; queues `run_verification` via `BackgroundTasks`.
- Uses the modern `lifespan` context manager for logging setup (FastAPI deprecated `on_event`).

### 12. Test suite (36 tests, all green)
- `tests/conftest.py`: shared `settings` fixture and a `make_request` factory; an `_override_settings` autouse fixture rewires `app.config.get_settings` AND `app.dependency_overrides` so `Depends(get_settings)` in FastAPI uses the test instance.
- `tests/test_geo.py`: 6 tests for haversine + trajectory ratio.
- `tests/test_fraud.py`: 10 tests covering happy path + every flag (short session, no GPS, outside radius, nonce match/mismatch/unknown, static frame, replay, optional-helper crash).
- `tests/test_scoring.py`: 6 tests covering weighted average, threshold, fraud-gate, scene-gate, task-gate.
- `tests/test_pipeline.py`: 6 tests for happy path, scene failure, task failure, fraud blocks pass, callback failure (returns False), callback exception (raises).
- `tests/test_callback.py`: 5 tests using `respx` to mock backend (success, retry-then-success, retries exhausted, bearer header, URL format).
- `tests/test_api.py`: 3 FastAPI `TestClient` tests for `/health`, `/verify` 202 (with `monkeypatch` of pipeline), and 422 on invalid input.
- `pytest.ini`: `asyncio_mode = auto`, `asyncio_default_fixture_loop_scope = function`, warning filters.

### 13. Local installation + smoke test
- Created `.venv` with Python 3.13.
- Installed pinned requirements (all wheels available for Python 3.13).
- Initial pytest run: 36 errors due to:
  1. Test settings used `callback_initial_backoff_seconds=0.01`, but constraint was `ge=0.1`. Relaxed to `ge=0.0` (validation still bounded by `>= 0.0` for any negative-time abuse).
  2. `@app.on_event("startup")` deprecated. Migrated to `lifespan` context manager.
  3. The autouse settings override needed to also patch `app.config.get_settings` (not just the lru-cache wrapper) and FastAPI's `dependency_overrides`. Reworked the fixture.
- Re-ran pytest: **36 passed in 0.58s**.
- Started `uvicorn app.main:app --port 8765` in the background.
  - `GET /health` → `{"status":"ok"}`.
  - `POST /verify` → `202 {"cleanup_id":"demo-1","status":"accepted"}`.
- Killed the smoke-test process (pid 57712) and re-ran the suite: still 36 passing.

---

## File index (Person 3B)

```
ai-service/
├── ACTION_LOG.md            <- this file
├── README.md
├── Dockerfile
├── pytest.ini
├── requirements.txt
├── .env.example
├── .gitignore
├── app/
│   ├── __init__.py
│   ├── main.py              <- FastAPI app, /health, /verify
│   ├── config.py            <- Settings (env-driven, lru-cached)
│   ├── models.py            <- Pydantic contracts (locked)
│   ├── geo.py               <- haversine + trajectory helpers
│   ├── vision.py            <- Person 3A stubs + integration surface
│   ├── fraud.py             <- 5 fraud rules
│   ├── scoring.py           <- weighted confidence + decision
│   ├── callback.py          <- retrying backend webhook client
│   └── verify_pipeline.py   <- orchestrator
└── tests/
    ├── __init__.py
    ├── conftest.py
    ├── test_api.py
    ├── test_callback.py
    ├── test_fraud.py
    ├── test_geo.py
    ├── test_pipeline.py
    └── test_scoring.py
```

## How to run locally

```powershell
cd ai-service
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
copy .env.example .env
uvicorn app.main:app --reload --port 8000
```

## How to run tests

```powershell
.\.venv\Scripts\python.exe -m pytest -q
```

## Outstanding work (handoff items)

- **Person 3A**: replace the stub bodies in `app/vision.py`. Optional helpers (`extract_nonce_from_video`, `is_static_video`, `looks_like_replay`) light up the matching fraud flags as soon as they're implemented; no Person 3B code needs to change.
- **Person 2 backend**: implement `POST /cleanups/:cleanup_id/verification-result` that accepts the JSON in the locked `VerificationResult` schema and triggers Solana payout on `verified=true`.
- **Demo prep**: pick `BACKEND_BASE_URL` for the deployed environment and (if used) set `BACKEND_INTERNAL_TOKEN`. Drop any of `fail-scene` / `fail-task` into the submission URL during demo to force the failure path.
- **Stretch**: swap `BackgroundTasks` for a Redis/RQ worker if we move past hackathon scope and need durable retries across restarts.

---

## Merge log: Person 3A pull (Apr 25, 5:15 PM)

### What landed in `ai-service/`
- `app/api/routes.py` — a parallel scaffold APIRouter with its own `/health` (`{"ok": True, ...}`) and a `/verify` TODO endpoint using a different request shape (`bounty_id`, `claim_id`, `gps_points: list[dict]`).
- `tests/test_health.py` — asserts `response.json()["ok"] is True`.
- `.env.example` — `AI_SERVICE_PORT=8001` and `CLAUDE_API_KEY=` added at the top.
- Person 3A did **not** replace the vision stubs in `app/vision.py` yet; those are still mine.

### Compatibility issues found
1. `app/api/routes.py` was never registered with the FastAPI app (dead code) and would have collided with my `/verify` and `/health` if it had been.
2. The new `tests/test_health.py` would have **failed** against my old `{"status":"ok"}` shape.
3. `BACKEND_BASE_URL` defaulted to `localhost:3000` but Person 2's backend (`backend/src/index.ts`) listens on `8080`.
4. `Settings` model didn't accept `AI_SERVICE_PORT` / `CLAUDE_API_KEY` (silently ignored via `extra="ignore"`, but undocumented).
5. Backend doesn't yet expose `/cleanups/:cleanup_id/verification-result` — my callback would 404 in real deployments. Out of my scope, called out in DESIGN_SPEC.md.

### Fixes applied
- Created `app/api/__init__.py` and rewrote `app/api/routes.py` as the **single registered router**, using my locked `VerifyRequest`/`VerificationResult` contract and wiring in the real `run_verification` background task.
- Adopted Person 3A's richer `/health` shape `{"ok": True, "service": "ai-verifier", "timestamp": ...}` so `tests/test_health.py` passes (also matches `backend/src/routes/health.ts`).
- Slimmed `app/main.py` to instantiate FastAPI + `app.include_router(api_router)`.
- Added `ai_service_port` and `claude_api_key` to `Settings`; changed `backend_base_url` default to `http://localhost:8080`.
- Updated `.env.example` (`BACKEND_BASE_URL=http://localhost:8080`).
- Updated my old `tests/test_api.py::test_health` to match the new shape.
- Wrote `tests/test_end_to_end.py` — comprehensive driver covering 10 scenarios via HTTP + respx-mocked backend, plus an interactive CLI mode (`python tests/test_end_to_end.py [all|--json]`).

### Result
- All **56 tests pass** (`pytest -q`): geo (6), fraud (10), scoring (6), pipeline (6), callback (5), api (3), health (1), end-to-end (19).
- Live smoke test still passes (`GET /health`, `POST /verify`).
- Interactive demo runner walks through happy + 9 failure scenarios with full callback payloads printed.
