# Civic Cleanup Bounty Marketplace

A bounty marketplace for civic cleanup. Funders post geo-tagged cleanup bounties backed by Solana escrow, claimers complete work, and an AI verifier validates proof before payout. High-stakes actions are gated by World ID.

## Project structure

- `frontend/` - React + Vite + Tailwind app (map UI, bounty flows)
- `backend/` - Express API (bounties, claims, sessions, Supabase integration)
- `ai-service/` - FastAPI verifier service (video/gps validation pipeline)
- `contracts/` - Solana program scaffold and tests
- `shared/` - shared schemas/types/contracts between services
- `docs/` - architecture, API, and product docs

## Quick start

### 1) Frontend

```bash
cd frontend
npm install
npm run dev
```

### 2) Backend

```bash
cd backend
npm install
# create backend/.env with PORT, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
# WORLD_ID_APP_ID, SOLANA_RPC_URL (devnet by default)
npm run dev
```

### 3) AI service

```bash
cd ai-service
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
# create ai-service/.env with at least OPENAI_API_KEY; see app/config.py
# for every tunable env var (backend URL, thresholds, detector backend, etc.)
uvicorn app.main:app --reload --port 8001
```

## MVP core flow

1. Poster funds bounty + uploads reference 360 video.
2. Claimer claims bounty (4h lock).
3. Claimer starts task and GPS logging.
4. Claimer submits completion 360 video + nonce watermark.
5. AI verifier checks media + GPS + street context.
6. Contract releases SOL on pass.

