import type { Tables } from '../types/database.types.js';

type Bounty = Tables<'bounties'>;

export type Currency = 'WLD' | 'SOL';

const CLAIM_WINDOW_MS = 4 * 60 * 60 * 1000;

// Smallest-unit scaling per currency.
//   * SOL: 1 SOL = 1e9 lamports
//   * WLD: 1 WLD = 1e6 micro-WLD (we use micro-WLD internally to fit in JS
//     integers; the on-chain ERC-20 has 18 decimals, but `lib/wld.ts` widens
//     to bigint at the chain boundary).
const LAMPORTS_PER_SOL = 1_000_000_000;
const MICRO_WLD_PER_WLD = 1_000_000;

export function rewardSolToLamports(rewardSol: number): number {
  if (!Number.isFinite(rewardSol) || rewardSol < 0) {
    throw new Error('reward_sol must be a non-negative finite number.');
  }
  return Math.round(rewardSol * LAMPORTS_PER_SOL);
}

export function rewardLamportsToSol(lamports: number): number {
  return Number((lamports / LAMPORTS_PER_SOL).toFixed(9));
}

export function rewardWldToMicro(rewardWld: number): number {
  if (!Number.isFinite(rewardWld) || rewardWld < 0) {
    throw new Error('reward_wld must be a non-negative finite number.');
  }
  return Math.round(rewardWld * MICRO_WLD_PER_WLD);
}

export function rewardMicroToWld(microWld: number): number {
  return Number((microWld / MICRO_WLD_PER_WLD).toFixed(6));
}

/** Convert a smallest-unit integer to a human-friendly amount in `currency`. */
export function smallestUnitsToHuman(
  currency: Currency,
  smallest: number
): number {
  return currency === 'SOL'
    ? rewardLamportsToSol(smallest)
    : rewardMicroToWld(smallest);
}

/** Convert a human amount to its smallest-unit integer for `currency`. */
export function humanToSmallestUnits(
  currency: Currency,
  human: number
): number {
  return currency === 'SOL'
    ? rewardSolToLamports(human)
    : rewardWldToMicro(human);
}

export function computeClaimExpiry(claimedAt: string): string {
  return new Date(new Date(claimedAt).getTime() + CLAIM_WINDOW_MS).toISOString();
}

export function isClaimExpired(claimedAt: string | null | undefined): boolean {
  if (!claimedAt) return false;
  const expiry = new Date(claimedAt).getTime() + CLAIM_WINDOW_MS;
  return Date.now() > expiry;
}

// Per-currency reward weights for urgency. Both currencies hover around
// $2-$3/unit at the time of writing, so we score them roughly equivalently
// (5 points per unit) and let the cap handle outliers.
const URGENCY_REWARD_WEIGHT: Record<Currency, number> = {
  WLD: 5,
  SOL: 5
};

export function computeUrgencyScore(bounty: Bounty): number {
  const createdAtMs = bounty.created_at
    ? new Date(bounty.created_at).getTime()
    : Date.now();
  const ageHours = Math.max(0, (Date.now() - createdAtMs) / (1000 * 60 * 60));
  const currency: Currency = bounty.reward_currency ?? 'WLD';
  const human = smallestUnitsToHuman(currency, bounty.reward_lamports);
  const rewardComponent = Math.min(
    50,
    human * URGENCY_REWARD_WEIGHT[currency]
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
 * Build the public-facing reward fields for a bounty. Always emits
 * `reward_currency` and a `reward` value in the bounty's currency, plus
 * the per-currency-named field (`reward_wld` or `reward_sol`) for clients
 * that key off currency.
 */
export function rewardFieldsFor(bounty: Bounty): {
  reward_currency: Currency;
  reward: number;
  reward_wld?: number;
  reward_sol?: number;
} {
  const currency: Currency = bounty.reward_currency ?? 'WLD';
  const human = smallestUnitsToHuman(currency, bounty.reward_lamports);
  return currency === 'SOL'
    ? { reward_currency: 'SOL', reward: human, reward_sol: human }
    : { reward_currency: 'WLD', reward: human, reward_wld: human };
}
