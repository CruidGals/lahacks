import { Router } from 'express';
import { z } from 'zod';
import { supabase } from '../config/supabase.js';
import { requireAuthUser } from '../lib/auth.js';
import {
  computeClaimExpiry,
  computeUrgencyScore,
  isClaimExpired,
  rewardFieldsFor,
  rewardSolToLamports
} from '../lib/bounties.js';
import { escrowBounty } from '../lib/solana.js';

export const bountyRouter = Router();

function bypassVerificationForTesting(): boolean {
  return process.env.BYPASS_VERIFICATION_FOR_TESTING?.trim().toLowerCase() === 'true';
}

/**
 * Bounty creation has two paths depending on the reward currency:
 *
 * 1. SOL: this endpoint escrows the reward server-side using the configured
 *    `SOLANA_FUNDER_SECRET_KEY` → `SOLANA_VAULT_SECRET_KEY` keypairs and
 *    persists the bounty immediately. The poster does not need to hold SOL.
 *
 * 2. WLD: bounty creation requires the poster to actually pay WLD from their
 *    World App wallet. That flow lives in `routes/payments.ts` under the
 *    two-phase `/api/payments/intent` + `/api/payments/confirm` endpoints.
 *    Posting to this route with `reward_currency: "WLD"` returns 410 with a
 *    pointer to the right flow.
 */
const createBountySchema = z
  .object({
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
    reward_currency: z.enum(['WLD', 'SOL']).optional(),
    reward_sol: z.number().positive().optional(),
    reward_wld: z.number().positive().optional(),
    description: z.string().min(1).max(2000),
    reference_video_url: z.url().optional().nullable()
  })
  .refine(
    (val) =>
      val.reward_sol !== undefined ||
      val.reward_wld !== undefined ||
      val.reward_currency !== undefined,
    {
      message:
        'Provide either reward_sol or reward_wld (and optionally reward_currency).'
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

  const parsed = createBountySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  // Resolve currency. Explicit `reward_currency` wins; otherwise infer from
  // whichever amount field was supplied; default to SOL for back-compat with
  // the original API shape.
  const currency =
    parsed.data.reward_currency ??
    (parsed.data.reward_wld !== undefined ? 'WLD' : 'SOL');

  if (currency === 'WLD') {
    res.status(410).json({
      error:
        'WLD bounties must be created through the payments flow. Use POST /api/payments/intent with kind="bounty_escrow" then POST /api/payments/confirm.',
      migration: {
        step1:
          'POST /api/payments/intent { kind: "bounty_escrow", bounty: { lat, lng, reward_wld, description, reference_video_url } }',
        step2:
          'await MiniKit.pay({ reference, to: recipient, tokens: [{ symbol: Tokens.WLD, token_amount: expected_amount_wei }] })',
        step3: 'POST /api/payments/confirm { reference, transaction_id }'
      }
    });
    return;
  }

  // ---- SOL path: server-funded escrow ----
  const rewardSol = parsed.data.reward_sol;
  if (rewardSol === undefined) {
    res.status(400).json({
      error: 'reward_sol is required for SOL bounties.'
    });
    return;
  }

  if (!supabase) {
    res.status(500).json({ error: 'Supabase is not configured.' });
    return;
  }

  const rewardLamports = rewardSolToLamports(rewardSol);

  let escrowTxSig: string;
  try {
    escrowTxSig = await escrowBounty({
      posterId: user.id,
      posterWallet: user.wallet_address,
      rewardLamports
    });
  } catch (error) {
    console.error('SOL escrow failed:', error);
    const message =
      error instanceof Error ? error.message : 'Failed to escrow bounty funds.';
    const lowered = message.toLowerCase();
    const isFundingConfigIssue =
      lowered.includes('insufficient balance') ||
      lowered.includes('poster wallet is required') ||
      lowered.includes('requires a client-signed escrow transfer') ||
      lowered.includes('missing required env var');
    res.status(isFundingConfigIssue ? 400 : 502).json({
      error: isFundingConfigIssue ? message : 'Solana escrow failed.',
      details: isFundingConfigIssue ? null : message
    });
    return;
  }

  const { data: created, error: insertError } = await supabase
    .from('bounties')
    .insert({
      poster_id: user.id,
      lat: parsed.data.lat,
      lng: parsed.data.lng,
      reward_currency: 'SOL',
      reward_lamports: rewardLamports,
      description: parsed.data.description,
      reference_video_url: parsed.data.reference_video_url ?? null,
      status: 'open',
      escrow_tx_sig: escrowTxSig
    })
    .select('*')
    .single();

  if (insertError || !created) {
    res.status(500).json({
      error:
        'Solana escrow succeeded but bounty record failed to persist. Manual reconciliation required.',
      escrow_tx_sig: escrowTxSig
    });
    return;
  }

  res.status(201).json({
    bounty: {
      ...created,
      ...rewardFieldsFor(created),
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
      '*, poster:users!bounties_poster_id_fkey(id, wallet_address, world_address, verified)'
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

      const effective = {
        ...bounty,
        status: hasExpiredClaim ? 'expired' : bounty.status
      };

      return {
        ...effective,
        ...rewardFieldsFor(effective),
        urgency_score: computeUrgencyScore(effective)
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
      '*, poster:users!bounties_poster_id_fkey(id, wallet_address, world_address, verified)'
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
        ...rewardFieldsFor(bounty),
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
      '*, poster:users!bounties_poster_id_fkey(id, wallet_address, world_address, verified)'
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

  const effective = { ...bounty, status };
  res.json({
    ...effective,
    ...rewardFieldsFor(effective),
    urgency_score: computeUrgencyScore(effective)
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

  // Heuristic check: ensure the claimer has a wallet of the right kind for
  // the bounty's currency, so payout doesn't fail mysteriously later.
  if (bounty.reward_currency === 'WLD' && !user.world_address) {
    res.status(409).json({
      error:
        'This bounty pays in WLD. Link your World App wallet (walletAuth) before claiming.',
      required: 'world_address'
    });
    return;
  }
  if (bounty.reward_currency === 'SOL' && !user.wallet_address) {
    res.status(409).json({
      error:
        'This bounty pays in SOL but your account has no Solana wallet. Re-register to receive a wallet.',
      required: 'wallet_address'
    });
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
      '*, poster:users!bounties_poster_id_fkey(id, wallet_address, world_address, verified)'
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
      ...rewardFieldsFor(updated),
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
      '*, poster:users!bounties_poster_id_fkey(id, wallet_address, world_address, verified)'
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
      ...rewardFieldsFor(updated),
      urgency_score: computeUrgencyScore(updated)
    }
  });
});
