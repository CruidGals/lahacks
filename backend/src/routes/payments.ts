/**
 * Payments router.
 *
 * Two-phase commit for any flow that requires the user to spend WLD via the
 * `MiniKit.pay` mini-app command:
 *
 * 1. POST /api/payments/intent
 *    - Authenticated user describes what they want to do (e.g. create a bounty)
 *      and the amount of WLD they're willing to spend.
 *    - Backend mints a one-shot `reference` (UUID) and remembers the expected
 *      recipient + amount + payload.
 *    - Returns `{reference, recipient, expected_amount_wei, expected_amount_micro_wld}`
 *      so the client can pass them straight into `MiniKit.pay()`.
 *
 * 2. POST /api/payments/confirm
 *    - Client passes the `reference` plus the `transactionId` returned by
 *      `MiniKit.pay`.
 *    - Backend looks up the intent, locks it, then validates the transaction
 *      against the Worldcoin Developer Portal API (matching reference,
 *      recipient, amount, and status). On success we run the "side effect"
 *      bound to the intent (e.g. create the bounty row) and return its
 *      result.
 *
 * Locking ensures a single intent is only ever consumed once and survives
 * concurrent confirm requests (the second one gets a busy error).
 */

import { Router } from 'express';
import { z } from 'zod';
import { supabase } from '../config/supabase.js';
import { requireAuthUser } from '../lib/auth.js';
import {
  computeUrgencyScore,
  rewardFieldsFor,
  rewardMicroToWld,
  rewardWldToMicro
} from '../lib/bounties.js';
import {
  IntentAlreadyConsumedError,
  IntentBusyError,
  IntentExpiredError,
  IntentForbiddenError,
  IntentNotFoundError,
  consumeIntent,
  createBountyEscrowIntent,
  lockIntent,
  unlockIntent,
  type BountyEscrowIntent
} from '../lib/payment-intents.js';
import {
  Wld,
  WldConfigError,
  WldVerificationError,
  microToWei,
  verifyMiniKitPayment
} from '../lib/wld.js';

export const paymentsRouter = Router();

const MIN_BOUNTY_WLD = 0.01;
const MAX_BOUNTY_WLD = 100;

const bountyIntentSchema = z.object({
  kind: z.literal('bounty_escrow'),
  bounty: z.object({
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
    reward_wld: z.number().min(MIN_BOUNTY_WLD).max(MAX_BOUNTY_WLD),
    description: z.string().min(1).max(2000),
    reference_video_url: z.url().optional().nullable()
  })
});

const intentBodySchema = z.discriminatedUnion('kind', [bountyIntentSchema]);

const confirmBodySchema = z.object({
  reference: z.string().uuid(),
  transaction_id: z.string().min(1).max(256)
});

paymentsRouter.post('/intent', async (req, res) => {
  const user = await requireAuthUser(req, res);
  if (!user) return;

  if (!user.verified) {
    res.status(403).json({ error: 'World ID verification is required.' });
    return;
  }

  const parsed = intentBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  if (parsed.data.kind === 'bounty_escrow') {
    let recipient: string;
    try {
      recipient = Wld.vaultAddress();
    } catch (err) {
      res
        .status(503)
        .json({ error: configErrorMessage(err) ?? 'Vault is not configured.' });
      return;
    }

    const amountMicro = rewardWldToMicro(parsed.data.bounty.reward_wld);
    const amountWei = microToWei(amountMicro);
    const intent = createBountyEscrowIntent({
      user_id: user.id,
      recipient_address: recipient,
      amount_micro_wld: amountMicro,
      amount_wei: amountWei,
      payload: {
        lat: parsed.data.bounty.lat,
        lng: parsed.data.bounty.lng,
        description: parsed.data.bounty.description,
        reward_micro_wld: amountMicro,
        reference_video_url: parsed.data.bounty.reference_video_url ?? null
      }
    });

    res.status(201).json({
      reference: intent.reference,
      kind: intent.kind,
      recipient,
      token_address: Wld.tokenAddress(),
      chain_id: 480,
      expected_amount_micro_wld: amountMicro,
      expected_amount_wei: amountWei.toString(),
      expected_amount_wld: rewardMicroToWld(amountMicro),
      expires_at: intent.expires_at
    });
    return;
  }

  res.status(400).json({ error: 'Unsupported intent kind.' });
});

paymentsRouter.post('/confirm', async (req, res) => {
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

  const parsed = confirmBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const { reference, transaction_id: transactionId } = parsed.data;

  let intent;
  try {
    intent = lockIntent(reference, user.id);
  } catch (err) {
    if (err instanceof IntentNotFoundError) {
      res.status(404).json({ error: err.message });
      return;
    }
    if (err instanceof IntentExpiredError) {
      res.status(410).json({ error: err.message });
      return;
    }
    if (err instanceof IntentAlreadyConsumedError) {
      res.status(409).json({ error: err.message });
      return;
    }
    if (err instanceof IntentBusyError) {
      res.status(409).json({ error: err.message });
      return;
    }
    if (err instanceof IntentForbiddenError) {
      res.status(403).json({ error: err.message });
      return;
    }
    throw err;
  }

  try {
    let payment;
    try {
      payment = await verifyMiniKitPayment({
        transactionId,
        expectedReference: intent.reference,
        expectedRecipient: intent.recipient_address as `0x${string}`,
        expectedAmountWei: BigInt(intent.amount_wei),
        // We accept `pending` here because World App debits the user before
        // the user-op mines; the funds are guaranteed to land in the vault.
        allowPending: true
      });
    } catch (err) {
      if (err instanceof WldVerificationError) {
        unlockIntent(reference);
        res.status(400).json({ error: err.message });
        return;
      }
      if (err instanceof WldConfigError) {
        unlockIntent(reference);
        res.status(503).json({ error: err.message });
        return;
      }
      throw err;
    }

    if (intent.kind === 'bounty_escrow') {
      const result = await commitBountyEscrowIntent(intent, payment, user.id);
      if (!result.ok) {
        unlockIntent(reference);
        res.status(500).json({ error: result.error });
        return;
      }
      consumeIntent(reference);
      res.status(201).json(result.body);
      return;
    }

    unlockIntent(reference);
    res.status(400).json({ error: 'Unsupported intent kind.' });
  } catch (err) {
    unlockIntent(reference);
    throw err;
  }
});

type CommitResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; error: string };

async function commitBountyEscrowIntent(
  intent: BountyEscrowIntent,
  payment: Awaited<ReturnType<typeof verifyMiniKitPayment>>,
  userId: string
): Promise<CommitResult> {
  if (!supabase) return { ok: false, error: 'Supabase is not configured.' };

  const escrowTxSig = payment.transactionHash ?? payment.transactionId;

  const { data: created, error: insertError } = await supabase
    .from('bounties')
    .insert({
      poster_id: userId,
      lat: intent.payload.lat,
      lng: intent.payload.lng,
      reward_currency: 'WLD',
      reward_lamports: intent.payload.reward_micro_wld,
      description: intent.payload.description,
      reference_video_url: intent.payload.reference_video_url,
      status: 'open',
      escrow_tx_sig: escrowTxSig
    })
    .select('*')
    .single();

  if (insertError || !created) {
    return {
      ok: false,
      error: 'Payment confirmed but bounty record failed to persist.'
    };
  }

  return {
    ok: true,
    body: {
      bounty: {
        ...created,
        ...rewardFieldsFor(created),
        urgency_score: computeUrgencyScore(created)
      },
      escrow_tx_sig: escrowTxSig,
      payment: {
        transaction_id: payment.transactionId,
        transaction_hash: payment.transactionHash ?? null,
        status: payment.status,
        reference: payment.reference
      }
    }
  };
}

function configErrorMessage(err: unknown): string | null {
  if (err instanceof WldConfigError) return err.message;
  return null;
}
