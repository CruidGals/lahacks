-- WLD (Worldcoin) bounty support: a third reward type alongside SOL and XP.
--
-- Why this is shaped differently from the SOL path:
--   * SOL escrow is debited from a backend-controlled funder/vault keypair --
--     the user never signs a transaction. This is how the legacy `escrowBounty`
--     helper still works.
--   * WLD escrow MUST originate from the user's wallet inside World App. The
--     World App SDK (MiniKit) signs `MiniKit.pay()` on the device; the
--     backend can only *verify* the resulting transaction via the Developer
--     Portal API. There is no testnet/simulator path for `MiniKit.pay()` --
--     World docs explicitly call this out, so any flow that tried to fake
--     payments outside the real World App was guaranteed to fail.
--   * Payouts (vault -> claimer) and refunds (vault -> poster) are signed
--     server-side with a vault EOA private key via viem on World Chain
--     mainnet (chainId 480). They transfer the canonical WLD ERC-20 at
--     0x2cFc85d8E48F8EAB294be644d9E25C3030863003.
--
-- Storage choices:
--   * `reward_wld_wei` is TEXT because WLD has 18 decimals; the BIGINT range
--     would only safely hold up to ~9.2 WLD per bounty. TEXT lets us store
--     the canonical wei integer without losing precision and matches how the
--     World API returns `token_amount` (a BigInt-as-string).
--   * `world_payment_reference` and `world_pay_tx_id` mirror the
--     MiniKit.pay() response (the reference we generated and the
--     `transactionId` it returned); the tuple is what the backend uses to
--     fetch the on-chain transaction from the Developer Portal.
--   * `users.world_wallet_address` is a separate column from `wallet_address`
--     (the legacy Solana keypair) so SOL flows are never confused for WLD
--     flows when paying out.

BEGIN;

-- 1. New WLD-tracking columns on bounties --------------------------------- --

ALTER TABLE bounties
    ADD COLUMN IF NOT EXISTS reward_wld_wei text,
    ADD COLUMN IF NOT EXISTS world_payment_reference text,
    ADD COLUMN IF NOT EXISTS world_pay_tx_id text,
    ADD COLUMN IF NOT EXISTS world_pay_tx_hash text;

-- Drop the old reward-currency invariant (SOL-or-XP only) and reinstall it
-- with the WLD branch added. Using NOT VALID + VALIDATE keeps any pre-existing
-- rows safe even if a transient NULL slipped through.
ALTER TABLE bounties
    DROP CONSTRAINT IF EXISTS bounties_reward_currency_chk;

ALTER TABLE bounties
    ADD CONSTRAINT bounties_reward_currency_chk
    CHECK (
        (reward_type = 'sol'
            AND reward_xp IS NULL
            AND reward_wld_wei IS NULL)
        OR (reward_type = 'xp'
            AND reward_xp IS NOT NULL
            AND reward_xp > 0
            AND COALESCE(reward_lamports, 0) = 0
            AND reward_wld_wei IS NULL)
        OR (reward_type = 'wld'
            AND reward_xp IS NULL
            AND COALESCE(reward_lamports, 0) = 0
            AND reward_wld_wei IS NOT NULL
            -- Numeric-cast guard: rejects any non-integer or negative wei
            -- string at insert time so we never store a malformed amount.
            AND reward_wld_wei ~ '^[0-9]+$'
            AND reward_wld_wei <> '0')
    ) NOT VALID;

ALTER TABLE bounties VALIDATE CONSTRAINT bounties_reward_currency_chk;

-- The MiniKit reference is the idempotency key for an escrow payment.
-- A unique partial index lets two bounties share a NULL reference (SOL/XP)
-- but blocks a second WLD bounty from ever reusing the same reference.
CREATE UNIQUE INDEX IF NOT EXISTS bounties_world_payment_reference_uidx
    ON bounties (world_payment_reference)
    WHERE world_payment_reference IS NOT NULL;


-- 2. World wallet address + lifetime WLD totals on users ----------------- --

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS world_wallet_address text,
    ADD COLUMN IF NOT EXISTS total_earned_wld_wei text NOT NULL DEFAULT '0';

ALTER TABLE users
    ADD CONSTRAINT users_world_wallet_address_format_chk
    CHECK (world_wallet_address IS NULL
           OR world_wallet_address ~* '^0x[0-9a-f]{40}$');

ALTER TABLE users
    ADD CONSTRAINT users_total_earned_wld_wei_format_chk
    CHECK (total_earned_wld_wei ~ '^[0-9]+$');


-- 3. Lifetime WLD earnings helper (mirrors add_earned_lamports) ---------- --
--
-- Stored as a numeric-cast TEXT so we don't truncate big values. The function
-- accepts a wei amount as text and returns the new lifetime total as text.

CREATE OR REPLACE FUNCTION add_earned_wld_wei(p_user_id uuid, p_wei text)
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
    v_total text;
BEGIN
    IF p_wei IS NULL OR p_wei !~ '^[0-9]+$' THEN
        RAISE EXCEPTION 'add_earned_wld_wei: amount must be a non-negative integer string (got %)', p_wei;
    END IF;

    IF p_wei = '0' THEN
        SELECT total_earned_wld_wei INTO v_total FROM users WHERE id = p_user_id;
        RETURN v_total;
    END IF;

    UPDATE users
        SET total_earned_wld_wei =
            (total_earned_wld_wei::numeric + p_wei::numeric)::text
        WHERE id = p_user_id
        RETURNING total_earned_wld_wei INTO v_total;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'add_earned_wld_wei: user % not found', p_user_id;
    END IF;

    RETURN v_total;
END;
$$;

COMMIT;
