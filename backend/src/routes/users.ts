import { Router } from 'express';
import { Keypair } from '@solana/web3.js';
import { signRequest } from '@worldcoin/idkit-core/signing';
import { z } from 'zod';
import { supabase } from '../config/supabase.js';
import { requireAuthUser } from '../lib/auth.js';
import { rewardLamportsToSol } from '../lib/bounties.js';

export const usersRouter = Router();

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


  console.log('sig', sig);
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
    .select('id, description, reward_lamports, claimed_at')
    .eq('claimer_id', user.id)
    .eq('status', 'completed')
    .order('claimed_at', { ascending: false });

  if (completedError) {
    res.status(500).json({ error: 'Failed to load completed bounties.' });
    return;
  }

  const completed = completedBounties ?? [];
  const totalEarnedSol = completed.reduce(
    (sum, bounty) => sum + rewardLamportsToSol(bounty.reward_lamports),
    0
  );

  const recent = completed.slice(0, 8).map((bounty) => ({
    bounty_id: bounty.id,
    title: deriveTitle(bounty.description),
    reward_sol: rewardLamportsToSol(bounty.reward_lamports),
    completed_at: bounty.claimed_at ?? new Date().toISOString()
  }));

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
      total_earned_sol: Number(totalEarnedSol.toFixed(4)),
      total_completed: completed.length,
      current_streak: activeDays.size,
      wallet: {
        address: user.wallet_address,
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

  if (parsed.data.idkit_response) {
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
    const verifyJson = (await verifyRes.json().catch(() => null)) as VerifyV4Response | null;

    if (!verifyRes.ok || !verifyJson?.success) {
      res.status(400).json({
        error: 'World ID proof verification failed.',
        details: verifyJson ?? null
      });
      return;
    }

    worldIdHash =
      extractNullifierMarker(parsed.data.idkit_response) ??
      `world_${user.id}_${Date.now().toString(36)}`;
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

  if (error || !updated) {
    res.status(500).json({ error: 'Failed to store World ID verification.' });
    return;
  }

  res.json({ ok: true, user: updated });
});
