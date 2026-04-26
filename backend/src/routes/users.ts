import { randomBytes } from 'node:crypto';
import { Router } from 'express';
import { Keypair } from '@solana/web3.js';
import { signRequest } from '@worldcoin/idkit-core/signing';
import type { MiniAppWalletAuthSuccessPayload } from '@worldcoin/minikit-js/commands';
import { verifySiweMessage } from '@worldcoin/minikit-js/siwe';
import { getAddress, isAddress } from 'viem';
import { z } from 'zod';
import { supabase } from '../config/supabase.js';
import { requireAuthUser } from '../lib/auth.js';
import { rewardLamportsToSol, rewardMicroToWld } from '../lib/bounties.js';

export const usersRouter = Router();

const WALLET_NONCE_TTL_MS = 5 * 60 * 1000;
const WALLET_NONCES = new Map<string, { user_id: string; expires_at: number }>();

setInterval(() => {
  const now = Date.now();
  for (const [nonce, entry] of WALLET_NONCES) {
    if (entry.expires_at <= now) WALLET_NONCES.delete(nonce);
  }
}, 60_000).unref?.();

function mintWalletNonce(userId: string): string {
  // MiniKit requires alphanumeric nonces with no hyphens.
  const nonce = randomBytes(24).toString('hex');
  WALLET_NONCES.set(nonce, {
    user_id: userId,
    expires_at: Date.now() + WALLET_NONCE_TTL_MS
  });
  return nonce;
}

function consumeWalletNonce(nonce: string, userId: string): boolean {
  const entry = WALLET_NONCES.get(nonce);
  if (!entry) return false;
  WALLET_NONCES.delete(nonce);
  if (entry.expires_at <= Date.now()) return false;
  return entry.user_id === userId;
}

const createUserSchema = z.object({
  id: z.string().uuid().optional(),
  wallet_address: z.string().min(1).max(256).optional(),
  verified: z.boolean().optional(),
  world_id_hash: z.string().min(1).max(2048).optional()
});

const verifyWorldIdSchema = z.object({
  world_id_hash: z.string().min(1).max(2048).optional(),
  rp_id: z.string().min(1).optional(),
  idkit_response: z.record(z.string(), z.unknown()).optional()
});

const createRpContextSchema = z.object({
  action: z.string().min(1).max(128).optional()
});

const completeSiweSchema = z.object({
  nonce: z.string().min(8).max(128),
  payload: z.object({
    status: z.literal('success'),
    message: z.string().min(1),
    signature: z.string().min(1),
    address: z.string().min(1),
    version: z.number().optional()
  })
});

type VerifyV4Response = {
  success: boolean;
  code?: string;
  detail?: string;
};

function worldEnvMode(): 'production' | 'staging' {
  const configured = process.env.WORLD_ID_ENVIRONMENT?.trim().toLowerCase();
  return configured === 'production' ? 'production' : 'staging';
}

function extractNullifierMarker(payload: Record<string, unknown>): string | null {
  const responses = payload.responses;
  if (!Array.isArray(responses) || responses.length === 0) return null;
  const first = responses[0];
  if (!first || typeof first !== 'object') return null;

  const firstRecord = first as Record<string, unknown>;
  if (typeof firstRecord.nullifier === 'string' && firstRecord.nullifier.length > 0) {
    return firstRecord.nullifier;
  }

  const sessionNullifier = firstRecord.session_nullifier;
  if (Array.isArray(sessionNullifier) && typeof sessionNullifier[0] === 'string') {
    return sessionNullifier[0];
  }

  return null;
}

usersRouter.post('/', async (req, res) => {
  if (!supabase) {
    res.status(500).json({ error: 'Supabase is not configured.' });
    return;
  }

  const parsed = createUserSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const walletAddress =
    parsed.data.wallet_address ?? Keypair.generate().publicKey.toBase58();

  const payload = {
    id: parsed.data.id,
    wallet_address: walletAddress,
    verified: parsed.data.verified ?? false,
    world_id_hash: parsed.data.world_id_hash ?? null
  };

  const { data: created, error } = await supabase
    .from('users')
    .insert(payload)
    .select('*')
    .single();

  if (error) {
    if (error.code === '23505') {
      res.status(409).json({ error: 'User already exists.' });
      return;
    }
    res.status(500).json({ error: 'Failed to create user.' });
    return;
  }

  res.status(201).json({ ok: true, user: created });
});

usersRouter.post('/world/rp-context', async (req, res) => {
  const user = await requireAuthUser(req, res);
  if (!user) return;

  const parsed = createRpContextSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const appId = process.env.WORLD_ID_APP_ID?.trim();
  const rpId = process.env.WORLD_RP_ID?.trim();
  const signingKeyHex = process.env.WORLD_RP_SIGNING_KEY?.trim();
  if (!appId || !rpId || !signingKeyHex) {
    res.status(503).json({
      error:
        'World ID is not configured. Set WORLD_ID_APP_ID, WORLD_RP_ID, and WORLD_RP_SIGNING_KEY.'
    });
    return;
  }

  const action = parsed.data.action ?? 'verify-profile-world-id-v1';
  const { sig, nonce, createdAt, expiresAt } = signRequest({
    signingKeyHex,
    action
  });

  res.json({
    app_id: appId,
    action,
    environment: worldEnvMode(),
    rp_context: {
      rp_id: rpId,
      nonce,
      created_at: createdAt,
      expires_at: expiresAt,
      signature: sig
    }
  });
});

usersRouter.get('/me', async (req, res) => {
  const user = await requireAuthUser(req, res);
  if (!user) return;

  if (!supabase) {
    res.status(500).json({ error: 'Supabase is not configured.' });
    return;
  }

  // Bounties this user has completed (claimed by them, status=completed)
  const { data: completedBounties, error: completedError } = await supabase
    .from('bounties')
    .select('id, description, reward_currency, reward_lamports, claimed_at')
    .eq('claimer_id', user.id)
    .eq('status', 'completed')
    .order('claimed_at', { ascending: false });

  if (completedError) {
    res.status(500).json({ error: 'Failed to load completed bounties.' });
    return;
  }

  const completed = completedBounties ?? [];
  let totalEarnedWld = 0;
  let totalEarnedSol = 0;
  for (const bounty of completed) {
    if (bounty.reward_currency === 'SOL') {
      totalEarnedSol += rewardLamportsToSol(bounty.reward_lamports);
    } else {
      totalEarnedWld += rewardMicroToWld(bounty.reward_lamports);
    }
  }

  const recent = completed.slice(0, 8).map((bounty) => {
    const isSol = bounty.reward_currency === 'SOL';
    const human = isSol
      ? rewardLamportsToSol(bounty.reward_lamports)
      : rewardMicroToWld(bounty.reward_lamports);
    return {
      bounty_id: bounty.id,
      title: deriveTitle(bounty.description),
      reward_currency: isSol ? 'SOL' : 'WLD',
      reward: human,
      ...(isSol ? { reward_sol: human } : { reward_wld: human }),
      completed_at: bounty.claimed_at ?? new Date().toISOString()
    };
  });

  // Streak placeholder — count active days within the last week
  const lastWeek = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const activeDays = new Set(
    completed
      .map((b) => b.claimed_at)
      .filter((iso): iso is string => Boolean(iso))
      .filter((iso) => new Date(iso).getTime() >= lastWeek)
      .map((iso) => new Date(iso).toISOString().slice(0, 10))
  );

  res.json({
    user: {
      ...user,
      total_earned_wld: Number(totalEarnedWld.toFixed(4)),
      total_earned_sol: Number(totalEarnedSol.toFixed(4)),
      total_completed: completed.length,
      current_streak: activeDays.size,
      wallet: {
        address: user.wallet_address,
        world_address: user.world_address,
        balance_wld: Number(totalEarnedWld.toFixed(4)),
        balance_sol: Number(totalEarnedSol.toFixed(4))
      },
      recent_completed: recent
    }
  });
});

function deriveTitle(description: string | null): string {
  if (!description) return 'Cleanup task';
  const firstLine = description.split('\n')[0]?.trim() ?? '';
  if (!firstLine) return 'Cleanup task';
  return firstLine.length > 60 ? `${firstLine.slice(0, 57)}…` : firstLine;
}

usersRouter.get('/:id', async (req, res) => {
  if (!supabase) {
    res.status(500).json({ error: 'Supabase is not configured.' });
    return;
  }

  const idSchema = z.string().uuid();
  const parsedId = idSchema.safeParse(req.params.id);
  if (!parsedId.success) {
    res.status(400).json({ error: 'Invalid user id.' });
    return;
  }

  const { data: user, error } = await supabase
    .from('users')
    .select('*')
    .eq('id', parsedId.data)
    .maybeSingle();

  if (error) {
    res.status(500).json({ error: 'Failed to load user.' });
    return;
  }
  if (!user) {
    res.status(404).json({ error: 'User not found.' });
    return;
  }

  res.json({ user });
});

usersRouter.post('/verify', async (req, res) => {
  const user = await requireAuthUser(req, res);
  if (!user) return;

  if (!supabase) {
    res.status(500).json({ error: 'Supabase is not configured.' });
    return;
  }

  const parsed = verifyWorldIdSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  let worldIdHash = parsed.data.world_id_hash ?? `dev_${user.id}_${Date.now().toString(36)}`;

  // Dev-only bypass: useful when you're iterating on the rest of the app and
  // don't have a fully-wired Worldcoin RP. Gated on both env vars so it can
  // never leak into a production deploy.
  const bypassEnabled =
    process.env.NODE_ENV !== 'production' &&
    process.env.BYPASS_VERIFICATION_FOR_TESTING === 'true';

  if (parsed.data.idkit_response && !bypassEnabled) {
    const rpId = (parsed.data.rp_id ?? process.env.WORLD_RP_ID)?.trim();
    if (!rpId) {
      res.status(503).json({ error: 'WORLD_RP_ID is required for IDKit verification.' });
      return;
    }

    const worldVerifyUrl = `https://developer.world.org/api/v4/verify/${rpId}`;
    const developerApiKey = process.env.WORLD_DEVELOPER_API_KEY?.trim();
    const headers: Record<string, string> = {
      'content-type': 'application/json'
    };
    if (developerApiKey) {
      headers.authorization = `Bearer ${developerApiKey}`;
    }

    const verifyRes = await fetch(worldVerifyUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(parsed.data.idkit_response)
    });
    const verifyText = await verifyRes.text();
    let verifyJson: VerifyV4Response | null = null;
    try {
      verifyJson = JSON.parse(verifyText) as VerifyV4Response;
    } catch {
      verifyJson = null;
    }

    if (!verifyRes.ok || !verifyJson?.success) {
      console.error('world_id_verify_failed', {
        url: worldVerifyUrl,
        status: verifyRes.status,
        body: verifyText.slice(0, 1000),
        sent_keys: Object.keys(parsed.data.idkit_response ?? {}),
        sent_protocol_version: (parsed.data.idkit_response as Record<string, unknown> | undefined)
          ?.protocol_version,
        sent_environment: (parsed.data.idkit_response as Record<string, unknown> | undefined)
          ?.environment,
        sent_action: (parsed.data.idkit_response as Record<string, unknown> | undefined)?.action
      });
      res.status(400).json({
        error: 'World ID proof verification failed.',
        details: verifyJson ?? { raw: verifyText.slice(0, 500) }
      });
      return;
    }

    worldIdHash =
      extractNullifierMarker(parsed.data.idkit_response) ??
      `world_${user.id}_${Date.now().toString(36)}`;
  } else if (parsed.data.idkit_response && bypassEnabled) {
    console.warn(
      'BYPASS_VERIFICATION_FOR_TESTING is enabled — accepting World ID proof without remote verification. Disable in production.'
    );
    worldIdHash =
      extractNullifierMarker(parsed.data.idkit_response) ??
      `bypass_${user.id}_${Date.now().toString(36)}`;
  }

  const { data: hashTaken } = await supabase
    .from('users')
    .select('id')
    .eq('world_id_hash', worldIdHash)
    .neq('id', user.id)
    .maybeSingle();

  if (hashTaken) {
    res.status(409).json({
      error:
        'This World ID is already linked to another account. Use that account or clear the duplicate in the database.'
    });
    return;
  }

  const { data: updated, error } = await supabase
    .from('users')
    .update({
      world_id_hash: worldIdHash,
      verified: true
    })
    .eq('id', user.id)
    .select('*')
    .single();

  if (error) {
    if (error.code === '23505') {
      res.status(409).json({
        error:
          'This World ID is already linked to another account (unique constraint).'
      });
      return;
    }
    res.status(500).json({ error: 'Failed to store World ID verification.' });
    return;
  }
  if (!updated) {
    res.status(500).json({ error: 'Failed to store World ID verification.' });
    return;
  }

  res.json({ ok: true, user: updated });
});

/**
 * MiniKit `walletAuth` (Sign-In with Ethereum) — phase 1.
 *
 * Returns a one-shot alphanumeric nonce bound to the calling user. The client
 * should immediately pass it to `MiniKit.walletAuth({ nonce })` and forward
 * the resulting payload back to `/wallet/complete` for verification.
 */
usersRouter.post('/wallet/nonce', async (req, res) => {
  const user = await requireAuthUser(req, res);
  if (!user) return;

  const nonce = mintWalletNonce(user.id);
  res.json({ nonce, expires_in_ms: WALLET_NONCE_TTL_MS });
});

/**
 * MiniKit `walletAuth` — phase 2.
 *
 * Verifies the SIWE signature against the nonce we minted, and on success
 * persists the verified Ethereum address as the user's `world_address`. The
 * legacy Solana `wallet_address` is left untouched so the user can continue
 * to receive SOL bounties to their auto-generated keypair.
 * `verifySiweMessage` from MiniKit handles both Smart Accounts (EIP-1271) and
 * EOAs (ECDSA).
 */
usersRouter.post('/wallet/complete', async (req, res) => {
  const user = await requireAuthUser(req, res);
  if (!user) return;

  if (!supabase) {
    res.status(500).json({ error: 'Supabase is not configured.' });
    return;
  }

  const parsed = completeSiweSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  if (!consumeWalletNonce(parsed.data.nonce, user.id)) {
    res.status(400).json({ error: 'Invalid or expired wallet auth nonce.' });
    return;
  }

  const payload = parsed.data.payload as MiniAppWalletAuthSuccessPayload;

  let verification;
  try {
    verification = await verifySiweMessage(payload, parsed.data.nonce);
  } catch (err) {
    res.status(400).json({
      error: 'SIWE verification failed.',
      details: err instanceof Error ? err.message : null
    });
    return;
  }

  if (!verification.isValid) {
    res.status(400).json({ error: 'SIWE signature did not validate.' });
    return;
  }

  const rawAddress = verification.siweMessageData.address;
  if (!rawAddress || !isAddress(rawAddress)) {
    res.status(400).json({ error: 'SIWE returned an invalid address.' });
    return;
  }

  let address: string;
  try {
    address = getAddress(rawAddress);
  } catch {
    res.status(400).json({ error: 'SIWE returned an invalid address.' });
    return;
  }

  const { data: otherWallets } = await supabase
    .from('users')
    .select('id, world_address')
    .neq('id', user.id)
    .not('world_address', 'is', null);

  const addrTaken = otherWallets?.find(
    (row) => row.world_address?.toLowerCase() === address.toLowerCase()
  );

  if (addrTaken) {
    res.status(409).json({
      error:
        'This World App wallet is already linked to another account. Sign in with the original account or remove the duplicate link.'
    });
    return;
  }

  // We trust the address coming from `verifySiweMessage`, not the client-sent
  // `payload.address`. They should match but we use the verified one.
  const { data: updated, error } = await supabase
    .from('users')
    .update({ world_address: address })
    .eq('id', user.id)
    .select('*')
    .single();

  if (error) {
    if (error.code === '23505') {
      res.status(409).json({
        error:
          'This World App wallet is already linked to another account (unique constraint).'
      });
      return;
    }
    res.status(500).json({ error: 'Failed to persist world address.' });
    return;
  }
  if (!updated) {
    res.status(500).json({ error: 'Failed to persist world address.' });
    return;
  }

  res.json({ ok: true, user: updated, world_address: address });
});
