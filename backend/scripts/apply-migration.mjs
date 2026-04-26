#!/usr/bin/env node
// One-shot migration runner. Reads `SUPABASE_ACCESS_TOKEN` (a Personal Access
// Token; sbp_…) and `SUPABASE_URL` from `.env` and pipes a .sql file through
// the Supabase Management API:
//   POST https://api.supabase.com/v1/projects/{ref}/database/query
//
// Usage:
//   node scripts/apply-migration.mjs supabase/migrations/0002_dual_currency.sql

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import 'dotenv/config';

const sqlFile = process.argv[2];
if (!sqlFile) {
  console.error('Usage: node scripts/apply-migration.mjs <path-to-sql>');
  process.exit(1);
}

const accessToken = process.env.SUPABASE_ACCESS_TOKEN;
const supabaseUrl = process.env.SUPABASE_URL;
if (!accessToken) {
  console.error(
    'SUPABASE_ACCESS_TOKEN missing. Get a Personal Access Token at https://supabase.com/dashboard/account/tokens and put it in backend/.env.'
  );
  process.exit(1);
}
if (!supabaseUrl) {
  console.error('SUPABASE_URL missing in backend/.env');
  process.exit(1);
}

const ref = new URL(supabaseUrl).hostname.split('.')[0];
const sql = readFileSync(resolve(sqlFile), 'utf8');

console.log(`Applying ${sqlFile} to project ${ref}…`);

const res = await fetch(
  `https://api.supabase.com/v1/projects/${ref}/database/query`,
  {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ query: sql })
  }
);

const text = await res.text();
if (!res.ok) {
  console.error(`HTTP ${res.status}: ${text}`);
  process.exit(1);
}
console.log(`OK (${res.status})`);
console.log(text);
