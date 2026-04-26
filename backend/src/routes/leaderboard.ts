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

type LeaderboardEntry = {
  rank: number;
  user_id: string;
  handle: string;
  display_name: string | null;
  avatar_color: string;
  total_xp: number;
  total_earned_sol: number;
  total_completed: number;
  wallet_address: string;
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

  const timeframe = parsed.data.timeframe ?? 'all';
  const limit = parsed.data.limit ?? 25;

  if (timeframe === 'all') {
    res.json({
      timeframe,
      items: await rankAllTime(limit)
    });
    return;
  }

  res.json({
    timeframe,
    items: await rankWindow(timeframe, limit)
  });
});

/**
 * "All-time" rankings come straight from the ``users`` table, where the
 * verification handler maintains ``total_earned_xp``/``total_earned_lamports``
 * counters atomically. This avoids re-aggregating the ``bounties`` table on
 * every request and naturally respects refunds (which update XP without
 * incrementing the lifetime total).
 */
async function rankAllTime(limit: number): Promise<LeaderboardEntry[]> {
  if (!supabase) return [];

  const { data, error } = await supabase
    .from('users')
    .select(
      'id, wallet_address, display_name, total_earned_xp, total_earned_lamports'
    )
    .order('total_earned_xp', { ascending: false })
    .limit(limit);

  if (error) {
    console.error('Leaderboard all-time query failed:', error.message);
    return [];
  }

  const userIds = (data ?? []).map((u) => u.id);
  const completedCounts = await fetchCompletedCounts(userIds);

  return (data ?? []).map((u, index) => ({
    rank: index + 1,
    user_id: u.id,
    handle: shortHandle(u.id, u.wallet_address, u.display_name),
    display_name: u.display_name ?? null,
    avatar_color: avatarColorFor(u.id),
    total_xp: u.total_earned_xp ?? 0,
    total_earned_sol: Number(
      rewardLamportsToSol(u.total_earned_lamports ?? 0).toFixed(4)
    ),
    total_completed: completedCounts.get(u.id) ?? 0,
    wallet_address: u.wallet_address ?? ''
  }));
}

/**
 * Time-windowed rankings sum ``bounties.xp_award`` over the period. SOL and
 * XP bounties contribute to the same total because the XP award column is
 * populated for both reward types.
 */
async function rankWindow(
  timeframe: 'week' | 'month',
  limit: number
): Promise<LeaderboardEntry[]> {
  if (!supabase) return [];

  const since = new Date(Date.now() - TIMEFRAME_MS[timeframe]).toISOString();
  const { data, error } = await supabase
    .from('bounties')
    .select(
      'claimer_id, reward_lamports, xp_award, claimed_at, claimer:users!bounties_claimer_id_fkey(id, wallet_address, display_name)'
    )
    .eq('status', 'completed')
    .gte('claimed_at', since)
    .not('claimer_id', 'is', null);

  if (error) {
    console.error('Leaderboard window query failed:', error.message);
    return [];
  }

  type Aggregate = {
    user_id: string;
    wallet_address: string;
    display_name: string | null;
    total_xp: number;
    total_lamports: number;
    total_completed: number;
  };

  const map = new Map<string, Aggregate>();

  for (const row of data ?? []) {
    if (!row.claimer_id) continue;
    const claimer =
      (row as unknown as {
        claimer?: {
          wallet_address?: string;
          display_name?: string | null;
        } | null;
      }).claimer ?? null;

    const existing = map.get(row.claimer_id) ?? {
      user_id: row.claimer_id,
      wallet_address: claimer?.wallet_address ?? '',
      display_name: claimer?.display_name ?? null,
      total_xp: 0,
      total_lamports: 0,
      total_completed: 0
    };
    existing.total_xp += row.xp_award ?? 0;
    existing.total_lamports += row.reward_lamports ?? 0;
    existing.total_completed += 1;
    map.set(row.claimer_id, existing);
  }

  return Array.from(map.values())
    .sort((a, b) => b.total_xp - a.total_xp || b.total_lamports - a.total_lamports)
    .slice(0, limit)
    .map((entry, index) => ({
      rank: index + 1,
      user_id: entry.user_id,
      handle: shortHandle(
        entry.user_id,
        entry.wallet_address,
        entry.display_name
      ),
      display_name: entry.display_name,
      avatar_color: avatarColorFor(entry.user_id),
      total_xp: entry.total_xp,
      total_earned_sol: Number(
        rewardLamportsToSol(entry.total_lamports).toFixed(4)
      ),
      total_completed: entry.total_completed,
      wallet_address: entry.wallet_address
    }));
}

/**
 * Look up "completed bounties" counts for a set of users in a single round-
 * trip. Supabase doesn't support GROUP BY through the JS client without
 * RPC, so we fetch the rows and count client-side -- fine at hackathon
 * scale (top-N users with at most a few hundred bounties each).
 */
async function fetchCompletedCounts(
  userIds: string[]
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (userIds.length === 0 || !supabase) return counts;

  const { data, error } = await supabase
    .from('bounties')
    .select('claimer_id')
    .eq('status', 'completed')
    .in('claimer_id', userIds);

  if (error) {
    console.warn('Failed to load completed counts:', error.message);
    return counts;
  }

  for (const row of data ?? []) {
    if (!row.claimer_id) continue;
    counts.set(row.claimer_id, (counts.get(row.claimer_id) ?? 0) + 1);
  }
  return counts;
}

function shortHandle(
  userId: string,
  wallet: string | null | undefined,
  displayName: string | null | undefined
): string {
  if (displayName && displayName.trim().length > 0) return displayName.trim();
  if (wallet && wallet.length > 0) {
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
