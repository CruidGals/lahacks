import { Router } from 'express';
import { z } from 'zod';
import { supabase } from '../config/supabase.js';
import { rewardLamportsToSol, rewardMicroToWld } from '../lib/bounties.js';

// Rough USD conversion rates for combined ranking. These are display-only;
// the source of truth is always per-currency totals. Keep in sync with
// `frontend/lib/format.ts` SPOT_USD so both ends agree on USD totals.
const WLD_USD = 2;
const SOL_USD = 150;

export const leaderboardRouter = Router();

const querySchema = z.object({
  timeframe: z.enum(['week', 'month', 'all']).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional()
});

const TIMEFRAME_MS: Record<'week' | 'month', number> = {
  week: 7 * 24 * 60 * 60 * 1000,
  month: 30 * 24 * 60 * 60 * 1000
};

leaderboardRouter.get('/', async (req, res) => {
  if (!supabase) {
    res.status(500).json({ error: 'Supabase is not configured.' });
    return;
  }

  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const timeframe = parsed.data.timeframe ?? 'week';
  const limit = parsed.data.limit ?? 25;

  let query = supabase
    .from('bounties')
    .select(
      'claimer_id, reward_currency, reward_lamports, claimed_at, claimer:users!bounties_claimer_id_fkey(id, wallet_address, world_address)'
    )
    .eq('status', 'completed')
    .not('claimer_id', 'is', null);

  if (timeframe !== 'all') {
    const since = new Date(Date.now() - TIMEFRAME_MS[timeframe]).toISOString();
    query = query.gte('claimed_at', since);
  }

  const { data, error } = await query;
  if (error) {
    res.status(500).json({ error: 'Failed to load leaderboard.' });
    return;
  }

  type Aggregate = {
    user_id: string;
    wallet_address: string;
    world_address: string;
    total_micro_wld: number;
    total_lamports_sol: number;
    total_completed: number;
  };

  const map = new Map<string, Aggregate>();

  for (const row of data ?? []) {
    if (!row.claimer_id) continue;
    const claimer =
      (row as unknown as {
        claimer?: { wallet_address?: string; world_address?: string | null };
      }).claimer ?? {};
    const existing = map.get(row.claimer_id) ?? {
      user_id: row.claimer_id,
      wallet_address: claimer.wallet_address ?? '',
      world_address: claimer.world_address ?? '',
      total_micro_wld: 0,
      total_lamports_sol: 0,
      total_completed: 0
    };
    if (row.reward_currency === 'SOL') {
      existing.total_lamports_sol += row.reward_lamports;
    } else {
      existing.total_micro_wld += row.reward_lamports;
    }
    existing.total_completed += 1;
    map.set(row.claimer_id, existing);
  }

  const ranked = Array.from(map.values())
    .map((entry) => {
      const totalWld = rewardMicroToWld(entry.total_micro_wld);
      const totalSol = rewardLamportsToSol(entry.total_lamports_sol);
      return {
        ...entry,
        total_earned_wld: Number(totalWld.toFixed(4)),
        total_earned_sol: Number(totalSol.toFixed(4)),
        total_earned_usd: Number(
          (totalWld * WLD_USD + totalSol * SOL_USD).toFixed(2)
        )
      };
    })
    .sort((a, b) => b.total_earned_usd - a.total_earned_usd)
    .slice(0, limit)
    .map((entry, index) => ({
      rank: index + 1,
      user_id: entry.user_id,
      handle: shortHandle(
        entry.user_id,
        entry.world_address || entry.wallet_address
      ),
      avatar_color: avatarColorFor(entry.user_id),
      total_earned_wld: entry.total_earned_wld,
      total_earned_sol: entry.total_earned_sol,
      total_earned_usd: entry.total_earned_usd,
      total_completed: entry.total_completed,
      wallet_address: entry.wallet_address,
      world_address: entry.world_address || null
    }));

  res.json({ timeframe, items: ranked });
});

function shortHandle(userId: string, wallet: string): string {
  if (wallet) {
    return `${wallet.slice(0, 4)}…${wallet.slice(-4)}`;
  }
  return `user_${userId.slice(0, 6)}`;
}

const AVATAR_PALETTE = [
  '#16a34a',
  '#2563eb',
  '#7c3aed',
  '#f59e0b',
  '#e11d48',
  '#0891b2',
  '#0a0a0a'
];

function avatarColorFor(seed: string): string {
  let hash = 0;
  for (const ch of seed) {
    hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  }
  return AVATAR_PALETTE[hash % AVATAR_PALETTE.length] ?? '#16a34a';
}
