/**
 * In-process store for outstanding MiniKit payment intents.
 *
 * Each intent encodes:
 * - the user that minted it (so a different user can't consume it),
 * - the kind of action it backs (currently only `bounty_escrow`),
 * - the exact amount the user must pay and the recipient they must pay,
 * - and the structured payload we'll act on once payment is confirmed.
 *
 * Intents are short-lived (`TTL_MS` below) and can only be consumed once. We
 * lock an intent when a confirmation request begins so concurrent attempts
 * can't both succeed; if the actual on-chain verification fails the intent is
 * unlocked again so the client can retry.
 *
 * For a real production deployment this should live in Redis or Postgres so it
 * survives restarts and multiple backend instances. For the hackathon scope a
 * single-process Map is sufficient and keeps the system self-contained.
 */

import { randomUUID } from 'node:crypto';

const TTL_MS = 10 * 60 * 1000;
const MAX_INTENTS_PER_USER = 16;
const SWEEP_INTERVAL_MS = 60 * 1000;

export type BountyEscrowPayload = {
  lat: number;
  lng: number;
  description: string;
  reward_micro_wld: number;
  reference_video_url: string | null;
};

type IntentBase = {
  reference: string;
  user_id: string;
  recipient_address: string;
  amount_micro_wld: number;
  amount_wei: string;
  created_at: number;
  expires_at: number;
  status: 'pending' | 'locked' | 'consumed';
};

export type BountyEscrowIntent = IntentBase & {
  kind: 'bounty_escrow';
  payload: BountyEscrowPayload;
};

export type PaymentIntent = BountyEscrowIntent;

export class IntentNotFoundError extends Error {}
export class IntentExpiredError extends Error {}
export class IntentBusyError extends Error {}
export class IntentAlreadyConsumedError extends Error {}
export class IntentForbiddenError extends Error {}

const intents = new Map<string, PaymentIntent>();
const userIntents = new Map<string, Set<string>>();

setInterval(sweepExpired, SWEEP_INTERVAL_MS).unref?.();

function sweepExpired() {
  const now = Date.now();
  for (const [reference, intent] of intents) {
    if (intent.status === 'consumed' || intent.expires_at <= now) {
      intents.delete(reference);
      const refs = userIntents.get(intent.user_id);
      refs?.delete(reference);
      if (refs && refs.size === 0) userIntents.delete(intent.user_id);
    }
  }
}

function trackUserIntent(userId: string, reference: string) {
  const refs = userIntents.get(userId) ?? new Set<string>();
  refs.add(reference);
  userIntents.set(userId, refs);

  if (refs.size > MAX_INTENTS_PER_USER) {
    // Drop the oldest pending intent so an attacker can't exhaust memory.
    const sorted = Array.from(refs)
      .map((ref) => intents.get(ref))
      .filter((it): it is PaymentIntent => Boolean(it))
      .sort((a, b) => a.created_at - b.created_at);
    while (refs.size > MAX_INTENTS_PER_USER && sorted.length > 0) {
      const oldest = sorted.shift();
      if (!oldest) break;
      intents.delete(oldest.reference);
      refs.delete(oldest.reference);
    }
  }
}

export function createBountyEscrowIntent(args: {
  user_id: string;
  recipient_address: string;
  amount_micro_wld: number;
  amount_wei: bigint;
  payload: BountyEscrowPayload;
}): BountyEscrowIntent {
  const now = Date.now();
  const intent: BountyEscrowIntent = {
    kind: 'bounty_escrow',
    reference: randomUUID(),
    user_id: args.user_id,
    recipient_address: args.recipient_address,
    amount_micro_wld: args.amount_micro_wld,
    amount_wei: args.amount_wei.toString(),
    payload: args.payload,
    created_at: now,
    expires_at: now + TTL_MS,
    status: 'pending'
  };
  intents.set(intent.reference, intent);
  trackUserIntent(intent.user_id, intent.reference);
  return intent;
}

/**
 * Atomically transition an intent into the `locked` state so a confirm
 * handler can run on-chain verification without another caller consuming it
 * concurrently.
 */
export function lockIntent(reference: string, userId: string): PaymentIntent {
  const intent = intents.get(reference);
  if (!intent) throw new IntentNotFoundError('Payment intent not found.');
  if (intent.user_id !== userId) {
    throw new IntentForbiddenError('Caller does not own this payment intent.');
  }
  if (intent.expires_at <= Date.now()) {
    intents.delete(reference);
    throw new IntentExpiredError('Payment intent has expired.');
  }
  if (intent.status === 'consumed') {
    throw new IntentAlreadyConsumedError(
      'Payment intent has already been consumed.'
    );
  }
  if (intent.status === 'locked') {
    throw new IntentBusyError(
      'Payment intent is already being confirmed; please wait.'
    );
  }
  intent.status = 'locked';
  intents.set(reference, intent);
  return intent;
}

export function unlockIntent(reference: string) {
  const intent = intents.get(reference);
  if (intent && intent.status === 'locked') {
    intent.status = 'pending';
    intents.set(reference, intent);
  }
}

export function consumeIntent(reference: string): PaymentIntent {
  const intent = intents.get(reference);
  if (!intent) throw new IntentNotFoundError('Payment intent not found.');
  intent.status = 'consumed';
  // Keep the consumed record for a brief window so accidental re-confirms get
  // a clear error; the sweeper will purge it on TTL.
  intents.set(reference, intent);
  return intent;
}

export function getIntent(reference: string): PaymentIntent | null {
  return intents.get(reference) ?? null;
}
