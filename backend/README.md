# Backend (Express + Supabase + Solana)

This service powers bounty lifecycle routes, session GPS tracking, cleanup verification callbacks, and Solana escrow/payout transfers.

## Environment variables

Required:

- `SUPABASE_URL` (must be a valid `https://...` project URL)
- `SUPABASE_SERVICE_ROLE_KEY`

World ID / IDKit:

- `WORLD_ID_APP_ID` (World app id, e.g. `app_...`)
- `WORLD_RP_ID` (World RP id, e.g. `rp_...`)
- `WORLD_RP_SIGNING_KEY` (hex signing key from World developer portal; keep secret)
- `WORLD_ID_ENVIRONMENT` (`staging` or `production`, defaults to `staging`)
- `WORLD_DEVELOPER_API_KEY` (optional bearer token for `developer.world.org` verify calls)

Solana (devnet demo):

- `SOLANA_RPC_URL` (optional, defaults to Solana devnet)
- `SET_BOUNTY_WITH_FUNDER` (`true` or `false`)
- `SOLANA_FUNDER_SECRET_KEY` (base58 byte array string, e.g. `"[1,2,...]"`)
- `SOLANA_VAULT_SECRET_KEY` (base58 byte array string, e.g. `"[1,2,...]"`)

Verification service integration:

- `AI_VERIFY_URL` (AI service `/verify` endpoint)
- `INTERNAL_API_TOKEN` (optional; if set, required on `POST /api/cleanups/:id/verification-result` as `x-internal-token` **or** `Authorization: Bearer <token>`)
- `BOUNTY_RADIUS_METERS` (optional, defaults to `75`)

## Auth (API)

Protected routes accept either:

- `Authorization: Bearer <Supabase access JWT>` — user id is taken from the validated JWT and matched to `public.users.id`, or
- `Authorization: Bearer <user uuid>` / `x-user-id: <user uuid>` — legacy dev flow (use only in trusted environments).

World ID: clients first call `POST /api/users/world/rp-context` to fetch RP context, then submit IDKit result to `POST /api/users/verify` as `{ "rp_id": "...", "idkit_response": {...} }`. The backend verifies against World Developer Portal and sets `users.verified = true`. Posting bounties, claiming, starting sessions, pinging, and submitting cleanups require `verified`.

## Public map listing

`GET /api/bounties` is **unauthenticated** so the map can load pins without a session.

## Solana integration (hackathon scope)

Two backend functions are implemented in `src/lib/solana.ts`:

- `escrowBounty(amount, bounty_id)`:
  - when `SET_BOUNTY_WITH_FUNDER=true`, sends transfer from `SOLANA_FUNDER_SECRET_KEY` to vault
  - when `SET_BOUNTY_WITH_FUNDER=false`, backend first validates the authenticated poster wallet has enough lamports, then escrows via funder wallet for demo reliability
  - before transfer, backend checks required balance (`reward_lamports + fee buffer`)
  - returned signature is stored on `bounties.escrow_tx_sig`
- `releaseBountyToClaimer(bounty_id, recipient)`:
  - sends a devnet transfer from vault wallet to claimer wallet
  - returned signature is stored on `cleanups.payout_tx_sig`
- On verification **failure**, `refundEscrowToPoster` sends the bounty lamports from the vault back to the **poster’s** `wallet_address`; the signature is stored inside `cleanups.verification_result` as `refund_tx_sig` (schema has no separate refund column).

This provides a signed transaction audit trail in DB for lock, payout, and refund.

## Verification callback idempotency

`POST /api/cleanups/:id/verification-result` is safe to retry:

- If the cleanup is already `verified` with a `payout_tx_sig`, a repeat success callback returns the same signature with `idempotent: true`.
- If the cleanup is already `rejected`, a repeat failure callback returns `idempotent: true` without sending another refund.

## Trajectory analysis helper

Implemented in `src/lib/trajectory.ts`.

Input:
- GPS pings array
- bounty latitude/longitude

Output:
- `within_radius_pct`
- `avg_distance_m`
- `total_duration_s`
- `suspicious`

The helper result is included in `POST /api/cleanups` webhook payload to the AI service as `trajectory_analysis`.

## Run locally

```bash
npm install
npm run dev
```

## Mainnet migration path

1. Swap transfer-based escrow for Anchor PDA escrow account per bounty (one escrow account per `bounty_id`).
2. Replace direct `SystemProgram.transfer` calls with Anchor instructions:
   - `escrow_bounty(amount, bounty_id)`
   - `release_bounty(bounty_id, recipient)`
3. Move signer keys out of `.env` into a managed signer/KMS and/or server wallet service.
4. Add idempotency keys for payout callbacks and confirmation polling (`getSignatureStatuses`) before DB state transitions.
5. Enforce SPL-token USDC path if required (ATA creation + token program transfers) while preserving tx signature persistence in `bounties` / `cleanups`.
