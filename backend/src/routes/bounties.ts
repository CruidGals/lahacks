import { Router } from 'express';
import { z } from 'zod';
import { supabase } from '../config/supabase.js';
import { requireAuthUser } from '../lib/auth.js';
import {
  computeClaimExpiry,
  computeUrgencyScore,
  isClaimExpired,
  rewardLamportsToSol,
  rewardSolToLamports
} from '../lib/bounties.js';
import { escrowBounty } from '../lib/solana.js';

export const bountyRouter = Router();

function bypassVerificationForTesting(): boolean {
  return process.env.BYPASS_VERIFICATION_FOR_TESTING?.trim().toLowerCase() === 'true';
}

const createBountySchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  reward_sol: z.number().positive(),
  description: z.string().min(1).max(2000),
  reference_video_url: z.url().optional().nullable()
});

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

  const rewardLamports = rewardSolToLamports(parsed.data.reward_sol);
  let escrowTxSig: string;
  try {
    escrowTxSig = await escrowBounty({
      posterId: user.id,
      posterWallet: user.wallet_address,
      rewardLamports
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to escrow bounty funds.';
    const lowered = message.toLowerCase();
    const isFundingConfigIssue =
      lowered.includes('insufficient balance') ||
      lowered.includes('poster wallet is required') ||
      lowered.includes('requires a client-signed escrow transfer') ||
      lowered.includes('missing required env var');
    res.status(isFundingConfigIssue ? 400 : 500).json({ error: message });
    return;
  }

  const { data: created, error: insertError } = await supabase
    .from('bounties')
    .insert({
      poster_id: user.id,
      lat: parsed.data.lat,
      lng: parsed.data.lng,
      reward_lamports: rewardLamports,
      description: parsed.data.description,
      reference_video_url: parsed.data.reference_video_url ?? null,
      status: 'open',
      escrow_tx_sig: escrowTxSig
    })
    .select('*')
    .single();

  if (insertError || !created) {
    res.status(500).json({ error: 'Escrow succeeded but failed to create bounty record.' });
    return;
  }

  res.status(201).json({
    bounty: {
      ...created,
      reward_sol: rewardLamportsToSol(created.reward_lamports),
      urgency_score: computeUrgencyScore(created)
    },
    escrow_tx_sig: escrowTxSig
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

      return {
        ...bounty,
        status: hasExpiredClaim ? 'expired' : bounty.status,
        reward_sol: rewardLamportsToSol(bounty.reward_lamports),
        urgency_score: computeUrgencyScore({
          ...bounty,
          status: hasExpiredClaim ? 'expired' : bounty.status
        })
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
        reward_sol: rewardLamportsToSol(bounty.reward_lamports),
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

  res.json({
    ...bounty,
    status,
    reward_sol: rewardLamportsToSol(bounty.reward_lamports),
    urgency_score: computeUrgencyScore({ ...bounty, status })
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

  if (!bypassVerificationForTesting() && bounty.poster_id === user.id) {
    res.status(403).json({ error: 'You cannot claim a bounty that you posted.' });
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
      reward_sol: rewardLamportsToSol(updated.reward_lamports),
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
      reward_sol: rewardLamportsToSol(updated.reward_lamports),
      urgency_score: computeUrgencyScore(updated)
    }
  });
});
