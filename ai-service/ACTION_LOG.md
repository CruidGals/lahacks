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

## Phase 2 — LLM vision pipelines (Person A / Person B / disposal proof)

The original Person 3B service shipped with `/verify` calling stub vision functions. Phase 2 adds three real LLM-driven pipelines that actually look at the videos:

- **Person A (reference)** — requester's "before" video → DINO detections → annotated frames → LLM → parseable `ReferenceSpec`.
- **Person B (cleanup)** — cleaner's "after" video runs through the SAME pipeline as Person A *independently*, producing a `submission_spec`. A second LLM call then compares both videos + both DINO outputs + both pipeline specs and emits a `CleanupVerdict`.
- **Disposal proof** — short clip of the cleaner depositing trash → LLM-only check (no DINO) → `DisposalVerdict`.

All three share one `OpenAIPipelineClient` so swapping models is one env var. `PIPELINE_USE_STUB=true` makes every LLM call a deterministic stub for offline dev / tests.

### 14. Configuration extensions
- Added to `requirements.txt`: `opencv-python==4.10.0.84`, `pillow==11.0.0`, `openai==1.54.4`, `replicate` (latest, used by the Grounding DINO backend after the merge).
- Added to `app/config.py`:
  - `openai_api_key: str | None`
  - `openai_model: str = "gpt-5.4-mini"` (the model the project standardized on; the LLM client falls back to `max_tokens` for older models that don't accept `max_completion_tokens`).
  - `openai_max_tokens: int = 2000` (128–16000)
  - `pipeline_frames_per_video: int = 5` (1–30)
  - `pipeline_use_stub: bool = False`
- Mirrored those keys in `.env` (the live secrets file). The repo no longer carries any `.env.example` files — see step 27.

### 15. Shared LLM client + prompt helpers — `app/pipelines/llm_client.py`
- `OpenAIPipelineClient.call_json(request, schema, *, stub_factory, max_retries=1)`:
  - Returns `stub_factory()` when `PIPELINE_USE_STUB=true`.
  - Raises `LLMConfigError` when stub is off but `OPENAI_API_KEY` is missing.
  - One JSON-mode chat call with `response_format={"type": "json_object"}`; on `ValidationError`/`ValueError`, sharpens the system prompt and retries once.
  - `_call_once` tries `max_completion_tokens` first (required by gpt-5.x / o-series) and transparently falls back to `max_tokens` for legacy models. Lazy-imports `openai` so stub-mode tests don't pay the import cost.
  - Async client built with `timeout=180.0, max_retries=2` because real vision calls with 5 multi-MB frames routinely take 30–60 s; the SDK default 60 s deadline triggered `APITimeoutError` mid-flight.
- Helpers reused by every pipeline: `VisionImage`, `LLMRequest`, `render_json_block(label, payload)`, `join_text_blocks(blocks)`.

### 16. DINO contract types — `app/pipelines/dino_types.py`
- `Bbox(x, y, w, h)` — top-left + size, all floats.
- `Detection(label, confidence, bbox)`.
- `FrameDetections(timestamp_s, frame_index, detections)`.
- `DinoOutput(video_url, duration_s, width, height, frames, summary)` — `summary` is a `Counter`-style `dict[str, int]` of label totals so the LLM gets both bbox-level detail and aggregate context. `with_recomputed_summary()` rebuilds `summary` from `frames` when needed.

### 17. Frame extraction + annotator
- `app/pipelines/frame_extractor.py`:
  - `extract_frames(video, frames_per_video, *, settings)` accepts URL / `Path` / `bytes`. Downloads URLs to a temp file, samples evenly-spaced frames with OpenCV, encodes JPEG bytes + base64.
  - `_evenly_spaced_indices(n, total_frames)` — picks `n` frames guaranteeing both endpoints when possible, deduplicates when `n > total_frames`.
  - `make_placeholder_frames(n, label)` — deterministic 1×1 JPEGs used by stub mode + tests so we never touch OpenCV.
- `app/pipelines/annotator.py`:
  - `annotate_frame(frame, detections)` draws bboxes + labels via PIL on a base64-decoded JPEG and returns a new base64 JPEG suitable for `image_url` content parts.
  - `annotate_frames(frames, dino_frames)` matches each extracted frame to the closest `FrameDetections` by timestamp and annotates it. Returns `ExtractedFrame` records with `jpeg_b64` carrying the annotated image.

### 18. Three pipeline modules

#### 18.1 `app/pipelines/reference_pipeline.py` — Person A
- Output schema:
  - `TrashItem(item_id, description, label, location_hint, estimated_count)`.
  - `ReferenceSpec(site_summary, items, cleanup_success_criteria, raw_dino_summary, annotated_frames_b64)`. `annotated_frames_b64` is attached post-call so the LLM never has to emit huge base64 blobs.
- `run_reference_pipeline(video, dino=None, settings=None, client=None)`:
  - If `dino` is `None` and not in stub mode, calls `build_dino_output_from_video(video)` (see step 22) so the caller can hand in *just* a video.
  - Stub mode: returns `_stub_spec` with placeholder frames; if DINO summary is empty, emits a single `unknown` placeholder item.
  - Real mode: extracts + annotates frames, builds an `LLMRequest` carrying the system prompt + both human-readable JSON blocks (DINO summary + per-frame detections) + the annotated frames, calls `OpenAIPipelineClient.call_json(...)`, then `model_copy`s the b64 frames + `raw_dino_summary` onto the result.

#### 18.2 `app/pipelines/cleanup_pipeline.py` — Person B
- Output schema:
  - `ItemResolution(item_id, still_present, confidence, notes)`.
  - `CleanupVerdict(cleanup_complete, confidence, items, leftover_count, reasoning, submission_spec)` with a `model_validator` that flips `cleanup_complete` to false if the LLM contradicts itself by listing `still_present=true` items while claiming completion.
- `run_cleanup_pipeline(reference_video, submission_video, reference_spec, ...)`:
  1. **Independent DINO** — auto-runs the configured detector on each video unless `reference_dino` / `submission_dino` were supplied.
  2. **Independent submission analysis** — calls `run_reference_pipeline(video=submission_video, dino=submission_dino)` so the cleaner's video is described on its own terms, with no reference data leakage. The result is the `submission_spec`.
  3. **Comparison LLM call** — ships both videos' annotated frames + both DINO summaries + both pipeline specs to the LLM with a prompt that explicitly labels `REFERENCE pipeline output` vs `SUBMISSION pipeline output (independent analysis of AFTER video)` and asks the model to cite both in its `notes` and `reasoning`. Result is post-decorated with `submission_spec` so callers can introspect both analyses without a second round-trip.
- Stub mode: heuristic — an item is "cleared" if its label dropped to 0 in the submission DINO summary.

#### 18.3 `app/pipelines/disposal_pipeline.py` — disposal proof
- Output schema: `DisposalVerdict(deposited_into_bin, container_type, confidence, reasoning)`.
- `run_disposal_pipeline(video, settings=None, client=None)`:
  - Frame extraction only — no DINO.
  - LLM prompt asks: was a bag/object visibly released into a trash can / dumpster / recycling bin in the clip? Strict JSON output.
  - Stub mode: deterministic `deposited_into_bin=true, confidence=0.8`.

### 19. Standalone HTTP endpoints — `app/api/routes.py`
Mounted under `/pipelines` so `/verify` is unaffected:

- `POST /pipelines/reference` body `{video_url, dino?}` → `ReferenceSpec`.
- `POST /pipelines/cleanup` body `{reference_video_url, submission_video_url, reference_spec, reference_dino?, submission_dino?}` → `CleanupVerdict`.
- `POST /pipelines/disposal` body `{video_url}` → `DisposalVerdict`.

All three return `400 LLMConfigError` when `OPENAI_API_KEY` is missing in non-stub mode and `502 LLMResponseError` on malformed LLM JSON. `dino` and `*_dino` fields are optional — when missing, the adapter (step 22) computes them server-side.

### 20. Tests + interactive CLI
- `tests/fixtures/dino_reference_sample.json`, `dino_submission_sample.json`, `dino_clean_submission_sample.json` (loaded via `tests/fixtures/__init__.py`) drive deterministic stub flows.
- `tests/test_pipelines.py` — 24 tests covering: DINO type validation + summary recompute, frame extractor index math + placeholder frames, annotator output shape, LLM client (stub mode, missing key, retry on bad JSON), all three `run_*_pipeline` happy paths in stub mode, `CleanupVerdict` validator self-correction, and FastAPI endpoint integration (200 OK + 400 on missing key).
- `tests/test_pipelines_cli.py` — interactive CLI driver (`python tests/test_pipelines_cli.py all` etc.) plus 5 pytest checks that run each demo in stub mode and assert key output strings show up. Useful for hackathon demos where an evaluator wants to see one pipeline run live.

### 21. Repo merge with Person 3A's DINO branch (commit `f8507cb`)
The 3A branch had landed in the meantime; auditing the `git status` mid-merge:

- `app/object_detection.py` — full OpenCV/MobileNet-SSD detector + Grounding DINO over Replicate, with `summarize_video_objects` / `summarize_video_objects_grounding_dino` returning a `DetectionSummary` of aggregate label counts. Includes IoU tracker, demo overlay video writer.
- `app/vision.py` — `check_task_complete` now uses the OpenCV detector instead of the stub when `VISION_DETECTOR_BACKEND=opencv`.
- New scripts `scripts/grounding_overlay_demo.py` and `scripts/object_detection_demo.py`.
- Dependencies grew (`opencv-python`, `pillow`, `replicate`).

Conflicts noted and resolved (no force pushes):

1. **`.env.example`** — the merge dropped my OpenAI / pipeline entries. Restored `OPENAI_API_KEY`, `OPENAI_MODEL`, `OPENAI_MAX_TOKENS`, `PIPELINE_FRAMES_PER_VIDEO`, `PIPELINE_USE_STUB` so anyone copying it from history would get a complete template. Later removed the file entirely (step 22).
2. **DINO contract gap** — the merged helpers return aggregate counts but no per-frame bboxes. The pipelines need bbox-level data to draw the demo overlays and to give the LLM granular evidence. Built an adapter (next step) instead of patching 3A's API.
3. `replicate` was missing a version pin in `requirements.txt`; left unpinned to match the merged baseline.

After the merge, `pytest -q` was rerun and all 66 tests still passed.

### 22. DINO adapter — `app/pipelines/dino_adapter.py`
Bridges 3A's per-frame primitives (`detect_objects_in_frame`, `_detect_objects_grounding_dino`) with the pipelines' `DinoOutput` contract.

- `build_dino_output_from_video(video, *, settings, sample_every=30, max_samples=12)`:
  - Normalizes URL / `Path` / `bytes` to a local file.
  - Samples frames with OpenCV, captures `(width, height, fps, duration)` metadata.
  - When `settings.vision_detector_backend == "grounding_dino"`, runs Replicate's Grounding DINO per sampled frame (uses `cleanup_target_query`, `grounding_dino_model`, `grounding_dino_box_threshold`, `grounding_dino_text_threshold`).
  - Otherwise runs `detect_objects_in_frame` (OpenCV / MobileNet-SSD) inside `asyncio.to_thread`.
  - Clamps each box, drops degenerate ones, and packs everything into `Bbox` / `Detection` / `FrameDetections` / `DinoOutput` with a recomputed label-count `summary`.
- This is purely additive — `app/object_detection.py` is untouched.
- Re-exported via `app/pipelines/__init__.py` as `build_dino_output_from_video`.

### 23. Auto-DINO wiring in pipelines + endpoints
- `run_reference_pipeline(video, dino=None, ...)`: if `dino is None` and not stub-mode, build it from the video.
- `run_cleanup_pipeline(reference_video, submission_video, reference_spec, reference_dino=None, submission_dino=None, submission_spec=None, ...)`:
  - DINO auto-built per video if missing.
  - `submission_spec` auto-computed by re-running the reference pipeline on the submission video.
- HTTP endpoint bodies (`/pipelines/reference`, `/pipelines/cleanup`) made `dino` / `reference_dino` / `submission_dino` optional. Hand the endpoint just video URLs and it does everything.

### 24. Cleanup-pipeline rework: independent submission analysis
- The original cleanup flow only fed the cleaner's video into the comparison LLM; it never produced a standalone description of the submission. That violates the project spec which calls for "the SAME pipeline" running on Person B's video and the comparison LLM seeing "the pipeline outputs for both videos".
- Reworked `run_cleanup_pipeline` into a 3-step flow (now matches the spec):
  1. DINO on each video, independently.
  2. Run `run_reference_pipeline` on the submission video — fed its own DINO output, no reference data — to produce `submission_spec`.
  3. Comparison LLM call gets both videos (annotated frames), both DINO summaries + per-frame detections, and BOTH specs.
- `CleanupVerdict.submission_spec: ReferenceSpec | None` — attached post-call (`model_copy`) so the LLM never has to emit it. Lets the demo UI show both analyses side-by-side.
- `SYSTEM_PROMPT` rewritten to explicitly distinguish the two pipeline outputs and instruct the model to cite both in `notes` and `reasoning`.
- `_spec_payload_for_prompt(spec)` strips `annotated_frames_b64` (huge) before serializing the spec into the prompt — only the structured fields go to the LLM, keeping token use bounded.

### 25. Reliability tweaks observed during live runs
- `max_completion_tokens` first, fall back to `max_tokens` on `TypeError` or "unsupported_parameter" from the API. Required because gpt-5.4-mini rejects `max_tokens`.
- AsyncOpenAI `timeout=180.0, max_retries=2` so a 30 s API stall doesn't kill a 4-MB vision call. Confirmed during the live run: one transient `APIConnectionError` at the start of a session was absorbed by SDK retries and the pipeline recovered.

### 26. Live integration smoke runner — `scripts/integration_smoke.py`
Runs all three pipelines against the local fixtures in `data/videos/fixtures/` and prints a compact per-stage verdict.

- Defaults:
  - `--reference data/videos/fixtures/egRequest.MOV`
  - `--submission data/videos/fixtures/egUserPost.MOV`
  - `--disposal data/videos/fixtures/testing.MOV`
- `--stub` flag forces `PIPELINE_USE_STUB=true` for offline runs.
- Loads `ai-service/.env` regardless of CWD by passing `_env_file=...` to `Settings(...)`. Without this the script silently misses `OPENAI_API_KEY` when invoked from the repo root.
- Truncates `annotated_frames_b64` in the printed JSON so the terminal stays readable.

Live run results (real OpenAI, real OpenCV, gpt-5.4-mini):

| Stage | Video | Verdict | Time |
|---|---|---|---|
| reference (Person A) | `egRequest.MOV` | DINO `chair x3, person x4` → LLM produced `ReferenceSpec` with 1 item `discarded_chair` ("Right side of the paved path near the tree and metal railing") | 12 s (warm), 455 s (cold w/ retries) |
| disposal | `testing.MOV` | `deposited_into_bin=false, confidence=0.96` — correctly rejects the cafe scene; reasoning cites no bin visible | 5–20 s |
| cleanup (Person B) | `egRequest.MOV` + `egUserPost.MOV` | `cleanup_complete=true, leftover_count=0, confidence=0.95` — submission DINO had `chair x1, sofa x1` and the cleaner's `submission_spec` flagged a chair, but the comparison LLM correctly reasoned that the AFTER frames show a different object (scooter/bike rack) and the original chair is gone | 14–21 s |

The cleanup verdict's `notes` cite both pipeline outputs by name ("REFERENCE frame 0 shows…", "The SUBMISSION pipeline still flags a chair-like object…") which is the smoke-test that confirms the spec is satisfied.

### 27. Removed `.env.example` files (per project decision)
- Deleted `ai-service/.env.example` (was untracked thanks to `.env.*` rule in repo `.gitignore`).
- `git rm` of `backend/.env.example` (was tracked from the initial commit).
- Stripped `.env.example` references from `README.md`, `ai-service/README.md`, and removed the `!.env.example` allowlist exception from `backend/.gitignore`.
- Live envs (`./.env`, `ai-service/.env`) remain — both ignored by the existing rules.

### 28. Final test results

```
.\.venv\Scripts\python.exe -m pytest -q
......................................................................   [100%]
66 passed in 1.92s
```

Everything in `tests/` (geo, fraud, scoring, pipeline, callback, FastAPI, plus 24 pipeline tests + 5 CLI checks) is green. The live integration smoke also passes for all three pipelines against the real fixture videos.

---

## File index (current)

```
ai-service/
├── ACTION_LOG.md                    <- this file
├── README.md
├── Dockerfile
├── pytest.ini
├── requirements.txt
├── .gitignore
├── app/
│   ├── __init__.py
│   ├── main.py                      <- FastAPI app, /health, /verify, mounts /pipelines
│   ├── config.py                    <- Settings (env-driven, lru-cached)
│   ├── models.py                    <- Pydantic contracts (locked)
│   ├── geo.py                       <- haversine + trajectory helpers
│   ├── vision.py                    <- Person 3A check_*; uses object_detection.py
│   ├── object_detection.py          <- OpenCV + Grounding DINO (Person 3A)
│   ├── fraud.py                     <- 5 fraud rules
│   ├── scoring.py                   <- weighted confidence + decision
│   ├── callback.py                  <- retrying backend webhook client
│   ├── verify_pipeline.py           <- /verify orchestrator
│   ├── api/
│   │   └── routes.py                <- /pipelines/{reference,cleanup,disposal}
│   └── pipelines/
│       ├── __init__.py              <- public re-exports
│       ├── llm_client.py            <- OpenAI wrapper (stub + retry + timeout)
│       ├── dino_types.py            <- Bbox, Detection, FrameDetections, DinoOutput
│       ├── dino_adapter.py          <- video -> DinoOutput (OpenCV / Grounding DINO)
│       ├── frame_extractor.py       <- OpenCV frame sampling + JPEG b64
│       ├── annotator.py             <- PIL bbox drawing on extracted frames
│       ├── reference_pipeline.py    <- Person A: video + DINO -> ReferenceSpec
│       ├── cleanup_pipeline.py      <- Person B: 3-step compare -> CleanupVerdict
│       └── disposal_pipeline.py     <- LLM-only -> DisposalVerdict
├── scripts/
│   ├── object_detection_demo.py     <- DINO/OpenCV preview video
│   ├── grounding_overlay_demo.py    <- Grounding DINO overlay video
│   └── integration_smoke.py         <- run all 3 pipelines on real fixtures
└── tests/
    ├── __init__.py
    ├── conftest.py
    ├── fixtures/
    │   ├── __init__.py
    │   ├── dino_reference_sample.json
    │   ├── dino_submission_sample.json
    │   └── dino_clean_submission_sample.json
    ├── test_api.py
    ├── test_callback.py
    ├── test_fraud.py
    ├── test_geo.py
    ├── test_health.py
    ├── test_pipeline.py
    ├── test_pipelines.py            <- new: 24 pipeline tests
    ├── test_pipelines_cli.py        <- new: interactive demo + 5 stub checks
    └── test_scoring.py
```

## How to run locally

```powershell
cd ai-service
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
# create ai-service/.env with at least OPENAI_API_KEY (see app/config.py for all knobs)
uvicorn app.main:app --reload --port 8000
```

## How to run tests

```powershell
.\.venv\Scripts\python.exe -m pytest -q
```

## How to run the live smoke against real fixture videos

```powershell
# real OpenAI + DINO
.\.venv\Scripts\python.exe scripts\integration_smoke.py

# offline (deterministic stub mode, no API calls)
.\.venv\Scripts\python.exe scripts\integration_smoke.py --stub

# custom videos
.\.venv\Scripts\python.exe scripts\integration_smoke.py `
  --reference path\to\before.mov `
  --submission path\to\after.mov `
  --disposal path\to\disposal.mov
```

## Outstanding work (handoff items)

- **`/verify` ↔ `cleanup_pipeline` bridge** — the legacy `/verify` endpoint still calls `vision.check_task_complete` (OpenCV-only). A natural next step is a thin adapter that maps `CleanupVerdict` → `TaskCompleteResult` so `/verify` benefits from the LLM step.
- **Disposal proof** — `testing.MOV` is a cafe scene, so the live disposal verdict is correctly `false`. We need a real disposal recording to demo the positive path.
- **Person 2 backend**: `POST /cleanups/:cleanup_id/verification-result` already accepts the locked schema; the new pipelines plug in without touching that contract.
- **Demo prep**: `BACKEND_BASE_URL` for the deployed environment, optional `BACKEND_INTERNAL_TOKEN`. `fail-scene` / `fail-task` substrings in the submission URL still force the legacy stub failure path for `/verify`.
- **Stretch**: Redis/RQ worker if we move past hackathon scope and need durable retries across restarts. Persist `ReferenceSpec` on the bounty record so the cleanup pipeline can fetch it from the backend instead of receiving it inline.
