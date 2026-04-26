import { Router } from 'express';
import { z } from 'zod';
import { supabase } from '../config/supabase.js';
import { calculateXpReward } from '../lib/aiXp.js';
import { requireAuthUser } from '../lib/auth.js';
import {
  MAX_XP_STAKE,
  MIN_XP_STAKE,
  computeClaimExpiry,
  computeUrgencyScore,
  describeReward,
  isClaimExpired,
  rewardSolToLamports
} from '../lib/bounties.js';
import { escrowBounty } from '../lib/solana.js';

export const bountyRouter = Router();

const createBountySchema = z
  .object({
    /** Optional client-generated UUID (v4) so the poster can upload fixture files to namespaced paths before the row is created. */
    id: z.string().uuid().optional(),
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
    reward_sol: z.number().positive().optional(),
    reward_xp: z.number().int().min(MIN_XP_STAKE).max(MAX_XP_STAKE).optional(),
    title: z.string().min(1).max(120).optional(),
    category: z.string().min(1).max(60).optional(),
    description: z.string().min(1).max(2000),
    reference_video_url: z.url().optional().nullable()
  })
  .refine(
    (data) =>
      (data.reward_sol !== undefined) !== (data.reward_xp !== undefined),
    {
      message:
        'Exactly one of reward_sol or reward_xp must be provided.',
      path: ['reward_sol']
    }
  );

const bboxSchema = z.object({
  min_lat: z.coerce.number().min(-90).max(90).optional(),
  max_lat: z.coerce.number().min(-90).max(90).optional(),
  min_lng: z.coerce.number().min(-180).max(180).optional(),
  max_lng: z.coerce.number().min(-180).max(180).optional()
});

bountyRouter.post('/', async (req, res) => {
  const user = await requireAuthUser(req, res);
  if (!user) return;

  if (!user.verified) {
    res.status(403).json({ error: 'World ID verification is required.' });
    return;
  }

  if (!supabase) {
    res.status(500).json({ error: 'Supabase is not configured.' });
    return;
  }

  const parsed = createBountySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const isXpBounty = parsed.data.reward_xp !== undefined;

  // Always run the AI XP pipeline -- for SOL bounties it gives us the bonus
  // XP the claimer earns on top of the SOL payout; for XP bounties it gives
  // us difficulty/importance for transparency (the actual xp_award is
  // overridden to match the poster's stake so the system isn't gameable).
  const xp = await calculateXpReward({
    title: parsed.data.title ?? null,
    description: parsed.data.description,
    category: parsed.data.category ?? null,
    reward_sol: parsed.data.reward_sol ?? null,
    lat: parsed.data.lat,
    lng: parsed.data.lng
  });

  const rewardLamports = isXpBounty
    ? 0
    : rewardSolToLamports(parsed.data.reward_sol as number);

  let escrowTxSig: string | null = null;

  if (isXpBounty) {
    const stake = parsed.data.reward_xp as number;
    const { error: stakeError } = await supabase.rpc('stake_xp', {
      p_user_id: user.id,
      p_amount: stake
    });

    if (stakeError) {
      const message = stakeError.message ?? '';
      if (message.includes('insufficient XP balance')) {
        res.status(402).json({
          error: 'Insufficient XP balance to stake this bounty.'
        });
      } else {
        res.status(500).json({ error: 'Failed to stake XP.' });
      }
      return;
    }
  } else {
    try {
      escrowTxSig = await escrowBounty({
        posterId: user.id,
        rewardLamports
      });
    } catch (err) {
      console.error('SOL escrow failed:', err);
      res.status(500).json({ error: 'Failed to escrow SOL bounty.' });
      return;
    }
  }

  const xpAward = isXpBounty ? (parsed.data.reward_xp as number) : xp.xp_award;

  const { data: created, error: insertError } = await supabase
    .from('bounties')
    .insert({
      poster_id: user.id,
      lat: parsed.data.lat,
      lng: parsed.data.lng,
      reward_lamports: rewardLamports,
      reward_type: isXpBounty ? 'xp' : 'sol',
      reward_xp: isXpBounty ? (parsed.data.reward_xp as number) : null,
      xp_award: xpAward,
      difficulty_score: xp.difficulty_score,
      importance_score: xp.importance_score,
      xp_reasoning: xp.reasoning,
      title: parsed.data.title ?? null,
      description: parsed.data.description,
      reference_video_url: parsed.data.reference_video_url ?? null,
      status: 'open',
      escrow_tx_sig: escrowTxSig,
      ...(parsed.data.id ? { id: parsed.data.id } : {})
    })
    .select('*')
    .single();

  if (insertError || !created) {
    // If we already moved value (SOL escrow or XP stake), best-effort roll
    // it back so the user doesn't lose anything to a transient DB blip.
    if (isXpBounty) {
      await supabase.rpc('refund_xp', {
        p_user_id: user.id,
        p_amount: parsed.data.reward_xp as number
      });
    }
    res.status(500).json({
      error: isXpBounty
        ? 'Failed to create XP bounty record (stake refunded).'
        : 'Escrow succeeded but failed to create bounty record.'
    });
    return;
  }

  res.status(201).json({
    bounty: {
      ...created,
      ...describeReward(created),
      urgency_score: computeUrgencyScore(created)
    },
    escrow_tx_sig: escrowTxSig,
    xp_evaluation: {
      xp_award: created.xp_award,
      difficulty_score: xp.difficulty_score,
      importance_score: xp.importance_score,
      reasoning: xp.reasoning,
      source: xp.source
    }
  });
});

bountyRouter.get('/', async (req, res) => {
  if (!supabase) {
    res.status(500).json({ error: 'Supabase is not configured.' });
    return;
  }

  const parsed = bboxSchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  let query = supabase
    .from('bounties')
    .select(
      '*, poster:users!bounties_poster_id_fkey(id, wallet_address, verified)'
    )
    .order('created_at', {
      ascending: false
    });

  if (parsed.data.min_lat !== undefined) {
    query = query.gte('lat', parsed.data.min_lat);
  }
  if (parsed.data.max_lat !== undefined) {
    query = query.lte('lat', parsed.data.max_lat);
  }
  if (parsed.data.min_lng !== undefined) {
    query = query.gte('lng', parsed.data.min_lng);
  }
  if (parsed.data.max_lng !== undefined) {
    query = query.lte('lng', parsed.data.max_lng);
  }

  const { data, error } = await query;
  if (error) {
    res.status(500).json({ error: 'Failed to list bounties.' });
    return;
  }

  const now = new Date();
  const items =
    data?.map((bounty) => {
      const hasExpiredClaim =
        bounty.status === 'claimed' && isClaimExpired(bounty.claimed_at);
      const adjusted = {
        ...bounty,
        status: hasExpiredClaim ? 'expired' : bounty.status
      };

      return {
        ...adjusted,
        ...describeReward(adjusted),
        urgency_score: computeUrgencyScore(adjusted)
      };
    }) ?? [];

  res.json({
    as_of: now.toISOString(),
    items
  });
});

bountyRouter.get('/me/claimed', async (req, res) => {
  const user = await requireAuthUser(req, res);
  if (!user) return;

  if (!supabase) {
    res.status(500).json({ error: 'Supabase is not configured.' });
    return;
  }

  const { data, error } = await supabase
    .from('bounties')
    .select(
      '*, poster:users!bounties_poster_id_fkey(id, wallet_address, verified)'
    )
    .eq('claimer_id', user.id)
    .eq('status', 'claimed')
    .order('claimed_at', { ascending: false });

  if (error) {
    res.status(500).json({ error: 'Failed to load claimed bounties.' });
    return;
  }

  const items =
    data
      ?.filter((bounty) => !isClaimExpired(bounty.claimed_at))
      .map((bounty) => ({
        ...bounty,
        ...describeReward(bounty),
        urgency_score: computeUrgencyScore(bounty),
        claim_expires_at: bounty.claimed_at
          ? computeClaimExpiry(bounty.claimed_at)
          : null
      })) ?? [];

  res.json({
    as_of: new Date().toISOString(),
    items
  });
});

bountyRouter.get('/:id', async (req, res) => {
  if (!supabase) {
    res.status(500).json({ error: 'Supabase is not configured.' });
    return;
  }

  const { data: bounty, error } = await supabase
    .from('bounties')
    .select(
      '*, poster:users!bounties_poster_id_fkey(id, wallet_address, verified)'
    )
    .eq('id', req.params.id)
    .maybeSingle();

  if (error) {
    res.status(500).json({ error: 'Failed to load bounty.' });
    return;
  }
  if (!bounty) {
    res.status(404).json({ error: 'Bounty not found.' });
    return;
  }

  const status =
    bounty.status === 'claimed' && isClaimExpired(bounty.claimed_at)
      ? 'expired'
      : bounty.status;
  const adjusted = { ...bounty, status };

  res.json({
    ...adjusted,
    ...describeReward(adjusted),
    urgency_score: computeUrgencyScore(adjusted)
  });
});

bountyRouter.post('/:id/claim', async (req, res) => {
  const user = await requireAuthUser(req, res);
  if (!user) return;

  if (!user.verified) {
    res.status(403).json({ error: 'World ID verification is required.' });
    return;
  }

  if (!supabase) {
    res.status(500).json({ error: 'Supabase is not configured.' });
    return;
  }

  const { data: bounty, error } = await supabase
    .from('bounties')
    .select('*')
    .eq('id', req.params.id)
    .maybeSingle();

  if (error) {
    res.status(500).json({ error: 'Failed to load bounty.' });
    return;
  }
  if (!bounty) {
    res.status(404).json({ error: 'Bounty not found.' });
    return;
  }

  if (bounty.status === 'completed') {
    res.status(409).json({ error: 'Bounty is already completed.' });
    return;
  }

  if (bounty.status === 'claimed' && !isClaimExpired(bounty.claimed_at)) {
    res.status(409).json({ error: 'Bounty is currently claimed.' });
    return;
  }

  const claimedAt = new Date().toISOString();
  const { data: updated, error: updateError } = await supabase
    .from('bounties')
    .update({
      status: 'claimed',
      claimer_id: user.id,
      claimed_at: claimedAt
    })
    .eq('id', bounty.id)
    .select(
      '*, poster:users!bounties_poster_id_fkey(id, wallet_address, verified)'
    )
    .single();

  if (updateError || !updated) {
    res.status(500).json({ error: 'Failed to claim bounty.' });
    return;
  }

  res.json({
    message: 'Bounty claimed successfully.',
    claim_expires_at: computeClaimExpiry(claimedAt),
    bounty: {
      ...updated,
      ...describeReward(updated),
      urgency_score: computeUrgencyScore(updated)
    }
  });
});

bountyRouter.post('/:id/unclaim', async (req, res) => {
  const user = await requireAuthUser(req, res);
  if (!user) return;

  if (!supabase) {
    res.status(500).json({ error: 'Supabase is not configured.' });
    return;
  }

  const { data: bounty, error } = await supabase
    .from('bounties')
    .select('*')
    .eq('id', req.params.id)
    .maybeSingle();

  if (error) {
    res.status(500).json({ error: 'Failed to load bounty.' });
    return;
  }
  if (!bounty) {
    res.status(404).json({ error: 'Bounty not found.' });
    return;
  }

  if (bounty.claimer_id !== user.id) {
    res.status(403).json({
      error: 'Only the user who claimed this bounty can cancel the claim.'
    });
    return;
  }

  if (bounty.status === 'completed') {
    res.status(409).json({
      error: 'Bounty is already completed and cannot be unclaimed.'
    });
    return;
  }

  if (bounty.status !== 'claimed') {
    res
      .status(409)
      .json({ error: 'Bounty is not currently in a claimed state.' });
    return;
  }

  // Close any active sessions the user has on this bounty so a new
  // claimer can't piggyback on a stale session record.
  const { error: sessionError } = await supabase
    .from('sessions')
    .update({ status: 'rejected' })
    .eq('bounty_id', bounty.id)
    .eq('user_id', user.id)
    .eq('status', 'active');

  if (sessionError) {
    res.status(500).json({ error: 'Failed to close active session.' });
    return;
  }

  const { data: updated, error: updateError } = await supabase
    .from('bounties')
    .update({
      status: 'open',
      claimer_id: null,
      claimed_at: null
    })
    .eq('id', bounty.id)
    .select(
      '*, poster:users!bounties_poster_id_fkey(id, wallet_address, verified)'
    )
    .single();

  if (updateError || !updated) {
    res.status(500).json({ error: 'Failed to release bounty claim.' });
    return;
  }

  res.json({
    message: 'Claim cancelled. The bounty is open for others again.',
    bounty: {
      ...updated,
      ...describeReward(updated),
      urgency_score: computeUrgencyScore(updated)
    }
  });
});
