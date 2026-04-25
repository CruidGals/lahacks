import type { Tables } from '../types/database.types.js';

type Bounty = Tables<'bounties'>;

const CLAIM_WINDOW_MS = 4 * 60 * 60 * 1000;
const LAMPORTS_PER_SOL = 1_000_000_000;

export function rewardSolToLamports(rewardSol: number): number {
  return Math.round(rewardSol * LAMPORTS_PER_SOL);
}

export function rewardLamportsToSol(lamports: number): number {
  return Number((lamports / LAMPORTS_PER_SOL).toFixed(4));
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
  const rewardSol = rewardLamportsToSol(bounty.reward_lamports);
  const rewardComponent = Math.min(50, rewardSol * 5);
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
