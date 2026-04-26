import type { Tables } from '../types/database.types.js';

type Bounty = Tables<'bounties'>;

const CLAIM_WINDOW_MS = 4 * 60 * 60 * 1000;
const LAMPORTS_PER_SOL = 1_000_000_000;

export const MIN_XP_STAKE = 5;
export const MAX_XP_STAKE = 5_000;

export function rewardSolToLamports(rewardSol: number): number {
  return Math.round(rewardSol * LAMPORTS_PER_SOL);
}

export function rewardLamportsToSol(lamports: number): number {
  return Number((lamports / LAMPORTS_PER_SOL).toFixed(4));
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
  // Treat XP and SOL on the same urgency scale: 100 XP ~= 0.05 SOL of urgency
  // weight, so a 200-XP bounty feels comparable to a 0.1-SOL one for sorting.
  const rewardSol = rewardLamportsToSol(bounty.reward_lamports);
  const xpAsSolEquivalent = (bounty.reward_xp ?? 0) / 2_000;
  const rewardComponent = Math.min(50, (rewardSol + xpAsSolEquivalent) * 5);
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
 * includes. We always emit both ``reward_sol`` and ``reward_xp`` so the UI
 * can render either currency without first re-checking ``reward_type``.
 */
export function describeReward(bounty: Bounty): {
  reward_type: 'sol' | 'xp';
  reward_sol: number;
  reward_xp: number | null;
  xp_award: number;
} {
  return {
    reward_type: bounty.reward_type,
    reward_sol: rewardLamportsToSol(bounty.reward_lamports),
    reward_xp: bounty.reward_xp ?? null,
    xp_award: bounty.xp_award ?? 0
  };
}
