import { Router } from 'express';
import { z } from 'zod';
import { supabase } from '../config/supabase.js';
import { requireAuthUser, requireInternalToken } from '../lib/auth.js';
import { isClaimExpired } from '../lib/bounties.js';
import { releaseBountyToClaimer } from '../lib/solana.js';
import { analyzeTrajectory } from '../lib/trajectory.js';

export const cleanupRouter = Router();

const createCleanupSchema = z.object({
  session_id: z.string().uuid(),
  video_url: z.url()
});

const verificationResultSchema = z.object({
  verified: z.boolean(),
  confidence: z.number().min(0).max(1).optional(),
  scene_match: z.boolean().optional(),
  task_complete: z.boolean().optional(),
  fraud_flags: z.array(z.string()).optional(),
  reasoning: z.string().optional()
});

type VerificationPayload = {
  cleanup_id: string;
  submission_video_url: string;
  reference_video_url: string | null;
  bounty_lat: number;
  bounty_lng: number;
  gps_trajectory: Array<{
    lat: number;
    lng: number;
    accuracy: number | null;
    timestamp: string | null;
  }>;
  issued_nonce: string | null;
  session_duration_s: number;
  trajectory_analysis: {
    within_radius_pct: number;
    avg_distance_m: number;
    total_duration_s: number;
    suspicious: boolean;
  };
};

async function postToAiVerifier(payload: VerificationPayload): Promise<void> {
  const verifyUrl = process.env.AI_VERIFY_URL;
  if (!verifyUrl) {
    console.warn('AI_VERIFY_URL is not set; skipping verifier webhook.');
    return;
  }

  const response = await fetch(verifyUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Verifier webhook failed: ${response.status} ${text}`);
  }
}

cleanupRouter.post('/', async (req, res) => {
  const user = await requireAuthUser(req, res);
  if (!user) return;

  if (!supabase) {
    res.status(500).json({ error: 'Supabase is not configured.' });
    return;
  }

  const parsed = createCleanupSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const { data: session, error: sessionError } = await supabase
    .from('sessions')
    .select('*')
    .eq('id', parsed.data.session_id)
    .maybeSingle();

  if (sessionError) {
    res.status(500).json({ error: 'Failed to load session.' });
    return;
  }
  if (!session) {
    res.status(404).json({ error: 'Session not found.' });
    return;
  }
  if (session.user_id !== user.id) {
    res.status(403).json({ error: 'Cannot submit cleanup for another user session.' });
    return;
  }
  if (session.status !== 'active') {
    res.status(409).json({ error: 'Session is not active.' });
    return;
  }

  const { data: bounty, error: bountyError } = await supabase
    .from('bounties')
    .select('*')
    .eq('id', session.bounty_id ?? '')
    .maybeSingle();

  if (bountyError) {
    res.status(500).json({ error: 'Failed to load bounty.' });
    return;
  }
  if (!bounty) {
    res.status(404).json({ error: 'Associated bounty not found.' });
    return;
  }
  if (bounty.claimer_id !== user.id || isClaimExpired(bounty.claimed_at)) {
    res.status(409).json({ error: 'Bounty claim is invalid or expired.' });
    return;
  }

  const { data: cleanup, error: cleanupError } = await supabase
    .from('cleanups')
    .insert({
      bounty_id: bounty.id,
      session_id: session.id,
      video_url: parsed.data.video_url,
      status: 'pending'
    })
    .select('*')
    .single();

  if (cleanupError || !cleanup) {
    res.status(500).json({ error: 'Failed to create cleanup record.' });
    return;
  }

  const { data: pings, error: pingError } = await supabase
    .from('gps_pings')
    .select('lat,lng,accuracy,timestamp')
    .eq('session_id', session.id)
    .order('timestamp', { ascending: true });

  if (pingError) {
    res.status(500).json({ error: 'Failed to load GPS trajectory.' });
    return;
  }

  const startedAtMs = session.started_at
    ? new Date(session.started_at).getTime()
    : Date.now();
  const durationSec = Math.max(
    0,
    Math.round((Date.now() - startedAtMs) / 1_000)
  );

  const payload: VerificationPayload = {
    cleanup_id: cleanup.id,
    submission_video_url: cleanup.video_url ?? '',
    reference_video_url: bounty.reference_video_url,
    bounty_lat: bounty.lat,
    bounty_lng: bounty.lng,
    gps_trajectory: pings ?? [],
    issued_nonce: session.nonce,
    session_duration_s: durationSec,
    trajectory_analysis: analyzeTrajectory(
      pings ?? [],
      bounty.lat,
      bounty.lng
    )
  };

  void postToAiVerifier(payload).catch((error) => {
    console.error('Verifier webhook failed:', error);
  });

  res.status(202).json({
    cleanup_id: cleanup.id,
    status: 'pending'
  });
});

cleanupRouter.post('/:id/verification-result', async (req, res) => {
  if (!requireInternalToken(req, res)) return;

  if (!supabase) {
    res.status(500).json({ error: 'Supabase is not configured.' });
    return;
  }

  const parsed = verificationResultSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const { data: cleanup, error: cleanupError } = await supabase
    .from('cleanups')
    .select('*')
    .eq('id', req.params.id)
    .maybeSingle();

  if (cleanupError) {
    res.status(500).json({ error: 'Failed to load cleanup.' });
    return;
  }
  if (!cleanup) {
    res.status(404).json({ error: 'Cleanup not found.' });
    return;
  }

  const { data: bounty, error: bountyError } = await supabase
    .from('bounties')
    .select('*')
    .eq('id', cleanup.bounty_id ?? '')
    .maybeSingle();

  if (bountyError) {
    res.status(500).json({ error: 'Failed to load bounty.' });
    return;
  }
  if (!bounty) {
    res.status(404).json({ error: 'Associated bounty not found.' });
    return;
  }

  const verificationJson = parsed.data as Record<string, unknown>;

  if (parsed.data.verified) {
    if (!bounty.claimer_id) {
      res.status(409).json({ error: 'Bounty has no claimer for payout.' });
      return;
    }

    const { data: claimer, error: userError } = await supabase
      .from('users')
      .select('*')
      .eq('id', bounty.claimer_id)
      .maybeSingle();

    if (userError) {
      res.status(500).json({ error: 'Failed to load claimer user.' });
      return;
    }
    if (!claimer) {
      res.status(404).json({ error: 'Claimer user not found.' });
      return;
    }

    const payoutTxSig = await releaseBountyToClaimer({
      bountyId: bounty.id,
      recipientWallet: claimer.wallet_address,
      cleanupId: cleanup.id,
      rewardLamports: bounty.reward_lamports
    });

    const [cleanupUpdate, bountyUpdate, sessionUpdate] = await Promise.all([
      supabase
        .from('cleanups')
        .update({
          status: 'verified',
          verification_result: verificationJson,
          confidence_score: parsed.data.confidence ?? null,
          payout_tx_sig: payoutTxSig
        })
        .eq('id', cleanup.id),
      supabase
        .from('bounties')
        .update({ status: 'completed' })
        .eq('id', bounty.id),
      supabase
        .from('sessions')
        .update({
          status: 'completed',
          ended_at: new Date().toISOString()
        })
        .eq('id', cleanup.session_id ?? '')
    ]);

    if (cleanupUpdate.error || bountyUpdate.error || sessionUpdate.error) {
      res.status(500).json({ error: 'Failed to persist verified cleanup state.' });
      return;
    }

    res.json({
      ok: true,
      verified: true,
      payout_tx_sig: payoutTxSig
    });
    return;
  }

  const [cleanupUpdate, bountyUpdate, sessionUpdate] = await Promise.all([
    supabase
      .from('cleanups')
      .update({
        status: 'rejected',
        verification_result: verificationJson,
        confidence_score: parsed.data.confidence ?? null
      })
      .eq('id', cleanup.id),
    supabase
      .from('bounties')
      .update({
        status: 'open',
        claimer_id: null,
        claimed_at: null
      })
      .eq('id', bounty.id),
    supabase
      .from('sessions')
      .update({
        status: 'cancelled',
        ended_at: new Date().toISOString()
      })
      .eq('id', cleanup.session_id ?? '')
  ]);

  if (cleanupUpdate.error || bountyUpdate.error || sessionUpdate.error) {
    res.status(500).json({ error: 'Failed to persist rejected cleanup state.' });
    return;
  }

  res.json({
    ok: true,
    verified: false,
    refund_status: 'escrow_lock_released'
  });
});
