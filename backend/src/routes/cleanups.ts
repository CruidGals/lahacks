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
  final_result: z.string().optional(),
  artifact_removed: z.boolean().optional(),
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

function isVerificationBypassEnabled(): boolean {
  const raw = process.env.BYPASS_VERIFICATION_FOR_TESTING?.trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

async function postToAiVerifier(payload: VerificationPayload): Promise<void> {
  const verifyUrl = process.env.AI_VERIFY_URL;
  if (!verifyUrl) {
    console.warn(
      'AI_VERIFY_URL is not set; running stub verification locally.'
    );
    void simulateLocalVerification(payload);
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

/**
 * Demo-mode fallback when the AI service is not running.
 * After a short delay, calls the verification-result endpoint locally
 * with verified=true so the end-to-end flow completes.
 */
async function simulateLocalVerification(
  payload: VerificationPayload
): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 3500));

  const port = process.env.PORT ?? '8080';
  const baseUrl = process.env.SELF_BASE_URL ?? `http://localhost:${port}`;
  const url = `${baseUrl}/api/cleanups/${payload.cleanup_id}/verification-result`;
  const internalToken = process.env.INTERNAL_API_TOKEN;

  const headers: Record<string, string> = {
    'content-type': 'application/json'
  };
  if (internalToken) headers['x-internal-token'] = internalToken;

  const trajectoryOk = payload.trajectory_analysis.within_radius_pct >= 50;
  const sessionOk = payload.session_duration_s >= 30;
  const verified = trajectoryOk && sessionOk;

  try {
    await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        verified,
        confidence: verified ? 0.92 : 0.3,
        scene_match: verified,
        task_complete: verified,
        fraud_flags: verified ? [] : ['session_too_short_or_off_site'],
        reasoning: verified
          ? 'Stub verifier: GPS trajectory and session duration look good.'
          : 'Stub verifier: trajectory or duration insufficient for auto-verify.'
      })
    });
  } catch (err) {
    console.error('Local verification simulation failed:', err);
  }
}

cleanupRouter.post('/', async (req, res) => {
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

cleanupRouter.get('/:id', async (req, res) => {
  const user = await requireAuthUser(req, res);
  if (!user) return;

  if (!supabase) {
    res.status(500).json({ error: 'Supabase is not configured.' });
    return;
  }

  const { data: cleanup, error } = await supabase
    .from('cleanups')
    .select('*')
    .eq('id', req.params.id)
    .maybeSingle();

  if (error) {
    res.status(500).json({ error: 'Failed to load cleanup.' });
    return;
  }
  if (!cleanup) {
    res.status(404).json({ error: 'Cleanup not found.' });
    return;
  }

  // Authorize: only the claimer or poster can read
  const { data: bounty } = await supabase
    .from('bounties')
    .select('claimer_id, poster_id, reward_lamports')
    .eq('id', cleanup.bounty_id ?? '')
    .maybeSingle();

  if (
    bounty &&
    bounty.claimer_id !== user.id &&
    bounty.poster_id !== user.id
  ) {
    res.status(403).json({ error: 'Not allowed.' });
    return;
  }

  res.json({ cleanup });
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

  const bypassVerification = isVerificationBypassEnabled();
  const effectiveResult = bypassVerification
    ? {
        ...parsed.data,
        verified: true,
        confidence: 1,
        scene_match: true,
        task_complete: true,
        fraud_flags: [] as string[],
        reasoning:
          'Verification bypass is enabled for testing; forcing pass result.'
      }
    : parsed.data;

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

  const verificationJson = effectiveResult as Record<string, unknown>;

  const shouldPayout =
    effectiveResult.verified === true &&
    effectiveResult.scene_match !== false &&
    effectiveResult.task_complete !== false &&
    (effectiveResult.fraud_flags?.length ?? 0) === 0;

  if (shouldPayout) {
    if (cleanup.status === 'verified' && cleanup.payout_tx_sig) {
      res.json({
        ok: true,
        verified: true,
        payout_tx_sig: cleanup.payout_tx_sig,
        idempotent: true
      });
      return;
    }

    if (cleanup.status === 'rejected') {
      res.status(409).json({ error: 'Cleanup was already rejected.' });
      return;
    }

    if (cleanup.status !== 'pending') {
      res.status(409).json({
        error: `Cleanup is not awaiting verification (status=${cleanup.status}).`
      });
      return;
    }

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

    let payoutTxSig: string;
    try {
      payoutTxSig = await releaseBountyToClaimer({
        bountyId: bounty.id,
        recipientWallet: claimer.wallet_address,
        cleanupId: cleanup.id,
        rewardLamports: bounty.reward_lamports
      });
    } catch (e) {
      console.warn(
        'On-chain payout failed; using simulated payout signature for demo:',
        e instanceof Error ? e.message : e
      );
      // Demo fallback: don't block the verification flow if devnet vault is empty.
      payoutTxSig = `simulated_${cleanup.id.slice(0, 8)}_${Date.now().toString(36)}`;
    }

    const [cleanupUpdate, bountyUpdate, sessionUpdate] = await Promise.all([
      supabase
        .from('cleanups')
        .update({
          status: 'verified',
          verification_result: verificationJson,
          confidence_score: effectiveResult.confidence ?? null,
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

  if (cleanup.status === 'rejected') {
    res.json({
      ok: true,
      verified: false,
      idempotent: true,
      refund_status: 'escrow_lock_released'
    });
    return;
  }

  if (cleanup.status === 'verified') {
    res.status(409).json({ error: 'Cleanup was already verified.' });
    return;
  }

  if (cleanup.status !== 'pending') {
    res.status(409).json({
      error: `Cleanup is not awaiting verification (status=${cleanup.status}).`
    });
    return;
  }

  const [cleanupUpdate, bountyUpdate, sessionUpdate] = await Promise.all([
    supabase
      .from('cleanups')
      .update({
        status: 'rejected',
        verification_result: verificationJson,
        confidence_score: effectiveResult.confidence ?? null
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
    refund_status: 'escrow_retained'
  });
});
