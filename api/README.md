# API

Minimal Node/Express backend configured for Supabase.

## Setup

1. Install dependencies:
   - `npm install`
2. Copy env file:
   - `cp .env.example .env`
3. Add your Supabase project credentials in `.env`:
   - `SUPABASE_URL`
   - `SUPABASE_ANON_KEY` (or `SUPABASE_SERVICE_ROLE_KEY`)

## Run

- Development: `npm run dev`
- Production: `npm start`

## Endpoints

- `GET /` - basic API status
- `GET /health` - checks API and Supabase connectivity
