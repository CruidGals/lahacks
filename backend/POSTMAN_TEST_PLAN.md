# Backend Postman Test Plan

Comprehensive, step-by-step Postman test checklist for the implemented backend routes in `backend/src/routes/*`, aligned with `DESIGN_SPEC.md`.

## 1) Postman Environment Setup

Create a Postman environment with:

- `baseUrl` = `http://localhost:8080`
- `userAId` = poster user UUID (seed or generated during run)
- `userBId` = claimer user UUID (seed or generated during run)
- `unverifiedUserId` = optional unverified UUID
- `internalToken` = value of `INTERNAL_API_TOKEN` (if set)
- `bountyId` = (empty initially)
- `sessionId` = (empty initially)
- `cleanupId` = (empty initially)

## 2) Auth Notes

Protected routes accept either:

- `Authorization: Bearer <Supabase JWT>`
- `Authorization: Bearer <user uuid>` (dev flow)
- `x-user-id: <user uuid>` (legacy dev flow)

For this plan, use:

- Poster requests: `Authorization: Bearer {{userAId}}`
- Claimer requests: `Authorization: Bearer {{userBId}}`

## 3) Route Inventory (Implemented)

- `GET /health`
- `POST /api/users`
- `GET /api/users/:id`
- `POST /api/users/verify`
- `POST /api/bounties`
- `GET /api/bounties`
- `GET /api/bounties/:id`
- `POST /api/bounties/:id/claim`
- `POST /api/sessions/start`
- `POST /api/sessions/:id/ping`
- `POST /api/cleanups`
- `POST /api/cleanups/:id/verification-result`

Note:

- `POST /verify` in `DESIGN_SPEC.md` is an AI-service endpoint; backend calls it via `AI_VERIFY_URL`.
- `GET /users/:id` and `GET /leaderboard` are referenced in spec responsibilities but are not implemented in this backend.

## 4) Happy Path End-to-End

### Step 1: Health check

- Method: `GET`
- URL: `{{baseUrl}}/health`
- Auth: none
- Expect: `200 OK`

Example response:

```json
{
  "ok": true,
  "service": "backend",
  "timestamp": "2026-04-25T23:00:00.000Z"
}
```

### Step 2: Create poster user

- Method: `POST`
- URL: `{{baseUrl}}/api/users`
- Auth: none
- Body:

```json
{
  "id": "11111111-1111-1111-1111-111111111111",
  "wallet_address": "FunderWalletPubkey11111111111111111111111111111",
  "verified": false
}
```

- Expect: `201 Created` with `{ ok: true, user: {...} }`
- Save `user.id` into `{{userAId}}` if not pre-seeded

Suggested Postman test script:

```javascript
pm.test("status is 201", function () {
  pm.response.to.have.status(201);
});
const json = pm.response.json();
pm.environment.set("userAId", json.user.id);
```

### Step 3: Create claimer user

- Method: `POST`
- URL: `{{baseUrl}}/api/users`
- Auth: none
- Body:

```json
{
  "id": "22222222-2222-2222-2222-222222222222",
  "wallet_address": "ClaimerWalletPubkey2222222222222222222222222222",
  "verified": false
}
```

- Expect: `201 Created` with `{ ok: true, user: {...} }`
- Save `user.id` into `{{userBId}}` if not pre-seeded

Suggested Postman test script:

```javascript
pm.test("status is 201", function () {
  pm.response.to.have.status(201);
});
const json = pm.response.json();
pm.environment.set("userBId", json.user.id);
```

### Step 4: Verify poster user (World ID)

- Method: `POST`
- URL: `{{baseUrl}}/api/users/verify`
- Headers: `Authorization: Bearer {{userAId}}`
- Body:

```json
{
  "world_id_hash": "worldid-proof-hash-userA"
}
```

- Expect: `200 OK` and `user.verified = true`

### Step 5: Verify claimer user (World ID)

- Method: `POST`
- URL: `{{baseUrl}}/api/users/verify`
- Headers: `Authorization: Bearer {{userBId}}`
- Body:

```json
{
  "world_id_hash": "worldid-proof-hash-userB"
}
```

- Expect: `200 OK` and `user.verified = true`

### Step 6: Create bounty (poster)

- Method: `POST`
- URL: `{{baseUrl}}/api/bounties`
- Headers: `Authorization: Bearer {{userAId}}`
- Body:

```json
{
  "lat": 34.0689,
  "lng": -118.4452,
  "reward_sol": 0.02,
  "description": "Clean trash near bus stop",
  "reference_video_url": "https://example.com/reference.mp4"
}
```

- Expect: `201 Created` with `bounty` and `escrow_tx_sig`
- Save `bounty.id` into `{{bountyId}}`

Suggested Postman test script:

```javascript
pm.test("status is 201", function () {
  pm.response.to.have.status(201);
});
const json = pm.response.json();
pm.environment.set("bountyId", json.bounty.id);
```

### Step 7: List bounties (public)

- Method: `GET`
- URL: `{{baseUrl}}/api/bounties`
- Auth: none
- Expect: `200 OK`, includes `items`

### Step 8: List bounties with bbox filter (public)

- Method: `GET`
- URL: `{{baseUrl}}/api/bounties?min_lat=34&max_lat=35&min_lng=-119&max_lng=-118`
- Auth: none
- Expect: `200 OK`, filtered items

### Step 9: Get bounty by ID

- Method: `GET`
- URL: `{{baseUrl}}/api/bounties/{{bountyId}}`
- Auth: none
- Expect: `200 OK`, includes `reward_sol` and `urgency_score`

### Step 10: Claim bounty (claimer)

- Method: `POST`
- URL: `{{baseUrl}}/api/bounties/{{bountyId}}/claim`
- Headers: `Authorization: Bearer {{userBId}}`
- Body: none
- Expect: `200 OK`, includes `claim_expires_at`

### Step 11: Start session (claimer)

- Method: `POST`
- URL: `{{baseUrl}}/api/sessions/start`
- Headers: `Authorization: Bearer {{userBId}}`
- Body:

```json
{
  "bounty_id": "{{bountyId}}"
}
```

- Expect: `201 Created`, returns `session_id`, `nonce`
- Save `session_id` into `{{sessionId}}`

Suggested Postman test script:

```javascript
pm.test("status is 201", function () {
  pm.response.to.have.status(201);
});
const json = pm.response.json();
pm.environment.set("sessionId", json.session_id);
```

### Step 12: Send GPS pings (claimer)

- Method: `POST`
- URL: `{{baseUrl}}/api/sessions/{{sessionId}}/ping`
- Headers: `Authorization: Bearer {{userBId}}`
- Body:

```json
{
  "lat": 34.06895,
  "lng": -118.44521,
  "accuracy": 8,
  "timestamp": "2026-04-25T23:05:00.000Z"
}
```

- Expect: `200 OK`, `{ "ok": true }`
- Repeat 3 to 5 times with incrementing timestamps

### Step 13: Submit cleanup (claimer)

- Method: `POST`
- URL: `{{baseUrl}}/api/cleanups`
- Headers: `Authorization: Bearer {{userBId}}`
- Body:

```json
{
  "session_id": "{{sessionId}}",
  "video_url": "https://example.com/submission.mp4"
}
```

- Expect: `202 Accepted`, returns `cleanup_id`
- Save `cleanup_id` into `{{cleanupId}}`

Suggested Postman test script:

```javascript
pm.test("status is 202", function () {
  pm.response.to.have.status(202);
});
const json = pm.response.json();
pm.environment.set("cleanupId", json.cleanup_id);
```

### Step 14: Simulate AI callback success

- Method: `POST`
- URL: `{{baseUrl}}/api/cleanups/{{cleanupId}}/verification-result`
- Headers:
  - `Content-Type: application/json`
  - `x-internal-token: {{internalToken}}` (only if token is configured)
- Body:

```json
{
  "verified": true,
  "confidence": 0.93,
  "scene_match": true,
  "task_complete": true,
  "fraud_flags": [],
  "reasoning": "All checks passed."
}
```

- Expect: `200 OK`, `{ ok: true, verified: true, payout_tx_sig: "..." }`

### Step 15: Verify success idempotency

- Repeat Step 12 exactly.
- Expect: `200 OK` with `idempotent: true` and same `payout_tx_sig`

## 5) Failure and Edge Case Tests

### Auth and verification gates

1. No auth on protected route (`POST /api/bounties`) -> `401`
2. `POST /api/users` duplicate id -> `409`
3. Invalid bearer token -> `401`
4. Unverified user on gated routes (`/api/bounties`, `/claim`, `/sessions/start`, `/sessions/:id/ping`, `/api/cleanups`) -> `403`

### Validation errors (`400`)

5. `POST /api/bounties` invalid `lat/lng/reward_sol/url`
6. `POST /api/sessions/start` invalid UUID
7. `POST /api/sessions/:id/ping` malformed timestamp
8. `POST /api/cleanups` invalid `session_id` or invalid `video_url`
9. `POST /api/cleanups/:id/verification-result` invalid payload types

### Resource and state conflicts

10. `GET /api/users/:id` unknown id -> `404`
11. `GET /api/bounties/:id` unknown id -> `404`
12. Claim already completed bounty -> `409`
13. Claim already claimed and not expired -> `409`
14. Start session without valid claim owner -> `403`
15. Start session on expired claim lock -> `409`
16. Ping session not owned by caller -> `403`
17. Ping inactive session -> `409`
18. Submit cleanup when session not active -> `409`
19. Submit cleanup when claim expired/invalid -> `409`

### Internal callback token checks

20. `POST /api/cleanups/:id/verification-result` without/incorrect token (if `INTERNAL_API_TOKEN` set) -> `401`

### Rejection path and idempotency

21. Send reject callback:

```json
{
  "verified": false,
  "confidence": 0.42,
  "scene_match": false,
  "task_complete": false,
  "fraud_flags": ["trajectory_outside_radius"],
  "reasoning": "Location mismatch."
}
```

Expect: `200 OK`, includes `refund_tx_sig`, `refund_status`.

22. Repeat reject callback after rejection -> `200 OK`, `idempotent: true`.

## 6) Suggested Postman Collection Folder Order

1. `Health`
2. `Users`
   - Create User A
   - Create User B
   - Verify User A
   - Verify User B
   - Get User by ID
3. `Bounties`
   - Create
   - List
   - List (bbox)
   - Get by ID
   - Claim
4. `Sessions`
   - Start
   - Ping #1
   - Ping #2
   - Ping #3
5. `Cleanups`
   - Submit
   - Callback Success
   - Callback Success Retry (idempotent)
   - Callback Reject
   - Callback Reject Retry (idempotent)
6. `Negative Tests`
   - Missing auth
   - Unverified access
   - Validation failures
   - State conflicts

## 7) Run Notes

- `GET /api/bounties` and `GET /api/bounties/:id` are public.
- Most lifecycle routes require `users.verified = true`.
- If Solana or wallets are misconfigured, callback verification may fail with `502` from payout/refund operations.
- If `AI_VERIFY_URL` is not set, backend still accepts cleanup and returns `202`, but verifier webhook is skipped.
