import type { Tables } from '../types/database.types.js';
import { weiStringToWld } from './world.js';

type Bounty = Tables<'bounties'>;

const CLAIM_WINDOW_MS = 4 * 60 * 60 * 1000;
const LAMPORTS_PER_SOL = 1_000_000_000;

export const MIN_XP_STAKE = 5;
export const MAX_XP_STAKE = 5_000;

/**
 * WLD reward limits, in human units. Mirrors `MIN_XP_STAKE`/`MAX_XP_STAKE` --
 * keeps the AI XP heuristic well-behaved (it would otherwise treat a 0 WLD or
 * 1000 WLD bounty as a nonsense outlier) and gives us a sane upper bound for
 * vault solvency. Tweak these in lockstep with the frontend post page.
 */
export const MIN_WLD_REWARD = 0.01;
export const MAX_WLD_REWARD = 50;

export function rewardSolToLamports(rewardSol: number): number {
  return Math.round(rewardSol * LAMPORTS_PER_SOL);
}

export function rewardLamportsToSol(lamports: number): number {
  return Number((lamports / LAMPORTS_PER_SOL).toFixed(4));
}

/** Display helper: wei TEXT in DB -> human WLD amount, capped to 4 places. */
export function rewardWeiToWld(weiString: string | null | undefined): number {
  if (!weiString) return 0;
  try {
    return Number(weiStringToWld(weiString).toFixed(4));
  } catch {
    return 0;
  }
}

/**
 * XP awards live on the [MIN_XP_STAKE, MAX_XP_STAKE] interval and round to
 * the nearest 5 -- that keeps the leaderboard visually clean without
 * sacrificing the LLM's resolution.
 */
export function clampXp(value: number): number {
  if (!Number.isFinite(value)) return MIN_XP_STAKE;
  const rounded = Math.round(value / 5) * 5;
  return Math.max(MIN_XP_STAKE, Math.min(MAX_XP_STAKE, rounded));
}

export function computeClaimExpiry(claimedAt: string): string {
  return new Date(new Date(claimedAt).getTime() + CLAIM_WINDOW_MS).toISOString();
}

export function isClaimExpired(claimedAt: string | null | undefined): boolean {
  if (!claimedAt) return false;
  const expiry = new Date(claimedAt).getTime() + CLAIM_WINDOW_MS;
  return Date.now() > expiry;
}

export function computeUrgencyScore(bounty: Bounty): number {
  const createdAtMs = bounty.created_at
    ? new Date(bounty.created_at).getTime()
    : Date.now();
  const ageHours = Math.max(0, (Date.now() - createdAtMs) / (1000 * 60 * 60));
  // Treat all reward types on the same urgency scale. The conversion factors
  // are deliberately rough -- this is a UI sort heuristic, not a price oracle:
  //   * 100 XP    ~= 0.05 SOL of urgency weight
  //   * 1 WLD     ~= 0.10 SOL of urgency weight (roughly market-aligned in
  //                 mid-2026 fixture data; the exact value doesn't affect
  //                 correctness, only sort order)
  const rewardSol = rewardLamportsToSol(bounty.reward_lamports);
  const xpAsSolEquivalent = (bounty.reward_xp ?? 0) / 2_000;
  const wldAsSolEquivalent = rewardWeiToWld(bounty.reward_wld_wei) * 0.1;
  const rewardComponent = Math.min(
    50,
    (rewardSol + xpAsSolEquivalent + wldAsSolEquivalent) * 5
  );
  const ageComponent = Math.min(35, ageHours * 0.9);
  const statusComponent =
    bounty.status === 'open'
      ? 15
      : bounty.status === 'claimed'
        ? 5
        : bounty.status === 'expired'
          ? 0
          : 3;

  return Math.max(
    0,
    Math.min(100, Math.round(rewardComponent + ageComponent + statusComponent))
  );
}

/**
 * Build the front-end-shaped reward summary that every bounty response
 * includes. We always emit ``reward_sol`` / ``reward_xp`` / ``reward_wld``
 * regardless of the underlying reward type so the UI can render any of them
 * without first re-checking ``reward_type``. The unused fields collapse to 0
 * (or `null` for staked-XP) so the renderer can do a single switch.
 */
export function describeReward(bounty: Bounty): {
  reward_type: 'sol' | 'xp' | 'wld';
  reward_sol: number;
  reward_xp: number | null;
  reward_wld: number;
  reward_wld_wei: string | null;
  xp_award: number;
} {
  return {
    reward_type: bounty.reward_type,
    reward_sol: rewardLamportsToSol(bounty.reward_lamports),
    reward_xp: bounty.reward_xp ?? null,
    reward_wld: rewardWeiToWld(bounty.reward_wld_wei),
    reward_wld_wei: bounty.reward_wld_wei ?? null,
    xp_award: bounty.xp_award ?? 0
  };
}
