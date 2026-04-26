# Backend (Express + Supabase + Solana + World)

This service powers bounty lifecycle routes, session GPS tracking, cleanup verification callbacks, and on-chain escrow/payout transfers on **two** networks:

- **Solana** (legacy SOL bounties; backend funder/vault keypair signs both escrow and payout)
- **World Chain mainnet** (WLD bounties; the user signs `MiniKit.pay()` from World App for escrow, the backend vault signs ERC-20 transfers via viem for payouts/refunds)

XP bounties live entirely off-chain in Postgres.

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

World Chain / WLD bounties:

- `WORLD_RPC_URL` (optional, defaults to `https://worldchain-mainnet.g.alchemy.com/public`)
- `WORLD_VAULT_ADDRESS` (`0x...` EOA on World Chain mainnet that receives `MiniKit.pay()` escrow and signs payouts/refunds; **must** be allow-listed in the Developer Portal as the recipient when configuring `pay`)
- `WORLD_VAULT_PRIVATE_KEY` (the matching private key for `WORLD_VAULT_ADDRESS`; viem signs ERC-20 transfers with it. Must hold both WLD for payouts AND ETH for gas)
- `WLD_TOKEN_ADDRESS` (optional, defaults to canonical WLD `0x2cFc85d8E48F8EAB294be644d9E25C3030863003`)
- `WORLD_DEVELOPER_API_KEY` (also used for IDKit; required to verify a user's `MiniKit.pay()` against `https://developer.worldcoin.org/api/v2/minikit/transaction/{id}` before the bounty record is created)
- `WORLD_ID_APP_ID` (the `app_...` from the Developer Portal; passed as `?app_id=` query parameter to the verification API)

> **Important:** there is **no testnet path** for `MiniKit.pay()`. Per the official [World docs FAQ](https://docs.world.org/mini-apps/more/faq#can-i-use-the-simulator-to-test-transactions-on-mini-apps), Mini App transactions must be developed on World Chain mainnet -- testnet/simulator routes are unsupported and will silently fail. Develop with real-but-small WLD amounts (sub-$1) on a dedicated dev vault.

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

## World Chain / WLD integration

Implemented in `src/lib/world.ts` with helpers `verifyMiniKitPayment`, `payoutWldToClaimer`, and `refundWldToPoster`. Unlike SOL, the signing topology is split:

- **Escrow** (poster funds the bounty):
  - The frontend (inside World App only) calls `MiniKit.pay()` with `to: WORLD_VAULT_ADDRESS` and `tokens: [{ symbol: "WLD", token_amount: tokenToDecimals(amount, "WLD") }]`. World App signs and submits the transfer to the vault.
  - The frontend POSTs the resulting `transactionId` + the client-generated `reference` to `POST /api/bounties` with `reward_wld`.
  - The backend re-fetches the canonical record via `GET https://developer.worldcoin.org/api/v2/minikit/transaction/{id}?app_id=...&type=payment` (Bearer `WORLD_DEVELOPER_API_KEY`) and rejects unless **all** of:
    - `transaction_status === "mined"`
    - `reference` matches the one the client sent (replay defense)
    - `to` matches `WORLD_VAULT_ADDRESS` (no spoofed recipient)
    - `token === "WLD"` (no ABA-style token swaps)
    - `token_amount` ≥ the wei equivalent of `reward_wld` (poster cannot underpay)
  - On success, `bounties.world_pay_tx_id`, `bounties.world_payment_reference`, and `bounties.world_pay_tx_hash` are persisted; `bounties.escrow_tx_sig` mirrors the on-chain hash for legacy queries.
- **Payout** (verification passes): `payoutWldToClaimer` uses viem with `WORLD_VAULT_PRIVATE_KEY` to sign a standard ERC-20 `transfer(to, amount)` of WLD on World Chain mainnet (chainId 480) to the claimer's `world_wallet_address`. The vault pays its own gas in ETH (Mini App gas sponsorship only applies to verified users **inside** World App, not to backend writers like us).
- **Refund** (verification fails): `refundWldToPoster` is the same call shape as the payout, but to the poster's `world_wallet_address`. Both branches surface the on-chain hash on `cleanups.payout_tx_sig` (or inside `cleanups.verification_result.refund_tx_sig` for the failure path).

The `users.world_wallet_address` column is populated from `MiniKit.user.walletAddress` either at registration or via `POST /api/users/me/world-wallet`. **WLD payouts are blocked with a 409** if the recipient has not linked a World wallet yet -- the verification stays in flight so an operator can resolve manually rather than the funds being permanently stuck.

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
