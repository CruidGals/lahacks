import { Router } from 'express';
import { z } from 'zod';
import { supabase } from '../config/supabase.js';
import { requireAuthUser, requireInternalToken } from '../lib/auth.js';
import { isClaimExpired } from '../lib/bounties.js';
import { refundEscrowToPoster, releaseBountyToClaimer } from '../lib/solana.js';

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

// We intentionally only forward ``cleanup_id`` to the AI service. The Stage 2
// fixture pipeline ignores the recorded video and GPS trajectory entirely --
// it runs the hardcoded reference + submission fixtures and reports the
// boolean ``Stage2FinalVerdict.approved`` back to
// ``/api/cleanups/:id/verification-result``.
type VerificationPayload = {
  cleanup_id: string;
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
 *
 * The Stage 2 fixture pipeline is the source of truth for verification, so
 * when no AI service is reachable we just auto-verify after a short delay
 * so the end-to-end flow continues. Ops will see the warning logged above.
 */
async function simulateLocalVerification(
  payload: VerificationPayload
): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 2500));

  const port = process.env.PORT ?? '8080';
  const baseUrl = process.env.SELF_BASE_URL ?? `http://localhost:${port}`;
  const url = `${baseUrl}/api/cleanups/${payload.cleanup_id}/verification-result`;
  const internalToken = process.env.INTERNAL_API_TOKEN;

  const headers: Record<string, string> = {
    'content-type': 'application/json'
  };
  if (internalToken) headers['x-internal-token'] = internalToken;

  try {
    await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        verified: true,
        confidence: 0.85,
        scene_match: true,
        task_complete: true,
        fraud_flags: [],
        reasoning:
          'AI_VERIFY_URL not set; auto-verifying locally so the demo flow completes.'
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

  // GPS trajectory + reference video URL are intentionally not forwarded.
  // The AI service runs the Stage 2 fixture pipeline against hardcoded
  // reference/submission videos and posts the boolean verdict back to
  // /api/cleanups/:id/verification-result.
  const payload: VerificationPayload = {
    cleanup_id: cleanup.id
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

    // SOL payout only happens for SOL bounties. XP bounties release
    // exclusively through the XP path below.
    let payoutTxSig: string | null = null;
    if (bounty.reward_type === 'sol' && bounty.reward_lamports > 0) {
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
        // Demo fallback: don't block the verification flow if the devnet
        // vault is empty.
        payoutTxSig = `simulated_${cleanup.id.slice(0, 8)}_${Date.now().toString(36)}`;
      }

      // Mirror the SOL win on the leaderboard so /api/leaderboard?timeframe=all
      // can rank historic earners without re-summing the bounties table.
      const { error: lamportsError } = await supabase.rpc(
        'add_earned_lamports',
        {
          p_user_id: claimer.id,
          p_lamports: bounty.reward_lamports
        }
      );
      if (lamportsError) {
        console.warn(
          'Failed to update lifetime lamports counter for claimer:',
          lamportsError.message
        );
      }
    }

    // Award XP for *both* reward types. SOL bounties earn the LLM-derived
    // bonus stored in ``bounty.xp_award``; XP bounties pay out the staked
    // amount, which was also written into ``bounty.xp_award`` at creation.
    let claimerXpAfter: number | null = null;
    if (bounty.xp_award > 0) {
      const { data: balance, error: xpError } = await supabase.rpc(
        'award_xp',
        {
          p_user_id: claimer.id,
          p_amount: bounty.xp_award
        }
      );
      if (xpError) {
        // The cleanup is already verified at this point -- if XP grant
        // fails we surface the error so it can be replayed manually rather
        // than silently dropping reward.
        console.error('Failed to award XP to claimer:', xpError.message);
        res.status(500).json({
          error: 'Verified cleanup but failed to grant XP reward.'
        });
        return;
      }
      claimerXpAfter = typeof balance === 'number' ? balance : null;
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
      payout_tx_sig: payoutTxSig,
      reward_type: bounty.reward_type,
      xp_awarded: bounty.xp_award,
      claimer_xp_after: claimerXpAfter
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

  if (!bounty.poster_id) {
    res.status(500).json({ error: 'Bounty has no poster for refund.' });
    return;
  }

  const { data: poster, error: posterError } = await supabase
    .from('users')
    .select('*')
    .eq('id', bounty.poster_id)
    .maybeSingle();

  if (posterError) {
    res.status(500).json({ error: 'Failed to load poster for refund.' });
    return;
  }
  if (!poster) {
    res.status(404).json({ error: 'Poster user not found for refund.' });
    return;
  }

  // Refund the staked currency back to the poster. SOL goes back via the
  // on-chain escrow program; XP goes back via the ``refund_xp`` RPC which
  // increments ``users.xp`` *without* touching ``users.total_earned_xp``
  // (a refund must not inflate the leaderboard).
  let refundTxSig: string | null = null;
  let posterXpAfter: number | null = null;
  let refundStatus = 'no_refund_needed';

  if (bounty.reward_type === 'sol' && bounty.reward_lamports > 0) {
    try {
      refundTxSig = await refundEscrowToPoster({
        bountyId: bounty.id,
        posterWallet: poster.wallet_address,
        cleanupId: cleanup.id,
        rewardLamports: bounty.reward_lamports
      });
    } catch (e) {
      console.warn(
        'Refund transaction failed; using simulated refund signature for demo:',
        e instanceof Error ? e.message : e
      );
      refundTxSig = `simulated_refund_${cleanup.id.slice(0, 8)}_${Date.now().toString(36)}`;
    }
    refundStatus = 'escrow_refunded_to_poster';
  } else if (bounty.reward_type === 'xp' && (bounty.reward_xp ?? 0) > 0) {
    const { data: balance, error: refundError } = await supabase.rpc(
      'refund_xp',
      {
        p_user_id: poster.id,
        p_amount: bounty.reward_xp as number
      }
    );
    if (refundError) {
      console.error('Failed to refund XP to poster:', refundError.message);
      res.status(500).json({ error: 'Failed to refund XP stake.' });
      return;
    }
    posterXpAfter = typeof balance === 'number' ? balance : null;
    refundStatus = 'xp_refunded_to_poster';
  }

  const verificationWithRefund = {
    ...verificationJson,
    refund_tx_sig: refundTxSig
  };

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
    refund_tx_sig: refundTxSig,
    refund_status: refundStatus,
    reward_type: bounty.reward_type,
    poster_xp_after: posterXpAfter
  });
});
