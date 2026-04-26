-- Dual-currency support: bounties can be funded in either WLD (Worldcoin /
-- World Chain) or SOL (Solana). The smallest-unit integer column
-- `bounties.reward_lamports` is reused for both — its interpretation depends
-- on `reward_currency`:
--   * 'SOL': lamports (1e-9 SOL)
--   * 'WLD': micro-WLD (1e-6 WLD)
--
-- Users may also have two on-chain addresses:
--   * `wallet_address`  — auto-generated Solana keypair address (legacy primary)
--   * `world_address`   — World App ETH address bound via SIWE walletAuth
--
-- Existing rows in `bounties` are assumed to be WLD-denominated (the most
-- recent migration before this one repurposed `reward_lamports` to micro-WLD).
-- If you have older SOL-denominated rows, backfill them with reward_currency='SOL'.

-- 1. bounty_currency enum
do $$
begin
  if not exists (select 1 from pg_type where typname = 'bounty_currency') then
    create type bounty_currency as enum ('WLD', 'SOL');
  end if;
end$$;

-- 2. bounties.reward_currency column
alter table public.bounties
  add column if not exists reward_currency bounty_currency not null default 'WLD';

-- 3. users.world_address column (nullable; only set after SIWE walletAuth)
alter table public.users
  add column if not exists world_address text;

-- 4. Helpful index for leaderboard / per-currency queries
create index if not exists bounties_reward_currency_idx
  on public.bounties (reward_currency);
