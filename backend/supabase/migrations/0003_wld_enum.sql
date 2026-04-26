-- Step 1 of WLD support: extend the reward_type enum.
--
-- Postgres requires ALTER TYPE ... ADD VALUE to be committed *before* the
-- new value can be referenced in DDL or DML, so the rest of the WLD schema
-- changes (columns, constraints that reference 'wld', helper functions)
-- live in 0004_wld_system.sql which runs in a separate transaction.
ALTER TYPE reward_type ADD VALUE IF NOT EXISTS 'wld';
