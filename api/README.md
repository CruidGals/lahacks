# API

Minimal Node/Express backend configured for PostgreSQL.

## Setup

1. Install dependencies:
   - `npm install`
2. Copy env file:
   - `cp .env.example .env`
3. Update database credentials in `.env`.

## Run

- Development: `npm run dev`
- Production: `npm start`

## Endpoints

- `GET /` - basic API status
- `GET /health` - checks API and PostgreSQL connectivity
