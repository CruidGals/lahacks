import { Router } from 'express';
import { z } from 'zod';
import { supabase } from '../config/supabase.js';
import { rewardLamportsToSol } from '../lib/bounties.js';

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
      'claimer_id, reward_lamports, claimed_at, claimer:users!bounties_claimer_id_fkey(id, wallet_address)'
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
    total_lamports: number;
    total_completed: number;
  };

  const map = new Map<string, Aggregate>();

  for (const row of data ?? []) {
    if (!row.claimer_id) continue;
    const existing = map.get(row.claimer_id) ?? {
      user_id: row.claimer_id,
      // claimer is a single nested object thanks to the FK
      wallet_address:
        (row as unknown as { claimer?: { wallet_address?: string } }).claimer
          ?.wallet_address ?? '',
      total_lamports: 0,
      total_completed: 0
    };
    existing.total_lamports += row.reward_lamports;
    existing.total_completed += 1;
    map.set(row.claimer_id, existing);
  }

  const ranked = Array.from(map.values())
    .sort((a, b) => b.total_lamports - a.total_lamports)
    .slice(0, limit)
    .map((entry, index) => ({
      rank: index + 1,
      user_id: entry.user_id,
      handle: shortHandle(entry.user_id, entry.wallet_address),
      avatar_color: avatarColorFor(entry.user_id),
      total_earned_sol: Number(rewardLamportsToSol(entry.total_lamports).toFixed(4)),
      total_completed: entry.total_completed,
      wallet_address: entry.wallet_address
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
