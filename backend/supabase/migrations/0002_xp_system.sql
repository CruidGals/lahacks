-- XP system: dual-reward bounties (SOL or XP) and per-user XP balance.
--
-- This migration is additive. Existing SOL bounties keep working unchanged
-- because:
--   * `bounties.reward_type` defaults to 'sol' for every existing row.
--   * `bounties.reward_lamports` stays the SOL stake; XP bounties set it to 0.
--   * `bounties.reward_xp` is NULL for SOL bounties.
--   * `bounties.xp_award` is populated on every successful claim regardless of
--     reward type (SOL bounties earn a calculated XP bonus; XP bounties earn
--     exactly `reward_xp`).
--
-- The XP economy:
--   * Every user starts with `users.xp = 200` so they can post a few XP-only
--     bounties without first claiming a SOL one (good for demos / cold start).
--   * Posting an XP bounty deducts `reward_xp` from the poster's balance and
--     stores it in `bounties.reward_xp` (acts as escrow).
--   * Verified completion grants `bounties.xp_award` to the claimer and
--     increments `users.total_earned_xp` (leaderboard metric).
--   * Rejected XP bounties refund `reward_xp` back to the poster.

BEGIN;

-- 1. New enum + columns on bounties --------------------------------------- --

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'reward_type') THEN
        CREATE TYPE reward_type AS ENUM ('sol', 'xp');
    END IF;
END $$;

ALTER TABLE bounties
    ADD COLUMN IF NOT EXISTS reward_type reward_type NOT NULL DEFAULT 'sol',
    ADD COLUMN IF NOT EXISTS reward_xp integer,
    ADD COLUMN IF NOT EXISTS xp_award integer NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS difficulty_score smallint,
    ADD COLUMN IF NOT EXISTS importance_score smallint,
    ADD COLUMN IF NOT EXISTS xp_reasoning text,
    ADD COLUMN IF NOT EXISTS title text;

-- Make reward_lamports nullable-with-default so XP bounties can store 0
-- without needing the SOL escrow path.
ALTER TABLE bounties
    ALTER COLUMN reward_lamports SET DEFAULT 0;

-- Sanity guards: only one reward currency per row, and the staked amount
-- matches the chosen type. We use NOT VALID + VALIDATE so we don't blow up
-- on any pre-existing rows that snuck through with NULL values.
ALTER TABLE bounties
    ADD CONSTRAINT bounties_reward_currency_chk
    CHECK (
        (reward_type = 'sol' AND reward_xp IS NULL)
        OR (reward_type = 'xp' AND reward_xp IS NOT NULL AND reward_xp > 0
            AND COALESCE(reward_lamports, 0) = 0)
    ) NOT VALID;

ALTER TABLE bounties VALIDATE CONSTRAINT bounties_reward_currency_chk;

ALTER TABLE bounties
    ADD CONSTRAINT bounties_score_range_chk
    CHECK (
        (difficulty_score IS NULL OR (difficulty_score BETWEEN 1 AND 10))
        AND (importance_score IS NULL OR (importance_score BETWEEN 1 AND 10))
    );

CREATE INDEX IF NOT EXISTS bounties_reward_type_idx ON bounties (reward_type);


-- 2. XP balance + lifetime totals on users ------------------------------- --

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS xp integer NOT NULL DEFAULT 200,
    ADD COLUMN IF NOT EXISTS total_earned_xp integer NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS total_earned_lamports bigint NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS display_name text;

ALTER TABLE users
    ADD CONSTRAINT users_xp_nonneg_chk CHECK (xp >= 0),
    ADD CONSTRAINT users_total_earned_xp_nonneg_chk CHECK (total_earned_xp >= 0),
    ADD CONSTRAINT users_total_earned_lamports_nonneg_chk CHECK (total_earned_lamports >= 0);


-- 3. Atomic XP escrow / payout helpers ----------------------------------- --
--
-- We expose these as Postgres functions so the backend can call them via
-- supabase.rpc() and get a single round-trip with proper row-level locking.
-- Every function is SECURITY INVOKER -- the service-role key the backend
-- uses already bypasses RLS, and we want the same auth context for tests.

-- Stake XP from a poster when they create an XP bounty.
-- Raises if the poster doesn't have enough balance.
CREATE OR REPLACE FUNCTION stake_xp(p_user_id uuid, p_amount integer)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
    v_new_balance integer;
BEGIN
    IF p_amount IS NULL OR p_amount <= 0 THEN
        RAISE EXCEPTION 'stake_xp: amount must be positive (got %)', p_amount;
    END IF;

    UPDATE users
        SET xp = xp - p_amount
        WHERE id = p_user_id AND xp >= p_amount
        RETURNING xp INTO v_new_balance;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'stake_xp: insufficient XP balance for user %', p_user_id;
    END IF;

    RETURN v_new_balance;
END;
$$;

-- Award XP to a claimer (verified completion path).
-- Increments both the spendable balance and the lifetime leaderboard total.
CREATE OR REPLACE FUNCTION award_xp(p_user_id uuid, p_amount integer)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
    v_new_balance integer;
BEGIN
    IF p_amount IS NULL OR p_amount < 0 THEN
        RAISE EXCEPTION 'award_xp: amount must be non-negative (got %)', p_amount;
    END IF;

    IF p_amount = 0 THEN
        SELECT xp INTO v_new_balance FROM users WHERE id = p_user_id;
        RETURN v_new_balance;
    END IF;

    UPDATE users
        SET
            xp = xp + p_amount,
            total_earned_xp = total_earned_xp + p_amount
        WHERE id = p_user_id
        RETURNING xp INTO v_new_balance;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'award_xp: user % not found', p_user_id;
    END IF;

    RETURN v_new_balance;
END;
$$;

-- Refund XP to a poster (rejected XP bounty).
-- Same as award_xp but does NOT touch total_earned_xp -- a refund must not
-- inflate the leaderboard.
CREATE OR REPLACE FUNCTION refund_xp(p_user_id uuid, p_amount integer)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
    v_new_balance integer;
BEGIN
    IF p_amount IS NULL OR p_amount < 0 THEN
        RAISE EXCEPTION 'refund_xp: amount must be non-negative (got %)', p_amount;
    END IF;

    IF p_amount = 0 THEN
        SELECT xp INTO v_new_balance FROM users WHERE id = p_user_id;
        RETURN v_new_balance;
    END IF;

    UPDATE users
        SET xp = xp + p_amount
        WHERE id = p_user_id
        RETURNING xp INTO v_new_balance;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'refund_xp: user % not found', p_user_id;
    END IF;

    RETURN v_new_balance;
END;
$$;

-- Track lifetime SOL earnings on the leaderboard side. Lamports stays a
-- separate column from `total_earned_xp` because the two units never mix.
CREATE OR REPLACE FUNCTION add_earned_lamports(p_user_id uuid, p_lamports bigint)
RETURNS bigint
LANGUAGE plpgsql
AS $$
DECLARE
    v_total bigint;
BEGIN
    IF p_lamports IS NULL OR p_lamports < 0 THEN
        RAISE EXCEPTION 'add_earned_lamports: amount must be non-negative (got %)', p_lamports;
    END IF;

    UPDATE users
        SET total_earned_lamports = total_earned_lamports + p_lamports
        WHERE id = p_user_id
        RETURNING total_earned_lamports INTO v_total;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'add_earned_lamports: user % not found', p_user_id;
    END IF;

    RETURN v_total;
END;
$$;

COMMIT;
