# Architecture (Scaffold)

## Services

- Frontend (React/Vite): map + bounty UX, wallet + World ID checks.
- Backend (Express): REST API for bounties/claims, DB writes, auth/session checks.
- AI Service (FastAPI): async verification endpoint for media/GPS evidence.
- Solana Program: escrow and payout logic.

## Data model (initial)

- `bounties`: poster, location, escrow amount, reference media, status.
- `claims`: claimer, bounty, started_at, lock_expires_at, gps_track.
- `verifications`: claim_id, ai_result, confidence, notes.

## Next implementation steps

1. Define DB schema and Supabase migrations.
2. Define API contracts in `shared/schemas`.
3. Add wallet + World ID verification middleware.
4. Add async verification queue (BullMQ or Supabase jobs).
5. Connect contract CPI for payout release.
